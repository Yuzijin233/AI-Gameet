/**
 * 单文件打包器：把 `src/**` 的 75 个 ES 模块合成**一个经典脚本**（零依赖，自己写）
 *
 *   node tools/bundle.mjs [输出路径]
 *
 * 为什么要自己写：项目是零依赖 + 离线环境，装不了 rollup/esbuild；
 * 而这份代码正好适合手写打包（实测）：
 *   · 只有静态 import，**没有** `export default`、没有 `export *`、没有动态 import
 *   · **没有循环依赖** → 按依赖顺序合并即可
 *   · 顶层重名（sanitize×6、sleep×3…）**不影响**：每个模块包在独立函数作用域里
 *
 * 产出的东西长这样（模块各自一个作用域，导入靠解构，导出靠 return）：
 *   const __defs = {}; const __cache = {};
 *   function __req(id) { ... }
 *   __defs['src/data/x.js'] = function () {
 *     const { a } = __req('src/store/y.js');   // ← 由 import 行改写而来
 *     ...模块正文（export 关键字已剥掉）...
 *     return { a, b };                          // ← 由 export 列表生成
 *   };
 *   __req('src/main.js');                       // 入口：跑起来
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = 'src/main.js';
const OUT = process.argv[2] || join(ROOT, 'tmp-bundle/game.js');

const posix = (p) => p.split(sep).join('/');
const resolveId = (fromRel, spec) => posix(join(dirname(fromRel), spec)).replace(/^\.\//, '');

/** 读一个模块的源码 */
function readModule(id) {
  const full = join(ROOT, id);
  if (!existsSync(full)) throw new Error(`打包时找不到模块：${id}`);
  return readFileSync(full, 'utf8');
}

/**
 * 改写一个模块：
 *   · import  → 顶部解构（或直接 __req 一次）
 *   · export  → 剥掉关键字，并记下导出名
 * @returns {{id:string, code:string, deps:string[], exports:string[]}}
 */
function transform(id) {
  const src = readModule(id);
  const deps = [];
  const exports = new Set();
  /**
   * 转发导出（`export { x } from './y.js'`）单独记着，**不在模块里建局部变量** ——
   * 否则会和同名的 import 撞车（matchSummary.js 就同时 import 和转发 neutralizeSummary，
   * 直接解构会 "Identifier has already been declared"）。
   */
  const forward = [];
  /**
   * 归一化：有的文件写成 `/** 群聊 *\/export const GROUP = {`（注释和 export 同一行），
   * 行首锚定的规则会漏掉它 —— 先在 `*\/` 后面补个换行。
   */
  let out = src.replace(/\*\/[ \t]*(export|import)\s+/g, '*/\n$1 ');

  // ① `export { a, b as c };`（含 `export { x } from './y.js';`）
  out = out.replace(/^export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?\s*;?/gm, (all, names, from) => {
    const list = names.split(',').map((s) => s.trim()).filter(Boolean);
    const pairs = list.map((s) => {
      const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s);
      return m ? { local: m[1], exported: m[2] || m[1] } : null;
    }).filter(Boolean);
    if (from) {
      // 转发导出：**不要**加进"本模块自己的导出名"，否则会生成一个没声明的变量
      const dep = resolveId(id, from);
      deps.push(dep);
      forward.push({ dep, pairs });
      return '';
    }
    for (const p of pairs) exports.add(p.exported);
    return ''; // 纯本地导出：只记名字，代码不用动
  });

  // ② `export const/let/var/function/class/async function`
  out = out.replace(/^export\s+(const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/gm,
    (all, kind, name) => { exports.add(name); return `${kind} ${name}`; });

  // ③ 副作用 import：`import './x.js';`
  out = out.replace(/^import\s+['"]([^'"]+)['"]\s*;?/gm, (all, spec) => {
    const dep = resolveId(id, spec);
    deps.push(dep);
    return `__req('${dep}');`;
  });

  // ④ 带 from 的 import（可能跨多行）
  out = out.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm, (all, clause, spec) => {
    const dep = resolveId(id, spec);
    deps.push(dep);
    const c = clause.trim();
    if (c.startsWith('*')) { // import * as ns
      const ns = c.replace(/^\*\s+as\s+/, '').trim();
      return `const ${ns} = __req('${dep}');`;
    }
    const brace = /^\{([\s\S]*)\}$/.exec(c);
    if (brace) {
      const list = brace[1].split(',').map((s) => s.trim()).filter(Boolean);
      const bind = list.map((s) => {
        const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s);
        return m ? (m[2] ? `${m[1]}: ${m[2]}` : m[1]) : s;
      }).join(', ');
      return `const { ${bind} } = __req('${dep}');`;
    }
    // 默认导入（本项目没有，留个兜底）
    return `const ${c} = __req('${dep}').default;`;
  });

  // ⑤ 兜底：还有没处理的 export / import 就直接报错（别悄悄打错包）
  const leftover = out.match(/^[ \t]*(export|import)\s+/m);
  if (leftover) {
    throw new Error(`${id} 里还有没覆盖到的 ${leftover[1]} 写法，请先看 tools/bundle.mjs 的规则`);
  }
  // `import.meta` 在经典脚本里没有，出现就直接报错（本项目当前没有）
  if (/import\s*\.\s*meta/.test(out)) throw new Error(`${id} 用了 import.meta，单文件版不支持`);

  return { id, code: out, deps, exports: [...exports], forward };
}

