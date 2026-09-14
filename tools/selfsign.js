// 纯 Node 生成自签 X.509 证书（不需要 openssl）。
//
// 为什么需要：浏览器只在「安全上下文」下开放摄像头，http://localhost 算安全，
// 但手机通过 http://192.168.x.x 访问电脑就不算了。想让手机当接收端就必须上 HTTPS。
//
// 这里手写了一遍 DER 编码。证书是自签的，浏览器会警告不受信任，点「继续」即可。

import crypto from 'node:crypto';

/* ---------------- DER 基础 ---------------- */

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), len(content.length), content]);
}

const der = {
  seq: (...items) => tlv(0x30, Buffer.concat(items)),
  set: (...items) => tlv(0x31, Buffer.concat(items)),
  bool: (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00])),
  int: (buf) => {
    let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && !(b[i + 1] & 0x80)) i++;
    b = b.subarray(i);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // 保持为正数
    return tlv(0x02, b);
  },
  bitString: (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf])),
  octet: (buf) => tlv(0x04, buf),
  null: () => Buffer.from([0x05, 0x00]),
  oid: (dotted) => {
    const parts = dotted.split('.').map(Number);
    const out = [40 * parts[0] + parts[1]];
    for (const p of parts.slice(2)) {
      const stack = [p & 0x7f];
      let v = p >>> 7;
      while (v > 0) {
        stack.unshift((v & 0x7f) | 0x80);
        v >>>= 7;
      }
      out.push(...stack);
    }
    return tlv(0x06, Buffer.from(out));
  },
  utf8: (s) => tlv(0x0c, Buffer.from(s, 'utf8')),
  ia5: (s) => tlv(0x16, Buffer.from(s, 'ascii')),
  utcTime: (d) => {
    const p = (v) => String(v).padStart(2, '0');
    const s =
      p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
      p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
    return tlv(0x17, Buffer.from(s, 'ascii'));
  },
  ctx: (n, content, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, content),
  prim: (n, content) => tlv(0x80 | n, content),
};

const OID = {
  sha256WithRSA: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
};

function name(cn, org) {
  const rdn = (oid, value) => der.set(der.seq(der.oid(oid), der.utf8(value)));
  return der.seq(rdn(OID.commonName, cn), rdn(OID.organization, org));
}

function extension(oid, critical, valueDer) {
  const parts = [der.oid(oid)];
  if (critical) parts.push(der.bool(true));
  parts.push(der.octet(valueDer));
  return der.seq(...parts);
}

function subjectAltName(hosts) {
  const entries = [];
  for (const h of hosts) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (m) {
      // iPAddress [7] IMPLICIT OCTET STRING
      entries.push(der.prim(7, Buffer.from(m.slice(1).map(Number))));
    } else {
      // dNSName [2] IMPLICIT IA5String
      entries.push(der.prim(2, Buffer.from(h, 'ascii')));
    }
  }
  return der.seq(...entries);
}

function pem(label, buf) {
  const b64 = buf.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * 生成一张自签服务器证书。
 * @param {string[]} hosts 证书要覆盖的域名 / IP，第一个作为 CN
 * @param {number} days 有效期
 * @returns {{key: string, cert: string}} PEM 字符串
 */
export function generateSelfSigned(hosts, days = 3650) {
  if (!hosts.length) hosts = ['localhost'];
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 3600 * 1000);

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;

  const subject = name(hosts[0], 'Flicker Transport (self-signed)');
  const algo = der.seq(der.oid(OID.sha256WithRSA), der.null());

  const extensions = der.ctx(
    3,
    der.seq(
      extension(OID.basicConstraints, true, der.seq(der.bool(true))),
      // digitalSignature(0) + keyEncipherment(2) → 0b10100000，末 5 位未使用
      extension(OID.keyUsage, true, der.bitString(Buffer.from([0xa0]), 5)),
      extension(OID.extKeyUsage, false, der.seq(der.oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, subjectAltName(hosts))
    )
  );

  const tbs = der.seq(
    der.ctx(0, der.int(Buffer.from([2]))), // v3
    der.int(serial),
    algo,
    subject, // 自签，颁发者就是自己
    der.seq(der.utcTime(notBefore), der.utcTime(notAfter)),
    subject,
    spki,
    extensions
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = der.seq(tbs, algo, der.bitString(signature));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', cert),
  };
}
