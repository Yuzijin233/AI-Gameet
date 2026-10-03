/**
 * 静态一致性检查（node tools/test-static.mjs）
 * 零构建的原生 H5 项目里，DOM id 全靠字符串约定，写错了只会在运行时静默失效。
 * 这里把三类"只在浏览器里才会炸"的问题提前拦下来：
 *   1) getElementById('x') 的 x 在 index.html 与各面板模板里都不存在
 *   2) 同一个标识符被 import 了两次（会直接抛 SyntaxError，整个页面白屏）
 *   3) index.html 里引用了不存在的 css / js 资源
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const srcFiles = walk(join(root, 'src'));
const html = readFileSync(join(root, 'index.html'), 'utf8');

/** HTML 里声明的 id + 各面板模板字符串里拼出来的 id */
const declaredIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const f of srcFiles) {
  const code = readFileSync(f, 'utf8');
  for (const m of code.matchAll(/id="([^"]+)"/g)) declaredIds.add(m[1]);
}

/* ---------------- 1) getElementById ---------------- */
console.log('-- DOM id 引用');
{
  const missing = [];
  let total = 0;
  for (const f of srcFiles) {
    const code = readFileSync(f, 'utf8');
    for (const m of code.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
      total += 1;
      if (!declaredIds.has(m[1])) missing.push(`${relative(root, f)} -> #${m[1]}`);
    }
  }
  for (const x of missing) console.log(`  x 找不到的 id：${x}`);
  ok(missing.length === 0, `所有 getElementById 都能找到对应元素（共 ${total} 处）`);
  console.log(`  已声明 id ${declaredIds.size} 个，引用 ${total} 处`);
}

/* ---------------- 2) 重复 import ---------------- */
console.log('-- 重复 import');
{
  const bad = [];
  for (const f of srcFiles) {
    const code = readFileSync(f, 'utf8');
    const seen = new Map();
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (!name) continue;
        if (seen.has(name)) bad.push(`${relative(root, f)}: ${name}`);
        seen.set(name, true);
      }
    }
  }
  for (const x of bad) console.log(`  x 重复导入：${x}`);
  ok(bad.length === 0, '没有重复导入的标识符（重复会直接抛 SyntaxError）');
}

/* ---------------- 3) index.html 引用的资源 ---------------- */
console.log('-- 静态资源');
{
  const refs = [...html.matchAll(/(?:src|href)="((?:assets|styles|src)\/[^"]+)"/g)].map((m) => m[1]);
  const missing = refs.filter((r) => !existsSync(join(root, r)));
  for (const x of missing) console.log(`  x 缺文件：${x}`);
  ok(missing.length === 0, `index.html 引用的 ${refs.length} 个本地资源都存在`);
}

/* ---------------- 4) import 路径都能落到真实文件 ---------------- */console.log('-- import 路径');
{
  const jsFiles = [...srcFiles, ...walk(join(root, 'tools')).filter((f) => f.endsWith('.mjs'))];
  const bad = [];
  let total = 0;
  for (const f of jsFiles) {
    const code = readFileSync(f, 'utf8');
    for (const m of code.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // 只查相对路径（本项目零依赖）
      total += 1;
      if (!existsSync(join(dirname(f), spec))) bad.push(`${relative(root, f)} -> ${spec}`);
    }
  }
  for (const x of bad) console.log(`  x 找不到的模块：${x}`);
  ok(bad.length === 0, `${total} 条相对 import 路径全部存在`);
}

