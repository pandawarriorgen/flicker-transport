// 传输协议：文件 ↔ 帧序列。无 DOM 依赖。
//
// 三层嵌套：
//   ① 数据流  [FLK1 魔数 | 长度 | 整体CRC32 | 文件名 | 文件内容]
//   ② 喷泉码  数据流切成 K 个 blockSize 大小的块，每帧发一个随机异或组合
//   ③ 帧      [16字节帧头 + RS16] + [CRC32 + 块] 经 RS 分块交织后画成码图
//
// 接收端只要攒够约 1.05K 个不重复的帧就能还原，与收到的顺序无关。

import {
  concatBytes,
  crc16,
  crc32,
  readU16,
  readU24,
  readU32,
  utf8Decode,
  utf8Encode,
  writeU16,
  writeU24,
  writeU32,
} from './util.js';
import {
  HEADER_DATA_BYTES,
  HEADER_NSYM,
  PALETTE_BY_ID,
  frameCapacityBytes,
  paintFrame,
  paletteByName,
} from './format.js';
import { maxPayloadFor, rsDecodeInterleaved, rsEncode, rsEncodeInterleaved, rsDecode } from './rs.js';
import { LtDecoder, LtEncoder } from './fountain.js';

export const PROTOCOL_VERSION = 1;
const STREAM_MAGIC = [0x46, 0x4c, 0x4b, 0x31]; // "FLK1"
const STREAM_HEADER_FIXED = 16;
const BLOCK_CRC_BYTES = 4;

/* ---------------- ① 数据流 ---------------- */

export function makeStream(fileName, body) {
  const name = utf8Encode(fileName || '');
  if (name.length > 65535) throw new Error('文件名过长');
  const head = new Uint8Array(STREAM_HEADER_FIXED + name.length);
  head.set(STREAM_MAGIC, 0);
  head[4] = PROTOCOL_VERSION;
  head[5] = 0;
  writeU32(head, 6, body.length);
  writeU32(head, 10, crc32(body));
  writeU16(head, 14, name.length);
  head.set(name, STREAM_HEADER_FIXED);
  return concatBytes([head, body]);
}

export function parseStream(bytes) {
  if (bytes.length < STREAM_HEADER_FIXED) return { ok: false, error: '数据流过短' };
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== STREAM_MAGIC[i]) return { ok: false, error: '魔数不匹配' };
  }
  if (bytes[4] !== PROTOCOL_VERSION) return { ok: false, error: `协议版本不支持: ${bytes[4]}` };
  const bodyLen = readU32(bytes, 6);
  const bodyCrc = readU32(bytes, 10);
  const nameLen = readU16(bytes, 14);
  const bodyStart = STREAM_HEADER_FIXED + nameLen;
  if (bodyStart + bodyLen > bytes.length) return { ok: false, error: '数据流被截断' };
  const name = utf8Decode(bytes.subarray(STREAM_HEADER_FIXED, bodyStart));
  const body = bytes.slice(bodyStart, bodyStart + bodyLen);
  if (crc32(body) !== bodyCrc) return { ok: false, error: '整体 CRC32 校验失败' };
  return { ok: true, name, body };
}

/* ---------------- ③ 帧头 ---------------- */

export function packHeader({ paletteId, fileId, K, blockSize, seed, nsym }) {
  const h = new Uint8Array(HEADER_DATA_BYTES);
  h[0] = PROTOCOL_VERSION;
  h[1] = paletteId & 0x07;
  writeU16(h, 2, fileId);
  writeU24(h, 4, K);
  writeU16(h, 7, blockSize);
  writeU32(h, 9, seed);
  h[13] = nsym;
  writeU16(h, 14, crc16(h, 0, 14));
  return h;
}

export function unpackHeader(h) {
  if (h.length < HEADER_DATA_BYTES) return null;
  if (crc16(h, 0, 14) !== readU16(h, 14)) return null;
  if (h[0] !== PROTOCOL_VERSION) return null;
  const paletteId = h[1] & 0x07;
  if (!PALETTE_BY_ID[paletteId]) return null;
  const K = readU24(h, 4);
  const blockSize = readU16(h, 7);
  if (K < 1 || blockSize < 1) return null;
  return {
    paletteId,
    palette: PALETTE_BY_ID[paletteId].name,
    fileId: readU16(h, 2),
    K,
    blockSize,
    seed: readU32(h, 9),
    nsym: h[13],
  };
}

/* ---------------- 参数推导 ---------------- */

/**
 * 由「版面尺寸 / 调色板 / 纠错强度」推出每帧能装多少净数据。
 * @param {number} nsym 每个 255 字节 RS 码字里的校验字节数（0~64）
 */
export function frameGeometry(n, paletteName, nsym) {
  const capacity = frameCapacityBytes(n, paletteName);
  const payloadLen = maxPayloadFor(capacity, nsym);
  const blockSize = payloadLen - BLOCK_CRC_BYTES;
  if (blockSize < 16) throw new Error('参数组合下每帧可用数据太少，请调大版面或降低纠错强度');
  return { capacity, payloadLen, blockSize };
}

/* ---------------- 发送端 ---------------- */

