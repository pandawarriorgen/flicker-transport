// 零依赖静态服务器。
//   node server.js            → http://localhost:8000
//   node server.js --https    → 同时起 https://<局域网IP>:8443（手机当接收端必须走这个）
//   node server.js --port 9000 --https-port 9443

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateSelfSigned } from './tools/selfsign.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(ROOT, '.certs');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const PORT = +flag('--port', 8000);
const HTTPS_PORT = +flag('--https-port', 8443);
const USE_HTTPS = args.includes('--https');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function handler(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  // 关键：解析后必须仍在 ROOT 之内，挡掉 ../ 穿越
  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      // 页面是纯静态的，但顺手把跨源隔离头带上，将来想用 SharedArrayBuffer 不用改
      'cross-origin-opener-policy': 'same-origin',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function loadOrCreateCert(hosts) {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const stampPath = path.join(CERT_DIR, 'hosts.json');
  const wanted = JSON.stringify(hosts);

  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(stampPath)) {
    if (fs.readFileSync(stampPath, 'utf8') === wanted) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), reused: true };
    }
  }
  const pair = generateSelfSigned(hosts);
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pair.key);
  fs.writeFileSync(certPath, pair.cert);
  fs.writeFileSync(stampPath, wanted);
  return { key: pair.key, cert: pair.cert, reused: false };
}

const ips = localIPs();

http.createServer(handler).listen(PORT, () => {
  console.log(`\n  HTTP   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`         http://${ip}:${PORT}   (摄像头在此地址下不可用)`);
});

if (USE_HTTPS) {
  const hosts = ['localhost', '127.0.0.1', ...ips];
  const { key, cert, reused } = loadOrCreateCert(hosts);
  https.createServer({ key, cert }, handler).listen(HTTPS_PORT, () => {
    console.log(`\n  HTTPS  https://localhost:${HTTPS_PORT}`);
    for (const ip of ips) console.log(`         https://${ip}:${HTTPS_PORT}`);
    console.log(
      `\n  证书：${reused ? '复用' : '已生成'} ${path.relative(ROOT, CERT_DIR)}/cert.pem（自签，覆盖 ${hosts.join(', ')}）`
    );
    console.log('  手机首次打开会提示「连接不安全」，选择「高级 → 继续访问」即可。');
  });
} else {
  console.log('\n  想用手机摄像头当接收端？加上 --https 重启：  node server.js --https');
}

console.log('\n  Ctrl+C 退出\n');
