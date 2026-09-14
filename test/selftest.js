// 全流程自测：node test/selftest.js
// 不依赖浏览器，用合成的「摄像头画面」把编码→识别→解码整条链路跑通。

import { crc32, mulberry32 } from '../src/util.js';
import { rsDecode, rsDecodeInterleaved, rsEncode, rsEncodeInterleaved } from '../src/rs.js';
import { LtDecoder, LtEncoder, pickBlocks } from '../src/fountain.js';
import { frameCapacityBytes } from '../src/format.js';
import {
  Receiver,
  Transmitter,
  decodePayload,
  frameGeometry,
  makeStream,
  packHeader,
  parseStream,
  unpackHeader,
} from '../src/protocol.js';
import { rasterize } from '../src/raster.js';
import { readCode } from '../src/detect.js';
import { simulateCamera } from '../src/synth.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function randomBytes(n, seed = 1) {
  const rand = mulberry32(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rand() * 256);
  return b;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ================= 1. Reed-Solomon ================= */

section('1. Reed-Solomon 纠错');
{
  const msg = randomBytes(200, 7);
  const cw = rsEncode(msg, 32);
  check('编码长度正确', cw.length === 232);
  check('无错误时可解', bytesEqual(rsDecode(cw, 32).data, msg));

  // 32 个校验字节 → 最多纠 16 个字节错
  const rand = mulberry32(99);
  for (const nErr of [1, 8, 16]) {
    const bad = Uint8Array.from(cw);
    const used = new Set();
    for (let i = 0; i < nErr; i++) {
      let p;
      do {
        p = Math.floor(rand() * bad.length);
      } while (used.has(p));
      used.add(p);
      bad[p] ^= 0x5a;
    }
    const r = rsDecode(bad, 32);
    check(`纠正 ${nErr} 个字节错`, r.ok && bytesEqual(r.data, msg));
  }

  const tooBad = Uint8Array.from(cw);
  for (let i = 0; i < 40; i++) tooBad[i * 5] ^= 0xff;
  const r = rsDecode(tooBad, 32);
  check('错太多时明确报失败而不是给出错数据', !r.ok || bytesEqual(r.data, msg));
}

section('2. RS 分块 + 交织');
{
  const payload = randomBytes(1300, 11);
  const enc = rsEncodeInterleaved(payload, 24);
  check('交织编码可无损还原', bytesEqual(rsDecodeInterleaved(enc, 1300, 24).data, payload));

  // 一段连续污损（模拟画面上一小片反光），交织后应被摊薄到各块
  // 1300B 载荷分 6 块，nsym=32 每块可纠 16 字节，理论上能扛住约 96 字节连续污损
  const enc32 = rsEncodeInterleaved(payload, 32);
  const bad = Uint8Array.from(enc32);
  for (let i = 300; i < 380; i++) bad[i] ^= 0xa5;
  const r = rsDecodeInterleaved(bad, 1300, 32);
  check('80 字节连续污损可恢复（nsym=32）', r.ok && bytesEqual(r.data, payload));

  const bad2 = Uint8Array.from(enc32);
  for (let i = 300; i < 500; i++) bad2[i] ^= 0xa5;
  check('200 字节污损超出纠错能力时如实报错', !rsDecodeInterleaved(bad2, 1300, 32).ok);
}

/* ================= 3. 喷泉码 ================= */

section('3. LT 喷泉码');
{
  for (const K of [1, 5, 64, 500]) {
    const blockSize = 64;
    const data = randomBytes(K * blockSize, K);
    const enc = new LtEncoder(data, blockSize);
    check(`K=${K} 块数正确`, enc.K === K);

    const dec = new LtDecoder(K, blockSize);
    let sent = 0;
    for (let seed = 0; seed < K * 8 && !dec.done; seed++) {
      dec.add(seed, enc.make(seed));
      sent++;
    }
    check(`K=${K} 无丢帧可解出`, dec.done, `用了 ${sent} 帧`);
    if (dec.done) check(`K=${K} 内容一致`, bytesEqual(dec.assemble(), data));
  }

  // 随机丢 40% 的帧
  const K = 300;
  const blockSize = 100;
  const data = randomBytes(K * blockSize, 3);
  const enc = new LtEncoder(data, blockSize);
  const dec = new LtDecoder(K, blockSize);
  const rand = mulberry32(2024);
  let received = 0;
  let seed = 0;
  while (!dec.done && seed < K * 20) {
    if (rand() > 0.4) {
      dec.add(seed, enc.make(seed));
      received++;
    }
    seed++;
  }
  check('丢 40% 帧仍可解出', dec.done, `收到 ${received} 帧 / K=${K}，开销 ${(received / K).toFixed(2)}×`);
  check('丢帧后内容一致', dec.done && bytesEqual(dec.assemble(), data));

  // 从中途开始接收（模拟摄像头晚一步对准）
  const dec2 = new LtDecoder(K, blockSize);
  let s = Math.floor(K * 0.7);
  let got = 0;
  while (!dec2.done && got < K * 20) {
    dec2.add(s++, enc.make(s));
    got++;
  }
  check('中途接入也能解出', dec2.done, `开销 ${(got / K).toFixed(2)}×`);

  check('seed<K 时退化为系统码', pickBlocks(17, 100).length === 1 && pickBlocks(17, 100)[0] === 17);
}

