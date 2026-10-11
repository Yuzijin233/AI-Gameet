/**
 * 零依赖本地服务器（PRD Q7/Q12）
 *  - 静态资源服务：把项目根目录当作 web 根
 *  - POST /api/chat：可选的 DeepSeek 代理（浏览器直连被 CORS 拦时的兜底，PRD Q8）
 *  - GET/POST /api/save：把浏览器里的存档**镜像成本地文件**（save/ 目录），
 *    顺带生成人能直接读的 `save/AI记忆.md`（AI 记忆本地化，PRD §2.12 补充）
 *  - GET /__ddz：本项目自己的"身份牌"，用来判断 5173 上跑的是不是同一份服务
 * 只使用 Node 内置模块，无任何 npm 依赖。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { memoryDigest, memoryJson } from './src/data/memoryDigest.js';

/**
 * 记忆文件里的人名：**从存档本身取**（好友记录里存着名字副本），
 * 不去 import `src/data/personas.js` —— 分发版里那份人设表是**加密**的，
 * 服务端在 Node 里直接 import 会读成乱码（这个坑踩过一次）。
 */
function personasFromSave(save) {
  const list = [];
  for (const f of (save && Array.isArray(save.friends) ? save.friends : [])) {
    if (f && f.personaId && !list.some((x) => x.id === f.personaId)) {
      list.push({ id: f.personaId, name: f.name || f.personaId });
    }
  }
  return list;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
/** 存档镜像目录：save/ddz_save.json（原始）+ AI记忆.md / AI记忆.json（人读 / 机读）
 *  DDZ_SAVE_DIR 可以改写到别处（测试用，免得把玩家真正的记忆文件写脏） */
const SAVE_DIR = process.env.DDZ_SAVE_DIR
  ? path.resolve(process.env.DDZ_SAVE_DIR)
  : path.join(ROOT, 'save');
const SAVE_FILE = path.join(SAVE_DIR, 'ddz_save.json');
const MEMORY_MD = path.join(SAVE_DIR, 'AI记忆.md');
const MEMORY_JSON = path.join(SAVE_DIR, 'AI记忆.json');
const START_PORT = Number(process.env.PORT || 5173);
const MAX_PORT_TRIES = 10;
/** 身份牌：只有本项目的服务才会回这个标记，用来识别"已经有一份在跑了" */
const INSTANCE_TAG = 'ai-ddz-local-server';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

/** 从 src/config.js 里读出 apiKey（前端写死 Key 时，代理也复用同一份，避免两处维护） */
function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
    const m = src.match(/apiKey:\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** POST /api/chat —— 把前端的请求转发给 DeepSeek，避免浏览器 CORS 问题 */
function handleChatProxy(req, res) {
  // 先收原始字节、再一次性按 UTF-8 解码：
  // 直接 `raw += chunk` 会在多字节汉字刚好被切成两半时解码错乱（偶发、很难查）
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1e6) { req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return send(res, 400, JSON.stringify({ error: 'bad json' }), { 'Content-Type': MIME['.json'] });
    }
    // ★ 绿色版（PowerShell 服务）由页面把自己的 Key 带过来：优先用它，其次用本机 config
    const key = String(req.headers['x-api-key'] || '').trim() || readApiKey();
    if (!key) {
      return send(res, 500, JSON.stringify({ error: 'no api key' }), { 'Content-Type': MIME['.json'] });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const upstream = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await upstream.text();
      send(res, upstream.status, text, { 'Content-Type': MIME['.json'] });
    } catch (err) {
      send(res, 502, JSON.stringify({ error: String(err && err.message) }), { 'Content-Type': MIME['.json'] });
    } finally {
      clearTimeout(timer);
    }
  });
}

/* ===================================================================== */
/*            分发版的源码加密（内测包专用，工作区原样不影响）              */
/* ===================================================================== */
/**
 * 打包时会把 **除 server.js 以外的所有 .js**（`src/**` 与 `assets/manifest.js`）
 * 用 AES-256-GCM 加密成二进制；这里在发文件之前**即时解密**再送给浏览器，
 * 所以双击 start.bat 照常能玩，而直接打开解压出来的 .js 只会看到乱码。
 *
 * ⚠️ 说清楚它的边界：浏览器必须拿到明文才能执行，所以这**不是**真正的保密 ——
 *    懂行的人翻 server.js、或者在 DevTools 里看网络请求，一样能拿到源码。
 *    它挡的是"解压之后顺手改一改就当成自己的"这类随手破解。
 *
 * 容器格式：`DDZENC1` + iv(12) + authTag(16) + 密文
 */
