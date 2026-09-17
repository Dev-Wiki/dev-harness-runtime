import { readFile } from 'node:fs/promises';

/** Linux boot identity plus /proc start ticks distinguishes PID reuse across boots. */
export async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closing = stat.lastIndexOf(')');
    if (closing < 0 || !/^[a-f0-9-]{36}$/u.test(boot)) return undefined;
    const fields = stat.slice(closing + 2).trim().split(/\s+/u);
    // Fields after comm start with state (field 3); starttime is field 22.
    const start = fields[19];
    if (!start || !/^\d+$/u.test(start) || ['Z', 'X', 'x'].includes(fields[0] ?? '')) return undefined;
    return `linux:${boot}:${pid}:${start}`;
  } catch { return undefined; }
}
