/**
 * 英语朗读 · 可选本地代理
 *
 * 作用：
 *  1. 托管本目录的静态页面（访问 http://127.0.0.1:8765）
 *  2. POST /api/tts-edge   Edge TTS 服务端合成（浏览器直连失败时的自动兜底）
 *  3. POST /api/tts        转发 OmniVoice 等 OpenAI 兼容 TTS 请求，绕过浏览器跨域限制
 *
 * 用法：  node server.js   然后浏览器打开 http://127.0.0.1:8765
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');
const EdgeDRM = require('./js/edge-drm.js');

const PORT = 8765;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Target, X-Proxy-Auth',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...CORS, ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ================= Edge TTS：裸 TLS WebSocket 客户端 ================= */

const EDGE_HOST = 'speech.platform.bing.com';
const EDGE_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

function edgeDate() {
  const d = new Date();
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = (n) => String(n).padStart(2, '0');
  return `${day} ${mon} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}
function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// 客户端→服务端帧必须掩码
function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// 服务端→客户端帧解析（不掩码）
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0F;
  let len = buf[1] & 0x7F;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); off = 10;
  }
  if (buf[1] & 0x80) off += 4; // 理论上服务端帧不掩码，防御性跳过
  if (buf.length < off + len) return null;
  return { opcode, payload: buf.slice(off, off + len), total: off + len };
}

/**
 * 调用 Edge TTS 合成一段文本，返回 MP3 Buffer。
 * @param {string} text
 * @param {string} voice  如 en-US-AvaMultilingualNeural
 * @param {number} ratePercent  100 = 正常语速
 */
function edgeSynthesize(text, voice, ratePercent) {
  return new Promise((resolve, reject) => {
    if (!text || !text.trim()) { reject(new Error('文本为空')); return; }
    text = text.slice(0, 1000); // 单句安全上限

    const token = EdgeDRM.generateSecMsGecV2();
    const qs = `?TrustedClientToken=${EdgeDRM.TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${encodeURIComponent(token)}` +
      `&Sec-MS-GEC-Version=2-143.0.3650.75` +
      `&ConnectionId=${crypto.randomBytes(16).toString('hex')}`;
    const wsKey = crypto.randomBytes(16).toString('base64');
    const reqHead =
      `GET ${EDGE_PATH}${qs} HTTP/1.1\r\n` +
      `Host: ${EDGE_HOST}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      'Pragma: no-cache\r\n' +
      'Cache-Control: no-cache\r\n' +
      'Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n' +
      `User-Agent: ${EDGE_UA}\r\n` +
      'Accept-Encoding: gzip, deflate, br\r\n' +
      'Accept-Language: en-US,en;q=0.9\r\n\r\n';

    const date = edgeDate();
    const rate = (ratePercent - 100 >= 0 ? '+' : '') + (ratePercent - 100).toFixed(2) + '%';
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
      `<voice name='${voice}'>` +
      `<prosody rate='${rate}' pitch='+0Hz' volume='+0%'>${escapeXml(text)}</prosody>` +
      `</voice></speak>`;
    const speechConfig = `X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
      JSON.stringify({ context: { synthesis: { audio: {
        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      } } } });
    const ssmlMsg = `X-RequestId:${crypto.randomBytes(16).toString('hex')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n${ssml}`;

    const sock = tls.connect({ host: EDGE_HOST, port: 443, servername: EDGE_HOST }, () => sock.write(reqHead));
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    const audioChunks = [];
    let finished = false;

    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* 忽略 */ }
      if (err) reject(err);
      else {
        const out = Buffer.concat(audioChunks);
        out.length ? resolve(out) : reject(new Error('Edge TTS 未返回音频数据'));
      }
    };
    const timer = setTimeout(() => finish(new Error('Edge TTS 连接超时')), 45000);

    sock.on('data', (d) => {
      buffer = Buffer.concat([buffer, d]);
      if (!handshakeDone) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buffer.slice(0, idx).toString('latin1');
        if (!/^HTTP\/1\.1 101 /.test(head.split('\r\n')[0])) {
          finish(new Error('Edge TTS 握手被拒绝: ' + head.split('\r\n')[0]));
          return;
        }
        handshakeDone = true;
        buffer = buffer.slice(idx + 4);
        sock.write(encodeTextFrame(speechConfig));
        sock.write(encodeTextFrame(ssmlMsg));
      }
      for (;;) {
        const frame = parseFrame(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.total);
        if (frame.opcode === 1) {           // 文本
          const msg = frame.payload.toString('utf8');
          if (msg.includes('Path:turn.end')) { finish(null); return; }
        } else if (frame.opcode === 2) {    // 二进制音频
          if (frame.payload.length > 2) {
            const hlen = frame.payload.readUInt16BE(0);
            audioChunks.push(frame.payload.slice(2 + hlen));
          }
        } else if (frame.opcode === 8) {    // 关闭
          finish(audioChunks.length ? null : new Error('Edge TTS 连接被服务端关闭'));
          return;
        }
      }
    });
    sock.on('error', (e) => finish(new Error('Edge TTS 连接错误: ' + e.message)));
    sock.on('close', () => { if (!finished) finish(audioChunks.length ? null : new Error('Edge TTS 连接中断')); });
  });
}

/* ================= HTTP 服务 ================= */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

  // ===== 探活 =====
  if (url.pathname === '/api/ping') {
    send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }));
    return;
  }

  // ===== Edge TTS 合成：POST /api/tts-edge {text, voice, rate} =====
  if (url.pathname === '/api/tts-edge') {
    if (req.method !== 'POST') { send(res, 405, {}, 'Method Not Allowed'); return; }
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const mp3 = await edgeSynthesize(String(body.text || ''), String(body.voice || 'en-US-AvaMultilingualNeural'), Number(body.rate) || 100);
      send(res, 200, { 'Content-Type': 'audio/mpeg' }, mp3);
    } catch (err) {
      send(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ===== OmniVoice 转发：POST /api/tts =====
  if (url.pathname === '/api/tts') {
    if (req.method !== 'POST') { send(res, 405, {}, 'Method Not Allowed'); return; }
    const target = req.headers['x-proxy-target'];
    if (!target || !/^https?:\/\//i.test(target)) {
      send(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: '缺少合法的 X-Proxy-Target 头' }));
      return;
    }
    const body = await readBody(req);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers['x-proxy-auth']) headers['Authorization'] = req.headers['x-proxy-auth'];
      const upstream = await fetch(target, { method: 'POST', headers, body });
      const buf = Buffer.from(await upstream.arrayBuffer());
      send(res, upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' }, buf);
    } catch (err) {
      send(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: '代理请求失败：' + err.message }));
    }
    return;
  }

  // ===== 静态文件 =====
  let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const full = path.normalize(path.join(ROOT, file));
  if (!full.startsWith(ROOT)) { send(res, 403, {}, 'Forbidden'); return; } // 防目录穿越
  fs.readFile(full, (err, data) => {
    if (err) { send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found'); return; }
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    send(res, 200, { 'Content-Type': type }, data);
  });
});

// 局域网 IPv4（供 iPad / 手机同一 Wi-Fi 下访问）；优先家用网段，跳过 VPN 虚拟网卡
function lanIP() {
  const all = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) all.push(net.address);
    }
  }
  return all.find((ip) => /^192\.168\./.test(ip))
      || all.find((ip) => /^10\./.test(ip))
      || all.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
      || all[0] || null;
}

server.listen(PORT, () => {
  console.log(`✅ 英语朗读已启动`);
  console.log(`   本机访问：        http://127.0.0.1:${PORT}`);
  const ip = lanIP();
  if (ip) console.log(`   局域网(iPad/手机)：http://${ip}:${PORT}`);
  console.log('   Edge TTS 端点：  POST /api/tts-edge');
  console.log('   TTS 代理端点：   POST /api/tts');
});