const ENC_MAGIC = Buffer.from('DDZENC1', 'utf8');
const ENC_IV_LEN = 12;
const ENC_TAG_LEN = 16;
/**
 * 哪些扩展名会走"读进来 → 该解密就解密 → 从内存发"这条路
 * （分发版里这些类型全是加密的：源码 / 样式 / 图片 / 音频）
 */
const ENCRYPT_EXT = new Set([
  '.js', '.mjs', '.css',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico',
  '.mp3', '.wav', '.ogg', '.m4a',
]);
/** 口令不写明文：异或存着（存的只是"别一眼看见"，不是密码学保护） */
const KEY_XOR = [59, 51, 119, 61, 59, 55, 63, 63, 46, 119, 51, 52, 46, 63, 40, 52, 59, 54, 119, 104, 106, 104, 108, 119, 34, 109];
const KEY_MASK = 0x5a;
const KEY_SALT = [90, 46, 160, 122, 73, 160, 61, 78, 147, 137, 232, 144, 30, 237, 93, 72];
let _srcKey = null;
function sourceKey() {
  if (!_srcKey) {
    const pass = Buffer.from(KEY_XOR.map((b) => b ^ KEY_MASK)).toString('utf8');
    _srcKey = crypto.scryptSync(pass, Buffer.from(KEY_SALT), 32);
  }
  return _srcKey;
}

/** 解密后的内容缓存（按 路径+修改时间 缓存，别每次请求都解一遍） */
const decryptedCache = new Map();

/** 这段内容是加密过的吗 */
function isEncrypted(buf) {
  return buf.length > ENC_MAGIC.length + ENC_IV_LEN + ENC_TAG_LEN
    && buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC);
}

/**
 * 读一个文件；**加密过的自动解密**（没加密的原样返回 —— 工作区里就是明文）
 * @returns {Buffer}
 */
function readMaybeEncrypted(filePath, stat) {
  const cacheKey = `${filePath}:${stat ? stat.mtimeMs : 0}:${stat ? stat.size : 0}`;
  const hit = decryptedCache.get(cacheKey);
  if (hit) return hit;
  const raw = fs.readFileSync(filePath);
  const out = isEncrypted(raw) ? decryptSource(raw) : raw;
  if (decryptedCache.size > 200) decryptedCache.clear();
  decryptedCache.set(cacheKey, out);
  return out;
}

function decryptSource(buf) {
  const iv = buf.subarray(ENC_MAGIC.length, ENC_MAGIC.length + ENC_IV_LEN);
  const tag = buf.subarray(ENC_MAGIC.length + ENC_IV_LEN, ENC_MAGIC.length + ENC_IV_LEN + ENC_TAG_LEN);
  const data = buf.subarray(ENC_MAGIC.length + ENC_IV_LEN + ENC_TAG_LEN);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', sourceKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]);
  } catch (err) {
    console.error(`[源码] 解密失败（${err && err.message}）：多半是包里的 server.js 与加密时用的口令对不上了`);
    return Buffer.from('/* 源码解密失败：请用包内自带的 server.js 启动 */\n', 'utf8');
  }
}

/**
 * 解析 Range 请求头（只支持 `bytes=start-end` 这种最常见的写法）
 * 为什么要支持：<audio>/<video> 播放时浏览器会先发 Range 探一下，
 * 服务器不支持的话 Chrome 有时会把它当成"下载媒体"，左下角弹出下载小窗（用户报的问题）。
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) { // bytes=-N：最后 N 字节
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

/**
 * 按**内容**认出图片/音频的真实类型。
 * 为什么需要：素材文件名和内容不一定对得上（例如 `avatar_01.png` 其实是 JPEG、
 * `avatar_29.png` 其实是 WebP）；浏览器多半会自己嗅探，但明确告诉它更稳。
 * @returns {string} 认出来就返回 MIME，认不出返回空串
 */
