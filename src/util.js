// 通用工具：CRC、位流读写、伪随机数、UTF-8、格式化
// 本文件不依赖任何 DOM API，可直接在 Node 中运行。

/* ---------------- CRC-32 (IEEE 802.3) ---------------- */

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- CRC-16/CCITT-FALSE ---------------- */

export function crc16(bytes, start = 0, end = bytes.length) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/* ---------------- 伪随机数 ----------------
 * 发送端与接收端必须得到完全一致的序列，所以不能用 Math.random。
 * mulberry32：32 位种子，质量足够且实现极短。 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 位流 ---------------- */

/** 按 MSB-first 往 Uint8Array 里写入定长位组。 */
export class BitWriter {
  constructor(byteLength) {
    this.bytes = new Uint8Array(byteLength);
    this.bitPos = 0;
  }
  write(value, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      if (bit) this.bytes[this.bitPos >> 3] |= 0x80 >> (this.bitPos & 7);
      this.bitPos++;
    }
  }
}

/** 按 MSB-first 从 Uint8Array 里读取定长位组。 */
export class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bitPos = 0;
  }
  read(bits) {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.bytes[this.bitPos >> 3] | 0;
      v = (v << 1) | ((byte >> (7 - (this.bitPos & 7))) & 1);
      this.bitPos++;
    }
    return v;
  }
}

/* ---------------- 字节 / 文本 ---------------- */

export function concatBytes(list) {
  let total = 0;
  for (const a of list) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of list) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(str) {
  return textEncoder.encode(str);
}
export function utf8Decode(bytes) {
  return textDecoder.decode(bytes);
}

export function writeU16(buf, off, v) {
  buf[off] = (v >>> 8) & 0xff;
  buf[off + 1] = v & 0xff;
}
export function readU16(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}
export function writeU24(buf, off, v) {
  buf[off] = (v >>> 16) & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = v & 0xff;
}
export function readU24(buf, off) {
  return (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
}
export function writeU32(buf, off, v) {
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}
export function readU32(buf, off) {
  return (
    ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
  );
}

/* ---------------- 展示用格式化 ---------------- */

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '--';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}
