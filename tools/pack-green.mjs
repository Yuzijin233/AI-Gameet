/**
 * 打包**绿色版**：`node tools/pack-green.mjs 1.4` → `AI-Gameet_绿色版_v1.4.zip`
 *
 * 绿色版 = **接收方不需要装 Node.js / Python / 任何东西**：
 *   解压 → 双击 `start.bat` → 浏览器打开 http://localhost:5176/ → 开箱即玩。
 *   本地服务由 Windows 自带的 PowerShell（HttpListener）提供，见 `serve.ps1`：
 *     · 静态文件 + 音频 Range（语音、BGM 都正常）
 *     · POST /api/chat   代理 DeepSeek（key 从页面来，不落盘）
 *     · POST /api/save   存档镜像；POST /api/memory 记忆清单；GET /api/save 恢复
 *   localhost 是安全上下文，所以**麦克风（语音输入）也能用**。
 *
 * 包里的文件就这么多（**看不到 src/、server.js、tools/**，架构没法从目录猜出来）：
 *   index.html   —— 13 个 styles/*.css **已经内联**进来，只留一个 <script src="game.js">
 *   game.js      —— 75 个 ES 模块打成的**单个**经典脚本（tools/bundle.mjs 生成）
 *   assets/ image/ music/  —— 贴图 / 头像 / BGM（原样）
 *   start.bat serve.ps1 README.md  —— 启动器、本地服务、说明书
 *   save/README.md —— 存档目录（**不放存档**：每台机器从全新存档开始）
 *
 * 其它：
 *   · `src/config.js` 里的 apiKey 在**打包产物**里清空（工作区原文件不动）
 *   · `.bat` 用 CRLF，zip 内路径一律正斜杠
 *   · 不做加密：浏览器必须拿到明文才能跑，加密只是"看起来麻烦"，绿色版干脆不装
 *
 * ⚠️ 只写 zip 和 tmp-green/，工作区里的原文件一个都不动。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = (process.argv[2] || '1.4').replace(/^v/, '');
const GAME = process.argv[3] || 'AI-Gameet';
const TOP = `${GAME}_绿色版_v${VERSION}`;
const OUT = path.join(ROOT, `${TOP}.zip`);
const TMP = path.join(ROOT, 'tmp-green');

/** 原样搬进包里的目录 */
const COPY_DIRS = ['assets', 'image', 'music'];
/** 原样搬进包里的单文件 */
const COPY_FILES = ['serve.ps1'];

/* ===================================================================== */
/*                          手写 ZIP（无依赖）                            */
/* ===================================================================== */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** files: [{ name, data:Buffer }] → 写一个标准 zip */
function writeZip(outPath, files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12); // 时间 2020-01-01，保证可复现
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0, 42);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(outPath, Buffer.concat([...locals, centralBuf, end]));
}

/* ===================================================================== */
/*                              产物内容                                  */
/* ===================================================================== */