function sniffMediaType(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  return '';
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, '404 Not Found: ' + urlPath, { 'Content-Type': MIME['.txt'] });
    }
    const ext = path.extname(filePath).toLowerCase();
    let type = MIME[ext] || 'application/octet-stream';

    /**
     * 这些类型在**分发版**里是加密的（见 tools/pack-release.mjs）：
     * 读进来 → 该解密就解密 → 从内存发。工作区里是明文，走的也是这条路（原样返回）。
     */
    if (ENCRYPT_EXT.has(ext)) {
      let body;
      try {
        body = readMaybeEncrypted(filePath, stat);
      } catch (e) {
        return send(res, 500, '500 Read Failed: ' + urlPath, { 'Content-Type': MIME['.txt'] });
      }
      if (/^image\/|^audio\/|^video\//.test(type)) {
        const sniffed = sniffMediaType(body);
        if (sniffed) type = sniffed;
      }
      const isMedia = /^(audio|video)\//.test(type);
      const baseHeaders = {
        'Content-Type': type,
        'Cache-Control': /\.(?:m?js|css)$/.test(ext) ? 'no-store' : 'no-cache',
      };
      if (isMedia) {
        baseHeaders['Accept-Ranges'] = 'bytes';
        baseHeaders['Content-Disposition'] = 'inline';
      }
      const range = isMedia ? parseRange(req.headers.range, body.length) : null;
      if (range) {
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Length': range.end - range.start + 1,
          'Content-Range': `bytes ${range.start}-${range.end}/${body.length}`,
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(body.subarray(range.start, range.end + 1));
      }
      res.writeHead(200, { ...baseHeaders, 'Content-Length': body.length });
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    }

    /** 其他文件（index.html / server.js / start.bat / save/*）：正常流式发 */
    const isMedia = /^(audio|video)\//.test(type);
    const headers = {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    };
    if (isMedia) {
      headers['Accept-Ranges'] = 'bytes';
      headers['Content-Disposition'] = 'inline';
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ===================================================================== */
/*                      存档镜像（AI 记忆本地化）                        */
/* ===================================================================== */
/**
 * 把存档写到本地文件：
 *   save/ddz_save.json —— 完整存档（缩进过的 JSON，可以直接看/备份/手改）
 *   save/AI记忆.md     —— 每个好友的记忆清单（**给人读的**）
 *   save/AI记忆.json   —— 只有记忆部分（好搜索、好 diff）
 * 写失败不影响游戏（存档真正的主副本仍在浏览器 localStorage 里）。
 */
function writeSaveFiles(save) {
  const now = new Date();
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const payload = { ...save, savedAt: save.savedAt || now.toISOString() };
  /**
   * 页面会把渲染好的记忆清单一起推过来（绿色版的服务端没有 JS 运行时，只能由页面算）。
   * 这两个字段**不能混进存档 JSON**，先摘出来。
   */
  const postedMd = typeof payload.memoryMd === 'string' ? payload.memoryMd : '';
  const postedJson = typeof payload.memoryJson === 'string' ? payload.memoryJson : '';
  delete payload.memoryMd;
  delete payload.memoryJson;
  const personas = personasFromSave(payload);
  fs.writeFileSync(SAVE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(MEMORY_MD, postedMd || memoryDigest(payload, { personas, now }), 'utf8');
  fs.writeFileSync(MEMORY_JSON, postedJson
    ? `${postedJson}\n`
    : `${JSON.stringify(memoryJson(payload, { personas, now }), null, 2)}\n`, 'utf8');
  return payload;
}

/** GET /api/save —— 取本地文件里的存档（浏览器存档丢了就用它恢复） */
function handleSaveGet(res) {
  try {
    if (!fs.existsSync(SAVE_FILE)) return send(res, 200, JSON.stringify({ ok: false, reason: 'no-file' }), { 'Content-Type': MIME['.json'] });
    const save = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    return send(res, 200, JSON.stringify({ ok: true, save, mtime: fs.statSync(SAVE_FILE).mtimeMs }), { 'Content-Type': MIME['.json'] });
  } catch (err) {
    return send(res, 200, JSON.stringify({ ok: false, reason: String(err && err.message) }), { 'Content-Type': MIME['.json'] });
  }
}

/** POST /api/save —— 浏览器把存档推过来（写文件 + 重新生成记忆文件） */
function handleSavePost(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 8e6) { req.destroy(); return; } // 存档里可能带上传头像，放宽到 8MB
    chunks.push(c);
  });
  req.on('end', () => {
    let save;
    try {
      save = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return send(res, 400, JSON.stringify({ ok: false, error: 'bad json' }), { 'Content-Type': MIME['.json'] });
    }
    if (!save || typeof save !== 'object' || !Array.isArray(save.friends)) {
      return send(res, 400, JSON.stringify({ ok: false, error: 'not a save' }), { 'Content-Type': MIME['.json'] });
    }
    try {
      const written = writeSaveFiles(save);
      return send(res, 200, JSON.stringify({
        ok: true, savedAt: written.savedAt, files: ['save/ddz_save.json', 'save/AI记忆.md', 'save/AI记忆.json'],
      }), { 'Content-Type': MIME['.json'] });
    } catch (err) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(err && err.message) }), { 'Content-Type': MIME['.json'] });
    }
  });
}

/**
 * POST /api/memory —— 页面单独推来的记忆清单（Markdown + JSON）。
 * 绿色版（PowerShell 服务端）没有 JS 运行时，记忆清单只能由页面渲染；
 * 这里也留同一个接口，两种服务端行为完全一致。
 */
