// 识别放在 Worker 里跑，主线程只管画面和界面，摄像头预览不会被解码拖卡。
// 主线程若检测不到 module worker 支持，会退回主线程解码（见 recv.html）。

import { readCode } from './detect.js';
import { decodePayload } from './protocol.js';

/** 一次完整识别：图像 → 帧头 → 喷泉码块。 */
export function decodeImage(data, width, height, gridHint) {
  const t0 = performance.now();
  const res = readCode(data, width, height, { gridHint });
  if (!res.ok) {
    return { ok: false, reason: res.reason, quad: res.quad ?? null, ms: performance.now() - t0 };
  }
  const p = decodePayload(res.header, res.payload);
  if (!p.ok) {
    return {
      ok: false,
      reason: p.reason,
      quad: res.quad,
      gridSize: res.gridSize,
      ms: performance.now() - t0,
    };
  }
  return {
    ok: true,
    quad: res.quad,
    gridSize: res.gridSize,
    rotation: res.rotation,
    header: res.header,
    block: p.block,
    rsErrors: p.rsErrors,
    ms: performance.now() - t0,
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !self.document) {
  self.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'ping') {
      self.postMessage({ type: 'pong' });
      return;
    }
    if (msg.type !== 'frame') return;
    const out = decodeImage(msg.data, msg.width, msg.height, msg.gridHint | 0);
    out.type = 'result';
    out.seq = msg.seq;
    // block 是 Uint8Array，直接连缓冲区一起转移回去，避免拷贝
    const transfer = out.block ? [out.block.buffer] : [];
    self.postMessage(out, transfer);
  };
}