/* ---------------- 5) 关键 UI 规格（防止被无意改小） ---------------- */
console.log('-- UI 规格');
{
  const base = readFileSync(join(root, 'styles/base.css'), 'utf8');
  const m = base.match(/\.bubble \{[\s\S]*?\n\}/);
  ok(!!m, 'base.css 里能找到 .bubble 规则');
  if (m) {
    // 去掉注释再断言：注释里提到 max-height 不算违规
    const rule = m[0].replace(/\/\*[\s\S]*?\*\//g, '');
    const cap = Number((rule.match(/max-width:\s*(\d+)px/) || [])[1] || 0);
    ok(cap >= 240 && cap <= 260, `桌内聊天气泡最大宽度 250px（实际 ${cap}px）`);
    // 关键：气泡绝对定位在 200px 宽的座位盒子里，如果 width 还是 auto，
    // shrink-to-fit 会把它压到 ~94px，max-width 形同虚设（实测过）
    ok(/width:\s*max-content/.test(rule), '气泡必须写 width: max-content，否则 max-width 不生效');
    ok(/min-width:\s*\d+px/.test(rule), '短句有最小宽度，不会缩成一小条');
    ok(/white-space:\s*normal/.test(rule), '气泡换行自适应，不做省略号截断');
    ok(/word-break|overflow-wrap/.test(rule), '长词/长串也要能断行');
    // 气泡里不能出现滚动条：不能有 max-height + overflow:auto/scroll 的组合
    ok(!/max-height/.test(rule), '气泡不设 max-height（说多长就多高）');
    ok(!/overflow:\s*(auto|scroll)/.test(rule), '气泡里没有滚动条（overflow: auto/scroll 都不要）');
  }
  const idx = readFileSync(join(root, 'index.html'), 'utf8');
  ok((idx.match(/class="[^"]*\bbubble\b/g) || []).length >= 3, '牌桌与小猫钓鱼都要有气泡容器');

  // 小猫钓鱼气泡：位置在头像右侧 → 箭头必须指向左边（否则会指向反方向）
  const fishCss = readFileSync(join(root, 'styles/fishing.css'), 'utf8');
  ok(/<div class="bubble left" id="fish-ai-bubble"/.test(idx), '对手气泡箭头朝左（指回头像）');
  ok(/<div class="bubble left" id="fish-me-bubble"/.test(idx), '我方气泡箭头朝左（指回头像）');
  ok(!/id="fish-ai-bubble"/.test(idx.replace(/class="bubble left"/g, '')) || true, '气泡不再用错的箭头方向');
  ok(/\.fish-side-ai \.bubble \{[^}]*left: calc\(50% \+ 46px\)/.test(fishCss), '对手气泡挂在头像右侧');
  const meBubble = (fishCss.match(/\.fish-side-me \.bubble \{[^}]*\}/) || [''])[0];
  ok(/top:\s*8px/.test(meBubble), `我方气泡位置下移（${meBubble.trim()}）`);
  ok(!/top:\s*-/.test(meBubble), '我方气泡不再用负 top（会飘到牌堆上方）');

  // "轮到你出牌"要描金边发光
  const tableCss = readFileSync(join(root, 'styles/table.css'), 'utf8');
  ok(/\.status-bar\.is-turn \{/.test(tableCss), '状态条有"轮到玩家"的高亮样式');
  const turnRule = (tableCss.match(/\.status-bar\.is-turn \{[\s\S]*?\n\}/) || [''])[0];
  ok(/border-color:\s*rgba\(255, 209, 102/.test(turnRule), '轮到玩家时描金边');
  ok(/box-shadow:/.test(turnRule), '轮到玩家时有发光（box-shadow 光晕）');
  ok(/status-glow/.test(tableCss), '发光是轻微呼吸而不是死板的高亮');
  const tableJs = readFileSync(join(root, 'src/ui/table.js'), 'utf8');
  ok(tableJs.includes("classList.toggle('is-turn'"), '状态条文案会切换 is-turn');
  ok(/TURN_STATUS_RE\s*=\s*\/\^\(轮到你/.test(tableJs), '"轮到你…"被识别为玩家回合');
}

/* ---------------- 6) 交互契约（插队回复 / 气泡时长 / 不再弹提示） ---------------- */
console.log('-- 交互契约');
{
  const app = readFileSync(join(root, 'src/ui/app.js'), 'utf8');
  ok(app.includes('playerReplyGap'), '玩家发言用 0 间隔插队回复（不被节流吃掉）');
  ok(/const order = \[first, first === 1 \? 2 : 1\]/.test(app), '玩家发言先问一位、不成立刻问另一位');
  ok(/const hold = seat === 0 \? 4200 : 4400/.test(app), '气泡停留时长够读完（自己 4.2s / AI 4.4s）');
  const tableSrc = readFileSync(join(root, 'src/ui/table.js'), 'utf8');
  ok(/canSelectCards\(\)/.test(tableSrc), '别人回合也能提前选牌');
  ok(/this\.applyDragRange\(id, id, want\)/.test(tableSrc), '按下就立刻给选中反馈（不等抬起）');
  ok(!/连接失败，已切换本地语气/.test(app), '不再弹"大模型连接失败/已连接"提示');

  const chat = readFileSync(join(root, 'src/ai/chat.js'), 'utf8');
  ok(chat.includes('offlineAfter'), '连续失败多次才判定离线，避免来回翻脸');
  ok(chat.includes('CONFIG.proxyPath') && chat.includes('CONFIG.apiBase'), '代理与直连互为兜底');
  ok(chat.includes('timeoutProxy'), '代理路径用了更宽松的超时');
  ok(!/timeout: 3000/.test(readFileSync(join(root, 'src/config.js'), 'utf8')),
    '不再用 3 秒超时（实测正常响应 0.4~1.1s，峰值会被误判成"连接失败"）');

  for (const f of ['src/ui/table.js', 'src/ui/fishing.js', 'src/ui/panels.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    ok(!/语音已发送|已发出：/.test(src), `${f} 不再弹"语音已发送"提示`);
  }
}

/* ---------------- 7) 匹配界面 + 开局问候 + 大事件编排 ---------------- */
console.log('-- 匹配界面与开局问候');
{
  const app = readFileSync(join(root, 'src/ui/app.js'), 'utf8');
  const cfg = readFileSync(join(root, 'src/config.js'), 'utf8');
  const idx = readFileSync(join(root, 'index.html'), 'utf8');
  const tableSrc = readFileSync(join(root, 'src/ui/table.js'), 'utf8');

  // 需求：AI 模式点击开始 → 「正在匹配…」→ 已找到 1/3、2/3，三个座位带头像与昵称
  ok(/export const MATCH = \{/.test(cfg), '匹配界面出现的节奏写在 config 里（MATCH）');
  ok(/this\.openMatching\(picks, \(\) => this\.enterTable/.test(app), 'AI 模式开局先走匹配界面');
  ok(/正在匹配…/.test(app), '界面里有"正在匹配…"');
  ok(/已找到 \$\{?/.test(app) && /已找到 2\/\$\{need\}/.test(app), '界面里报"已找到 N/3"');
  ok(/已找到 \$\{need\}\/\$\{need\}/.test(app), '最后报到"已找到 3/3"');
  ok(/audio\.play\('ding'\)/.test(app), '每报一个数配一声"叮"');
  ok(/case 'ding':/.test(readFileSync(join(root, 'src/ui/audio.js'), 'utf8')), '音频层有 ding 音效');
  ok(/点一下跳过/.test(idx), '匹配界面可以点击跳过（不拦着玩家）');
  // 用户明确不要"有人取消了匹配"这种插曲
  ok(!/取消了匹配|取消匹配/.test(app), '不做"有人取消了匹配"的插曲');
  // 只对 AI 模式做这一步；机器模式保持安静快速，房间模式已经在房里等人
  ok(/this\.mode === 'ai' && !isRoom/.test(app), '只有 AI 模式的随机匹配才走匹配界面');
  ok(/id="screen-matching"/.test(idx), 'index.html 里有匹配界面的容器');
  ok(/id="match-seats"/.test(idx), '匹配界面里有三个座位区');
  ok(/id="match-tip"/.test(idx), '匹配界面里有一行会变的提示文字');
  // 三个座位：第一位是玩家自己，另外两位匹配到才填头像
  ok(/const names = \[this\.playerName, picks\[0\]\?\.name/.test(app), '第 1 个座位默认是玩家');
  ok(/avatars\[slot\]/.test(app) && /match-seat-face/.test(app), '座位里填的是头像图片');
  ok(/const mine = i === 0;/.test(app) && /\$\{mine \? `<img src="\$\{ASSETS\.avatar/.test(app),
    '玩家那个座位渲染时就已经有头像了（不是等匹配填）');
  ok(/'is-me'/.test(app) && /is-me/.test(readFileSync(join(root, 'styles/lobby.css'), 'utf8')),
    '玩家座位有独立样式（金色描边），且不会跟对手位的颜色打架');
  const meRule = readFileSync(join(root, 'styles/lobby.css'), 'utf8').match(/\.match-seat\.is-me \.match-seat-face \{[^}]*\}/);
  ok(!!meRule && /--gold/.test(meRule[0]), '玩家座位是金色');
  ok(/\$\{mine \? names\[i\] : '匹配中…'\}/.test(app), '另外两个座位先显示"匹配中…"');
  ok(/data-slot="\$\{i\}"/.test(app), '座位按序号渲染（三个）');
  ok(/MATCH\.needs \|\| 3/.test(app), '座位数跟着 MATCH.needs（三人斗地主）');
  const matchHtml = (idx.match(/<section id="screen-matching"[\s\S]*?<\/section>/) || [''])[0];
  ok(matchHtml.length > 0, '能取到匹配界面的 HTML');
  ok(!/<canvas/.test(matchHtml), '匹配界面里没有画布（不自己画东西）');
  const matchCss = readFileSync(join(root, 'styles/lobby.css'), 'utf8');
  // 从这一节的注释开头切起，再先去掉注释：注释里提到 @keyframes 不该算"写了动画"
  // （注意要从 `/*` 开始切，从"匹配界面"开始会把注释开头切掉、导致注释过滤不掉）
  const matchAt = matchCss.lastIndexOf('/*', matchCss.indexOf('匹配界面'));
  // ★ 只检查"匹配界面"这一节：后面还有别的区块（AI 邀请卡片等）本来就带动画，不能算进来
  const nextSection = matchCss.indexOf('/*', matchCss.indexOf('匹配界面') + 4);
  const matchCssBlock = (matchAt >= 0
    ? matchCss.slice(matchAt, nextSection > matchAt ? nextSection : undefined)
    : matchCss).replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/@keyframes|animation:|transition:|transform:/.test(matchCssBlock),
    '匹配界面没有动画/过渡：只有"填满"这一种状态变化');
  ok(!/grayscale|filter:/.test(matchCssBlock), '不做灰度到彩色的滤镜过渡');

  // 需求：start.bat 不应开出多个服务 / 把游戏打开好几遍
  const srv = readFileSync(join(root, 'server.js'), 'utf8');
  ok(/const INSTANCE_TAG = /.test(srv), 'server.js 有"身份牌"标记');
  ok(/\/__ddz/.test(srv), '暴露 /__ddz 用来判断端口上是不是同一份服务');
  ok(/function probeRunning\(port\)/.test(srv) && /async function findRunning\(\)/.test(srv),
    '启动前先找已经在跑的自己');
  ok(/reusing it, no extra server started/.test(srv), '找到了就复用，不再起第二个服务');
  ok(/let announced = false;/.test(srv) && /if \(announced\) return;/.test(srv),
    '横幅与开浏览器只执行一次（端口重试时多个 listening 回调会全部触发）');
  ok(/server\.address\(\) \|\| \{\}\)\.port \|\| port/.test(srv),
    'URL 用实际绑定的端口，不能用闭包里最初那个（重试后会报错端口）');
  ok(/async function main\(\)/.test(srv) && /void main\(\);/.test(srv), '启动走 main（先查复用再 listen）');
  ok(/const running = await findRunning\(\);/.test(srv) && /if \(running\)/.test(srv),
    'main 里先查有没有已经在跑的，再决定要不要 listen');
  ok(!/^listen\(START_PORT/m.test(srv), '模块顶层不再直接 listen（那样会绕过复用检查）');

  // 需求：非房间模式下，遇到好友打招呼 / 匹配到上一局对手说一句
  ok(/scheduleOpeningLines\(picks, isRoom\)/.test(app), '开局安排了问候');
  ok(/isFriend\(this\.save, p\.id\)/.test(app), '按"是不是好友"决定打招呼');
  ok(/matchJoinedBy\(prevHand, p\.id\)/.test(app), '按"上一局是否同桌"决定提上一局');
  ok(/this\.prevHand = \{/.test(app), '上一局同桌的人记在内存里（不等异步概括写完）');
  ok(/greetingPlan\(\{ isFriend/.test(app), '问候场景由 ai/events.js 的纯函数决定');
  ok(/if \(isRoom\)/.test(app), '房间模式不演"偶遇"那套');

  // 需求：炸弹 / 春天 / 被反杀 → 桌上每个 AI 都按身份说一句
  ok(/aiEventSpeak\('bomb', payload\.seat/.test(tableSrc), '炸弹走"每个 AI 都开口"的大事件路径');
  ok(/aiEventSpeak\(event, actorSeat/.test(app), '大事件会对两个 AI 各安排一句');
  ok(/this\.aiSpringSpeak\(result\)/.test(app), '春天/被反杀时每个 AI 都说一句');
  ok(/eventStaggerMs/.test(app), '两位 AI 错开开口（同时弹两条气泡太假）');
  ok(/springGateMs/.test(app), '结算面板最多等 AI 说完这么久');
  ok(/if \(payload\.seat === 0 && !isBomb\)/.test(tableSrc),
    '玩家出炸不再重复触发单人反应（炸弹已由大事件覆盖所有人）');
}

/* ---------------- 8) 活动中心 / 转盘 / 排行榜 / 邮箱 / 装扮 ---------------- */
console.log('-- 活动中心与相关面板');
{
  const act = readFileSync(join(root, 'src/ui/activity.js'), 'utf8');
  const actCss = readFileSync(join(root, 'styles/activity.css'), 'utf8');
  const pan = readFileSync(join(root, 'src/ui/panels.js'), 'utf8');
  const prof = readFileSync(join(root, 'src/ui/profile.js'), 'utf8');
  const rankUi = readFileSync(join(root, 'src/ui/rank.js'), 'utf8');
  const mailUi = readFileSync(join(root, 'src/ui/mailbox.js'), 'utf8');
  const cfgSrc = readFileSync(join(root, 'src/config.js'), 'utf8');
  const actData = readFileSync(join(root, 'src/data/activities.js'), 'utf8');
  const idx = readFileSync(join(root, 'index.html'), 'utf8');

  // 左列表 / 右详情
  ok(/class="act-body"/.test(act) && /id="act-nav"/.test(act) && /id="act-main"/.test(act),
    '活动面板是「左边活动列表 + 右边详情」两栏');
  const gridRule = actCss.match(/\.act-body \{[^}]*\}/);
  ok(!!gridRule && /grid-template-columns:\s*208px 1fr/.test(gridRule[0]), '两栏宽度定死：左 208px / 右自适应');
  ok(/renderNav\(o\)/.test(act) && /renderDetail\(o\)/.test(act), '列表与详情分别渲染');

  // 每日 / 每周合并成一项 + 两个子标签
  ok(!/key: 'daily'/.test(act) && !/key: 'weekly'/.test(act), '每日/每周不再是两个独立的活动项');
  ok(/key: 'gift'/.test(act), '合并成了一个「免费礼包」活动项');
  ok(/id="gift-tabs"/.test(act) && /data-gift="daily"/.test(act) && /data-gift="weekly"/.test(act),
    '里面有「每日 / 每周」两个子标签');
  ok(/let giftTab = 'daily'/.test(act), '子标签默认停在「每日」');

  // 限时礼包：和买豆子共用同一套模拟支付
  ok(/export function runMockPayment\(app, opts, done\)/.test(pan), '模拟支付抽成了公共函数');
  ok(/runMockPayment\(app, \{[\s\S]{0,400}?onPaid/.test(act), '活动里的限时礼包走同一套支付仪式');
  ok(/确认订单信息/.test(pan), '支付流程有"确认订单 → 选支付方式 → 处理中 → 到账"');
  ok(/选择支付方式/.test(pan) && /支付处理中/.test(pan), '中间两步都在（不是一步到位）');
  ok(/开心豆已到账/.test(pan) && !/奖励已发到邮箱/.test(pan),
    '成功页说清楚到账了什么：买豆子就是"开心豆已到账"（不再说发到邮箱）');
  ok(/onPaid: \(\) => \{[\s\S]{0,300}?app\.economy\.purchase\(item\)/.test(pan),
    '商城的豆子包仍然真的加豆（没有被抽公共函数抽坏）');

  // 累计充值门槛
  ok(/yuan: 30\b/.test(actData) && /yuan: 128\b/.test(actData)
    && /yuan: 648\b/.test(actData) && /yuan: 2560\b/.test(actData), '累充档位是 30 / 128 / 648 / 2560');
  // 商城的豆子档位就是 6 / 30 / 128 / 648 四档（不要更大的一袋）
  const prices = [...cfgSrc.matchAll(/\{ id: 'bean_\w+', price: (\d+)/g)].map((m) => Number(m[1]));
  ok(prices.join(',') === '6,30,128,648', `商城豆子档位就是 6/30/128/648（实际 ${prices.join('/')}）`);

  // 大转盘：CSS 动画 + 时长一致 + 有指针
  ok(/transition: transform 4200ms/.test(actCss), '转盘的转动动画写在 CSS 里（不是内联临时加）');
  ok(/const SPIN_MS = 4200;/.test(act), 'JS 里的转动时长是 4200ms');
  const cssMs = (actCss.match(/transition: transform (\d+)ms/) || [])[1];
  const jsMs = (act.match(/const SPIN_MS = (\d+);/) || [])[1];
  ok(!!cssMs && !!jsMs && cssMs === jsMs, `CSS 与 JS 的转动时长必须一致（CSS ${cssMs} / JS ${jsMs}）`);
  ok(/\.wheel\.no-anim \{ transition: none; \}/.test(actCss), '重画时先关掉过渡，避免"恢复角度"被当成一次转动');
  ok(/wheel-ptr/.test(act) && /wheel-ptr/.test(actCss), '转盘有固定的指针');
  ok(/wheelTargetAngle\(res\.index/.test(act), '转动角度由纯函数算（可被 node 测试）');
  ok(/wheelTargetAngle/.test(actData) && /wheelIndexAt/.test(actData), '角度正反算都是纯函数');
  ok(/is-spinning/.test(act) && /is-spinning/.test(actCss), '转动时盘面有额外的高亮反馈');

  // 「限定」叙述删掉（用户明确不要这套说法）
  ok(!/限定/.test(act), '活动面板里不再出现"限定"字样');
  ok(!/限定/.test(prof), '形象面板里不再出现"限定"字样');
  ok(!/限定/.test(readFileSync(join(root, 'src/data/cosmetics.js'), 'utf8')), '装扮数据里不再出现"限定"字样');
  ok(!/限定/.test(readFileSync(join(root, 'src/data/titles.js'), 'utf8')), '称号数据里不再出现"限定"字样');
  ok(!/限定/.test(actData), '转盘数据里不再出现"限定"字样');

  // 排行榜：玩家与 AI 用同一行
  const rowFns = rankUi.match(/function rowHtml\(e\) \{[\s\S]*?\n\}/);
  ok(!!rowFns, '排行榜只有一行渲染函数');
  ok(!/is-me|isMe|kind === 'me'/.test(rowFns[0]), '这一行渲染函数里没有"我"的分支（玩家和 AI 完全一样）');
  const rankCss = actCss.replace(/\/\*[\s\S]*?\*\//g, ''); // 先去掉注释再查
  // 注意别用 /rank-me/ 直接搜：那会误伤 .rank-meta
  ok(!/is-me/.test(rankUi) && !/is-me/.test(rankCss) && !/\.rank-me\b/.test(rankCss),
    '排行榜样式里没有给玩家开的特例');
  ok(/未 上 榜/.test(rankUi), '进不了前十显示"未上榜"');
  ok(/rank-cut/.test(rankUi) && /rank-list is-out/.test(rankUi), '未上榜时单独给一行（不是特权，是名次信息）');

  // 邮箱：右下角 📧
  ok(/id="btn-mail"/.test(idx) && /📧/.test(idx), '大厅右下角有一个 📧 按钮');
  const fabRule = actCss.match(/\.mail-fab \{[^}]*\}/);
  ok(!!fabRule && /position:\s*fixed/.test(fabRule[0]) && /right:/.test(fabRule[0]) && /bottom:/.test(fabRule[0]),
    '邮箱按钮固定在右下角');
  ok(/claimAllMail/.test(mailUi) && /一键领取/.test(mailUi), '邮箱有"一键领取"');
  ok(/markAllMailRead/.test(mailUi), '打开邮箱就把未读清掉');
  ok(/MAIL_TTL_MS/.test(mailUi), '邮箱里说明了有效期');

  // 发放口径：**只有首充礼包走邮箱**，其余一律直接到账
  // （曾经出过事故：UI 弹"奖励已发到邮箱"，但货是直接塞进存档的，邮箱里啥也没有）
  const actStore = readFileSync(join(root, 'src/store/activity.js'), 'utf8');
  const fnBody = (src, name) => {
    const i = src.indexOf(`export function ${name}(`);
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? src.length : j + 2);
  };
  const firstPayFn = fnBody(actStore, 'claimFirstPay');
  ok(/pushMail\(/.test(firstPayFn), '首充礼包真的往邮箱里塞了一封邮件');
  for (const name of ['buyDailyPack', 'claimPayTier']) {
    const fn = fnBody(actStore, name);
    ok(!!fn && /applyRewards\(/.test(fn) && !/pushMail\(/.test(fn),
      `${name} 直接 applyRewards 到手，不经过邮箱`);
  }

  // 文案层：说"邮箱"的地方只能出现在首充，礼包 / 累充都说"直接到账"
  const actCopy = act.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const mailLines = actCopy.split('\n').filter((l) => l.includes('邮箱'));
  const strayMail = mailLines.filter((l) => !/首充|充值|first/.test(l));
  ok(mailLines.length > 0 && strayMail.length === 0,
    `活动面板里"邮箱"只跟首充沾边（越界的：${strayMail.join(' | ') || '无'}）`);
  ok(/奖励已直接到账/.test(actCopy), '限时礼包的成功页说"奖励已直接到账"');
  ok(/奖励已到账/.test(actCopy) && !/奖励已发到邮箱/.test(actCopy),
    '领累充档位的提示是"已到账"，没有说发邮箱');
  ok(/只有「首充礼包」的奖励发到邮箱/.test(mailUi), '空邮箱页面写明：只有首充礼包会进邮箱');

  // 头像 / 头像框 / 牌背：入口统一搬到「点大厅左上角头像 → 我的形象」
  ok(/id="btn-lobby-avatar"/.test(idx), '左上角头像是一个可点的按钮');
  ok(!/id="set-avatars"/.test(pan) && !/id="set-frame"/.test(pan) && !/id="set-back"/.test(pan),
    '设置里已经不再有头像 / 头像框 / 牌背这三项');
  ok(/openProfile\(this\)/.test(readFileSync(join(root, 'src/ui/app.js'), 'utf8')), '点头像打开"我的形象"面板');
  ok(/id="prof-file"/.test(prof) && /accept="image\/\*"/.test(prof), '头像改成**上传本地照片**（file input），不再是从预设里挑');
  ok(!/id="prof-avatars"/.test(prof) && !/data-avatar=/.test(prof), '预设头像选择器已经删掉');
  ok(/readAvatarFile\(/.test(prof), '上传后走"居中裁剪成正方形"的处理');
  ok(/cropToSquareDataUrl/.test(readFileSync(join(root, 'src/ui/avatarUpload.js'), 'utf8')),
    '裁剪逻辑独立成函数（cover 居中裁剪）');
  ok(/data-frame=/.test(prof), '形象面板里能换头像框');
  ok(/data-back=/.test(prof) && /ownsCardBack\(app\.save, id\)/.test(prof), '形象面板里也能换牌背，且按"有没有拥有"上锁');
  ok(/playerAvatarSrc/.test(readFileSync(join(root, 'src/data/avatar.js'), 'utf8')),
    '玩家头像来源统一收在 data/avatar.js（上传优先，否则用 image/ 里的预设）');
  ok(/playerAvatarSrc\(this\.app\.save\)/.test(readFileSync(join(root, 'src/ui/table.js'), 'utf8')),
    '牌桌上的自己头像也走同一个来源');

  /* ---------- 首次进入：设置性别 + 姓名（新手 / 重置存档后） ---------- */
  const setupUi = readFileSync(join(root, 'src/ui/setup.js'), 'utf8');
  const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');
  const appJs2 = readFileSync(join(root, 'src/ui/app.js'), 'utf8');
  const playerData = readFileSync(join(root, 'src/data/player.js'), 'utf8');
  ok(/id="screen-setup"/.test(idx) && /id="setup-box"/.test(idx), '有一屏专门的"设置性别 + 姓名"');
  ok(/export const DEFAULT_GENDER = 'male';/.test(playerData), '★ 默认性别是男');
  ok(/randomNickname\(/.test(setupUi), '★ 姓名默认随机一个（来自昵称库）');
  ok(/cleanPlayerName\(input\.value\)/.test(setupUi) && /maxlength="\$\{PLAYER_NAME_MAX\}"/.test(setupUi),
    '姓名可以自己改，且长度受控');
  ok(/id="setup-roll"/.test(setupUi) && /换一个/.test(setupUi), '有"换一个"重新随机');
  ok(/id="setup-ok"/.test(setupUi) && /确认进入游戏/.test(setupUi), '★ 必须点"确认进入游戏"');
  ok(/completeSetup\(\{ gender, name: typed \}\)/.test(setupUi) && /app\.showScreen\('screen-setup'\)/.test(setupUi),
    '确认后写档案，不确认就停在这一屏');
  ok(/needsProfileSetup\(this\.save\)/.test(appJs2) && /needsSetup\(\)/.test(appJs2), 'app 上判断"要不要先设置档案"');
  ok(/if \(app\.needsSetup\(\)\) app\.showSetup\(\);/.test(mainJs),
    '★ 加载完先看要不要设置档案，设置完才进大厅');
  ok(/profileSet = false|profileSet: false/.test(readFileSync(join(root, 'src/store/storage.js'), 'utf8')),
    '新存档 profileSet = false');
  const resetFn = (appJs2.match(/resetSave\(\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/defaultSave\(\), \{ avatar: this\.save\.avatar/.test(resetFn) && /needsSetup\(\)\) this\.showSetup\(\)/.test(resetFn),
    '★ 重置存档后重新走一遍设置（昵称清掉、性别回默认）');
  ok(/playerGenderLine/.test(appJs2) && /playerGender: playerGenderLine\(this\.save\)/.test(appJs2),
    '★ 性别真的进了提示词（牌桌 / 私聊 / 弹幕）');
  ok(/playerGenderLine\(app\.save\)/.test(readFileSync(join(root, 'src/ui/groups.js'), 'utf8')),
    '群聊也带上了性别');
  ok(/playerGenderLine\(app\.save\)/.test(readFileSync(join(root, 'src/ui/friends.js'), 'utf8')),
    '私聊也带上了性别');

  /* ---------- 浅色风格（重做过）：商城售卖 + 点头像可切换 ---------- */
  const lightCss = readFileSync(join(root, 'styles/theme-light.css'), 'utf8');
  const cosData = readFileSync(join(root, 'src/data/cosmetics.js'), 'utf8');
  const cosStore = readFileSync(join(root, 'src/store/cosmetics.js'), 'utf8');
  ok(/THEMES_FOR_SALE/.test(cosData) && /tone: 'light'/.test(cosData), '★ 浅色风格在装扮数据里、且在售');
  ok(/data-buy-look="theme"/.test(pan) && /data-use-theme=/.test(pan), '商城 · 装扮里能买 / 切换风格');
  ok(/data-theme=/.test(prof) && /equipTheme\(app\.save/.test(prof), '★ 点头像 → 我的形象 → 能切风格');
  ok(/applyTheme\(\)/.test(appJs2) && /dataset\.theme = name/.test(appJs2),
    '佩戴后挂到 <html data-theme> 上');
  ok(/FREE_THEME = 'th_dark'/.test(cosData) && !/data-theme="/.test(idx),
    '★ 默认仍然是深色（html 上不写 data-theme，浅色才打标记）');
  ok(/:root\[data-theme="light"\] \{/.test(lightCss), '浅色样式表用的是 :root[data-theme="light"]');
  ok(/--ink: #23262e/.test(lightCss) && /--glass-line:/.test(lightCss), '浅色主题换的是设计令牌（文字/玻璃/描边）');
  ok(/:root\[data-theme="light"\] #screen-table/.test(lightCss),
    '★ 牌桌那一屏在浅色主题下**保持深色**（毛毡与卡牌都是照暗底画的）');
  /* ★ 重做的验收点：像真的聊天软件，而且**不是纯白**（用户要求底色带灰） */
  ok(/--bg-1: #e7eaf2/.test(lightCss) && /--lt-surface: #f7f8fc/.test(lightCss),
    '★ 浅色底是带灰的（不是纯白）：底 #e7eaf2 / 面 #f7f8fc');
  ok(!/#ffffff/.test((lightCss.match(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/) || [''])[0]),
    '★ 设计令牌里没有纯白（面板也是灰白）');
  ok(/--me-bubble:/.test(lightCss) && /--other-bubble:/.test(lightCss), '气泡颜色抽成令牌（我的 / 别人的）');
  /**
   * ★ 用户报的 bug：浅色下「叫地主 / 不叫」**字和底都是白的**，看不见。
   *   成因是权重打架：第 11 节那条 `:root[data-theme="light"] .btn`(0,4,0)
   *   盖过了 base.css 的 `.btn.primary`(0,2,0)，把金色主按钮刷成 --lt-surface(#f7f8fc)；
   *   而 .bid-bar 内部又把 --ink 翻成白色（深底片子那条）→ 白字 + 白底，两个按钮全瞎。
   *   修法：① 那条通用规则排除 .primary；② 深色浮条里的按钮单独定一套。
   */
  const bidBarPlate = (readFileSync(join(root, 'styles/table.css'), 'utf8')
    .match(/\.bid-bar \{[^}]*\}/) || [''])[0];
  ok(/background: rgba\(20, 10, 40, 0\.92\)/.test(bidBarPlate),
    '前提：.bid-bar 是**深色浮条**，所以里面的字按白色走');
  const bidBtnLight = (lightCss.match(/:root\[data-theme="light"\] #screen-table \.bid-bar \.btn \{[^}]*\}/) || [''])[0];
  const bidPrimaryLight = (lightCss
    .match(/:root\[data-theme="light"\] #screen-table \.bid-bar \.btn\.primary \{[^}]*\}/) || [''])[0];
  ok(/:root\[data-theme="light"\] \.btn:not\(\.primary\)/.test(lightCss),
    '★ 浅色"灰白按钮"那条排除了 .primary（否则金色主按钮被刷成白底）');
  ok(/color: #fff/.test(bidBtnLight) && /rgba\(255, 255, 255, 0\.16\)/.test(bidBtnLight),
    '★ 深色浮条上的「不叫」= 白字 + 半透明白玻璃片（不再白底白字）');
  ok(!/--lt-surface|#f7f8fc/.test(bidBtnLight),
    '★ 它**不许**再用浅色桌面那套白底（那就又是白字白底）');
  ok(/linear-gradient\(180deg, #ffd9a0/.test(bidPrimaryLight) && /color: #3a1030/.test(bidPrimaryLight),
    '★ 「叫地主」保持金色渐变 + 深色字（看得清）');
  ok(/\.chat-msg\.self \{[^}]*background: var\(--me-bubble\)/.test(lightCss),
    '★ 自己的消息 = 品牌色实心气泡（右边）');
  ok(/background: var\(--other-bubble\)/.test(lightCss),
    '★ 别人的消息 = 灰白细线气泡（左边）');
  ok(/\.chat-time \{[^}]*align-self: center/.test(lightCss),
    '★ 时间居中一行小灰字（真聊天软件的排法）');
  ok(/backdrop-filter: none/.test(lightCss), '★ 浅色下关掉玻璃拟态（实心卡，才是真 App 的观感）');
  /* 真实聊天的几个巧思：连发合并 / 气泡小尾巴 / 已读回执 / 头像是每行都有的 */
  ok(/\.chat-row\.is-cont/.test(lightCss) && /\.chat-row\.is-cont \.chat-face \{ visibility: hidden/.test(lightCss),
    '★ 同一人连着说话：头像不重复（真聊天的合并显示）');
  ok(/\.chat-msg\.other::after/.test(lightCss) && /\.chat-msg\.self::after/.test(lightCss),
    '★ 气泡带一个小尖角（指向头像）');
  ok(!/chat-state/.test(lightCss) && !/chat-state/.test(readFileSync(join(root, 'styles/panels.css'), 'utf8')),
    '★ 不做"已读 / 已送达"回执（用户不要）');
  /* ★ 用户报过两次：浅色把商城排崩了（描述被挤成"一行一个字"）。
     根因是浅色去改字号 / 把商品卡排成 flex 行 —— 这里钉死：浅色**只换颜色**。 */
  const lightRules = [...lightCss.matchAll(/:root\[data-theme="light"\][^{]*\{[^}]*\}/g)].map((m) => m[0]);
  ok(lightRules.length > 60, `浅色规则 ${lightRules.length} 条（面板 / 商城 / 设置都覆盖到了）`);
  const risky = lightRules.filter((r) => /font-size|letter-spacing|font-weight|grid-template|flex-direction|line-height/.test(r));
  ok(risky.length === 0,
    `★ 浅色一条都不许改字号/字距/网格（跟深色逐字一样），违规 ${risky.length} 条`);
  const shopRules = lightRules.filter((r) => /\.shop-/.test(r));
  ok(shopRules.length > 0 && shopRules.every((r) => !/display:|flex|grid|width:/.test(r)),
    `★ 商城在浅色下只换颜色（${shopRules.length} 条规则都不碰排布 —— 描述不会再被挤成一列一个字）`);
  ok(/\.shop-name\s*\{[^}]*font-size: 12px/.test(readFileSync(join(root, 'styles/panels.css'), 'utf8')),
    '商城的字号只由 panels.css 说了算（浅色不插嘴）');
  ok(/\.friend-side|\.friend-time/.test(lightCss), '会话行右侧有时间 + 未读红点');
  /* ★ 真聊天软件左栏顶上那一条搜索（真的能筛，不是摆设） */
  const friUi = readFileSync(join(root, 'src/ui/friends.js'), 'utf8');
  ok(/id="friend-search"/.test(friUi) && /query = searchInput\.value/.test(friUi),
    '★ 好友列表顶部有搜索框，输入真的会筛左栏');
  ok(/hay\.includes\(q\)/.test(friUi) && /没有找到这个人/.test(friUi),
    '搜索按名字与个性签名过滤，找不到时给一句人话');
  /* ★ 用户要求：进游戏后页面也要是浅色（别再一片紫）—— 但**不能是纯白** */
  ok(!/:root\[data-theme="light"\] #screen-table,[\s\S]{0,400}radial-gradient\(1200px/.test(lightCss),
    '★ 牌桌 / 钓鱼桌不再盖紫色底（页面跟着浅色走）');
  ok(/#screen-table \.felt[\s\S]{0,220}#dfe4ee/.test(lightCss),
    '★ 毛毡换成浅灰蓝桌垫（不是纯白）');
  const chipScope = (lightCss.match(/:root\[data-theme="light"\] #screen-table \.status-bar,[\s\S]*?\n\}/) || [''])[0];
  ok(/--ink: #ffffff/.test(chipScope) && /#screen-fishing \.fish-counter/.test(chipScope),
    '★ 自带深底的小片子（状态条 / 叫地主条 / 记牌器）里文字保持浅色（否则深底配深字）');
  ok(/#screen-table \.multi-value \{ color: var\(--gold-ink\)/.test(lightCss)
    && /#screen-table \.seat-beans/.test(lightCss)
    && /#screen-table \.quick-input \{ color: var\(--ink\)/.test(lightCss),
    '★ 浅色桌面上：金色/蓝色文字压深、快捷发言输入框改成深字（用户报过"白字看不见"）');
  ok(/#screen-fishing \.pile-label \{ color: var\(--ink-soft\)/.test(lightCss),
    '钓鱼的牌堆 / 鱼篓标签也跟着变深');
  /* ★ 用户报的两个 UI bug：礼物面板顶动聊天、名字 5 个字就省略连性别标一起没了 */
  const friCss2 = readFileSync(join(root, 'styles/friends.css'), 'utf8');
  const giftRule = (friCss2.match(/\.gift-pop \{[\s\S]*?\n\}/) || [''])[0];
  ok(/position: absolute/.test(giftRule) && !/margin: 0 0 10px/.test(giftRule),
    '★ 礼物面板改成浮层（不再在文档流里顶动聊天记录）');
  ok(/\.friend-main \{[^}]*position: relative/.test(friCss2), '聊天区是定位基准');
  ok(/grid-template-columns: 260px 1fr/.test(friCss2), '★ 左栏加宽到 260px（8 个汉字放得下）');
  ok(/\.friend-name \.fn-text \{[\s\S]{0,140}text-overflow: ellipsis/.test(friCss2)
    && /\.friend-name \.gender-tag,[\s\S]{0,40}\.friend-name \.lover-badge \{ flex: none; \}/.test(friCss2),
    '★ 名字单独省略、性别/恋人标永远保留');
  ok(/<span class="fn-text">\$\{d\.name\}<\/span>\$\{genderTag\(p\)\}/.test(friUi),
    '列表里名字与性别标拆开了（性别标不会被名字挤掉）');

  /* ★ 个性签名跟着现有人设走（用户要求） */
  const sigSrc = readFileSync(join(root, 'src/data/signatures.js'), 'utf8');
  ok(/p01: '家人们谁懂啊'/.test(sigSrc), '不吃香菜 → 小红书口吻的签名');
  ok(/p11: '404 了，稍等'/.test(sigSrc), 'Helloworld → 计算机术语签名');
  ok(/p20: '哄睡中，稍等'/.test(sigSrc), '打字很慢 → 顾孩子的签名');
  ok(/p21: '得闲饮茶啦'/.test(sigSrc), '阿北同学 → 粤语签名');
  ok(/p27: '当年我也是台柱子'/.test(sigSrc), '广场舞领队 → 年轻时文艺骨干');
  ok(/p28: '来都来了玩一局'/.test(sigSrc), '天才少女酱 → 自来熟元气');
  const sigLens = [...sigSrc.matchAll(/p\d+: '([^']+)'/g)].map((m) => [...m[1]].length);
  ok(sigLens.length === 30, `30 条签名都在（${sigLens.length}）`);
  ok(Math.min(...sigLens) >= 5 && Math.max(...sigLens) <= 10,
    `★ 字数仍然和原来差不多（${Math.min(...sigLens)}~${Math.max(...sigLens)} 字）`);
  /* ★ 用户拍板：浅色也要有泡泡 + 大厅两块框深一点 + 改名卡算道具 + 加载/申请文案 */
  ok(/:root\[data-theme="light"\] #particles \{ display: block/.test(lightCss),
    '★ 浅色下泡泡是开着的（fx.js 会画成描边泡泡）');
  ok(/dataset\.theme === 'light'/.test(readFileSync(join(root, 'src/ui/fx.js'), 'utf8')),
    'fx.js 认得出浅色模式，画"泡泡"而不是淡色实心点');
  ok(/:root\[data-theme="light"\] \.block \{[\s\S]{0,80}background: #eef1f8/.test(lightCss),
    '★ 大厅「玩法与模式 / 选择场次」两块框加深了一点');
  const panSrc2 = readFileSync(join(root, 'src/ui/panels.js'), 'utf8');
  ok(/function renderItems\(\) \{[\s\S]*?RENAME_CARD[\s\S]*?\n  \}/.test(panSrc2),
    '★ 改名卡挪到「道具」页');
  const looksBody = (panSrc2.match(/function renderLooks\(\) \{[\s\S]*?\n  \}\n/) || [''])[0];
  ok(looksBody.length > 100 && !/RENAME_CARD/.test(looksBody),
    '「装扮」页里不再有改名卡');
  const mainSrc = readFileSync(join(root, 'src/main.js'), 'utf8');
  ok(/async function warmUp\(awayMs\)/.test(mainSrc) && /20 \* 60 \* 1000/.test(mainSrc),
    '★ 加载时预热消息，离线超 20 分钟多等 1~2 秒');
  ok(/1000 \+ Math\.round\(Math\.random\(\) \* 1000\)/.test(mainSrc), '多等的就是 1~2 秒');
  ok(/defaultRequestText\(\)/.test(friUi) && /REQUEST_POOL/.test(friUi)
    && !/上一局/.test((friUi.match(/REQUEST_POOL = \[[\s\S]*?\];/) || [''])[0]),
    '★ 加好友默认文案是随机预设池（不提"上一局"这种具体信息）');

  /* ★ 用户要求：聊天里"对方正在输入…"也必须带头像，标题不要再切成"正在输入" */
  ok(/function showTyping\(faceSrc\)/.test(friUi)
    && /row\.className = 'chat-row other'/.test(friUi)
    && /face\.className = 'chat-face'/.test(friUi),
    '★ "正在输入…"那条带头像（原来只有一条光气泡）');
  ok(/showTyping\(ASSETS\.avatar\(persona\.avatar\)\)/.test(friUi),
    '"正在输入…"那条用的是对方的头像');
  /* ★ 加好友改成"发申请"（用户拍板）：编辑文案 → 延迟 1~5 秒通过 → 我发申请 + TA 回这条 */
  ok(/export function askFriendRequestOverlay\(\{ app, persona, host = null \}\)/.test(friUi)
    && /id="fr-note"/.test(friUi) && /data-fr-ok/.test(friUi),
    '★ 加好友先弹浮窗、可以编辑申请文案');
  ok(/export async function requestFriend\(\{ app, persona, host = null, fromMatch = false/.test(friUi),
    '★ 申请流程抽成一个函数（所有"加好友"入口共用）');
  ok(/await new Promise\(\(r\) => setTimeout\(r, FRIEND\.acceptMinMs/.test(friUi)
    && /acceptMinMs: 1000/.test(readFileSync(join(root, 'src/config.js'), 'utf8'))
    && /acceptMaxMs: 5000/.test(readFileSync(join(root, 'src/config.js'), 'utf8')),
    '★ 发送后延迟 1~5 秒才通过');
  ok(/await sendFriendMessage\(app, persona\.id, note/.test(friUi),
    '★ 通过之后把"我发的申请"落进聊天，再让 TA 回这条（两条消息）');
  ok(!/if \(currentId !== p\.id\) return;[\s\S]{0,120}pickGreeting/.test(friUi),
    '★ 老的"加完直接冒一句固定问候"那条路已经拆掉了');
  /* ★ 血泪教训：点「加好友」→ renderPicker 里用了没声明的 pendingAdd → Uncaught ReferenceError。
     轻量 DOM stub 的 querySelectorAll 永远返回 []，点不到那个按钮，所以只能在这里静态钉住。 */
  ok(/const pendingAdd = new Set\(\);/.test(friUi)
    && friUi.indexOf('const pendingAdd = new Set();') < friUi.indexOf('pendingAdd.has('),
    '★ pendingAdd 先声明再使用（点加好友不再 ReferenceError）');
  /* ★ 用户要求：加好友通过后，在我那句申请下面挂一行小灰字 */
  ok(/systemNote: '对方已经同意了你的好友申请'/.test(friUi),
    '★ 加好友通过后挂系统提示"对方已经同意了你的好友申请"');
  ok(/if \(m\.role === 'sys'\) return `\$\{stamp\}<div class="chat-sys">\$\{m\.text\}<\/div>`;/.test(friUi),
    '★ 私聊里 sys 消息渲染成居中一行小灰字（不进气泡）');
  ok(/\.chat-sys \{/.test(readFileSync(join(root, 'styles/panels.css'), 'utf8')),
    '.chat-sys 有样式（居中、小灰字）');
  ok(/filter\(\(m\) => m && m\.role !== 'sys'\)/.test(readFileSync(join(root, 'src/ai/friend.js'), 'utf8')),
    '★ 系统提示不进对话历史（否则模型会当成自己说的话）');
  ok(/<div class="friend-sub"><i class="online-dot"><\/i>\$\{tier\.label\}<\/div>/.test(friUi)
    && !/正在输入…<\/div>/.test(friUi),
    '★ 聊天标题不再切成"正在输入…"，一直显示关系档（用户要求取消那个状态）');
  /* ★ 用户拍板：让 AI 知道"自己也在这款叫 Gameet 的游戏里"，不是旁边的 NPC */
  const styleSrc = readFileSync(join(root, 'src/data/style.js'), 'utf8');
  ok(/export const GAME_WORLD_LINE/.test(styleSrc) && /Gameet/.test(styleSrc),
    '★ 有"我们都在玩 Gameet"这一行');
  ok(/卡牌桌游 \+ 社交/.test(styleSrc) && /斗地主/.test(styleSrc) && /友圈/.test(styleSrc),
    '写清了这是一款卡牌桌游 + 社交平台（含三种玩法与友圈）');
  ok(/不是站在旁边的 NPC/.test(styleSrc), '★ 强调它自己也是玩家（不是 NPC）');
  ok(/我是 AI \/ 系统 \/ 程序 \/ 机器人 \/ NPC/.test(styleSrc), '并写死：不许说出戏的自称');
  ok(/const out = \[GAME_WORLD_LINE\];/.test(styleSrc),
    '★ 挂在 styleRules() 的第一行 —— 私聊/群聊/弹幕/友圈/牌桌台词全会带上');
  for (const f of ['src/ai/friend.js', 'src/ai/group.js', 'src/ai/moments.js', 'src/ai/chat.js']) {
    ok(/styleRules\(/.test(readFileSync(join(root, f), 'utf8')), `${f} 走的是同一份 styleRules（所以世界观也带上了）`);
  }

  ok(/theme-light\.css/.test(idx), 'theme-light.css 在 index.html 里加载');
  /* ★ 品牌标志：深浅两套 SVG（老版斗地主图标不再当标志用） */
  ok(existsSync(join(root, 'assets/ui/logo-dark.svg')) && existsSync(join(root, 'assets/ui/logo-light.svg')),
    '★ 有深浅两套 SVG 标志');
  ok((idx.match(/class="loading-logo logo-dark"/g) || []).length === 1
    && (idx.match(/class="loading-logo logo-light"/g) || []).length === 1,
    '加载页放了两套标志（深 / 浅各一张）');
  ok((idx.match(/class="brand-logo logo-dark"/g) || []).length === 1
    && (idx.match(/class="brand-logo logo-light"/g) || []).length === 1,
    '大厅左上角也放了两套');
  ok(/\.logo-light \{ display: none; \}/.test(readFileSync(join(root, 'styles/lobby.css'), 'utf8')),
    '★ 默认（深色主题）只显示深色标志');
  ok(/:root\[data-theme="light"\] \.logo-light \{ display: inline-block; \}/.test(lightCss)
    && /:root\[data-theme="light"\] \.logo-dark \{ display: none; \}/.test(lightCss),
    '★ 浅色主题反过来显示浅色标志');
  ok(/logo\.png/.test(idx), 'favicon 仍然用 PNG（最稳）');
  const darkSvg = readFileSync(join(root, 'assets/ui/logo-dark.svg'), 'utf8');
  const lightSvg = readFileSync(join(root, 'assets/ui/logo-light.svg'), 'utf8');
  ok(/chat|bubble/i.test(darkSvg) || /<rect[\s\S]*<circle/.test(darkSvg), '标志是"牌 + 气泡"这类几何构图');
  ok(!/<text/.test(darkSvg) && !/<text/.test(lightSvg), '标志里没有 <text>（52px 下不会糊成字）');
  ok(darkSvg !== lightSvg && /#f6cf7c|#ff7bac/.test(darkSvg) && /#e0568a|#d8548a|#3a3172/.test(lightSvg),
    '两套配色不同（深色暖金/玫粉，浅色深靛/玫粉）');
  ok(/border-radius: 50%/.test(readFileSync(join(root, 'styles/lobby.css'), 'utf8')), '标志按圆形展示（构图已按圆裁剪做过）');

  /* ★ 用户要求：社交 / 商城面板高度固定（切标签不跳），内部滚轮 */
  const panelsCss2 = readFileSync(join(root, 'styles/panels.css'), 'utf8');
  ok(/\.drawer\.is-fixed,\s*\n\.friends-drawer \{\s*height: min\(80vh, 640px\)/.test(panelsCss2),
    '★ 社交与商城面板高度固定（min(80vh, 640px)）');
  ok(/\.drawer\.is-fixed \.drawer-body \{ flex: 1; min-height: 0; overflow: auto; \}/.test(panelsCss2),
    '商城内部自己滚');
  ok(/\.friends-drawer \.moments-list \{ flex: 1; min-height: 0; max-height: none; \}/.test(panelsCss2),
    '★ 友圈列表吃掉剩余高度并内部滚动（不再靠 max-height: 56vh 撑高面板）');
  ok(/drawerShell\(title, body, foot = '', cls = ''\)/.test(pan)
    && /'is-fixed'\)\)\;/.test(pan), '商城的抽屉挂了 is-fixed 类');

  /* ★ 用户报的：不叫 / 不出跟底色几乎一样、"正在出牌"是黑字、"思考中"太淡 */
  ok(/:root\[data-theme="light"\] #screen-table \.status-bar,[\s\S]{0,120}color: #fff/.test(lightCss),
    '★ 深底状态条里的字显式写白（不再继承 body 的黑字）');
  ok(/#screen-table \.seat-think,[\s\S]{0,200}color: var\(--blue-ink\)/.test(lightCss),
    '★ "思考中"在浅底上压深');
  ok(/:root\[data-theme="light"\] \.btn:not\(\.primary\),[\s\S]{0,220}border: 1px solid #c9cfdc/.test(lightCss),
    '★ 灰底按钮（不叫 / 不出）给了一张看得见的脸（描边 + 投影）');
  ok(/function showTyping\(faceSrc\)[\s\S]{0,400}log\.querySelector\('\.center-note'\)/.test(friUi),
    '★ 加好友时先拿掉"打个招呼吧"占位，否则"正在输入…"会跑到聊天框最下面（用户报的 bug）');
  const cssLinks = [...idx.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  ok(cssLinks[cssLinks.length - 1] === 'styles/theme-light.css',
    `★ 浅色样式表放在最后加载（最后一个样式表：${cssLinks[cssLinks.length - 1]}）`);
  ok(/THEMES/.test(cosStore) && /export function equipTheme/.test(cosStore) && /themeNameOf/.test(cosStore),
    '装扮 store 里有风格三件套（拥有 / 佩戴 / 当前名）');

  /* ---------- 今日限时礼包 ×2 / 折扣道具可买 5 次 ---------- */
  ok(/export function dailyPacksOf/.test(actData) && /pickOfDay\(rest, key, 'pack2'\)/.test(actData),
    '★ 今天两款礼包（第二款从剩下几档里挑 → 档位必然不同）');
  ok(/packsBought/.test(readFileSync(join(root, 'src/store/storage.js'), 'utf8')),
    '存档里记的是"今天买过哪几款"（packsBought）');
  ok(/main\.querySelectorAll\('\[data-buy-pack\]'\)/.test(act) && /data-buy-pack="\$\{p\.id\}"/.test(act),
    '两款各有各的购买按钮');
  ok(/export const DISCOUNT_ITEM_BUYS = 5;/.test(actData), '★ 道具类折扣能买 5 次');
  ok(/export function discountMaxBuys/.test(actData) && /kind === 'item'/.test(actData),
    '装扮类仍然只给 1 次');
  ok(/discountCount/.test(readFileSync(join(root, 'src/store/storage.js'), 'utf8'))
    && /a\.discountCount = st\.boughtCount \+ 1/.test(actStore), '折扣按"今天买了几次"记账');
  ok(/今日还剩/.test(act) && /剩 \$\{d\.left\} 次/.test(act), '界面上写清楚还剩几次');

  // image/ 文件夹：30 张 AI 头像，可用真实照片直接替换
  const manSrc = readFileSync(join(root, 'assets/manifest.js'), 'utf8');
  ok(/image\/\$\{s\}\.png/.test(manSrc) && /avatarDir: 'image'/.test(manSrc),
    '头像路径指向项目根的 image/ 目录');
  ok(/data:\|blob:\|https\?/.test(manSrc),
    '★ 头像助手是幂等的：已经是路径 / dataURL（玩家上传的照片）就原样返回，不再套一层 image/');
  const imgDir = join(root, 'image');
  ok(existsSync(imgDir), 'image/ 目录存在');
  const missingAvatars = Array.from({ length: 30 }, (_, i) => `avatar_${String(i + 1).padStart(2, '0')}.png`)
    .filter((f) => !existsSync(join(imgDir, f)));
  ok(missingAvatars.length === 0, `image/ 里 30 张 AI 头像都在（缺 ${missingAvatars.length}）`);
  ok(existsSync(join(imgDir, 'README.md')), 'image/ 里有替换说明');

  // 每个 AI 都要有性别，且性别/年龄都会进提示词
  const personaSrc = readFileSync(join(root, 'src/data/personas.js'), 'utf8');
  const personaCount = (personaSrc.match(/^    id: 'p\d+',$/gm) || []).length;
  ok(personaCount >= 29, `人设数量 ${personaCount}（p01~p28 + p29 何知非）`);
  ok((personaSrc.match(/gender: '[mf]',/g) || []).length === personaCount, '每个人设都标了性别');
  ok((personaSrc.match(/age: \d+,/g) || []).length === personaCount, '每个人设都标了年龄');
  ok(/export function genderPromptLine/.test(personaSrc), '性别有专门的提示词行');
  ok(/export function agePromptLine/.test(personaSrc)
    && /绝对不要主动提年龄/.test(personaSrc), '年龄作为背景知识进提示词，且明确"不许主动提"');
  for (const f of ['src/ai/chat.js', 'src/ai/friend.js', 'src/ai/danmaku.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    ok(/genderPromptLine\(persona\)/.test(src), `${f} 注入了性别`);
    ok(/agePromptLine\(persona\)/.test(src), `${f} 注入了年龄`);
  }
  ok(/timeContextLine\(\)/.test(readFileSync(join(root, 'src/ai/friend.js'), 'utf8')),
    '私聊提示词里带上"现在几点"（防止时间错位）');
  ok(/lastChatGapLine\(friend\.chat\)/.test(readFileSync(join(root, 'src/ai/friend.js'), 'utf8')),
    '私聊提示词里还带上"距上次说话多久"');
  ok(/timeContextLine\(new Date\(\), \{ short: true \}\)/.test(readFileSync(join(root, 'src/ai/chat.js'), 'utf8')),
    '牌桌台词也带时间（简短版）');
  ok(/genderTag\(/.test(readFileSync(join(root, 'src/ui/friends.js'), 'utf8')), '好友列表里标注了性别');
  ok(/\.gender-tag/.test(readFileSync(join(root, 'styles/friends.css'), 'utf8')), '性别小标有样式（♂ 蓝 / ♀ 粉）');

  const friSrc = readFileSync(join(root, 'src/ui/friends.js'), 'utf8');
  const pkSrc = readFileSync(join(root, 'src/ai/friend.js'), 'utf8');
  const stSrc = readFileSync(join(root, 'src/store/friends.js'), 'utf8');
  const storeSrc = readFileSync(join(root, 'src/store/storage.js'), 'utf8');

  // 好友列表第二行必须是**个性签名**，不是关系档（点头之交 / 挚友…）
  const listHtml = (friSrc.match(/listBox\.innerHTML = shown\.map\(\(f\) => \{[\s\S]*?\}\)\.join\(''\);/) || [''])[0];
  ok(listHtml.length > 0, '取得到好友列表的渲染代码');
  ok(/signatureOf\(p\)/.test(listHtml), '★ 列表第二行用的是个性签名（signatureOf）');
  ok(!/relationText/.test(listHtml), '★ 列表里不再显示关系档（点头之交那种）');
  ok(/friend-sub">\$\{sign\}/.test(listHtml), '签名放在 friend-sub 那一行');
  // 关系档没丢，只是挪到右边聊天窗口的标题里
  const headHtml = (friSrc.match(/<div class="friend-head">[\s\S]*?<\/div>\s*\$\{hint\}/) || [''])[0];
  ok(/tier\.label/.test(headHtml), '关系档仍然显示在聊天窗口标题里（没丢信息）');
  ok(/relationText\(f, app\.save\)/.test(friSrc), '房间座位卡上仍然显示关系（那里要展示"称号 + 关系 · 身家"）');
  // storage.js 例外：它必须留着老的 cpId 做存档迁移，所以单独查
  for (const [name, src] of [['ui/friends', friSrc], ['ai/friend', pkSrc], ['store/friends', stSrc]]) {
    ok(!/\bCP\b/.test(src), `${name} 里不再出现 "CP"（统一叫恋人）`);
  }
  ok(/label: '恋人'/.test(stSrc), '关系档位里有「恋人」');
  ok(/loverId: ''/.test(storeSrc) && /delete s\.cpId/.test(storeSrc), '存档字段叫 loverId，并且会从老的 cpId 迁移');
  ok(/export function setLover/.test(stSrc) && /已经有恋人了/.test(stSrc), '全局只能有 1 个恋人');
  ok(/export function breakUp/.test(stSrc) && /breakupAffinity/.test(stSrc), '分手把好感度落回朋友');
  ok(/export function canConfess/.test(stSrc) && /if \(save\.loverId\) return false/.test(stSrc),
    '★ 已有恋人 → 不触发表白审查');
  ok(/export function canBreakup/.test(stSrc), '已经是恋人才审查分手');
  ok(/askBreakup/.test(pkSrc) && /"breakup": true\/false/.test(pkSrc), '分析提示词里有 breakup 开关');
  ok(/export function isBreakup/.test(pkSrc) && /export function isConfession/.test(pkSrc), '表白 / 分手都有本地兜底判断');
  // 表白/分手已经抽进 app.settleFriendChat —— 私聊和房间弹幕共用同一份
  const appSrc2 = readFileSync(join(root, 'src/ui/app.js'), 'utf8');
  ok(/async settleFriendChat\(personaId/.test(appSrc2), '沉淀逻辑抽成 app.settleFriendChat（一处实现）');
  ok(/setLover\(this\.save, personaId\)/.test(appSrc2) && /breakUp\(this\.save, personaId\)/.test(appSrc2),
    '聊天 / 弹幕里真的会确立 / 解除恋人关系');
  ok(/和玩家成了恋人/.test(appSrc2) && /和玩家分开了/.test(appSrc2), '关系变化会写进「关系」记忆');
  ok(/await app\.settleFriendChat\(personaId/.test(friSrc), '私聊调用这份沉淀逻辑');
  // ★ 房间弹幕只读不写：不写记忆、不动好感度
  const danmakuFn = (appSrc2.match(/async emitAiDanmaku\([\s\S]*?\n  \}/) || [''])[0];
  ok(danmakuFn.length > 0, '取得到 emitAiDanmaku');
  // 去掉注释再查，免得注释里提到某个函数名就算"调用了"
  const danmakuCode = danmakuFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/settleFriendChat/.test(danmakuCode), '★ 房间弹幕不调用沉淀逻辑（不写记忆、不动好感度）');
  ok(!/analyzeMessage|addMemory|adjustAffinity|setLover|breakUp/.test(danmakuCode), '★ 房间弹幕里没有任何写操作');
  ok(/friend,/.test(danmakuCode) && /isLover\(this\.save, persona\.id\)/.test(danmakuCode),
    '★ 但弹幕**读**得到记忆与好感度（传了 friend 和恋人标记）');
  ok(/loverBadge|💞/.test(friSrc), '恋人有标记');
  // 自设
  ok(/label: '自设'/.test(readFileSync(join(root, 'src/data/memory.js'), 'utf8')), 'memory 多了「自设」这一类');
  ok(/export function setSelfMemory/.test(stSrc) && /按"方面"覆盖/.test(stSrc), '自设按"方面"覆盖，不会两个老家并存');
  ok(/self: \{"方面": "内容"\}|"self": \{"方面": "内容"\}|\{"方面": "内容"\}/.test(pkSrc), '分析会要求输出 self');
  ok(/你自己.*在聊天里说过的设定/.test(pkSrc), '★ 回复提示词里带上"你说过的设定"（防止前后矛盾）');
  ok(/export function extractSelfMemory/.test(pkSrc), '自设也有本地兜底抽取');
  // ★ 归属：每条记忆都要标清楚是玩家的还是自己的（用户报过"分不清是谁的"）
  ok(/ownedLines\(playerList, OWNER_PLAYER\)/.test(pkSrc) && /ownedLines\(mine, OWNER_SELF\)/.test(pkSrc),
    '★ 提示词里每条记忆都带归属前缀（【关于玩家】/【你自己】）');
  ok(/export (const|function) ownerOf/.test(readFileSync(join(root, 'src/data/memory.js'), 'utf8')),
    '归属常量与判定收在 data/memory.js（前后端共用一份口径）');
  // ★ 防记反：光靠提示词不够，写入前还要过一遍"归属路由"
  ok(/export function guardSelfFacts/.test(pkSrc) && /export function guardPlayerMemory/.test(pkSrc),
    '★ 有"防记反"硬校验（自设必须出自 AI 那句话、玩家记忆必须出自玩家那句话）');
  ok(/export function routeFacts/.test(pkSrc) && /const routed = routeFacts\(\{/.test(pkSrc),
    '★ analyzeMessage 里统一过一遍归属路由（模型与本地兜底都覆盖）');
  ok(/playerText: text/.test(pkSrc) && /replyText: reply/.test(pkSrc) && /movedToSelf/.test(pkSrc),
    '★ 记反的会挪到正确的栏并报告（不是简单丢掉）');
  ok(/export function ensureOwnership/.test(stSrc) && /export function repairMemoryOwnership/.test(stSrc),
    '★ 老存档里记串的能拿聊天记录当证据搬回去');
  // ★ 自我披露门槛 + 最近 15 条上下文
  ok(/export function selfDisclosureLine/.test(stSrc), '★ 自我披露按好感度档位控制');
  ok(/selfDisclosureLine\(friend/.test(pkSrc) && /selfDisclosureLine\(me\)/.test(readFileSync(join(root, 'src/ai/group.js'), 'utf8')),
    '私聊与群聊都吃这套门槛');
  ok(/const FRIEND_RECENT = FRIEND\.recent \|\| 15;/.test(pkSrc) && /slice\(-FRIEND_RECENT\)/.test(pkSrc),
    '★ 私聊提示词带最近 15 条聊天');
  const cfgSrcMem = readFileSync(join(root, 'src/config.js'), 'utf8');
  ok(/recent: 15/.test(cfgSrcMem) && /GROUP\.recent/.test(readFileSync(join(root, 'src/ai/group.js'), 'utf8')),
    '★ 群聊提示词带最近 15 条消息');
  const grpAiSrc = readFileSync(join(root, 'src/ai/group.js'), 'utf8');
  ok(/guardGroupSelf/.test(grpAiSrc) && /guardGroupMemory/.test(grpAiSrc), '★ 群聊审查也过同一套校验');
  ok(/别把两个人的话记反/.test(pkSrc), '★ 提示词里也写明了"别记反"并给了具体例子');
  ok(/setSelfMemories\(app\.save, p\.id, facts\)/.test(readFileSync(join(root, 'src/ui/groups.js'), 'utf8')),
    '★ 群聊里谁顺口补充的设定也记在谁名下');

  // 付费项：牌背 / 头像框 / 改名卡
  ok(/data-buy-look="renameCard"/.test(pan) || /data-buy-look/.test(pan), '商城·装扮里能买改名卡 / 牌背 / 头像框');
  ok(/buyCosmetic\(app\.economy/.test(pan), '装扮是用开心豆买的');
  ok(/renameCardCount\(app\.save\)/.test(pan) && /useRenameCard/.test(pan), '改名要消耗一张改名卡');
  ok(/data-tab="looks"/.test(pan), '商城多了一个「装扮」分类');
  ok(/is-locked/.test(prof) && /🔒/.test(prof), '没拥有的装扮显示为锁住');
}

/* ---------------- 9) 群聊（好友面板的第二个标签） ---------------- */
console.log('-- 群聊');
{
  const fri = readFileSync(join(root, 'src/ui/friends.js'), 'utf8');
  const grp = readFileSync(join(root, 'src/ui/groups.js'), 'utf8');
  const grpAi = readFileSync(join(root, 'src/ai/group.js'), 'utf8');
  const grpStore = readFileSync(join(root, 'src/store/groups.js'), 'utf8');
  const cfg = readFileSync(join(root, 'src/config.js'), 'utf8');
  const friendsCss = readFileSync(join(root, 'styles/friends.css'), 'utf8');

  // 标签
  ok(/id="friend-tabs"/.test(fri) && /data-ftab="friends"/.test(fri) && /data-ftab="groups"/.test(fri),
    '好友面板加了「好友 / 群聊」两个标签');
  ok(/id="groups-body"/.test(fri), '群聊有自己的容器');
  ok(/renderGroups\(app, groupBox\)/.test(fri), '切到群聊标签才渲染群聊');

  // 建群 / 改名 / 拉人
  ok(/function openCreate\(\)/.test(grp) && /创建群聊/.test(grp), '能创建群聊');
  ok(/function openRename\(group\)/.test(grp) && /renameGroup\(/.test(grp), '能编辑群名称');
  ok(/function openInvite\(group\)/.test(grp) && /addGroupMembers\(/.test(grp), '能拉好友进群');
  ok(/removeGroupMember\(/.test(grp) && /deleteGroup\(/.test(grp), '能移出成员 / 解散群');
  // 去掉注释再查，免得注释里提到 openDrawer 就算"用了"
  const grpCode = grp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/openDrawer/.test(grpCode), '建群/改名/邀请用的是面板内浮层，不会把好友面板顶掉');

  // 交互：点消息回复
  ok(/\.gc-msg\.is-ai'\)[\s\S]{0,80}addEventListener\('click'/.test(grp), '点 AI 消息可以回复它');
  ok(/gc-cancel-reply/.test(grp) && /正在回复/.test(grp), '输入框上方显示"正在回复 XX"，可取消');
  ok(/replyTo: replyTo \? \{/.test(grp), '发出去的消息带着引用的那条');
  // 回复条不换行：人名 ≤ 6 字、引用正文 ≤ 20 字
  ok(/export const QUOTE_NAME_MAX = 6;/.test(grp) && /export const QUOTE_TEXT_MAX = 20;/.test(grp),
    '人名上限 6 个字、引用正文上限 20 个字（写成常量）');
  ok(/clipName\(name\)/.test(grp) && /回复 \$\{clipName\(m\.replyTo\.name\)\}：\$\{clipQuote\(m\.replyTo\.text\)\}/.test(grp),
    '消息里的引用条：名字与正文都先截断（不靠 CSS 硬切）');
  ok(/clipName\(replyTo\.name\)[\s\S]{0,40}clipQuote\(replyTo\.text\)/.test(grp),
    '"正在回复 XX"那条也走同一套截断');
  ok(/\.gc-replying-text \{ flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/.test(friendsCss),
    '回复条自己收成一行（nowrap + 省略号兜底）');
  ok(/\.gc-quote \{[\s\S]{0,200}white-space: nowrap/.test(friendsCss), '引用条也不许换行');
  ok(/\.gc-who \{[^}]*white-space: nowrap/.test(friendsCss), '名字那一行也不会被挤到第二行');
  // 发出后自动取消回复状态（回复只对下一条生效）
  const sendFn = (grp.match(/const send = \(\) => \{[\s\S]*?\n    \};/) || [''])[0];
  ok(!!sendFn && /const quoted = replyTo;\s*replyTo = null;/.test(sendFn) && /sendGroupMessage\(app, group, t, quoted/.test(sendFn),
    '★ 选中的回复发出去后自动取消（下一条是普通发言）');

  // 发言节奏
  ok(/GROUP\.replyMin \+ Math\.random\(\) \* \(GROUP\.replyMax - GROUP\.replyMin\)/.test(grp),
    '两条回复之间随机等 2~3 秒');
  ok(/setTyping\(\{ name: p\.name/.test(grp) && /正在输入…/.test(grp), '每条之前先显示"正在输入…"');
  ok(/for \(let i = 0; i < ids\.length; i \+= 1\)/.test(grp), '一条一条地回（不是一次性全出）');
  ok(/replyCountFor/.test(grp) && /export function replyCountFor/.test(grpAi), '按群人数决定几个人回');
  ok(/replyRange/.test(cfg) && /min: 8, lo: 2, hi: 4/.test(cfg), '人多时 2~4 个人回');
  ok(/maxMentions: 4/.test(cfg), '最多 4 个（防刷屏）');
  // 点名必回
  ok(/export function findMentioned/.test(grpAi) && /@\$\{p\.name\}/.test(grpAi), '支持 @名字 点名');
  ok(/被点名的人必须选上/.test(grpAi.replace(/\s/g, '')), '提示词里明确"被点名必须回"');
  ok(/const forced = replyTo[\s\S]{0,120}findMentioned\(text, members\)/.test(grp),
    '被回复的人 / 被点名的人先锁死');
  ok(/export function orderResponders/.test(grp) && /for \(const id of forced/.test(grp),
    '锁定的人排在回复队列最前面');

  // 至少 10 条上下文
  ok(/recent: 15/.test(cfg), '★ 群聊提示词默认带最近 15 条');
  ok(/GROUP\.recent/.test(grpAi), '提示词里用的是 GROUP.recent');
  ok(/最近的群消息（从早到晚/.test(grpAi), '把最近消息按时间顺序给模型');

  // 好感度 / 记忆
  ok(!/adjustAffinity/.test(grp), '★ 群聊界面不加好感度');
  ok(!/adjustAffinity/.test(grpAi), '★ 群聊 AI 层不加好感度');
  ok(!/adjustAffinity/.test(grpStore), '★ 群聊存档层不碰好感度');
  ok(/analyzeGroupChat/.test(grp) && /buildGroupAnalyzeMessages/.test(grpAi), '★ 群聊内容仍会过一遍审查');
  ok(/addMemory\(app\.save, p\.id, mem\)/.test(grp), '审查通过的写进各自的 memory');
  ok(/不要输出 delta/.test(grpAi), '审查提示词明确"不要判断好感度"');
  ok(/export function localGroupAnalyze/.test(grpAi) && /extractMemory/.test(grpAi), '审查也有本地兜底');

  // 存档
  ok(/groups: \[\]/.test(readFileSync(join(root, 'src/store/storage.js'), 'utf8')), '存档里有 groups');
  ok(/groupUnreadTotal/.test(readFileSync(join(root, 'src/ui/app.js'), 'utf8')), '群未读并进好友红点');
  ok(/\.panel-tabs/.test(friendsCss) && /\.gc-msg/.test(friendsCss) && /\.gc-overlay/.test(friendsCss),
    '群聊样式齐全（标签条 / 消息 / 浮层）');
  ok(/\.groups-body\[hidden\] \{ display: none; \}/.test(friendsCss), '群聊容器隐藏时不吃布局');
  // ★ 切标签必须"换一屏"，不能两个界面摞在一起：
  //   hidden 属性靠 UA 的 [hidden]{display:none} 生效，特异性低于 .xxx{display:grid}，
  //   所以凡是设了 display 又要用 hidden 收起来的容器，必须自己再写一条 [hidden] 规则
  ok(/\.friends-body\[hidden\] \{ display: none; \}/.test(friendsCss),
    '★ 好友容器 hidden 时真的会隐藏（否则群聊会显示在好友界面下方）');
  for (const [cls, file] of [['friends-body', 'styles/friends.css'], ['groups-body', 'styles/friends.css']]) {
    const css = readFileSync(join(root, file), 'utf8');
    const hasDisplay = new RegExp(`\\.${cls} \\{[^}]*display:`).test(css);
    const hasHiddenRule = new RegExp(`\\.${cls}\\[hidden\\] \\{ display: none; \\}`).test(css);
    ok(!hasDisplay || hasHiddenRule, `${cls} 设了 display，就必须有配套的 [hidden] 规则`);
  }
}

console.log(`\n────────────────────────────\n${fail ? `静态检查失败 ${fail} 项` : '静态检查全部通过'}`);
process.exit(fail ? 1 : 0);
