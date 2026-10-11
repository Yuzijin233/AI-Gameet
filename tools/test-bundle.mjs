/**
 * 单文件版打包器测试（node tools/test-bundle.mjs）
 *
 * 盯三件事：
 *   1. 打包器能把 75 个模块合成**一个经典脚本**（没有残留 import/export、语法正确）
 *   2. 这个脚本**真的能跑起来**：用 DOM 桩把它 eval 进 Node，应用对象该有的都在
 *   3. 关键链路真调一遍（开局、引擎、记忆、友圈…），证明合并没有把模块拆坏
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'tmp-test-bundle', 'game.js');
let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };

/* ---------------- 1) 打包 ---------------- */
console.log('-- 打包器');
{
  rmSync(join(root, 'tmp-test-bundle'), { recursive: true, force: true });
  mkdirSync(join(root, 'tmp-test-bundle'), { recursive: true });
  let out = '';
  try {
    out = execFileSync(process.execPath, [join(root, 'tools/bundle.mjs'), OUT], { encoding: 'utf8' });
  } catch (e) {
    ok(false, `打包器跑失败：${e && e.message}`);
  }
  ok(existsSync(OUT), '生成了单文件 game.js');
  const src = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  ok(/打包完成：\d+ 个模块/.test(out), `打包器自报：${(out.split('\n')[0] || '').trim()}`);
  ok(/\d+ 个模块/.test(out) && !/找不到模块|没覆盖到/.test(out), '没有报"找不到模块 / 没覆盖到的写法"');
  // 结果里不该再有 ESM 语法（行首的 import/export）
  ok(!/^[ \t]*(import|export)\s+/m.test(src), '★ 产物里没有残留的 import / export');
  ok(/__defs\["m\d+"\]/.test(src), '模块用短 id（m0/m1…）登记');
  ok(!/__defs\["src\//.test(src) && !/__req\("src\//.test(src), '★ 产物里看不到源码路径（src/ai/... 不外泄目录结构）');
  ok(/__req\("m\d+"\)/.test(src), '产物最后会执行入口');
  ok(/__AI_GAMEET__/.test(src), '留了 window.__AI_GAMEET__ 调试把手');
  // 语法自检（node --check）
  try {
    execFileSync(process.execPath, ['--check', OUT], { stdio: 'ignore' });
    ok(true, '');
  } catch (e) {
    ok(false, `产物语法检查失败：${e && e.message}`);
  }
}

/* ---------------- 2) 万能 DOM 桩（和 test-app-smoke 同一套思路） ---------------- */
function makeStub(name = 'node') {
  const fn = function () { return makeStub(name); };
  const bag = {
    name, length: 0, dataset: {}, files: [], value: '', hidden: false, disabled: false,
    textContent: '', src: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  bag.style = new Proxy({ setProperty() {}, removeProperty() {}, getPropertyValue: () => '' }, {
    get(t, k) { return k in t ? t[k] : ''; },
    set(t, k, v) { t[k] = v; return true; },
  });
  return new Proxy(fn, {
    get(t, k) {
      if (k === 'toString' || k === Symbol.toPrimitive) return () => `<${name}>`;
      if (k === 'then') return undefined;
      if (k === 'querySelectorAll') return () => [];
      if (k === 'querySelector') return () => makeStub('child');
      if (k === 'appendChild' || k === 'append' || k === 'prepend') return () => makeStub('child');
      if (k === 'addEventListener' || k === 'removeEventListener') return () => {};
      if (k === 'focus' || k === 'select' || k === 'click' || k === 'remove') return () => {};
      if (k === 'getContext') return () => makeStub('ctx');
      if (k === 'getBoundingClientRect') return () => ({ width: 100, height: 100, top: 0, left: 0 });
      if (k in bag) return bag[k];
      bag[k] = makeStub(`${name}.${String(k)}`);
      return bag[k];
    },
    set(t, k, v) { bag[k] = v; return true; },
    apply() { return makeStub(name); },
  });
}

const documentStub = makeStub('document');
documentStub.getElementById = (id) => makeStub(`#${id}`);
documentStub.querySelector = () => makeStub('q');
documentStub.querySelectorAll = () => [];
documentStub.createElement = (tag) => makeStub(tag);
documentStub.body = makeStub('body');
documentStub.documentElement = makeStub('html');
documentStub.readyState = 'complete';

globalThis.document = documentStub;
globalThis.window = makeStub('window');
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', language: 'zh-CN' }, configurable: true }); } catch { /* ignore */ }
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame = () => {};
globalThis.AudioContext = function () { return makeStub('audio'); };
globalThis.webkitAudioContext = globalThis.AudioContext;
globalThis.Audio = function () { return makeStub('audioEl'); };
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
globalThis.location = { protocol: 'http:', href: 'http://localhost:5176/' };
globalThis.speechSynthesis = makeStub('speechSynthesis');
globalThis.Image = function () { return makeStub('img'); };
globalThis.CustomEvent = function (t, o) { return { type: t, detail: o && o.detail }; };
globalThis.Event = globalThis.CustomEvent;
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => { timers.push({ fn, ms, rest }); return timers.length; };

/* ---------------- 3) 把产物跑起来 ---------------- */
console.log('-- 产物能不能跑');
let HOOK = null;
{
  const src = readFileSync(OUT, 'utf8');
  let err = null;
  try {
    // eslint-disable-next-line no-new-func
    new Function(src)();
  } catch (e) { err = e; }
  ok(!err, `★ 单文件脚本能执行（没有任何 ReferenceError/TypeError）${err ? `：${err.message}` : ''}`);

  HOOK = globalThis.__AI_GAMEET__ || (globalThis.window && globalThis.window.__AI_GAMEET__);
  ok(!!HOOK, '★ 挂上了 window.__AI_GAMEET__（说明模块图跑通了）');
  const app = HOOK && HOOK.app;
  ok(!!app, '★ 拿得到 app 实例');
  if (app) {
    ok(typeof app.boot === 'function' && typeof app.showScreen === 'function', 'app 的关键方法都在');
    ok(typeof app.startGomoku === 'function' && typeof app.settleFriendChat === 'function', '五子棋与私聊沉淀也在');
    ok(!!app.save && typeof app.save === 'object', '存档对象在');
    ok(app.playerName === '玩家' || typeof app.playerName === 'string', `playerName 正常（${app.playerName}）`);
    // 真调几个入口（模块拆坏的话这里会炸）
    let callErr = null;
    try {
      app.applySettings();
      app.updateFriendDot();
      app.refreshLobby();
      app.openChat();
      app.selectLobbyGame('gomoku');
      app.selectLobbyGame('fishing');
      app.selectLobbyGame('ddz');
    } catch (e) { callErr = e; }
    ok(!callErr, `★ 真调入口不抛错${callErr ? `：${callErr.message}` : ''}`);
  }
}

/* ---------------- 4) 关键逻辑抽查（证明合并没拆坏依赖） ---------------- */
console.log('-- 抽查关键逻辑');
{
  const app = HOOK && HOOK.app;
  ok(!!app, '拿得到 app');
  const checks = [];
  if (app) {
    // 五子棋：从场次池抽人 + 难度取自人设
    for (const roomId of ['low', 'mid', 'high']) {
      try {
        app.mode = 'ai';
        app.startGomoku(roomId, null);
        checks.push(!!app.gomokuPersona && !!app.gomoku);
        if (app.gomoku) app.gomoku.destroy();
      } catch (e) { checks.push(false); }
    }
  }
  ok(checks.length === 3 && checks.every(Boolean), '★ 五子棋三个场次都能开局（依赖链完整）');
}

/* ---------------- 清理 ---------------- */
rmSync(join(root, 'tmp-test-bundle'), { recursive: true, force: true });
globalThis.setTimeout = realSetTimeout;

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '单文件版打包检查通过'}`);
process.exit(fail ? 1 : 0);