function handleMemoryPost(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 4e6) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return send(res, 400, JSON.stringify({ ok: false, error: 'bad json' }), { 'Content-Type': MIME['.json'] });
    }
    try {
      fs.mkdirSync(SAVE_DIR, { recursive: true });
      let files = 0;
      if (typeof payload.md === 'string' && payload.md) { fs.writeFileSync(MEMORY_MD, payload.md, 'utf8'); files++; }
      if (typeof payload.json === 'string' && payload.json) { fs.writeFileSync(MEMORY_JSON, `${payload.json.replace(/\s+$/, '')}\n`, 'utf8'); files++; }
      return send(res, 200, JSON.stringify({ ok: true, files }), { 'Content-Type': MIME['.json'] });
    } catch (err) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(err && err.message) }), { 'Content-Type': MIME['.json'] });
    }
  });
}

const server = http.createServer((req, res) => {
  // 身份牌：只用来回答"这个端口上是不是同一份服务"，不参与游戏
  if (req.method === 'GET' && req.url && req.url.split('?')[0] === '/__ddz') {
    const addr = server.address();
    return send(res, 200, JSON.stringify({ app: INSTANCE_TAG, port: addr && addr.port }), {
      'Content-Type': MIME['.json'],
    });
  }
  if (req.method === 'POST' && req.url && req.url.split('?')[0] === '/api/chat') return handleChatProxy(req, res);
  if (req.url && req.url.split('?')[0] === '/api/save') {
    if (req.method === 'GET') return handleSaveGet(res);
    if (req.method === 'POST') return handleSavePost(req, res);
    return send(res, 405, 'Method Not Allowed');
  }
  if (req.method === 'POST' && req.url && req.url.split('?')[0] === '/api/memory') return handleMemoryPost(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
  serveStatic(req, res);
});

/** 打开系统默认浏览器（控制台输出保持纯 ASCII：Windows 控制台默认不是 UTF-8） */
function openBrowser(url) {
  if (process.env.DDZ_NO_OPEN) return;
  try {
    exec(`start "" "${url}"`, { windowsHide: true });
  } catch {
    /* 打不开浏览器不影响服务 */
  }
}

function banner(port) {
  const url = `http://localhost:${port}/`;
  console.log('+--------------------------------------------+');
  console.log('|  AI Dou Dizhu  -  local server is running   |');
  console.log('+--------------------------------------------+');
  console.log(`  Game URL : ${url}`);
  console.log('  Stop     : Ctrl+C\n');
  return url;
}

/**
 * 端口上已经有一份本项目的服务在跑吗？
 * 用来避免"反复点 start.bat → 攒出一堆服务器和一堆终端、游戏被打开好几遍"
 */
function probeRunning(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/__ddz', timeout: 700 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          resolve(res.statusCode === 200 && body.includes(INSTANCE_TAG) ? port : 0);
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

/** 从起始端口往后找一份已经在跑的自己 */
async function findRunning() {
  for (let i = 0; i <= MAX_PORT_TRIES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await probeRunning(START_PORT + i);
    if (hit) return hit;
  }
  return 0;
}

/**
 * 只播报一次
 * Node 的 server.listen(port, host, cb) 会给每一次调用都挂一个 listening 回调，
 * 端口被占用而逐个重试时，这些回调会**全部**在最后一次成功时触发 ——
 * 于是横幅打印 N 遍、浏览器被打开 N 遍（用户看到的就是"点一次开了三遍游戏"）。
 */
let announced = false;

function listen(port, triesLeft) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`[server] port ${port} is busy, trying ${port + 1} ...`);
      listen(port + 1, triesLeft - 1);
      return;
    }
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(port, '127.0.0.1', () => {
    // 成功了就把这个 error 监听摘掉，免得以后任何运行时错误都被报成"启动失败"
    server.removeListener('error', onError);
    if (announced) return;
    announced = true;
    // 端口必须从 server.address() 读，不能用在闭包里传进来的 port：
    // 重试过端口时，先触发的那个回调闭包里装的还是最初那个（会报出错误的 URL）
    const actual = (server.address() || {}).port || port;
    openBrowser(banner(actual));
  });
}

async function main() {
  const running = await findRunning();
  if (running) {
    console.log(`[server] already running on port ${running} - reusing it, no extra server started.`);
    openBrowser(`http://localhost:${running}/`);
    // 让窗口停一下好让人看清这句话，然后自己退出：不留多余的服务和终端
    setTimeout(() => process.exit(0), 900);
    return;
  }
  listen(START_PORT, MAX_PORT_TRIES);
}

void main();
