/** Fixed, isolated Python control program. It is compiled into Core, never loaded from a project. */
export const SANDBOX_CONTROL = String.raw`
import os, sys, json, subprocess, selectors, select, signal, time, base64

MAX_OUTPUT = 8 * 1024 * 1024
READY = b'DHR_NAMESPACE_READY\n'
# bwrap's block-fd treats EOF as release, before setting the command's
# PDEATHSIG. This trusted PID 1 gate must therefore run before any project code.
# Its ready record is emitted only after bwrap has finished its setup. EOF on
# stdin never authorizes exec, including when the controller dies during setup.
BOOTSTRAP = '''import os, sys
# Mount-source O_PATH descriptors must never reach project code: they refer to
# host mount objects and could otherwise bypass the sandbox's readonly mounts.
for fd in os.listdir('/proc/self/fd'):
    if int(fd) > 2:
        try:
            os.close(int(fd))
        except OSError:
            pass
os.write(1, b'DHR_NAMESPACE_READY\\n')
if os.read(0, 1) != b'1':
    os._exit(125)
null = os.open('/dev/null', os.O_RDONLY)
os.dup2(null, 0)
os.close(null)
os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
'''

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()

def main():
    initial = bytearray()
    while not initial.endswith(b'\n'):
        byte = os.read(sys.stdin.fileno(), 1)
        if not byte or len(initial) > 1024 * 1024:
            raise RuntimeError('Missing or oversized controller configuration')
        initial.extend(byte)
    config = json.loads(initial)
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        emit({'error': 'PROVIDER_UNAVAILABLE', 'message': 'Python/Linux pidfd support is required'})
        return
    info_r, info_w = os.pipe()
    block_r, block_w = os.pipe()
    pinned = []
    args = list(config['args'])
    # Keep source directory inodes pinned while bwrap constructs its mounts.
    for mount in config['mounts']:
        fd = os.open(mount['source'], os.O_PATH | os.O_NOFOLLOW | os.O_DIRECTORY)
        st = os.fstat(fd)
        if str(st.st_dev) != mount['dev'] or str(st.st_ino) != mount['ino']:
            raise RuntimeError('Mount source identity changed')
        pinned.append(fd)
        # An unprivileged user namespace cannot dereference the host controller's
        # proc FDs. Pass our pinned FD and resolve it through bwrap's own proc entry.
        args.extend([mount['option'], '/proc/self/fd/' + str(fd), mount['destination']])
    args.extend(config['tail'])
    args.extend([config['python'], '-I', '-S', '-c', BOOTSTRAP] + config['argv'])
    args = ['--info-fd', str(info_w), '--block-fd', str(block_r)] + args
    start = time.monotonic()
    child = subprocess.Popen([config['binary']] + args, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={}, pass_fds=tuple([info_w, block_r] + pinned), close_fds=True)
    os.close(info_w)
    os.close(block_r)
    selector = selectors.DefaultSelector()
    for fd, label in [(info_r, 'info'), (child.stdout.fileno(), 'stdout'),
                      (child.stderr.fileno(), 'stderr'), (sys.stdin.fileno(), 'control')]:
        os.set_blocking(fd, False)
        selector.register(fd, selectors.EVENT_READ, label)
    chunks = {'stdout': [], 'stderr': []}
    info = bytearray()
    output_size = 0
    evidence = None
    initfd = None
    termination = 'aborted' if config.get('cancelled') else 'exited'
    failure = None
    stopped_at = start if config.get('cancelled') else None
    info_done = False
    killed = False
    command_released = False
    ready = bytearray()
    parsed = None
    control = bytearray()
    while True:
        now = time.monotonic()
        if termination == 'exited' and now - start >= config['timeoutMs'] / 1000:
            termination = 'timeout'
            stopped_at = now
        if termination != 'exited' and initfd is not None and (evidence is not None or failure is not None) and not killed:
            try:
                signal.pidfd_send_signal(initfd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            killed = True
        code = child.poll()
        if code is not None and info_done and not any(k.data in ('stdout', 'stderr') for k in selector.get_map().values()):
            if initfd is None or select.select([initfd], [], [], 0)[0]:
                break
            failure = 'Monitor exited before namespace init'
            if termination == 'exited':
                termination = 'aborted'
                stopped_at = now
        if stopped_at is not None and now - stopped_at > 10:
            # Never claim quiescence after an unobserved setup or stuck kernel operation.
            emit({'error': 'QUIESCENCE_UNKNOWN', 'message': 'Namespace monitor did not finish after cancellation'})
            os._exit(125)
        for key, _ in selector.select(0.025):
            data = os.read(key.fd, 65536)
            label = key.data
            if not data:
                selector.unregister(key.fd)
                if label == 'control' and termination == 'exited':
                    termination = 'aborted'
                    stopped_at = time.monotonic()
                if label == 'info':
                    info_done = True
                    try:
                        parsed = json.loads(info)
                        pid = parsed['child-pid']
                        if type(pid) is not int or pid <= 1:
                            raise RuntimeError('Invalid namespace init PID')
                        # bwrap's child is blocked before exec. A pidfd binds signalling to this
                        # process even if its numeric PID is later reused.
                        candidate_fd = os.pidfd_open(pid, 0)
                        stat = open('/proc/' + str(pid) + '/stat').read()
                        fields = stat[stat.rfind(')') + 2:].split()
                        actual_pid_ns = int(os.readlink('/proc/' + str(pid) + '/ns/pid').split('[')[1][:-1])
                        fdinfo = open('/proc/self/fdinfo/' + str(candidate_fd)).read()
                        fd_pid = next((int(line.split(':', 1)[1]) for line in fdinfo.splitlines() if line.startswith('Pid:')), -1)
                        if actual_pid_ns != parsed['pid-namespace'] or int(fields[1]) != child.pid or fd_pid != pid:
                            os.close(candidate_fd)
                            raise RuntimeError('Namespace process binding failed')
                        initfd = candidate_fd
                        # Release only the trusted bootstrap, not the command.
                        os.write(block_w, b'1')
                    except Exception as error:
                        failure = 'Namespace handshake failed: ' + str(error)
                        if termination == 'exited':
                            termination = 'aborted'
                            stopped_at = time.monotonic()
                continue
            if label == 'info':
                info.extend(data)
                if len(info) > 65536:
                    raise RuntimeError('Oversized namespace evidence')
            elif label == 'control':
                control.extend(data)
                if b'cancel\n' in control and termination == 'exited':
                    termination = 'aborted'
                    stopped_at = time.monotonic()
            else:
                if label == 'stdout' and evidence is None:
                    ready.extend(data)
                    if not READY.startswith(ready) and not ready.startswith(READY):
                        raise RuntimeError('Invalid namespace bootstrap handshake')
                    if len(ready) < len(READY):
                        continue
                    if parsed is None or initfd is None or select.select([initfd], [], [], 0)[0]:
                        raise RuntimeError('Namespace init was not bound before bootstrap')
                    # --disable-userns creates a second user namespace after info-fd
                    # is written. Read the final namespace from the bound, gated init.
                    namespaces = {}
                    for name in ('pid', 'mnt', 'net', 'ipc', 'uts', 'user', 'cgroup'):
                        namespace = int(os.readlink('/proc/' + str(pid) + '/ns/' + name).split('[')[1][:-1])
                        host_namespace = int(os.readlink('/proc/self/ns/' + name).split('[')[1][:-1])
                        if namespace == host_namespace or (name != 'user' and namespace != parsed.get(name + '-namespace')):
                            raise RuntimeError('Namespace isolation was not established: ' + name)
                        namespaces[name] = namespace
                    evidence = {'monitorPid': child.pid, 'initPid': pid,
                        'initStartTime': fields[19], 'namespaceIds': namespaces, 'pidfdBound': True}
                    if termination == 'exited':
                        child.stdin.write(b'1')
                        child.stdin.flush()
                        command_released = True
                    child.stdin.close()
                    data = bytes(ready[len(READY):])
                output_size += len(data)
                if output_size > MAX_OUTPUT:
                    failure = 'OUTPUT_LIMIT'
                    if termination == 'exited':
                        termination = 'aborted'
                        stopped_at = time.monotonic()
                elif failure != 'OUTPUT_LIMIT':
                    chunks[label].append(data)
    code = child.wait()
    # With --as-pid-1, this wait observes the namespace init exit, after the kernel
    # has killed the namespace's remaining processes. Ordinary bwrap mode differs.
    if evidence is None:
        emit({'error': 'QUIESCENCE_UNKNOWN' if code < 0 else 'PROVIDER_UNAVAILABLE', 'message': failure or 'Namespace setup failed',
              'stderr': base64.b64encode(b''.join(chunks['stderr'])).decode()})
    elif failure:
        emit({'error': 'OUTPUT_LIMIT' if failure == 'OUTPUT_LIMIT' else 'QUIESCENCE_UNKNOWN', 'message': failure,
              'quiescence': 'confirmed'})
    else:
        emit({'stdout': base64.b64encode(b''.join(chunks['stdout'])).decode(),
              'stderr': base64.b64encode(b''.join(chunks['stderr'])).decode(),
              'exitCode': code, 'termination': termination, 'quiescence': 'confirmed',
              'commandReleased': command_released, 'evidence': evidence})
    if initfd is not None:
        os.close(initfd)
    for fd in pinned + [block_w, info_r]:
        os.close(fd)

try:
    main()
except Exception as error:
    emit({'error': 'QUIESCENCE_UNKNOWN', 'message': str(error)})
    sys.exit(125)
`;