/** 从入口出发，按依赖顺序（后序 DFS）把模块排好 */
function collect(entry) {
  const seen = new Map();
  const order = [];
  const stack = new Set();
  function visit(id) {
    if (seen.has(id)) return;
    if (stack.has(id)) throw new Error(`出现循环依赖（单文件版不支持）：${id}`);
    stack.add(id);
    const mod = transform(id);
    seen.set(id, mod);
    for (const d of mod.deps) visit(d);
    stack.delete(id);
    order.push(mod);
  }
  visit(entry);
  return order;
}

const mods = collect(ENTRY);
/**
 * 模块 id → m0 / m1 / m2…：产物是给玩家看的，没必要把
 * `src/ai/chat.js`、`src/store/storage.js` 这种目录结构原样印在里面。
 * （不是保密手段 —— 代码本身还是可读的 —— 只是别一眼就把源码树读出来。）
 */
const shortIds = new Map(mods.map((m, i) => [m.id, `m${i}`]));
const sid = (id) => shortIds.get(id) || id;
/** 模块代码里的 __req('路径') 全部换成短 id */
const rewriteReqs = (code) => code.replace(/__req\('([^']+)'\)/g, (s, p) => `__req('${sid(p)}')`);

const parts = [];
parts.push('/* AI-Gameet · 打包产物（自动生成，请勿手改） */');
parts.push('(function () {');
parts.push("'use strict';");
parts.push('var __defs = {};');
parts.push('var __cache = {};');
parts.push('function __req(id) {');
parts.push('  if (__cache[id]) return __cache[id];');
parts.push("  var def = __defs[id];");
parts.push("  if (!def) throw new Error('module not found: ' + id);");
parts.push('  var exp = {};');
parts.push('  __cache[id] = exp;');
parts.push('  var got = def();');
parts.push('  for (var k in got) if (Object.prototype.hasOwnProperty.call(got, k)) exp[k] = got[k];');
parts.push('  return exp;');
parts.push('}');

let totalExports = 0;
for (const m of mods) {
  totalExports += m.exports.length;
  parts.push(`__defs[${JSON.stringify(sid(m.id))}] = function () {`);
  parts.push(rewriteReqs(m.code).trim());
  const own = `{ ${m.exports.join(', ')} }`;
  if (m.forward.length) {
    // 转发导出：从目标模块取过来挂上（用 assign，避免局部重名）
    const maps = m.forward.map(({ dep, pairs }) => {
      const inner = pairs.map((p) => `${p.exported}: __req(${JSON.stringify(sid(dep))}).${p.local}`).join(', ');
      return own === '{  }' ? `{ ${inner} }` : `Object.assign(${own}, { ${inner} })`;
    });
    parts.push(`return ${maps.join('; return ')};`);
  } else {
    parts.push(`return ${own};`);
  }
  parts.push('};');
}
parts.push(`__req(${JSON.stringify(sid(ENTRY))});`);
/** 给自动化测试/排查留个把手（单文件版没有 ESM 导出，只能挂到 window 上） */
parts.push('try {');
parts.push(`  var __app = __req(${JSON.stringify(sid('src/ui/app.js'))});`);
parts.push('  (typeof window !== "undefined" ? window : globalThis).__AI_GAMEET__ = {');
parts.push('    app: __app.app,');
parts.push(`    version: __req(${JSON.stringify(sid('src/config.js'))}).CONFIG.version || '',`);
parts.push('  };');
parts.push('} catch (e) { /* 忽略：不影响游戏 */ }');
parts.push('})();');

const bundle = `${parts.join('\n')}\n`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bundle, 'utf8');
console.log(`打包完成：${mods.length} 个模块 → ${OUT}`);
console.log(`大小：${(Buffer.byteLength(bundle) / 1024).toFixed(0)} KB｜导出符号 ${totalExports} 个`);