/* ================= 4. 数据流封装 ================= */

section('4. 数据流封装');
{
  const body = randomBytes(5000, 42);
  const s = makeStream('测试文件 名.bin', body);
  const p = parseStream(s);
  check('文件名往返一致', p.ok && p.name === '测试文件 名.bin');
  check('内容往返一致', p.ok && bytesEqual(p.body, body));

  const corrupted = Uint8Array.from(s);
  corrupted[corrupted.length - 10] ^= 1;
  check('整体 CRC 能发现篡改', !parseStream(corrupted).ok);
}

section('5. 帧头');
{
  const h = packHeader({ paletteId: 2, fileId: 0xbeef, K: 123456, blockSize: 1024, seed: 0xdeadbeef, nsym: 24 });
  const u = unpackHeader(h);
  check('帧头字段往返一致',
    u && u.paletteId === 2 && u.fileId === 0xbeef && u.K === 123456 &&
    u.blockSize === 1024 && u.seed === 0xdeadbeef >>> 0 && u.nsym === 24);
  const bad = Uint8Array.from(h);
  bad[5] ^= 0x10;
  check('帧头 CRC16 能发现篡改', unpackHeader(bad) === null);
}

/* ================= 6. 单帧字节层往返 ================= */

section('6. 单帧字节层往返');
{
  for (const palette of ['bw', 'gray4', 'rgb8']) {
    const n = 65;
    const nsym = 24;
    const geo = frameGeometry(n, palette, nsym);
    const tx = new Transmitter(randomBytes(geo.blockSize * 3, 5), 'a.bin', {
      gridSize: n, palette, nsym,
    });
    const cap = frameCapacityBytes(n, palette);
    check(`${palette}: 容量 ${cap}B / 净载荷 ${geo.blockSize}B`, geo.blockSize > 0);
  }
}

/* ================= 7. 无失真的完整识别 ================= */

section('7. 渲染 → 识别（无失真）');
{
  for (const palette of ['bw', 'gray4', 'rgb8']) {
    for (const n of [41, 65, 89]) {
      const geo = frameGeometry(n, palette, 24);
      const body = randomBytes(geo.blockSize * 2, n);
      const tx = new Transmitter(body, 't.bin', { gridSize: n, palette, nsym: 24, fileId: 1 });
      const rgb = tx.frame(0);
      const raster = rasterize(rgb, n, 6, 3);
      const res = readCode(raster.data, raster.width, raster.height);
      let okBlock = false;
      if (res.ok) {
        const p = decodePayload(res.header, res.payload);
        okBlock = p.ok && bytesEqual(p.block, tx.encoder.make(0));
      }
      check(`${palette} n=${n}`, res.ok && okBlock,
        res.ok ? `识别到 n=${res.gridSize} score=${res.score.toFixed(2)}` : `失败: ${res.reason}`);
    }
  }
}

/* ================= 8. 合成摄像头画面 ================= */

