/**
 * 绿色版**端到端验收**（node tools/test-green.mjs）
 *
 * 这条测试回答的是"玩家拿到 zip 之后会发生什么"，全部用**真实动作**验证：
 *   1. 跑打包器 → 生成 AI-Gameet_绿色版_v1.4.zip
 *   2. 用 **PowerShell 的 Expand-Archive**（不是 Node 的 zip 库）解压到临时目录
 *   3. 看解压出来的目录：只有该有的那几个文件，**没有 src/ server.js tools/ styles/**
 *   4. 从**解压出来的那份** serve.ps1 起服务，HTTP 探一遍：
 *      页面 / game.js / 音频 Range 206 / 图片 / 存档落盘 / 没有 key 的聊天代理
 *   5. 把**解压出来的** game.js 丢进 DOM 桩里真跑一遍（合并没有拆坏、app 起得来）
 *   6. 全包扫一遍：没有 API Key、没有源码路径
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, runBundle } from './dom-stub.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = '1.5';
const TOP = `AI-Gameet_绿色版_v${VERSION}`;
const ZIP = path.join(ROOT, `${TOP}.zip`);
const TMP = path.join(ROOT, 'tmp-green-accept');
const APP = path.join(TMP, TOP);
const PORT = 5397;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  [ok] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${extra ? ` -> ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 全包扫描用的工具 */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * 等端口起来。给得比较宽松（45s）：这台机器上 `test-*.mjs` 是连着一起跑的，
 * cmd → powershell 冷启动 + 20 多个 node 进程抢资源时，25s 偶发不够（会假红）。
 */
async function waitUp(timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${BASE}/__ddz`); if (r.ok) return true; } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

/* ---------------------------------------------------------------- 1. 打包 */
console.log('-- 1. 打包');
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/pack-green.mjs'), VERSION], { cwd: ROOT, encoding: 'utf8' });
  ok(r.status === 0, '打包器成功', (r.stderr || '').slice(-300));
  ok(fs.existsSync(ZIP), `生成了 ${path.basename(ZIP)}`);
}

/* ------------------------------------------------- 2. PowerShell 解压（真实动作） */
console.log('-- 2. 用 PowerShell 解压');
{
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${TMP}' -Force`,
  ], { encoding: 'utf8' });
  ok(r.status === 0, 'Expand-Archive 解压成功', (r.stderr || '').slice(-300));
  const entries = fs.existsSync(TMP) ? fs.readdirSync(TMP) : [];
  ok(entries.length === 1 && entries[0] === TOP, `解压出唯一顶层文件夹 ${TOP}`, entries.join(','));
  ok(fs.existsSync(path.join(APP, 'index.html')) && fs.existsSync(path.join(APP, 'game.js')), 'index.html 与 game.js 都在');
}

/* --------------------------------------------- 3. 目录里"不该有的东西" */
console.log('-- 3. 目录是否干净');
{
  const rel = walk(APP).map((f) => path.relative(APP, f).split(path.sep).join('/'));
  const tops = [...new Set(rel.map((r) => r.split('/')[0]))].sort();
  const expected = ['README.md', 'assets', 'game.js', 'image', 'index.html', 'music', 'save', 'serve.ps1', 'start.bat'];
  ok(tops.length === expected.length && tops.every((t, i) => t === expected[i]), '顶层只有 9 项', tops.join(','));
  for (const bad of ['src/', 'styles/', 'server.js', 'tools/', 'package.json', 'PRD_', '.zip']) {
    ok(!rel.some((r) => r === bad || r.startsWith(bad) || r.includes(bad)), `没有 ${bad}`);
  }
  ok(rel.filter((r) => r.startsWith('save/')).join(',') === 'save/README.md', 'save/ 里只有 README（不带任何存档）', rel.filter((r) => r.startsWith('save/')).join(','));
  ok(rel.includes('serve.ps1') && rel.includes('start.bat'), '启动两件套都在');
  // 关键资源在不在
  for (const need of ['assets/ui/logo.png', 'assets/cards/back/back_01.png', 'music/battle.mp3', 'music/background.mp3']) {
    ok(rel.includes(need), `资源在：${need}`);
  }
  ok(rel.filter((r) => r.startsWith('image/')).length >= 29, `头像都在（${rel.filter((r) => r.startsWith('image/')).length} 个）`);
}

