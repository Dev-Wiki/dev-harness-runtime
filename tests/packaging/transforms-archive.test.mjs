import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { applySkillTransform } from "../../build/dist/transforms/index.js";
import { createTarGzip, createZip } from "../../build/dist/manifests/archive.js";

const exec = promisify(execFile);
const timestamp = "2026-09-17T05:06:07.890Z";
const bytes = (value) => Buffer.from(value);
const sample = new Map([
  ["z.txt", bytes("last\n")],
  ["nested/é.txt", bytes("UTF-8 contents 中文\n")],
  ["nested/😀.txt", bytes("surrogate pair")],
  ["empty", bytes("")],
  ["A.txt", Uint8Array.from([0, 255, 1, 2])],
]);

// Independent standard-library readers inspect bytes in memory: never extract
// archive paths or execute archive content. zipfile.read also verifies CRC32.
async function readArchive(kind, archive) {
  const python = `
import base64, io, json, sys, tarfile, zipfile
data = io.BytesIO(base64.b64decode(sys.argv[2]))
result = []
if sys.argv[1] == 'tar':
    with tarfile.open(fileobj=data, mode='r:gz') as archive:
        for entry in archive:
            result.append(dict(name=entry.name, mode=entry.mode, uid=entry.uid, gid=entry.gid,
                uname=entry.uname, gname=entry.gname, timestamp=entry.mtime, regular=entry.isfile(),
                content=base64.b64encode(archive.extractfile(entry).read()).decode()))
else:
    with zipfile.ZipFile(data) as archive:
        for entry in archive.infolist():
            result.append(dict(name=entry.filename, mode=entry.external_attr >> 16,
                timestamp=entry.date_time, method=entry.compress_type, flags=entry.flag_bits,
                extra=entry.extra.hex(), comment=entry.comment.hex(), system=entry.create_system,
                content=base64.b64encode(archive.read(entry)).decode()))
print(json.dumps(result))
`;
  const { stdout } = await exec("python3", ["-I", "-S", "-c", python, kind, Buffer.from(archive).toString("base64")]);
  return JSON.parse(stdout);
}

test("skill transforms only explicit tokens and normalizes CRLF", () => {
  const source = "DHR_PATH docs/old invoke old\r\n{{DHR_PATH}} {{DHR_COMMAND}} {{DHR_INVOKE}} {{OTHER}}\r\n{{DHR_PATH}}";
  assert.equal(applySkillTransform(source, {
    DHR_PATH: "skills/runtime/SKILL.md", DHR_COMMAND: "pnpm dhr --help", DHR_INVOKE: "$dhr",
  }), "DHR_PATH docs/old invoke old\nskills/runtime/SKILL.md pnpm dhr --help $dhr {{OTHER}}\nskills/runtime/SKILL.md");
  assert.equal(applySkillTransform("plain\r\nprose", {}), "plain\nprose");
  assert.equal(applySkillTransform("a{{DHR_PATH}}b", { DHR_PATH: "" }), "ab");
  assert.equal(applySkillTransform("{{DHR_COMMAND}}", { DHR_COMMAND: "$& $' $`" }), "$& $' $`");
});

test("skill transforms refuse unknown keys and missing or recursively introduced known tokens", () => {
  for (const replacement of [{ UNKNOWN: "x" }, { "{{DHR_PATH}}": "x" }, { [Symbol("DHR_PATH")]: "x" }]) {
    assert.throws(() => applySkillTransform("plain", replacement), /Unknown skill replacement key/);
  }
  assert.throws(() => applySkillTransform("{{DHR_PATH}}", {}), /Unresolved/);
  assert.throws(() => applySkillTransform("{{DHR_PATH}}", Object.create({ DHR_PATH: "inherited" })), /Unresolved/);
  assert.throws(() => applySkillTransform("{{DHR_PATH}}", { DHR_PATH: "{{DHR_COMMAND}}", DHR_COMMAND: "cmd" }), /Unresolved/);
});

test("skill replacement values are bounded single-line text without absolute local paths", () => {
  for (const value of ["a\nb", "a\rb", "a\0b", "a\u2028b", "\ud800", "x".repeat(4097), "é".repeat(2049)]) {
    assert.throws(() => applySkillTransform("{{DHR_PATH}}", { DHR_PATH: value }), /bounded single-line/);
  }
  for (const value of ["/home/user/repo", "C:\\repo", "C:/repo", "\\repo", "\\\\host\\share", "~/repo", "file:///home/user", "node /home/user/run.js", "cmd --file='/tmp/out'"]) {
    assert.throws(() => applySkillTransform("{{DHR_PATH}}", { DHR_PATH: value }), /absolute local path/);
  }
  assert.equal(applySkillTransform("{{DHR_PATH}}", { DHR_PATH: "x".repeat(4096) }).length, 4096);
  assert.equal(applySkillTransform("{{DHR_PATH}}", { DHR_PATH: "😀".repeat(1024) }), "😀".repeat(1024));
});

