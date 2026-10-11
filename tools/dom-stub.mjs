/**
 * 测试用的"万能 DOM 桩"：把单文件产物丢进 Node 里跑起来。
 *
 * 为什么需要它：这台机器上起不了真浏览器（见 README），所以
 * "合并后的 game.js 到底会不会炸"只能靠一个什么都不做、但**什么属性都点得动**
 * 的 Proxy 假 DOM 来验证。它能抓住 ReferenceError / TypeError / 逻辑顺序错误，
 * 抓不住"好不好看"。
 *
 * 用法：
 *   import { installDom } from './dom-stub.mjs';
 *   const dom = installDom();      // 装好全局 document/window/localStorage…
 *   new Function(src)();           // 跑产物
 *   const app = dom.hook('app');   // 取 window.__AI_GAMEET__.app
 *   dom.restore();
 */
import { readFileSync } from 'node:fs';

export function makeStub(name = 'node') {
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

export function installDom() {
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
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', language: 'zh-CN' }, configurable: true });
  } catch { /* ignore */ }
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

  // setTimeout 全部收集起来不执行：否则 BGM/动画的定时器会一直往后排，
  // 测试会变成"跑不完"。要手动跑某个回调就自己调 dom.timers[i].fn()。
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { timers.push({ fn, ms, rest }); return timers.length; };

  const hook = (key = 'app') => {
    const h = globalThis.__AI_GAMEET__ || (globalThis.window && globalThis.window.__AI_GAMEET__);
    return h ? h[key] : undefined;
  };
  const restore = () => { globalThis.setTimeout = realSetTimeout; };
  return { documentStub, timers, hook, restore };
}

/** 跑一个单文件产物，返回 { error, hook } */
export function runBundle(file) {
  const src = readFileSync(file, 'utf8');
  let error = null;
  try {
    // eslint-disable-next-line no-new-func
    new Function(src)();
  } catch (e) { error = e; }
  return { error, src };
}