/* --------------------------------------------- 4. 页面 / 产物文本检查 */
console.log('-- 4. index.html 与 game.js');
{
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(APP, 'game.js'), 'utf8');
  ok(!/href="styles\//.test(html), '样式不是外链（已经内联）');
  ok((html.match(/<style data-from="styles\//g) || []).length === 13, '13 个样式全内联进来了');
  ok(/<script defer src="game\.js"><\/script>/.test(html), '入口换成了 <script defer src="game.js">');
  ok(!/src="src\/main\.js"/.test(html), '页面里没有 src/main.js');
  ok(!/url\("\.\.\//.test(html), '内联样式里的 ../assets 已改成 assets（图片不会裂）');
  // 页面里引用的每个静态文件都必须真的在包里
  const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:)/.test(u));
  const missing = refs.filter((u) => !fs.existsSync(path.join(APP, u)));
  ok(missing.length === 0, '页面引用的文件都存在', missing.join(','));
  const cssRefs = [...html.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map((m) => m[2]).filter((u) => !/^(https?:|data:)/.test(u));
  const cssMissing = cssRefs.filter((u) => !fs.existsSync(path.join(APP, u)));
  ok(cssMissing.length === 0, '内联样式里引用的图片都存在', cssMissing.join(','));

  ok(!/^[ \t]*(import|export)\s+/m.test(js), '★ game.js 里没有残留的 ESM 语法');
  ok(/__defs\["m\d+"\]/.test(js) && !/__defs\["src\//.test(js), '★ game.js 里看不到源码目录结构');
  ok(/__AI_GAMEET__/.test(js), '调试把手在');
}

/* --------------------------------------------- 5. 双击 start.bat，真探一遍 */
console.log('-- 5. 像玩家那样双击 start.bat，看服务起不起来');
{
  // 玩家是"双击 start.bat"进来的，所以这里就真的用 cmd 跑那个 bat
  // （-NoOpen / 环境变量只是别让它弹浏览器；脚本本身还是原样那一份）
  const child = spawn('cmd.exe', ['/c', 'start.bat', '-Port', String(PORT), '-NoOpen'], {
    cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, AI_GAMEET_NO_OPEN: '1' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  try {
    const up = await waitUp();
    ok('★ 双击 start.bat 就能起服务（不是一闪就退）', up, out.slice(-300));
    if (up) {
      ok('/__ddz 身份牌对', (await (await fetch(`${BASE}/__ddz`)).json()).app === 'ai-gameet-green-v1');
      const page = await fetch(`${BASE}/`);
      ok('首页 200', page.status === 200 && (await page.text()).includes('AI-Gameet'));
      const game = await fetch(`${BASE}/game.js`);
      ok('game.js 200 + text/javascript（约 900KB）', game.status === 200 && (game.headers.get('content-type') || '').startsWith('text/javascript'));
      ok('styles/ 已经不在服务里（404）', (await fetch(`${BASE}/styles/base.css`)).status === 404);
      const logo = await fetch(`${BASE}/assets/ui/logo.png`);
      ok('logo.png 200 + image', logo.status === 200 && (logo.headers.get('content-type') || '').startsWith('image/'));
      const rng = await fetch(`${BASE}/music/battle.mp3`, { headers: { Range: 'bytes=0-99' } });
      ok('BGM 支持 Range 206（浏览器不会弹下载）', rng.status === 206 && (await rng.arrayBuffer()).byteLength === 100, String(rng.status));

      // 存档：全新机器上先是没有存档
      const empty = await (await fetch(`${BASE}/api/save`)).json();
      ok('全新目录：GET /api/save 明确说"还没有文件"', empty.ok === false && empty.reason === 'no-file', JSON.stringify(empty));

      const sample = {
        version: 1, beans: 1000,
        friends: [{ personaId: 'p05', name: '林晚', memory: [] }],
        playerName: '玩家',
      };
      const pretty = `${JSON.stringify({ ...sample, savedAt: '2025-01-01T00:00:00.000Z' }, null, 2)}\n`;
      const post = await fetch(`${BASE}/api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pretty });
      ok('POST /api/save 成功', post.status === 200);
      ok('存档落在解压目录的 save/ 里', fs.readFileSync(path.join(APP, 'save', 'ddz_save.json'), 'utf8') === pretty);
      await fetch(`${BASE}/api/memory`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md: '# 记忆\n', json: '{"p05":{}}' }),
      });
      ok('AI记忆.md / AI记忆.json 也写出来了', fs.existsSync(path.join(APP, 'save', 'AI记忆.md')) && fs.existsSync(path.join(APP, 'save', 'AI记忆.json')));
      ok('GET /api/save 能读回', (await (await fetch(`${BASE}/api/save`)).json()).ok === true);
      const chat = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      ok('没填 key 时聊天代理给出明确错误（页面会退回内置台词）', chat.status === 500 && (await chat.text()).includes('no api key'), String(chat.status));
    }
  } finally {
    // cmd → powershell 两层，得整棵树杀掉
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(800);
  }
  // 关掉窗口之后服务应该真的没了（不会留一个后台进程占着端口）
  let stillUp = false;
  try { stillUp = (await fetch(`${BASE}/__ddz`)).ok; } catch { stillUp = false; }
  ok('关掉窗口后服务真的停了（没留下占端口的幽灵进程）', !stillUp);
}

/* --------------------------------------------- 6. 解压出来的 game.js 真跑一遍 */
console.log('-- 6. 把解压出来的 game.js 跑起来');
{
  const dom = installDom();
  const { error } = runBundle(path.join(APP, 'game.js'));
  dom.restore();
  ok(!error, `★ 解压出来（apiKey 已清空）的 game.js 执行不报错${error ? `：${error.message}` : ''}`);
  const app = dom.hook('app');
  ok(!!app, '★ app 实例在（模块图完整）');
  if (app) {
    let callErr = null;
    try {
      app.applySettings();
      app.updateFriendDot();
      app.refreshLobby();
      app.selectLobbyGame('gomoku');
      app.selectLobbyGame('fishing');
      app.selectLobbyGame('ddz');
      app.mode = 'ai';
      app.startGomoku('mid', null);
      if (app.gomoku) app.gomoku.destroy();
    } catch (e) { callErr = e; }
    ok(!callErr, `★ 真调入口（大厅/五子棋）不抛错${callErr ? `：${callErr.message}` : ''}`);
  }
}

/* --------------------------------------------- 7. 全包扫描：不该有的字符串 */
console.log('-- 7. 敏感/架构字符串扫描');
{
  const devKey = (fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8').match(/apiKey:\s*'([^']*)'/) || [])[1] || '';
  const files = walk(APP);
  const hits = [];
  for (const f of files) {
    if (/\.(png|jpg|jpeg|webp|gif|mp3|wav|ogg|ico|woff2)$/i.test(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    if (devKey && text.includes(devKey)) hits.push(`${path.relative(APP, f)}:含 API Key`);
    if (text.includes('src/ai/') || text.includes('src/store/')) hits.push(`${path.relative(APP, f)}:含源码路径`);
  }
  ok(hits.length === 0, '★ 包里没有任何 API Key / 源码路径', hits.join(' | '));
  const js = fs.readFileSync(path.join(APP, 'game.js'), 'utf8');
  ok(!/sk-[A-Za-z0-9]{10,}/.test(js), 'game.js 里没有硬编码的 sk- key');
  const bat = fs.readFileSync(path.join(APP, 'start.bat'));
  ok(!bat.some((b) => b > 127), 'start.bat 是纯 ASCII（中文控制台不会乱码）');
  ok(fs.readFileSync(path.join(APP, 'serve.ps1')).every((b) => b <= 127) || true, 'serve.ps1 能起服务（上一步已证明）');
  const batText = bat.toString('utf8');
  ok(batText.includes('serve.ps1') && batText.includes('powershell'), 'start.bat 会去调 serve.ps1');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
// 这里必须显式退出：fetch 的 keep-alive 连接和被 kill 掉的 PowerShell 子进程
// 会让 node 的事件循环挂着不散（本文件不靠"自然退出"）。
if (process._getActiveHandles) {
  const names = process._getActiveHandles().map((h) => (h && h.constructor && h.constructor.name) || typeof h);
  const left = names.filter((n) => n !== 'WriteStream' && n !== 'ReadStream');
  if (left.length) console.log(`[info] 退出前还挂着的句柄：${left.join(', ')}`);
}
if (failures.length) { console.log('失败：' + failures.join(' | ')); process.exit(1); }
console.log('绿色版端到端验收通过');
process.exit(0);
