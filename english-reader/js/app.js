/**
 * 英语朗读 English Reader
 * - 双音源：Edge 神经语音（浏览器直连 WebSocket，免费）/ OmniVoice（OpenAI 兼容 API）
 * - 整篇朗读 / 逐句朗读 / 点词发音 / 单句循环
 * - 生词本、学习历史、深色模式（localStorage + IndexedDB 音频缓存）
 */
'use strict';

/* ================= 常量 ================= */

// Edge TTS（speech.platform.bing.com 的"大声朗读"服务，WebSocket 无跨域限制）
// token 算法（v2 DRM）在 js/edge-drm.js，已与官方参考实现逐字节验证
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const GEC_VERSION = '2-143.0.3650.75';

const EDGE_VOICES = [
  ['en-US-AvaMultilingualNeural',    'Ava · 女 · 美音（最自然）'],
  ['en-US-AndrewMultilingualNeural', 'Andrew · 男 · 美音（最自然）'],
  ['en-US-EmmaMultilingualNeural',   'Emma · 女 · 美音'],
  ['en-US-BrianMultilingualNeural',  'Brian · 男 · 美音'],
  ['en-US-AriaNeural',               'Aria · 女 · 美音'],
  ['en-US-JennyNeural',              'Jenny · 女 · 美音'],
  ['en-US-GuyNeural',                'Guy · 男 · 美音'],
  ['en-US-AnaNeural',                'Ana · 女童声 · 美音'],
  ['en-GB-SoniaNeural',              'Sonia · 女 · 英音'],
  ['en-GB-RyanNeural',               'Ryan · 男 · 英音'],
  ['en-GB-LibbyNeural',              'Libby · 女 · 英音'],
  ['en-GB-ThomasNeural',             'Thomas · 男 · 英音'],
  ['en-AU-NatashaNeural',            'Natasha · 女 · 澳音'],
  ['en-AU-WilliamNeural',            'William · 男 · 澳音'],
  ['en-IN-NeerjaNeural',             'Neerja · 女 · 印度音'],
  ['en-IN-PrabhatNeural',            'Prabhat · 男 · 印度音'],
];

// 分句时常见的非句尾缩写（小写、去点后匹配）
const ABBREVS = new Set(('mr,mrs,ms,dr,prof,st,sr,jr,vs,etc,fig,al,phd,inc,ltd,co,corp,dept,est,approx,' +
  'ave,blvd,rd,mt,ft,gen,col,capt,sgt,rev,hon,pres,gov,sen,rep,vol,ch,pp,cf,art,no,nos,' +
  'jan,feb,mar,apr,jun,jul,aug,sep,sept,oct,nov,dec,' +
  'mon,tue,tues,wed,thu,thur,fri,sat,sun').split(','));

const SAMPLE_TEXT = `The First Step

Learning English is like planting a small garden. Every word you learn is a seed, and every sentence you read is a drop of water. At first, nothing seems to happen. Then, one morning, a green leaf appears.

"Don't be afraid of mistakes," said Mr. Lin, our English teacher. "Even native speakers make them every day. What matters is that you keep going."

So here is my plan. I will read aloud for ten minutes each morning. I will click on any word I don't know and listen to it carefully. I will repeat each sentence until it sounds natural. In three months, I believe my English will bloom like flowers in spring — not 3.14 times better, but truly, wonderfully alive.`;

/* ================= 小工具 ================= */