test("USTAR gzip is ordered, deterministic, and independently readable with fixed metadata", async () => {
  const archive = createTarGzip(sample, timestamp);
  assert.deepEqual(archive, createTarGzip(new Map([...sample].reverse()), timestamp));
  assert.deepEqual([...archive.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(archive[9], 255);
  const parsed = await readArchive("tar", archive);
  assert.deepEqual(parsed.map((entry) => entry.name), ["A.txt", "empty", "nested/é.txt", "nested/😀.txt", "z.txt"]);
  for (const entry of parsed) {
    assert.equal(entry.mode, 0o644);
    assert.equal(entry.uid, 0);
    assert.equal(entry.gid, 0);
    assert.equal(entry.uname, "");
    assert.equal(entry.gname, "");
    assert.equal(entry.regular, true);
    assert.equal(entry.timestamp, Math.floor(Date.parse(timestamp) / 1000));
    assert.deepEqual(Buffer.from(entry.content, "base64"), Buffer.from(sample.get(entry.name)));
  }
  const raw = gunzipSync(archive);
  assert.equal(raw.length % 512, 0);
  assert.ok(raw.subarray(-1024).every((byte) => byte === 0));
});

test("ZIP is ordered, deterministic, store-only, with UTC two-second DOS timestamps and valid CRC", async () => {
  const archive = createZip(sample, timestamp);
  assert.deepEqual(archive, createZip(new Map([...sample].reverse()), timestamp));
  const parsed = await readArchive("zip", archive);
  assert.deepEqual(parsed.map((entry) => entry.name), ["A.txt", "empty", "nested/é.txt", "nested/😀.txt", "z.txt"]);
  for (const entry of parsed) {
    assert.equal(entry.mode, 0o100644);
    assert.equal(entry.method, 0);
    assert.equal(entry.flags, 0x800);
    assert.equal(entry.system, 3);
    assert.equal(entry.extra, "");
    assert.equal(entry.comment, "");
    assert.deepEqual(entry.timestamp, [2026, 9, 17, 5, 6, 6]);
    assert.deepEqual(Buffer.from(entry.content, "base64"), Buffer.from(sample.get(entry.name)));
  }
});

test("archives reject empty, noncanonical, colliding, and non-byte entries", () => {
  for (const create of [createTarGzip, createZip]) {
    assert.throws(() => create(new Map(), timestamp), /at least one/);
    for (const path of ["", "/root", "../x", "a/../b", "./x", "a//b", "a/", "a\\b", "C:/x", "a\0b", "a\nb", "a.", "a ", "\ud800", "e\u0301.txt"]) {
      assert.throws(() => create(new Map([[path, bytes("x")]]), timestamp), /canonical portable relative path/);
    }
    assert.throws(() => create(new Map([["A", bytes("")], ["a", bytes("")]]), timestamp), /unique ignoring case/);
    assert.throws(() => create(new Map([["a", bytes("")], ["A/b", bytes("")]]), timestamp), /parent directory/);
    assert.throws(() => create(new Map([["file", "text"]]), timestamp), /content must be bytes/);
  }
});

test("USTAR path limits count UTF-8 bytes and never truncate names", async () => {
  const path = `${"p".repeat(155)}/${"n".repeat(100)}`;
  const parsed = await readArchive("tar", createTarGzip(new Map([[path, bytes("contents")]]), timestamp));
  assert.equal(parsed[0].name, path);
  for (const invalid of ["n".repeat(101), "é".repeat(51), `${"p".repeat(156)}/${"n".repeat(100)}`]) {
    assert.throws(() => createTarGzip(new Map([[invalid, bytes("")]]), timestamp), /USTAR name\/prefix limits/);
  }
});

test("timestamps are explicit valid UTC, tar rejects negative time, ZIP refuses out-of-range years", () => {
  for (const create of [createTarGzip, createZip]) {
    for (const invalid of ["invalid", "2026-09-17", "2026-09-17T05:06:07+00:00", "2026-02-30T00:00:00Z", "2026-09-17T25:06:07Z", "2026-09-17T05:06:07.0001Z"]) {
      assert.throws(() => create(sample, invalid), /timestamp/);
    }
    assert.deepEqual(create(sample, "2026-09-17T05:06:07Z"), create(sample, "2026-09-17T05:06:07.000Z"));
  }
  assert.throws(() => createTarGzip(sample, "1969-12-31T23:59:59Z"), /numeric field overflow/);
  assert.throws(() => createTarGzip(sample, "9999-12-31T23:59:59Z"), /numeric field overflow/);
  for (const invalid of ["1979-12-31T23:59:59Z", "2108-01-01T00:00:00Z"]) {
    assert.throws(() => createZip(sample, invalid), /DOS year limits/);
  }
});

test("classic ZIP rejects name and entry-count overflow instead of truncation", () => {
  assert.throws(() => createZip(new Map([["x".repeat(65536), bytes("")]]), timestamp), /ZIP entry limit/);
  const excessive = new Map(Array.from({ length: 65535 }, (_, index) => [`file-${index}`, bytes("")]));
  assert.throws(() => createZip(excessive, timestamp), /ZIP file count limit/);
});
