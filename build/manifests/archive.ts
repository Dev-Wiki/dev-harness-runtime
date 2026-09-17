import { constants as bufferConstants } from "node:buffer";
import { gzipSync } from "node:zlib";

const ZIP_MAX = 0xffffffff;
type Entry = { path: string; name: Buffer; bytes: Buffer };

function hasUnpairedSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

function entries(files: ReadonlyMap<string, Uint8Array>): Entry[] {
  const result: Entry[] = [];
  const paths = new Set<string>();
  for (const [path, content] of files) {
    if (typeof path !== "string" || hasUnpairedSurrogate(path) || path.normalize("NFC") !== path
      // eslint-disable-next-line no-control-regex -- Archive names must not contain control bytes.
      || path.length === 0 || /[\\:\u0000-\u001f\u007f-\u009f]/u.test(path)
      || path.split("/").some((part) => part === "" || part === "." || part === ".." || /[. ]$/.test(part))) {
      throw new Error("Archive path must be a canonical portable relative path");
    }
    const folded = path.toLowerCase();
    if (paths.has(folded)) throw new Error("Archive paths must be unique ignoring case");
    paths.add(folded);
    if (!(content instanceof Uint8Array)) throw new TypeError("Archive content must be bytes");
    result.push({ path, name: Buffer.from(path, "utf8"), bytes: Buffer.from(content) });
  }
  if (result.length === 0) throw new Error("Archive must contain at least one file");
  for (const path of paths) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count += 1) {
      if (paths.has(parts.slice(0, count).join("/"))) throw new Error("Archive file conflicts with a parent directory");
    }
  }
  return result.sort((a, b) => Buffer.compare(a.name, b.name));
}

function sourceTime(timestamp: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)) {
    throw new Error("Archive timestamp must be an explicit UTC ISO timestamp");
  }
  const date = new Date(timestamp);
  const normalized = timestamp.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) throw new Error("Invalid archive timestamp");
  return date;
}

function boundedLength(length: number): void {
  if (!Number.isSafeInteger(length) || length > bufferConstants.MAX_LENGTH) throw new Error("Archive exceeds buffer size limit");
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || encoded.length >= length) throw new Error("USTAR numeric field overflow");
  header.write(`${encoded.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarName(path: string): { name: Buffer; prefix: Buffer } {
  const name = Buffer.from(path, "utf8");
  if (name.length <= 100) return { name, prefix: Buffer.alloc(0) };
  for (let split = path.lastIndexOf("/"); split > 0; split = path.lastIndexOf("/", split - 1)) {
    const prefix = Buffer.from(path.slice(0, split), "utf8");
    const suffix = Buffer.from(path.slice(split + 1), "utf8");
    if (prefix.length <= 155 && suffix.length <= 100) return { name: suffix, prefix };
  }
  throw new Error("Archive path exceeds USTAR name/prefix limits");
}

/**
 * Builds a deterministic USTAR gzip from in-memory regular files only. Paths
 * must be NFC, portable relative POSIX paths, case-insensitively unique, with
 * no file/directory collision. USTAR name <=100 and prefix <=155 UTF-8 bytes;
 * extensions are never generated. Mode is 0644, uid/gid 0, names empty. UTC ISO
 * source time is floored to seconds (1970 onward, 11 octal digits maximum).
 * Gzip mtime is always 0 and OS is 255. Empty archives/overflow are rejected.
 */
export function createTarGzip(files: ReadonlyMap<string, Uint8Array>, timestamp: string): Uint8Array {
  const records = entries(files);
  const seconds = Math.floor(sourceTime(timestamp).getTime() / 1000);
  const chunks: Buffer[] = [];
  let length = 1024;
  for (const record of records) {
    const names = tarName(record.path);
    const header = Buffer.alloc(512);
    names.name.copy(header, 0);
    octal(header, 100, 8, 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, record.bytes.length);
    octal(header, 136, 12, seconds);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    names.prefix.copy(header, 345);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const padding = Buffer.alloc((512 - record.bytes.length % 512) % 512);
    length += header.length + record.bytes.length + padding.length;
    boundedLength(length);
    chunks.push(header, record.bytes, padding);
  }
  chunks.push(Buffer.alloc(1024));
  const gzip = gzipSync(Buffer.concat(chunks, length), { level: 9 });
  gzip.fill(0, 4, 8);
  gzip[9] = 255;
  return gzip;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds deterministic classic ZIP (store method, UTF-8 names, Unix regular
 * mode 0644). Uses the same canonical path rules as createTarGzip. No extras,
 * comments, directories or ZIP64: at most 65534 files, name <=65535 UTF-8 bytes,
 * sizes/offsets/total length < 0xffffffff and within Node's buffer limit.
 * UTC ISO source time must be in 1980..2107; DOS seconds round DOWN to the
 * nearest two seconds and discard fractions. DOS fields represent UTC, not
 * the machine's local timezone. ZIP has no uid/gid field; none is emitted.
 */
export function createZip(files: ReadonlyMap<string, Uint8Array>, timestamp: string): Uint8Array {
  const records = entries(files);
  if (records.length >= 0xffff) throw new Error("Archive exceeds classic ZIP file count limit");
  const date = sourceTime(timestamp);
  const year = date.getUTCFullYear();
  if (year < 1980 || year > 2107) throw new Error("Archive timestamp exceeds ZIP DOS year limits");
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  let total = 22;
  for (const record of records) {
    if (record.name.length > 0xffff || record.bytes.length >= ZIP_MAX) throw new Error("Archive exceeds classic ZIP entry limit");
    total += 76 + record.name.length * 2 + record.bytes.length;
    if (total >= ZIP_MAX) throw new Error("Archive exceeds classic ZIP size limit");
    boundedLength(total);
  }
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let centralSize = 0;
  for (const record of records) {
    const crc = crc32(record.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(record.bytes.length, 18);
    header.writeUInt32LE(record.bytes.length, 22);
    header.writeUInt16LE(record.name.length, 26);
    local.push(header, record.name, record.bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(dosTime, 12);
    directory.writeUInt16LE(dosDate, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(record.bytes.length, 20);
    directory.writeUInt32LE(record.bytes.length, 24);
    directory.writeUInt16LE(record.name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, record.name);
    offset += header.length + record.name.length + record.bytes.length;
    centralSize += directory.length + record.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end], total);
}