export class Transmitter {
  /**
   * @param {Uint8Array} body 文件内容
   * @param {string} fileName
   * @param {{gridSize:number, palette:string, nsym:number, fileId?:number}} opts
   */
  constructor(body, fileName, opts) {
    const { gridSize, palette, nsym } = opts;
    this.gridSize = gridSize;
    this.palette = palette;
    this.nsym = nsym;
    this.paletteId = paletteByName(palette).id;
    this.fileId = opts.fileId ?? (Math.floor(Math.random() * 65536) & 0xffff);

    this.stream = makeStream(fileName, body);
    const geo = frameGeometry(gridSize, palette, nsym);
    this.capacity = geo.capacity;
    this.payloadLen = geo.payloadLen;
    this.blockSize = geo.blockSize;

    this.encoder = new LtEncoder(this.stream, this.blockSize);
    this.K = this.encoder.K;
    this.fileName = fileName;
    this.bodyLength = body.length;
  }

  /** 生成第 seed 帧的 RGB 矩阵（长度 n*n*3）。 */
  frame(seed) {
    const block = this.encoder.make(seed >>> 0);
    const payload = new Uint8Array(this.payloadLen);
    writeU32(payload, 0, crc32(block));
    payload.set(block, BLOCK_CRC_BYTES);

    const header = packHeader({
      paletteId: this.paletteId,
      fileId: this.fileId,
      K: this.K,
      blockSize: this.blockSize,
      seed: seed >>> 0,
      nsym: this.nsym,
    });
    const headerCw = rsEncode(header, HEADER_NSYM);
    const encodedPayload = rsEncodeInterleaved(payload, this.nsym);
    return paintFrame(this.gridSize, this.palette, headerCw, encodedPayload);
  }

  /** 一轮（K 帧）能覆盖全部源块；实际通常要多发 5%~30%。 */
  get roundFrames() {
    return this.K;
  }
}

/* ---------------- 接收端 ---------------- */

/**
 * 收帧、去重、喷泉解码、还原文件。
 * 检测到 fileId 变化会自动重置，方便连续接收多个文件。
 */
export class Receiver {
  constructor() {
    this.reset();
  }

  reset() {
    this.fileId = null;
    this.K = 0;
    this.blockSize = 0;
    this.lt = null;
    this.framesAccepted = 0;
    this.framesDuplicate = 0;
    this.framesRedundant = 0;
    this.result = null;
    this.error = null;
    this.startedAt = 0;
  }

  get active() {
    return this.lt !== null;
  }
  get progress() {
    return this.lt ? this.lt.progress : 0;
  }
  get done() {
    return this.result !== null;
  }

  /**
   * 送入一个已通过 RS + CRC 校验的帧。
   * @param {object} header unpackHeader 的结果
   * @param {Uint8Array} block 长度 blockSize 的编码块
   * @returns {'accepted'|'duplicate'|'redundant'|'complete'|'restart'}
   */
  push(header, block) {
    let status = '';
    if (
      this.fileId !== header.fileId ||
      this.K !== header.K ||
      this.blockSize !== header.blockSize
    ) {
      this.reset();
      this.fileId = header.fileId;
      this.K = header.K;
      this.blockSize = header.blockSize;
      this.lt = new LtDecoder(header.K, header.blockSize);
      this.startedAt = Date.now();
      status = 'restart';
    }
    if (this.result) return 'redundant';

    const r = this.lt.add(header.seed, block);
    if (r === 'accepted') this.framesAccepted++;
    else if (r === 'duplicate') this.framesDuplicate++;
    else this.framesRedundant++;

    if (this.lt.done) {
      const assembled = this.lt.assemble();
      const parsed = parseStream(assembled);
      if (parsed.ok) {
        this.result = { name: parsed.name, body: parsed.body };
        return 'complete';
      }
      // 理论上不该发生：每块都过了 CRC32，整体还错说明有极小概率的碰撞
      this.error = parsed.error;
    }
    return status || r;
  }
}

/* ---------------- 帧字节 → 结构化数据 ---------------- */

/**
 * 帧头已解出来后，把数据区字节还原成一个喷泉码块。
 * @returns {{ok:boolean, block?:Uint8Array, reason?:string, rsErrors?:number}}
 */
export function decodePayload(header, payloadEncoded) {
  const payloadLen = header.blockSize + BLOCK_CRC_BYTES;
  const pr = rsDecodeInterleaved(payloadEncoded, payloadLen, header.nsym);
  if (!pr.ok) return { ok: false, reason: 'payload-rs' };

  const block = pr.data.subarray(BLOCK_CRC_BYTES);
  if (crc32(block) !== readU32(pr.data, 0)) return { ok: false, reason: 'payload-crc' };

  return { ok: true, block, rsErrors: pr.errors };
}

/**
 * 把「帧头码字 + 数据区字节」整体解成一帧（自测用；实际收帧走 decodePayload）。
 * @returns {{ok:boolean, header?:object, block?:Uint8Array, reason?:string}}
 */
export function decodeFrameBytes(headerCodeword, payloadEncoded) {
  const hr = rsDecode(headerCodeword, HEADER_NSYM);
  if (!hr.ok) return { ok: false, reason: 'header-rs' };
  const header = unpackHeader(hr.data);
  if (!header) return { ok: false, reason: 'header-crc' };

  const pr = decodePayload(header, payloadEncoded);
  if (!pr.ok) return { ok: false, reason: pr.reason, header };
  return { ok: true, header, block: pr.block, rsErrors: hr.errors + pr.rsErrors };
}
