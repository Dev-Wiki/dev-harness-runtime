"""R1 fixture subset checks, not a production schema validator or plugin loader."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'


def read(path):
    return json.loads(path.read_text())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def name(value):
    require(isinstance(value, str) and 1 <= len(value) <= 64, 'name length/type')
    require(re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', value), 'name syntax')
    require('--' not in value and '..' not in value, 'name repetition')


def portable_minimal(value):
    # Deliberately validates only this two-field fixture profile.
    require(isinstance(value, dict) and set(value) == {'$schema', 'name'}, 'minimal fields')
    require(value['$schema'] == SCHEMA, 'schema version')
    name(value['name'])


def contained_file(root, relative):
    require(isinstance(relative, str) and relative.startswith('./'), 'relative path')
    target = (root / relative).resolve()
    require(target.is_relative_to(root.resolve()), 'path escape')
    require(target.is_file(), 'missing file')
    return target


def skill(path):
    # The fixture uses a flat YAML subset; this is not a general YAML parser.
    text = path.read_text()
    require(text.startswith('---\n') and '\n---\n' in text[4:], 'frontmatter')
    fields = dict(line.split(': ', 1) for line in text.split('---\n')[1].splitlines())
    require(re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', fields.get('name', '')), 'skill name')
    require(fields['name'] == path.parent.name and len(fields['name']) <= 64, 'directory name')
    require(1 <= len(fields.get('description', '')) <= 1024, 'description')


class FixtureChecks(unittest.TestCase):
    def test_portable_profiles(self):
        for profile in ('portable', 'antigravity', 'codex-portable'):
            with self.subTest(profile=profile):
                portable_minimal(read(ROOT / profile / 'plugin.json'))
        mcp = read(ROOT / 'portable/mcp.json')
        self.assertEqual(mcp, {'$schema': SCHEMA.replace('plugin.schema', 'mcp.schema'), 'mcpServers': {}})

    def test_cursor_native(self):
        manifest = read(ROOT / 'cursor/.cursor-plugin/plugin.json')
        self.assertEqual(set(manifest), {'name'})
        name(manifest['name'])

    def test_codex_compat_marketplace(self):
        root = ROOT / 'codex-compat'
        catalog = read(root / '.agents/plugins/marketplace.json')
        entry, = catalog['plugins']
        manifest_path = contained_file(root, entry['source']['path'] + '/.codex-plugin/plugin.json')
        manifest = read(manifest_path)
        self.assertEqual(entry['name'], manifest['name'])
        self.assertEqual(entry['policy'], {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'})
        self.assertEqual(manifest['skills'], './skills')
        self.assertTrue(re.fullmatch(r'\d+\.\d+\.\d+', manifest['version']))
        for field in ('name', 'version', 'description', 'author', 'interface'):
            self.assertTrue(manifest[field])

    def test_dsh_bundle(self):
        root = ROOT / 'dsh'
        manifest = read(root / 'package.json')
        patch = contained_file(root, manifest['dsh']['bundle']['patch'])
        # Exact fixture shape; full Cordis patch parsing belongs to K6-P.
        self.assertEqual(patch.read_text(), '- insert:\n    - id: dev-harness-runtime-spec\n      name: ' + manifest['name'] + '\n')
        contained_file(root, manifest['exports']['.'])
        self.assertEqual(manifest['type'], 'module')

    def test_opencode_npm_config(self):
        root = ROOT / 'opencode-npm'
        package = read(root / 'package/package.json')
        config = read(root / 'consumer/opencode.json')
        self.assertEqual(config['plugin'], [package['name']])
        self.assertTrue(package['private'])
        contained_file(root / 'package', './' + package['main'])

    def test_module_shape_without_host(self):
        # Only our dependency-free no-op fixtures run, with no user config.
        for relative, export in [('opencode-local/.opencode/plugins/runtime-spec.js', 'RuntimeSpec'),
                                 ('opencode-npm/package/index.mjs', 'RuntimeSpec'),
                                 ('dsh/lib/index.js', 'apply')]:
            source = (ROOT / relative).read_text()
            script = source + '\nif (typeof ' + export + ' !== "function") throw Error("export");\n'
            if export == 'RuntimeSpec':
                script += 'if (Object.keys(await RuntimeSpec({})).length) throw Error("hooks");\n'
            subprocess.run(['node', '--input-type=module', '-'], input=script, text=True, check=True, capture_output=True)

    def test_skill_files(self):
        paths = list(ROOT.rglob('SKILL.md'))
        self.assertEqual(len(paths), 6)
        for path in paths:
            skill(path)

    def test_negative_manifest_cases(self):
        valid = read(ROOT / 'portable/plugin.json')
        invalid = [{}, {**valid, '$schema': 'unknown'}, {**valid, 'unexpected': True}]
        invalid += [{**valid, 'name': item} for item in ['', 'a..b', 'a--b', '-bad', 'x' * 65, 4]]
        for item in invalid:
            with self.subTest(item=item), self.assertRaises(ValueError):
                portable_minimal(item)
        for item in ['a', 'x' * 64]:
            portable_minimal({**valid, 'name': item})

    def test_negative_paths_and_skill(self):
        with tempfile.TemporaryDirectory() as directory:
            outer = Path(directory)
            root = outer / 'root'
            root.mkdir()
            (outer / 'outside').write_text('external')
            (root / 'escape').symlink_to(outer / 'outside')
            for path in ['../outside', './missing', './escape', './..' + '/outside', '/absolute']:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    contained_file(root, path)
            child = root / 'runtime-check'
            child.mkdir()
            target = child / 'SKILL.md'
            target.write_text('---\nname: mismatch\ndescription: test\n---\n')
            with self.assertRaises(ValueError):
                skill(target)

    def test_pinned_fixture_bytes(self):
        expected = read(ROOT / 'fixture-hashes.json')
        actual = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in ROOT.rglob('*') if p.is_file()
                  and p.name not in ('check.py', 'README.md', 'fixture-hashes.json')
                  and '__pycache__' not in p.parts}
        self.assertEqual(expected, actual)


if __name__ == '__main__':
    unittest.main(verbosity=2)