/** 1) 打过包的 game.js（apiKey 清空） */
function buildBundle() {
  const bundlePath = path.join(TMP, 'game.js');
  fs.mkdirSync(TMP, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/bundle.mjs'), bundlePath], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`bundle.mjs 失败：\n${r.stdout || ''}${r.stderr || ''}`);
  let js = fs.readFileSync(bundlePath, 'utf8');

  const config = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
  const key = (config.match(/apiKey:\s*'([^']*)'/) || [])[1] || '';
  if (key) {
    if (!js.includes(key)) throw new Error('打包产物里找不到 apiKey，清空逻辑要更新');
    js = js.split(key).join('');
  }
  if (key && js.includes(key)) throw new Error('apiKey 清空失败');
  return { js, key };
}

/** 2) index.html：内联全部 styles/*.css，把 module 入口换成 game.js */
function buildHtml() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  let inlined = 0;
  let bytes = 0;
  html = html.replace(/[ \t]*<link rel="stylesheet" href="(styles\/[^"]+\.css)"\s*\/>\r?\n/g, (m, href) => {
    const cssPath = path.join(ROOT, href);
    if (!fs.existsSync(cssPath)) throw new Error(`index.html 引用了不存在的样式：${href}`);
    // 样式原本在 styles/ 里，里面的 url("../assets/...") 是相对 styles/ 的；
    // 内联到根目录的 index.html 之后要把那层 ../ 去掉，否则图片全裂。
    const css = fs.readFileSync(cssPath, 'utf8').replace(/url\((['"]?)\.\.\//g, 'url($1');
    inlined += 1;
    bytes += Buffer.byteLength(css);
    return `<style data-from="${href}">\n${css.trim()}\n</style>\n`;
  });
  const entry = /[ \t]*<script type="module" src="src\/main\.js"><\/script>/;
  if (!entry.test(html)) throw new Error('index.html 里没有找到 src/main.js 入口');
  html = html.replace(entry, '  <script defer src="game.js"></script>');
  if (/href="styles\//.test(html) || /src="src\/main\.js"/.test(html)) throw new Error('index.html 里还有 styles/ 或 src/main.js 的引用');
  return { html, inlined, bytes };
}

/** 3) start.bat（**纯 ASCII + CRLF**：PS 5.1/中文控制台都不会乱码） */
const START_BAT = `@echo off
chcp 65001 >nul
title AI-Gameet - local server
cd /d "%~dp0"
echo.
echo   AI-Gameet is starting...
echo   A browser window will open at http://localhost:5176/
echo   Keep this window open while playing. Close it to stop.
echo.
set "PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
echo.
echo   Server stopped.
pause
`;

/** 4) save/README.md */
const SAVE_README = `# save — 存档镜像

游戏的主存档在**浏览器的 localStorage** 里（所以换浏览器/清缓存会看不到）。
每次存档都会顺手往这个目录写一份镜像，方便备份、翻看、手改：

| 文件 | 内容 |
| --- | --- |
| \`ddz_save.json\` | 完整存档（缩进过的 JSON，人能读） |
| \`AI记忆.md\` | 每个 AI 好友记住了什么（**给人读的**） |
| \`AI记忆.json\` | 只有记忆部分（好搜索、好 diff） |

- 存档丢了（清了浏览器数据 / 换了浏览器）：打开游戏，它会自动从这个目录拉回来。
- 想手动恢复：把 \`ddz_save.json\` 放回这里，然后刷新页面。
- 这个包里**故意不带存档**，所以每个人的第一局都是全新开始。
`;

/** 5) README.md */
function readme() {
  return `# ${GAME} · 社交-桌游平台（绿色版 v${VERSION}）

斗地主 / 小猫钓鱼 / 五子棋，对手都是会聊天、会记人、会怼人的 AI 人设。

## 怎么玩

1. 双击 **\`start.bat\`**
2. 会自动打开浏览器：<http://localhost:5176/>
   （没弹出来就手动打开这个地址，命令行窗口里也打印了）
3. 玩完关掉那个黑色命令行窗口就是关服务器

**不需要安装任何东西**：不用 Node.js、不用 Python、不用联网装依赖。
浏览器用 Edge 或 Chrome（语音输入靠它们）。

> 为什么非要开个"服务器"而不是直接双击 index.html？
> 因为语音输入（麦克风）只在 \`http://localhost\` 这种安全上下文里能用，
> 而且 AI 聊天需要一个本地代理来转发（顺便藏住你的 Key）。

## 第一次用：填 API Key

游戏里 **设置 → API Key**，填 DeepSeek 的 key（\`sk-\` 开头）。
它只存在**你自己的浏览器**里，不写进任何文件，也不会被别人看到。
不填也进得去、能打牌，只是 AI 不会真的聊天和记事。

## 存档

- 主存档：浏览器 localStorage
- 镜像 + 人可读的 AI 记忆清单：\`save/\` 目录（见 \`save/README.md\`）
- 存档没了就重新打开游戏，会自动从 \`save/\` 拉回来

## 常见问题

| 现象 | 怎么办 |
| --- | --- |
| 双击 start.bat 一闪就没 | 右键 → 编辑，看有没有被安全软件拦；窗口里本来会打印错误信息 |
| 端口被占用 | 不用管：它会自己往 5176-5185 找，窗口里打印的地址才是真的 |
| 想换端口 | \`powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 6000\` |
| 语音按钮说不能用 | 必须用 \`http://localhost:...\` 打开（双击 start.bat 就是） |
| 关掉窗口后网页还能看 | 那只是缓存里的页面，AI 聊天/存档都用不了了，刷新就白屏 |

## 文件夹里有什么

\`\`\`
start.bat      启动（双击它）
serve.ps1      本地服务（PowerShell，Windows 自带，不用装东西）
index.html     页面
game.js        游戏本体
assets/ image/ music/   贴图 / 头像 / 音乐
save/          存档镜像
\`\`\`
`;
}

/* ===================================================================== */
/*                                 打包                                   */
/* ===================================================================== */
function walkCopy(relDir, out) {
  const abs = path.join(ROOT, relDir);
  for (const name of fs.readdirSync(abs)) {
    const full = path.join(abs, name);
    const rel = path.posix.join(relDir, name);
    if (fs.statSync(full).isDirectory()) walkCopy(rel, out);
    else out.push({ name: rel, data: fs.readFileSync(full) });
  }
}

function main() {
  const { js, key } = buildBundle();
  const { html, inlined, bytes } = buildHtml();
  const notes = [];

  const files = [
    { name: 'index.html', data: Buffer.from(html, 'utf8') },
    { name: 'game.js', data: Buffer.from(js, 'utf8') },
    { name: 'start.bat', data: Buffer.from(START_BAT.replace(/\r?\n/g, '\r\n'), 'utf8') },
    { name: 'README.md', data: Buffer.from(readme().replace(/\r?\n/g, '\r\n'), 'utf8') },
    { name: 'save/README.md', data: Buffer.from(SAVE_README.replace(/\r?\n/g, '\r\n'), 'utf8') },
  ];
  for (const f of COPY_FILES) files.push({ name: f, data: fs.readFileSync(path.join(ROOT, f)) });
  for (const d of COPY_DIRS) walkCopy(d, files);

  // 包的根目录（顶层文件夹）
  const entries = files.map((f) => ({ name: `${TOP}/${f.name}`, data: f.data }));
  // 目录项：让"解压出来的到底是什么"一眼可见
  const tops = [...new Set(files.map((f) => f.name.split('/')[0]))].sort();
  writeZip(OUT, entries);
  fs.rmSync(TMP, { recursive: true, force: true });

  notes.push(`index.html 内联了 ${inlined} 个 CSS（${(bytes / 1024).toFixed(1)} KB），入口只剩 <script defer src="game.js">`);
  notes.push(`game.js 是单文件打包产物：${(Buffer.byteLength(js) / 1024).toFixed(0)} KB（原生 ES 模块，没压缩/没混淆）`);
  notes.push(key ? 'apiKey 已从打包产物里清空（原文件不动）' : 'config.js 里本来就没有 apiKey');
  notes.push('包里没有存档文件：每台机器全新开局');
  notes.push(`顶层内容（${tops.length} 项）：${tops.join(' / ')}`);

  console.log(`打包完成：${files.length} 个文件 → ${OUT}`);
  console.log(`大小：${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB　顶层文件夹：${TOP}`);
  for (const n of notes) console.log(`  · ${n}`);
}

main();
