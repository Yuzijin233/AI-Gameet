/**
 * 绿色版服务端（serve.ps1，PowerShell / HttpListener）的验收测试。
 *
 * 关键点：**绝不碰工作区里真实的 save/**。
 * 测试先把 serve.ps1 复制到一个临时目录（tmp-serve-test/），在那里准备
 * save/ 和几个假静态文件，然后从那个目录启动服务 —— 落盘全部落在临时目录里。
 *
 * 覆盖：
 *   /__ddz 身份牌 / 静态文件与 MIME / 音频 Range 206 / 404
 *   POST /api/save 原样落盘（缩进 JSON、UTF-8 无 BOM、不含 memoryMd）
 *   POST /api/memory 写两份记忆清单（中文文件名正确）
 *   GET  /api/save 读回
 *   POST /api/chat 没有 key 时报错但不崩
 *   HEAD 不返回 body
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'tmp-serve-test');
const PORT = 5399;
const BASE = `http://localhost:${PORT}`;
const MEM_MD = path.join(TMP, 'save', 'AI记忆.md');
const MEM_JSON = path.join(TMP, 'save', 'AI记忆.json');
const SAVE_FILE = path.join(TMP, 'save', 'ddz_save.json');

let pass = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  [ok] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${extra ? ` -> ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepare() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'save'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'serve.ps1'), path.join(TMP, 'serve.ps1'));
  fs.writeFileSync(path.join(TMP, 'index.html'), '<!doctype html><title>green</title>\n', 'utf8');
  fs.writeFileSync(path.join(TMP, 'game.js'), 'window.__AI_GAMEET__ = { app: 1 };\n', 'utf8');
  // 假的音频：只要 1000 个字节，用来验证 MIME + Range
  fs.writeFileSync(path.join(TMP, 'song.mp3'), Buffer.alloc(1000, 7));
}

async function waitUp(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/__ddz`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

async function main() {
  prepare();
  console.log('serve.ps1 服务端验收');
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'serve.ps1', '-Port', String(PORT), '-NoOpen'], {
    cwd: TMP,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  try {
    const up = await waitUp();
    ok('服务能启动并响应 /__ddz', up, out.slice(-400));
    if (!up) return;

    const tag = await (await fetch(`${BASE}/__ddz`)).json();
    ok('/__ddz 身份牌正确', tag.app === 'ai-gameet-green-v1' && tag.port === PORT, JSON.stringify(tag));

    // ---- 静态文件
    const html = await fetch(`${BASE}/`);
    ok('GET / 返回 index.html', html.status === 200 && (await html.text()).includes('green'));
    ok('index.html 的 MIME 是 text/html', (html.headers.get('content-type') || '').startsWith('text/html'));
    const js = await fetch(`${BASE}/game.js`);
    ok('GET /game.js 200 + text/javascript', js.status === 200 && (js.headers.get('content-type') || '').startsWith('text/javascript'));
    const nf = await fetch(`${BASE}/nope.txt`);
    ok('不存在的文件 404', nf.status === 404);
    const esc = await fetch(`${BASE}/../server.js`);
    ok('目录穿越被挡住（404/403）', esc.status === 404 || esc.status === 403, String(esc.status));

    // ---- 音频 Range
    const head = await fetch(`${BASE}/song.mp3`, { method: 'HEAD' });
    ok('音频 HEAD 200 + audio/mpeg', head.status === 200 && head.headers.get('content-type') === 'audio/mpeg');
    ok('音频带 Accept-Ranges + inline', head.headers.get('accept-ranges') === 'bytes' && head.headers.get('content-disposition') === 'inline');
    const range = await fetch(`${BASE}/song.mp3`, { headers: { Range: 'bytes=0-99' } });
    const rb = Buffer.from(await range.arrayBuffer());
    ok('Range 请求返回 206', range.status === 206, String(range.status));
    ok('Range 长度/头部正确', rb.length === 100 && range.headers.get('content-range') === 'bytes 0-99/1000', range.headers.get('content-range') || '');
    const tail = await fetch(`${BASE}/song.mp3`, { headers: { Range: 'bytes=-50' } });
    ok('后缀 Range（bytes=-50）也能用', tail.status === 206 && (await tail.arrayBuffer()).byteLength === 50);

    // ---- 存档落盘
    const save = {
      version: 1,
      beans: 12000,
      friends: [{ personaId: 'p05', name: '林晚', memory: [{ text: '喜欢下雨天' }], affinity: 7 }],
      recentHands: [],
      nested: { empty: [], single: ['a'] },
    };
    const pretty = `${JSON.stringify({ ...save, savedAt: '2025-01-02T03:04:05.000Z' }, null, 2)}\n`;
    const post = await fetch(`${BASE}/api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pretty });
    const postBody = await post.json();
    ok('POST /api/save 成功', post.status === 200 && postBody.ok === true, JSON.stringify(postBody));
    const written = fs.readFileSync(SAVE_FILE, 'utf8');
    ok('存档原样落盘（一字不改）', written === pretty, JSON.stringify(written.slice(0, 120)));
    const raw = fs.readFileSync(SAVE_FILE);
    ok('存档 UTF-8 无 BOM', !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));
    const back = JSON.parse(written);
    ok('空数组没被改成 null / 单元素数组还是数组', Array.isArray(back.nested.empty) && Array.isArray(back.nested.single) && back.nested.single[0] === 'a', JSON.stringify(back.nested));

    const bad = await fetch(`${BASE}/api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    ok('非存档 body 被拒（400）', bad.status === 400);
    const badJson = await fetch(`${BASE}/api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    ok('坏 JSON 被拒（400）', badJson.status === 400);

    // ---- 记忆清单
    const mdText = '# AI 记忆\n\n## p05（林晚）\n- 喜欢下雨天\n';
    const jsonText = JSON.stringify({ p05: { name: '林晚' } }, null, 2);
    const mem = await fetch(`${BASE}/api/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ md: mdText, json: jsonText }) });
    ok('POST /api/memory 成功', mem.status === 200 && (await mem.json()).files === 2);
    ok('AI记忆.md 文件名与内容正确', fs.existsSync(MEM_MD) && fs.readFileSync(MEM_MD, 'utf8') === mdText);
    ok('AI记忆.json 文件名与内容正确', fs.existsSync(MEM_JSON) && JSON.parse(fs.readFileSync(MEM_JSON, 'utf8')).p05.name === '林晚');

    // ---- 读回
    const got = await (await fetch(`${BASE}/api/save`)).json();
    ok('GET /api/save 能读回', got.ok === true && got.save.beans === 12000 && typeof got.mtime === 'number', JSON.stringify(got).slice(0, 160));

    // ---- 聊天代理（没有 key）
    const chat = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"deepseek-flash","messages":[]}' });
    const chatText = await chat.text();
    ok('没有 key 的 /api/chat 报错但不崩', chat.status === 500 && chatText.includes('no api key'), `${chat.status} ${chatText.slice(0, 80)}`);
    const stillAlive = await fetch(`${BASE}/__ddz`);
    ok('报错之后服务还在', stillAlive.status === 200);

    // ---- 兼容老客户端：memoryMd 内联在存档里
    const legacy = { ...save, savedAt: 'x', memoryMd: '# 老\n', memoryJson: '{"old":1}' };
    const lp = await fetch(`${BASE}/api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(legacy) });
    ok('内联 memoryMd 的老客户端仍可用', lp.status === 200);
    const written2 = fs.readFileSync(SAVE_FILE, 'utf8');
    ok('内联字段被摘出存档', !written2.includes('memoryMd') && !written2.includes('memoryJson'));
    ok('内联记忆写进了 AI记忆.md', fs.readFileSync(MEM_MD, 'utf8').includes('# 老'));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(400);
  }
}

await main();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) { console.log('失败：' + failures.join(' | ')); process.exit(1); }
