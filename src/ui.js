// 浏览器端共用的小工具：画码图、日志、参数持久化。

import { rasterize } from './raster.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const QUIET_CELLS = 3; // 静默区宽度（格），定位图案需要它才能被识别出来

/**
 * 造一个把 n×n RGB 矩阵画到 canvas 的函数。
 * 先在 1 像素/格的小画布上放好，再用最近邻放大——这样每个格子边界绝对锐利，
 * 交给 GPU 缩放也比在 JS 里逐像素填充快得多。
 */
export function makeFramePainter(canvas, n) {
  const cells = n + QUIET_CELLS * 2;
  const off = document.createElement('canvas');
  off.width = cells;
  off.height = cells;
  const octx = off.getContext('2d', { willReadFrequently: false });
  const img = octx.createImageData(cells, cells);
  const ctx = canvas.getContext('2d');

  return function paint(rgb) {
    img.data.set(rasterize(rgb, n, 1, QUIET_CELLS).data);
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  };
}

/**
 * 按可用空间算出「整数像素/格」的画布尺寸。
 * 格子宽度必须是整数设备像素，否则缩放会产生摩尔纹，识别率会明显下降。
 */
export function fitCanvas(canvas, n, availCssPx) {
  const dpr = window.devicePixelRatio || 1;
  const cells = n + QUIET_CELLS * 2;
  const cellPx = Math.max(2, Math.floor((availCssPx * dpr) / cells));
  const sizeDev = cellPx * cells;
  canvas.width = sizeDev;
  canvas.height = sizeDev;
  canvas.style.width = `${sizeDev / dpr}px`;
  canvas.style.height = `${sizeDev / dpr}px`;
  return { cellPx, sizeDev, sizeCss: sizeDev / dpr };
}

/* ---------------- 日志 ---------------- */

export function makeLogger(el, limit = 200) {
  return function log(msg, cls = '') {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    d.textContent = `${hh}:${mm}:${ss}  ${msg}`;
    el.appendChild(d);
    while (el.childElementCount > limit) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  };
}

/* ---------------- 参数持久化 ---------------- */

export function persist(key, controls) {
  const storageKey = `flicker:${key}`;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    for (const [id, el] of Object.entries(controls)) {
      if (saved[id] === undefined) continue;
      if (el.type === 'checkbox') el.checked = saved[id];
      else el.value = saved[id];
    }
  } catch {
    /* 存储不可用就算了，用默认值 */
  }
  const save = () => {
    const data = {};
    for (const [id, el] of Object.entries(controls)) {
      data[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {
      /* 忽略 */
    }
  };
  for (const el of Object.values(controls)) el.addEventListener('change', save);
  return save;
}

/* ---------------- 下载 ---------------- */

export function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'received.bin';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