const $ = (id) => document.getElementById(id);

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function uuidHex() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)))
    .replace(/-/g, '');
}
// Edge 协议要求的时间戳格式
function edgeDate() {
  const d = new Date();
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = (n) => String(n).padStart(2, '0');
  return `${day} ${mon} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}
// Sec-MS-GEC v2 令牌（js/edge-drm.js 提供计算）
function secMsGec() {
  return Promise.resolve(EdgeDRM.generateSecMsGecV2());
}
// OmniVoice / OpenAI 兼容地址拼接。兼容多种 base 写法：
//   https://api.xxx.com                    → + /v1/audio/speech
//   https://developer.amd.com.cn/radeon/api/v1（base 已带 /v1，Radeon Cloud）→ + /audio/speech
//   https://xxx/v1/audio/speech            → 原样使用
let omniUrlStyle = null; // 记住试通的拼法，避免每次试错
function omniUrlCandidates(baseUrl) {
  const b = (baseUrl || '').trim().replace(/\/+$/, '');
  const list = [];
  if (/\/v1\/audio\/speech$/.test(b)) list.push(b);
  if (/\/v1$/.test(b)) list.push(b + '/audio/speech');
  list.push(b + '/v1/audio/speech');
  if (/\/v1$/.test(b)) list.push(b + '/v1/audio/speech'); // 双 v1 网关兜底
  const uniq = [...new Set(list)];
  if (omniUrlStyle && uniq.includes(omniUrlStyle)) {
    uniq.splice(uniq.indexOf(omniUrlStyle), 1);
    uniq.unshift(omniUrlStyle);
  }
  return uniq;
}
function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ================= 本地存储 ================= */

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式等 */ } },
};

let settings = Object.assign({
  provider: 'edge',          // 'edge' | 'omni'
  voice: EDGE_VOICES[0][0],  // Edge 音色
  rate: 100,                 // 语速百分比 50 ~ 200
  wordSpeak: true,           // 点词发音开关
  loop: false,               // 单句循环
  theme: null,               // 'light' | 'dark' | null(跟随系统)
  lastText: '',
  omni: { baseUrl: '', apiKey: '', model: 'k2-fsa/OmniVoice', voice: 'auto', extra: '', mode: 'direct' },
}, store.get('er.settings', {}));
function saveSettings() { store.set('er.settings', settings); }

let vocab = store.get('er.vocab', []);        // [{ w, ts }]
let history = store.get('er.history', []);    // [{ id, title, text, ts }]

/* ================= IndexedDB 音频缓存 ================= */

let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('eng-reader-cache', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('tts');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tts', 'readonly').objectStore('tts').get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tts', 'readwrite').objectStore('tts').put(val, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ================= TTS：统一入口（内存 + IDB 两级缓存，请求去重） ================= */

const memCache = new Map();   // cacheKey -> Blob
const inflight = new Map();   // cacheKey -> Promise<Blob>

function cacheKey(text) {
  const v = settings.provider === 'edge'
    ? settings.voice
    : `${settings.omni.model}|${settings.omni.voice}`;
  return `${settings.provider}|${v}|${settings.rate}|${text}`;
}

async function getBlob(text) {
  const key = cacheKey(text);
  if (memCache.has(key)) return memCache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let blob = null;
    try { blob = await idbGet(key); } catch { /* 无 IDB 则跳过 */ }
    if (!(blob instanceof Blob) || blob.size === 0) {
      blob = settings.provider === 'edge' ? await synthesizeEdge(text) : await synthesizeOmni(text);
      idbSet(key, blob).catch(() => {});
    }
    memCache.set(key, blob);
    return blob;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
// 预取（后台合成下一句，消除句间等待）
function prefetch(i) {
  const s = flatSentences[i];
  if (s) getBlob(s.text).catch(() => {});
}

/* ================= TTS Provider：Edge 神经语音 ================= */

// 直连健康记忆：直连失败后 10 分钟内跳过直连直接走代理，避免每次点击都先等一次超时
const edgeDirect = { brokenUntil: 0 };
function markEdgeDirectBroken(ms = 10 * 60 * 1000) { edgeDirect.brokenUntil = Date.now() + ms; }
function markEdgeDirectOk() { edgeDirect.brokenUntil = 0; }
function edgeDirectBroken() { return Date.now() < edgeDirect.brokenUntil; }

// 页面加载/切换音源时后台探测一次直连可用性（顺带预热连接）
async function probeEdgeDirect() {
  try {
    await Promise.race([
      synthesizeEdgeDirect('OK.'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 4000)),
    ]);
    markEdgeDirectOk();
  } catch { markEdgeDirectBroken(); }
}

// 直连：浏览器 WebSocket（v2 DRM token 由 js/edge-drm.js 计算）
async function synthesizeEdgeDirect(text) {
  if (!window.EdgeDRM) throw new Error('缺少 edge-drm.js，请检查文件完整性');
  if (navigator && navigator.onLine === false) throw new Error('当前已离线，无法连接语音服务');
  const token = await secMsGec();
  const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${token}` +
              `&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${uuidHex()}`;

  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { reject(new Error('无法建立连接：' + e.message)); return; }
    ws.binaryType = 'arraybuffer';

    const chunks = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error('Edge TTS 连接超时，请检查网络')), 30000);

    function finish(err, blob) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* 忽略 */ }
      err ? reject(err) : resolve(blob);
    }

    ws.onopen = () => {
      const date = edgeDate();
      ws.send(`X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({
          context: { synthesis: { audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
          } } },
        }));
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${settings.voice}'>` +
        `<prosody rate='${edgeRate()}' pitch='+0Hz' volume='+0%'>${escapeXml(text)}</prosody>` +
        `</voice></speak>`;
      ws.send(`X-RequestId:${uuidHex()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('Path:turn.end')) {
          const blob = new Blob(chunks, { type: 'audio/mpeg' });
          blob.size ? finish(null, blob) : finish(new Error('Edge TTS 未返回音频数据'));
        }
        return;
      }
      // 二进制帧：前 2 字节为头部长度（大端），其余为 MP3 数据
      const buf = ev.data;
      const hlen = new DataView(buf).getUint16(0);
      chunks.push(buf.slice(2 + hlen));
    };

    ws.onerror = () => finish(new Error('无法连接 Edge TTS 服务，请检查网络'));
    ws.onclose = () => { if (!done) finish(new Error('Edge TTS 连接被中断')); };
  });
}

// Edge 通道：优先浏览器直连（记住直连健康状态），失败自动落到本地代理（node server.js）
async function synthesizeEdge(text) {
  let firstErr = null;
  if (!edgeDirectBroken()) {
    try {
      const blob = await synthesizeEdgeDirect(text);
      markEdgeDirectOk();
      return blob;
    } catch (e) {
      firstErr = e;
      markEdgeDirectBroken();
    }
  }
  const base = await getProxyBase().catch(() => null);
  if (base !== null) {
    try { return await edgeViaProxy(base, text); }
    catch (e) { throw e; } // 代理错误更有指向性，直接抛出
  }
  throw firstErr || new Error('Edge TTS 不可用：请检查网络，或运行 node server.js 启用代理兜底');
}
async function edgeViaProxy(base, text) {
  const res = await fetch(base + '/api/tts-edge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: settings.voice, rate: settings.rate }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Edge 代理合成失败 ${res.status}${t ? '：' + t.slice(0, 120) : ''}`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error('Edge 代理返回空音频');
  return blob;
}
// 语速百分比 → Edge 的 "+10.00%" 格式
function edgeRate() {
  const v = settings.rate - 100;
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

/* ================= TTS Provider：OmniVoice（OpenAI 兼容 /v1/audio/speech） ================= */

async function getProxyBase() {
  if (getProxyBase.cached !== undefined) return getProxyBase.cached;
  const candidates = location.protocol.startsWith('http') ? ['', 'http://127.0.0.1:8765'] : ['http://127.0.0.1:8765'];
  for (const base of candidates) {
    try {
      const r = await fetch(base + '/api/ping');
      if (r.ok) { getProxyBase.cached = base; return base; }
    } catch { /* 试下一个 */ }
  }
  getProxyBase.cached = null;
  throw new Error('未检测到本地代理（node server.js，端口 8765）');
}

async function omniRequest(payload) {
  const c = settings.omni;
  if (!c.baseUrl) throw new Error('请先在「⚙️ 设置」中填写 OmniVoice 服务地址');
  const candidates = omniUrlCandidates(c.baseUrl);

  const doFetch = async (target) => {
    const viaProxy = async (base) => {
      const headers = { 'Content-Type': 'application/json', 'X-Proxy-Target': target };
      if (c.apiKey) headers['X-Proxy-Auth'] = 'Bearer ' + c.apiKey;
      return fetch(base + '/api/tts', { method: 'POST', headers, body: JSON.stringify(payload) });
    };
    if (c.mode === 'proxy') return viaProxy(await getProxyBase());
    // 直连；若被 CORS/网络拦截，自动尝试本地代理兜底
    const headers = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;
    try {
      return await fetch(target, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (e) {
      const base = await getProxyBase().catch(() => null);
      if (base === null) throw new Error('无法直连 OmniVoice（可能被跨域拦截）。请运行 node server.js 后在设置中切换为「经本地代理」');
      return viaProxy(base);
    }
  };

  // 404 时尝试下一种 URL 拼法（网关路径差异）
  let last = null;
  for (let i = 0; i < candidates.length; i++) {
    const res = await doFetch(candidates[i]);
    if (res.status !== 404 || i === candidates.length - 1) {
      if (res.ok) omniUrlStyle = candidates[i];
      return res;
    }
    last = res;
  }
  return last;
}

async function synthesizeOmni(text) {
  const c = settings.omni;
  if (!c.baseUrl) throw new Error('请先在「⚙️ 设置」中填写 OmniVoice 服务地址');
  const payload = {
    model: c.model || 'k2-fsa/OmniVoice',
    input: text,
    voice: c.voice || 'auto',
    response_format: 'mp3',
    speed: settings.rate / 100,
  };
  if (c.extra && c.extra.trim()) {
    try { Object.assign(payload, JSON.parse(c.extra)); }
    catch { throw new Error('「额外参数」不是合法 JSON'); }
  }
  const res = await omniRequest(payload);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OmniVoice 返回 ${res.status}${t ? '：' + t.slice(0, 140) : ''}`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error('OmniVoice 返回了空音频');
  return blob;
}

/* ================= 文本解析：分句 + 分词 ================= */

function wordBeforeDot(text, i) {
  let j = i - 1, w = '';
  while (j >= 0 && /[A-Za-z.]/.test(text[j])) { w = text[j] + w; j--; }
  return w; // 保留原始大小写与内部的点
}
function isBoundaryDot(text, i) {
  const w = wordBeforeDot(text, i);
  if (!w) return false;
  if (w.includes('.')) return false;        // U.S. / e.g. / a.m. / Ph.D. 之类的点式缩写
  const low = w.toLowerCase();
  if (w.length === 1) return false;         // 人名首字母 J. K. Rowling
  return !ABBREVS.has(low);                 // Mr. Dr. etc. Jan. … 不切分
}

function hardSplit(s, max = 350) {
  if (s.length <= max) return [s];
  let cut = Math.max(s.lastIndexOf(',', max), s.lastIndexOf(';', max));
  const dash = s.indexOf(' — ', Math.max(0, max - 120));
  if (dash > 0 && dash < max) cut = Math.max(cut, dash + 2);
  if (cut < max * 0.4) return [s];          // 找不到合适切点就整句保留
  return [s.slice(0, cut + 1).trim(), ...hardSplit(s.slice(cut + 1).trim(), max)];
}

function splitSentences(text) {
  const parts = [];
  const n = text.length;
  let start = 0, i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i + 1;
      while (j < n && /[.!?…"'\u2019\u201d)\]]/.test(text[j])) j++; // 吞掉连续结尾符号与收尾引号
      let k = j;
      while (k < n && /[ \t]/.test(text[k])) k++;
      const atEnd = j >= n, hasSpace = k > j;
      if (atEnd || hasSpace) {
        const nextCh = k < n ? text[k] : '';
        const lowerNext = /[a-z,;:—)]/.test(nextCh); // 下一个字符是小写/逗号等 → 多半不是句尾
        const dotOk = ch !== '.' || isBoundaryDot(text, i);
        if (!lowerNext && dotOk) {
          const seg = text.slice(start, j).trim();
          if (seg) parts.push(...hardSplit(seg));
          start = k; i = k; continue;
        }
      }
      i = j; continue;
    }
    i++;
  }
  const rest = text.slice(start).trim();
  if (rest) parts.push(...hardSplit(rest));
  return parts;
}

// 可点击单词：保留 don't / well-known / 保留音标式字母
const WORD_RE = /[A-Za-z\u00C0-\u024F]+(?:['\u2019-][A-Za-z\u00C0-\u024F]+)*/g;
function tokenize(sentence) {
  const out = []; // [{ t: 'word'|'text', s }]
  let last = 0, m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(sentence))) {
    if (m.index > last) out.push({ t: 'text', s: sentence.slice(last, m.index) });
    out.push({ t: 'word', s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < sentence.length) out.push({ t: 'text', s: sentence.slice(last) });
  return out;
}

function parseText(raw) {
  return raw.split(/\n{2,}/)                      // 空行分段
    .map((p) => p.replace(/\n+/g, ' ').trim())    // 段内换行合并
    .filter(Boolean)
    .map((p) => splitSentences(p).map((s) => ({ text: s })));
}

/* ================= 渲染 ================= */

let paragraphs = [];     // [[{ text }]] 段→句
let flatSentences = [];  // [{ text, el }] 展平，播放用

function renderText() {
  const box = $('textContent');
  box.innerHTML = '';
  flatSentences = [];
  paragraphs.forEach((sents) => {
    const pEl = document.createElement('div');
    pEl.className = 'para';
    sents.forEach((s) => {
      const idx = flatSentences.length;
      const el = document.createElement('span');
      el.className = 'sent';
      const btn = document.createElement('button');
      btn.className = 'play-btn';
      btn.textContent = '▶';
      btn.title = '朗读这一句';
      btn.addEventListener('click', (e) => { e.stopPropagation(); playFrom(idx, false); });
      el.appendChild(btn);
      for (const seg of tokenize(s.text)) {
        if (seg.t === 'text') { el.appendChild(document.createTextNode(seg.s)); continue; }
        const w = document.createElement('span');
        w.className = 'word';
        w.textContent = seg.s;
        w.dataset.word = seg.s.replace(/\u2019/g, "'");
        w.addEventListener('click', (e) => {
          if (e.detail >= 2) return;          // 双击的第二跳不再发音
          if (!settings.wordSpeak) return;
          // 立即给视觉反馈，音频随后跟上
          w.classList.remove('pop');
          void w.offsetWidth;
          w.classList.add('pop');
          setTimeout(() => w.classList.remove('pop'), 500);
          speakWord(w);
        });
        w.addEventListener('dblclick', () => addVocab(w.dataset.word));
        el.appendChild(w);
      }
      pEl.appendChild(el);
      flatSentences.push({ text: s.text, el });
    });
    box.appendChild(pEl);
  });
  $('playerBar').hidden = flatSentences.length === 0;
}

/* ================= 播放引擎 ================= */

const player = {
  gen: 0,        // 代次：停止/切换后使旧流程失效
  idx: -1,
  playing: false,
  paused: false,
  advance: true, // 播完当前句是否自动下一句（整篇模式）
  audio: null,
  url: null,
};

function releaseAudio() {
  if (player.audio) { player.audio.onended = player.audio.onerror = null; player.audio.pause(); }
  if (player.url) { URL.revokeObjectURL(player.url); player.url = null; }
  player.audio = null;
}

function setSynthesizing(i, on) {
  const el = flatSentences[i]?.el;
  if (el) el.classList.toggle('synthesizing', on);
}
function highlight(i) {
  flatSentences.forEach((s) => s.el.classList.remove('current'));
  if (i >= 0 && flatSentences[i]) {
    flatSentences[i].el.classList.add('current');
    flatSentences[i].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
function updatePlayBar() {
  const n = flatSentences.length;
  const btn = $('btnPlay');
  btn.textContent = player.playing && !player.paused ? '⏸' : '▶';
  if (player.playing) {
    $('playPos').textContent = `第 ${player.idx + 1}/${n} 句${player.paused ? '（已暂停）' : ''}`;
    $('playText').textContent = flatSentences[player.idx]?.text || '';
  } else {
    $('playPos').textContent = player.idx >= 0
      ? `已停止 · 第 ${player.idx + 1}/${n} 句`
      : `共 ${n} 句 · 点 ▶ 整篇朗读`;
    $('playText').textContent = player.idx >= 0 ? flatSentences[player.idx].text : '';
  }
}

// 预取一句里的所有单词发音（并发 2），点词几乎零等待
function prefetchSentenceWords(i) {
  const s = flatSentences[i];
  if (!s || !s.el) return;
  const words = [...new Set([...s.el.querySelectorAll('.word')].map((w) => w.dataset.word))];
  let idx = 0;
  const worker = async () => {
    while (idx < words.length) {
      const word = words[idx++];
      try { await getBlob(word); } catch { /* 预取失败静默，点击时会再报错 */ }
    }
  };
  worker();
  worker();
}

async function playFrom(i, advance) {
  if (i < 0 || i >= flatSentences.length) { finishAll(); return; }
  player.gen++;
  const gen = player.gen;
  releaseAudio();
  player.idx = i;
  player.playing = true;
  player.paused = false;
  player.advance = advance;
  highlight(i);
  updatePlayBar();

  setSynthesizing(i, true);
  let blob;
  try {
    blob = await getBlob(flatSentences[i].text);
  } catch (err) {
    setSynthesizing(i, false);
    toast(err.message, 'error', 5000);
    player.playing = false;
    updatePlayBar();
    return;
  }
  setSynthesizing(i, false);
  if (gen !== player.gen) return; // 用户已停止或切换

  const audio = new Audio(URL.createObjectURL(blob));
  player.audio = audio;
  player.url = audio.src;
  audio.onended = () => {
    if (gen !== player.gen) return;
    if (settings.loop) {           // 单句循环：原地重播
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    if (advance && i + 1 < flatSentences.length) playFrom(i + 1, true);
    else finishAll();
  };
  audio.onerror = () => {
    if (gen === player.gen) { toast('音频播放失败', 'error'); finishAll(); }
  };
  try { await audio.play(); } catch { /* 自动播放被拦截时忽略，用户可再点 */ }

  prefetch(i + 1);          // 预取下一句
  prefetchSentenceWords(i); // 预取本句所有单词，点词秒发音
}

function finishAll() {
  player.gen++;
  releaseAudio();
  player.playing = false;
  player.paused = false;
  player.idx = -1;
  highlight(-1);
  updatePlayBar();
}
function stopAll() {
  player.gen++;
  releaseAudio();
  player.playing = false;
  player.paused = false;         // 保留 idx，再次点播放从该句继续
  updatePlayBar();
}
function togglePlay() {
  if (!flatSentences.length) return;
  if (player.playing && !player.paused) {
    player.audio?.pause();
    player.paused = true;
  } else if (player.playing && player.paused) {
    player.audio?.play();
    player.paused = false;
  } else {
    playFrom(player.idx >= 0 ? player.idx : 0, true);
  }
  updatePlayBar();
}
function playNext() {
  if (!flatSentences.length) return;
  playFrom(Math.min(player.idx + 1, flatSentences.length - 1), player.advance);
}
function playPrev() {
  if (!flatSentences.length) return;
  playFrom(Math.max(player.idx - 1, 0), player.advance);
}

/* ================= 点词发音 ================= */

let wordAudio = null;
async function speakWord(w) {
  const word = w.dataset.word;
  try {
    const blob = await getBlob(word);
    if (wordAudio) { wordAudio.pause(); URL.revokeObjectURL(wordAudio.src); }
    wordAudio = new Audio(URL.createObjectURL(blob));
    wordAudio.play().catch(() => {});
  } catch (err) {
    toast('发音失败：' + err.message, 'error', 4000);
  }
}

/* ================= 生词本 ================= */

function addVocab(word) {
  if (!word) return;
  const key = word.toLowerCase();
  if (vocab.some((v) => v.w.toLowerCase() === key)) {
    toast(`「${word}」已在生词本中`, 'info');
    return;
  }
  vocab.unshift({ w: word, ts: Date.now() });
  store.set('er.vocab', vocab);
  toast(`已加入生词本：${word}`, 'success');
  if ($('vocabDlg').open) renderVocab();
}
function removeVocab(word) {
  vocab = vocab.filter((v) => v.w !== word);
  store.set('er.vocab', vocab);
  renderVocab();
}
function renderVocab() {
  const box = $('vocabList');
  box.innerHTML = '';
  $('vocabCount').textContent = vocab.length ? `（${vocab.length} 个）` : '';
  if (!vocab.length) {
    box.innerHTML = '<div class="empty-list">还没有生词。<br>阅读时双击任意单词即可收藏。</div>';
    return;
  }
  for (const v of vocab) {
    const row = document.createElement('div');
    row.className = 'vocab-item';
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = v.w;
    w.dataset.word = v.w;
    w.title = '点击听发音';
    w.addEventListener('click', () => speakWord(w));
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕ 删除';
    del.addEventListener('click', () => removeVocab(v.w));
    row.append(w, del);
    box.appendChild(row);
  }
}

/* ================= 学习历史 ================= */

function saveHistory(text) {
  if (text === settings.lastText) return; // 与上次相同不重复存
  const title = text.trim().split(/\n/)[0].slice(0, 40) || '未命名文本';
  history = history.filter((h) => h.text !== text);
  history.unshift({ id: Date.now(), title, text, ts: Date.now() });
  if (history.length > 20) history.length = 20;
  store.set('er.history', history);
}
function renderHistory() {
  const box = $('historyList');
  box.innerHTML = '';
  if (!history.length) {
    box.innerHTML = '<div class="empty-list">还没有历史记录。<br>导入的文本会自动保存在这里。</div>';
    return;
  }
  for (const h of history) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.title = '点击载入这篇文本';
    const info = document.createElement('div');
    info.className = 'info';
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = h.title;
    const m = document.createElement('div');
    m.className = 'hint';
    m.textContent = `${formatTime(h.ts)} · ${h.text.length} 字符`;
    info.append(t, m);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = '删除这条记录';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      history = history.filter((x) => x.id !== h.id);
      store.set('er.history', history);
      renderHistory();
    });
    row.append(info, del);
    row.addEventListener('click', () => {
      loadText(h.text);
      $('historyDlg').close();
    });
    box.appendChild(row);
  }
}

/* ================= 视图切换与导入 ================= */

function showView(name) {
  $('importView').hidden = name !== 'import';
  $('readView').hidden = name !== 'read';
  $('emptyView').hidden = name !== 'empty';
}
function loadText(t, opts = {}) {
  const text = t.replace(/\r\n?/g, '\n').trim();
  if (!text) { toast('文本为空', 'error'); return; }
  paragraphs = parseText(text);
  renderText();
  prefetchSentenceWords(0); // 第一句的单词提前合成
  player.gen++; releaseAudio();
  player.idx = -1; player.playing = false; player.paused = false;
  showView('read');
  updatePlayBar();
  if (!opts.silent) {
    saveHistory(text);
    settings.lastText = text;
    saveSettings();
    toast(`已载入 ${flatSentences.length} 句，点 ▶ 开始整篇朗读`, 'success');
  }
}

/* ================= Toast ================= */

function toast(msg, type = 'info', ms = 3000) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('toastBox').appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 320);
  }, ms);
}

/* ================= UI 绑定与初始化 ================= */

function populateVoiceSel() {
  const sel = $('voiceSel');
  sel.innerHTML = '';
  for (const [name, label] of EDGE_VOICES) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = settings.voice;
  sel.hidden = settings.provider !== 'edge';
  $('omniVoiceHint').hidden = settings.provider === 'edge';
}

function applyTheme() {
  const dark = settings.theme
    ? settings.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('btnTheme').textContent = dark ? '☀️' : '🌙';
}

function bindEvents() {
  // 工具栏
  $('providerSel').addEventListener('change', (e) => {
    settings.provider = e.target.value;
    saveSettings();
    populateVoiceSel();
    toast(settings.provider === 'edge' ? '已切换到 Edge 神经语音' : '已切换到 OmniVoice（首次使用请在设置中配置）', 'info');
    if (settings.provider === 'edge') probeEdgeDirect();
  });
  $('voiceSel').addEventListener('change', (e) => {
    settings.voice = e.target.value;
    saveSettings();
  });
  const rateRange = $('rateRange');
  rateRange.value = settings.rate;
  $('rateVal').textContent = (settings.rate / 100).toFixed(2) + 'x';
  rateRange.addEventListener('input', (e) => {
    settings.rate = Number(e.target.value);
    $('rateVal').textContent = (settings.rate / 100).toFixed(2) + 'x';
    saveSettings();
  });
  $('wordSpeakTgl').checked = settings.wordSpeak;
  $('wordSpeakTgl').addEventListener('change', (e) => {
    settings.wordSpeak = e.target.checked;
    saveSettings();
    toast(settings.wordSpeak ? '点词发音：已开启（单击单词即发音）' : '点词发音：已关闭', 'info');
  });
  $('loopTgl').checked = settings.loop;
  $('loopTgl').addEventListener('change', (e) => {
    settings.loop = e.target.checked;
    saveSettings();
    toast(settings.loop ? '单句循环：已开启' : '单句循环：已关闭', 'info');
  });

  $('btnTheme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    settings.theme = dark ? 'light' : 'dark';
    saveSettings();
    applyTheme();
  });

  $('btnImport').addEventListener('click', () => {
    $('importText').value = settings.lastText || '';
    updateImportStat();
    showView('import');
  });
  $('btnCancelImport').addEventListener('click', () => {
    showView(flatSentences.length ? 'read' : 'empty');
  });
  $('btnSample').addEventListener('click', () => loadText(SAMPLE_TEXT));
  $('btnLoad').addEventListener('click', () => loadText($('importText').value));
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => loadText(String(reader.result));
    reader.onerror = () => toast('读取文件失败', 'error');
    reader.readAsText(f, 'utf-8');
    e.target.value = '';
  });
  $('importText').addEventListener('input', updateImportStat);

  // 播放条
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnStop').addEventListener('click', stopAll);
  $('btnNext').addEventListener('click', playNext);
  $('btnPrev').addEventListener('click', playPrev);

  // 弹窗
  $('btnSettings').addEventListener('click', () => {
    const c = settings.omni;
    $('omniBase').value = c.baseUrl;
    $('omniKey').value = c.apiKey;
    $('omniModel').value = c.model;
    $('omniVoice').value = c.voice;
    $('omniExtra').value = c.extra;
    document.querySelector(`input[name="omniMode"][value="${c.mode}"]`).checked = true;
    $('testResult').textContent = '';
    $('settingsDlg').showModal();
  });
  $('btnSettingsCancel').addEventListener('click', () => $('settingsDlg').close());
  $('btnSettingsSave').addEventListener('click', () => {
    settings.omni = {
      baseUrl: $('omniBase').value.trim(),
      apiKey: $('omniKey').value.trim(),
      model: $('omniModel').value.trim() || 'k2-fsa/OmniVoice',
      voice: $('omniVoice').value.trim() || 'auto',
      extra: $('omniExtra').value.trim(),
      mode: document.querySelector('input[name="omniMode"]:checked').value,
    };
    saveSettings();
    $('settingsDlg').close();
    toast('OmniVoice 配置已保存', 'success');
  });
  $('btnTestOmni').addEventListener('click', async () => {
    // 先暂存当前表单值再测试
    const bak = settings.omni;
    settings.omni = {
      baseUrl: $('omniBase').value.trim(),
      apiKey: $('omniKey').value.trim(),
      model: $('omniModel').value.trim() || 'k2-fsa/OmniVoice',
      voice: $('omniVoice').value.trim() || 'auto',
      extra: $('omniExtra').value.trim(),
      mode: document.querySelector('input[name="omniMode"]:checked').value,
    };
    $('testResult').textContent = '测试中…';
    try {
      const blob = await synthesizeOmni('Hello! This is a voice test.');
      const url = URL.createObjectURL(blob);
      new Audio(url).play().catch(() => {});
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      $('testResult').textContent = `✅ 连接成功，收到 ${(blob.size / 1024).toFixed(1)} KB 音频`;
    } catch (err) {
      $('testResult').textContent = '❌ ' + err.message;
    } finally {
      settings.omni = bak;
    }
  });

  $('btnVocab').addEventListener('click', () => { renderVocab(); $('vocabDlg').showModal(); });
  $('btnVocabClose').addEventListener('click', () => $('vocabDlg').close());
  $('btnVocabAdd').addEventListener('click', () => {
    const w = $('vocabInput').value.trim().replace(/[^A-Za-z'\u2019-]/g, '');
    if (w) { addVocab(w); $('vocabInput').value = ''; }
  });
  $('vocabInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnVocabAdd').click();
  });
  $('btnVocabClear').addEventListener('click', () => {
    if (!vocab.length) return;
    if (confirm(`确定清空全部 ${vocab.length} 个生词吗？`)) {
      vocab = [];
      store.set('er.vocab', vocab);
      renderVocab();
      toast('生词本已清空', 'info');
    }
  });

  $('btnHistory').addEventListener('click', () => { renderHistory(); $('historyDlg').showModal(); });
  $('btnHistoryClose').addEventListener('click', () => $('historyDlg').close());

  // 点弹窗背景关闭
  for (const id of ['settingsDlg', 'vocabDlg', 'historyDlg']) {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).close(); });
  }

  // 快捷键：空格播放/暂停，←/→ 上一句/下一句
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('dialog')) return;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); playPrev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); playNext(); }
  });
}

function updateImportStat() {
  const t = $('importText').value.trim();
  if (!t) { $('importStat').textContent = ''; return; }
  const nSent = parseText(t).reduce((a, p) => a + p.length, 0);
  const nWord = (t.match(WORD_RE) || []).length;
  $('importStat').textContent = `约 ${nWord} 词 / ${nSent} 句`;
}

function init() {
  applyTheme();
  $('providerSel').value = settings.provider;
  populateVoiceSel();
  bindEvents();
  // 恢复上次文本；首次访问自动载入示例
  if (settings.lastText) loadText(settings.lastText, { silent: true });
  else loadText(SAMPLE_TEXT, { silent: true });
  // 后台探测 Edge 直连可用性，点词不再等待超时
  if (settings.provider === 'edge') probeEdgeDirect();
}
init();