section('8. 模拟摄像头（透视 + 模糊 + 噪声 + 暗角）');
{
  const scenarios = [
    { name: '理想正对', opts: { perspective: 0.01, blur: 1, noise: 4 } },
    { name: '明显斜视角', opts: { perspective: 0.10, blur: 1, noise: 5 } },
    { name: '失焦 + 噪声大', opts: { perspective: 0.04, blur: 2, noise: 14 } },
    { name: '暗角 + 偏色', opts: { perspective: 0.05, blur: 1, noise: 6, vignette: 0.55, colorGain: [1.1, 0.95, 0.8], gamma: 1.25 } },
    { name: '画面旋转 90°', opts: { perspective: 0.04, blur: 1, noise: 6, rotate90: 1 } },
    { name: '画面旋转 180°', opts: { perspective: 0.04, blur: 1, noise: 6, rotate90: 2 } },
    { name: '画面旋转 270°', opts: { perspective: 0.04, blur: 1, noise: 6, rotate90: 3 } },
    { name: '码图偏离中心', opts: { perspective: 0.05, blur: 1, noise: 6, scale: 0.6, offsetX: -160, offsetY: 60 } },
  ];

  // 每个场景测出「至少要多强的纠错才能读出来」，比固定强度的通过/失败信息量大得多
  const NSYM_LADDER = [16, 32, 48, 64];
  const n = 65;
  const table = [];

  for (const palette of ['bw', 'gray4', 'rgb8']) {
    for (const sc of scenarios) {
      let minNsym = 0;
      let note = '';
      for (const nsym of NSYM_LADDER) {
        const geo = frameGeometry(n, palette, nsym);
        const body = randomBytes(geo.blockSize * 2, 8);
        const tx = new Transmitter(body, 'cam.bin', { gridSize: n, palette, nsym, fileId: 7 });
        const raster = rasterize(tx.frame(3), n, 8, 3);
        const cam = simulateCamera(raster, { seed: 5, ...sc.opts });
        const res = readCode(cam.data, cam.width, cam.height);
        if (!res.ok) {
          note = res.reason;
          continue;
        }
        const p = decodePayload(res.header, res.payload);
        if (!p.ok || !bytesEqual(p.block, tx.encoder.make(3))) {
          note = p.reason ?? 'block-mismatch';
          continue;
        }
        minNsym = nsym;
        note = `nsym=${nsym} 即可（本帧纠了 ${p.rsErrors} 字节，净载荷 ${geo.blockSize}B）`;
        break;
      }
      table.push({ palette, scenario: sc.name, minNsym });
      check(`${palette} / ${sc.name}`, minNsym > 0, note);
    }
  }

  console.log('\n  最低纠错强度需求（nsym，越小说明信道越好）：');
  const header = ['场景'.padEnd(16), ...['bw', 'gray4', 'rgb8'].map((p) => p.padEnd(7))].join('');
  console.log('  ' + header);
  for (const sc of scenarios) {
    const cells = ['bw', 'gray4', 'rgb8'].map((p) => {
      const row = table.find((t) => t.palette === p && t.scenario === sc.name);
      return String(row.minNsym || '不可用').padEnd(7);
    });
    console.log('  ' + sc.name.padEnd(14) + cells.join(''));
  }
}

/* ================= 9. 端到端文件传输 ================= */

section('9. 端到端：一个文件从发送端走到接收端');
{
  const fileBytes = randomBytes(24 * 1024, 777);
  const fileName = '示例文件.dat';
  const n = 65;
  const palette = 'gray4';
  const tx = new Transmitter(fileBytes, fileName, { gridSize: n, palette, nsym: 32, fileId: 33 });
  console.log(`  文件 ${fileBytes.length}B → K=${tx.K} 块，每块 ${tx.blockSize}B`);

  const rx = new Receiver();
  const rand = mulberry32(4242);
  let sentFrames = 0;
  let goodFrames = 0;
  let seed = 0;
  const dropRate = 0.25;

  while (!rx.done && sentFrames < tx.K * 6) {
    const rgb = tx.frame(seed);
    seed++;
    sentFrames++;
    if (rand() < dropRate) continue; // 模拟摄像头没拍到 / 拍糊了

    const raster = rasterize(rgb, n, 8, 3);
    const cam = simulateCamera(raster, {
      seed: (seed * 7919) >>> 0,
      perspective: 0.05,
      blur: 1,
      noise: 8,
      vignette: 0.4,
    });
    const res = readCode(cam.data, cam.width, cam.height, { gridHint: n });
    if (!res.ok) continue;
    const p = decodePayload(res.header, res.payload);
    if (!p.ok) continue;
    goodFrames++;
    rx.push(res.header, p.block);
  }

  check('接收完成', rx.done, `发出 ${sentFrames} 帧，成功识别 ${goodFrames} 帧，K=${tx.K}`);
  if (rx.done) {
    check('文件名一致', rx.result.name === fileName);
    check('内容逐字节一致', bytesEqual(rx.result.body, fileBytes));
    check('CRC32 一致', crc32(rx.result.body) === crc32(fileBytes));
    console.log(`  喷泉码开销 ${(goodFrames / tx.K).toFixed(2)}×`);
  }
}

/* ================= 10. 吞吐估算 ================= */

section('10. 各档参数的理论吞吐');
{
  const rows = [];
  for (const n of [49, 65, 81, 97]) {
    for (const palette of ['bw', 'gray4', 'rgb8']) {
      const geo = frameGeometry(n, palette, 32);
      rows.push({ n, palette, block: geo.blockSize, kbps10: ((geo.blockSize * 10) / 1024).toFixed(1) });
    }
  }
  console.log('  版面  调色板   每帧净载荷   10fps 速率');
  for (const r of rows) {
    console.log(
      `  ${String(r.n).padEnd(5)} ${r.palette.padEnd(8)} ${String(r.block + ' B').padEnd(12)} ${r.kbps10} KB/s`
    );
  }
  check('吞吐表生成', rows.length === 12);
}

/* ================= 收尾 ================= */

console.log(`\n\x1b[1m结果：${passed} 通过，${failed} 失败\x1b[0m`);
if (failed) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
