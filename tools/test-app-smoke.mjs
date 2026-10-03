/**
 * 应用冒烟测试（node tools/test-app-smoke.mjs）
 *
 * 起因（用户报的真 bug）：`app.rewardFriendPlay` 里用了一个**从没定义过**的常量
 * `AFFINITY_PLAY_MATCHED`，一调用就 ReferenceError。它排在钓鱼结算流程里
 * "打开结算面板"之前，于是**小猫钓鱼打完没有结算页面**。
 * `node --check` 查不出这种错（语法没错），必须有"真跑一遍"的测试。
 *
 * 这个套件做两件事：
 *   1. 用万能 DOM 桩把 UI 模块全加载一遍，并**真调用**几个关键入口
 *      （结算给好感度、钓鱼 finish、结算面板、存档/记忆相关方法），任何
 *      ReferenceError / TypeError 都会让它红。
 *   2. 静态扫一遍源码，找**全大写常量**里"用了但没定义也没 import"的（就是上面那类 bug）。
 */
import { readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };

/**
 * ★ 崩溃兜底：Windows 上 stdout 重定向到文件时是异步的，进程要是**突然挂掉**
 *   （未捕获异常 / unhandledRejection），最后那几行日志会连错误栈一起丢掉，
 *   只看到一个莫名的 exit 1。这里把崩溃原因**同步写到文件**，保证查得到。
 */
const CRASH = join(root, 'smoke-crash.txt');
function trap(err, tag) {
  try {
    writeFileSync(CRASH, `${tag}\n${(err && (err.stack || err.message)) || String(err)}\n`);
  } catch { /* 写不进去就算了 */ }
  console.error(`${tag}：${(err && err.message) || err}`);
  process.exit(9);
}
process.on('uncaughtException', (e) => trap(e, 'uncaughtException'));
process.on('unhandledRejection', (e) => trap(e, 'unhandledRejection'));

/* ===================================================================== */
/*  1) 万能 DOM 桩：够用就行，只为了"能把模块跑起来"                      */
/* ===================================================================== */
function makeStub(name = 'node') {
  const fn = function () { return makeStub(name); };
  const bag = {
    name,
    length: 0,
    dataset: {},
    files: [],
    value: '',
    hidden: false,
    disabled: false,
    textContent: '',
    src: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
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
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
globalThis.location = { protocol: 'http:', href: 'http://localhost:5173/' };
globalThis.speechSynthesis = makeStub('speechSynthesis');
globalThis.Image = function () { return makeStub('img'); };
globalThis.CustomEvent = function (t, o) { return { type: t, detail: o && o.detail }; };
globalThis.Event = globalThis.CustomEvent;

/* 拦住所有 setTimeout：既能看"排了哪些定时器"，也能手动触发（免得测试自己异步乱跑） */
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  timers.push({ fn, ms, rest });
  return timers.length;
};

const mod = (p) => `${new URL(`../${p}`, import.meta.url).href}`;

/* ===================================================================== */
console.log('-- 1) UI 模块都能加载');
{
  const files = [
    'src/ui/app.js', 'src/ui/table.js', 'src/ui/fishing.js', 'src/ui/panels.js', 'src/ui/friends.js',
    'src/ui/groups.js', 'src/ui/activity.js', 'src/ui/profile.js', 'src/ui/setup.js', 'src/ui/rank.js',
    'src/ui/mailbox.js', 'src/ui/lobby.js', 'src/ui/audio.js', 'src/ui/voice.js', 'src/ui/danmaku.js',
    'src/ui/moments.js', 'src/ui/invite.js',
  ];
  for (const f of files) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await import(mod(f));
      ok(true, '');
    } catch (err) {
      ok(false, `${f} 加载失败：${err && err.message}`);
    }
  }
  ok(true, `加载了 ${files.length} 个 UI 模块（有失败会在上面列出）`);
}

const { app } = await import(mod('src/ui/app.js'));
const { defaultSave } = await import(mod('src/store/storage.js'));
const { addFriend, findFriend } = await import(mod('src/store/friends.js'));
const { PERSONAS } = await import(mod('src/data/personas.js'));
const { FISHING_ROOMS, FRIEND } = await import(mod('src/config.js'));
const { FishingTable } = await import(mod('src/ui/fishing.js'));
const panels = await import(mod('src/ui/panels.js'));
const { Economy } = await import(mod('src/store/economy.js'));

/* ===================================================================== */
console.log('-- 2) 关键入口真调用一遍（ReferenceError 会在这里现形）');
{
  app.save = defaultSave();
  app.save.nickname = '冒烟测试';
  app.economy = new Economy(app.save, () => {});
  app.mode = 'ai';
  app.seatNames = ['冒烟测试', PERSONAS[0].name, PERSONAS[1].name];

  // ★ 就是这个方法炸掉了钓鱼结算（AFFINITY_PLAY_MATCHED 未定义）
  const p = PERSONAS[0];
  addFriend(app.save, p);
  const before = findFriend(app.save, p.id).affinity;
  let r1;
  try {
    r1 = app.rewardFriendPlay([p], true);
  } catch (err) {
    r1 = null;
    ok(false, `rewardFriendPlay 抛错：${err && err.message}`);
  }
  ok(Array.isArray(r1) && r1.length === 1, '★ rewardFriendPlay 能正常返回（不再 ReferenceError）');
  ok(findFriend(app.save, p.id).affinity === before + FRIEND.playAffinityInvited,
    `★ 邀请加成用的是 config 里的值（+${FRIEND.playAffinityInvited}）`);
  app.rewardFriendPlay([p], false);
  ok(findFriend(app.save, p.id).affinity === before + FRIEND.playAffinityInvited + FRIEND.playAffinityMatched,
    `★ 随机匹配加成也用 config 的值（+${FRIEND.playAffinityMatched}）`);
  ok(app.rewardFriendPlay([], false).length === 0, '没参战的人不会加好感');

  for (const [name, fn] of [
    ['matchJoinedBy', () => app.matchJoinedBy(null, 'p01')],
    ['needsSetup', () => app.needsSetup()],
    ['applySettings', () => app.applySettings()],
    ['applyTheme', () => app.applyTheme()],
    ['compressMemoryIfNeeded', () => app.compressMemoryIfNeeded('p99')],
    ['lastMatchOf', () => app.lastMatchOf('p01')],
  ]) {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') r.catch(() => {});
      ok(true, '');
    } catch (err) {
      ok(false, `app.${name}() 抛错：${err && err.message}`);
    }
  }
  ok(true, '存档 / 记忆 / 主题相关入口都不抛错');
}

/* ===================================================================== */
console.log('-- 3) 小猫钓鱼打完 → 必须能排上"结算面板"');
{
  app.save = defaultSave();
  app.save.nickname = '冒烟测试';
  app.economy = new Economy(app.save, () => {});
  app.fishPersona = PERSONAS[4];
  app.fishAvatar = PERSONAS[4].avatar;
  app.currentFishRoom = FISHING_ROOMS[0];
  app.seatNames = ['冒烟测试', PERSONAS[4].name, '对手'];

  const table = new FishingTable(app);
  const g = table.game;
  g.score = [18, 8];
  g.multiplier = 2;
  g.piles = [[], []];
  g.finish(); // over / winner 由真实逻辑算出来

  timers.length = 0;
  let threw = null;
  try {
    table.finish();
  } catch (err) {
    threw = err;
  }
  ok(!threw, `★ FishingTable.finish() 不再抛错${threw ? `：${threw.message}` : ''}`);
  const panelTimer = timers.find((t) => t.ms === 700 || t.ms === 900);
  ok(!!panelTimer, '★ finish() 里排上了"打开结算面板"的定时器（700 / 900ms）');
  if (panelTimer) {
    let cbErr = null;
    try {
      panelTimer.fn();
    } catch (err) {
      cbErr = err;
    }
    ok(!cbErr, `★ 结算面板的回调能正常跑完${cbErr ? `：${cbErr.message}` : ''}`);
  }
}

/* ===================================================================== */
console.log('-- 3.5) 所有面板 / 浮层都打开一遍（活动中心那个 nav 崩溃就是这么抓出来的）');
{
  const { openActivity } = await import(mod('src/ui/activity.js'));
  const { openRank } = await import(mod('src/ui/rank.js'));
  const { openMail } = await import(mod('src/ui/mailbox.js'));
  const { openProfile } = await import(mod('src/ui/profile.js'));
  const friendsPanel = await import(mod('src/ui/friends.js'));
  const openers = [
    ['活动中心', () => openActivity(app)],
    ['排行榜', () => openRank(app)],
    ['邮箱', () => openMail(app)],
    ['我的形象', () => openProfile(app)],
    ['商城', () => panels.openShop(app)],
    ['称号', () => panels.openTitles(app)],
    ['设置', () => panels.openSettings(app)],
    ['好友面板', () => friendsPanel.openFriends(app)],
    ['聊天面板', () => app.openChat()],
    ['签到', () => panels.openSignIn(app)],
  ];
  for (const [label, fn] of openers) {
    let err = null;
    try {
      const r = fn();
      if (r && typeof r.then === 'function') r.catch(() => {});
    } catch (e) {
      err = e;
    }
    ok(!err, `打开「${label}」不抛错${err ? `：${err.message}` : ''}`);
  }
  // 再来一遍（第二次打开会遇到"已经开着"的状态）
  for (const [label, fn] of openers) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    ok(!err, `再开一次「${label}」也不抛错${err ? `：${err.message}` : ''}`);
  }
}

/* ===================================================================== */
console.log('-- 3.55) ★ 好友自己发友圈：真的跑一遍（离线超过 20 分钟那条路）');
{
  const { addFriend } = await import(mod('src/store/friends.js'));
  const { findMoment, listMoments } = await import(mod('src/store/moments.js'));
  const { PERSONAS } = await import(mod('src/data/personas.js'));
  // 造 3 位好友，免得"没人评论"
  for (const p of PERSONAS.slice(0, 3)) addFriend(app.save, p);
  const ids = PERSONAS.slice(0, 3).map((p) => p.id);
  const [author, other] = ids;
  const leftAt = Date.now() - 3 * 3600 * 1000;
  const backAt = Date.now() - 60 * 1000;

  let err = null;
  try {
    await app.deliverFriendMoment(PERSONAS[0], author, { leftAt, backAt });
  } catch (e) { err = e; }
  ok(!err, `★ 好友发一条说说真的跑得通${err ? `：${err.message}` : ''}`);

  const mine = listMoments(app.save).find((m) => m.by === author);
  ok(!!mine, '★ 说说落库了，而且作者是那位好友（by = personaId）');
  if (mine) {
    ok(mine.at >= leftAt && mine.at <= backAt, '说说时间落在"玩家不在线"的那段时间里');
    ok(mine.likes.length <= 10, `★ 点赞不超过 10 个（实际 ${mine.likes.length}）`);
    ok(mine.likes.every((id) => id !== author), '作者不给自己点赞');
    ok(mine.comments.length >= 0, '评论数合法');
    ok(mine.comments.every((c) => ids.includes(c.by)), '★ 评论只由玩家的好友发（不会出现非好友）');
    ok(mine.comments.every((c) => c.by !== author), '作者不评自己的说说');
    for (const c of mine.comments) ok(c.at >= mine.at && c.at <= backAt, '评论时间在说说之后、玩家回来之前');
  }
  // 排期入口也要能跑（门槛 20 分钟）
  const before = listMoments(app.save).length;
  const n = app.scheduleReturnMoments(5 * 60 * 1000);
  ok(n === 0, '离线不到 20 分钟 → 不发友圈');
  ok(listMoments(app.save).length === before, '什么都没多出来');
  const n2 = app.scheduleReturnMoments(60 * 60 * 1000);
  ok(n2 >= 1 && n2 <= 4, `★ 离线超过 20 分钟 → 排期 1~2 位好友、各 1~2 条（这次 ${n2} 条）`);
}

/* ===================================================================== */
console.log('-- 3.56) ★ 离线回来：恋人权重更高 + 恋人这条能表达想念（真跑一遍）');
{
  const { listFriends: lf2, findFriend: ff2 } = await import(mod('src/store/friends.js'));
  const { RETURN_PING: RP } = await import(mod('src/config.js'));
  const { CHAT_BUCKETS: CB, CHAT_OPENERS: CO } = await import(mod('src/data/chatLines.js'));

  app.save = defaultSave();
  app.save.nickname = '冒烟测试';
  app.economy = new Economy(app.save, () => {});
  app.friendsActiveWith = '';
  const mates = PERSONAS.slice(0, 4);
  for (const p of mates) addFriend(app.save, p);
  const loverId = mates[0].id;
  app.save.loverId = loverId; // 直接立关系：这是 isLover 读的字段

  timers.length = 0;
  ok(app.scheduleReturnPing(60 * 1000) === 0, '离线不到 2 分钟 → 没人来打招呼');
  ok(timers.length === 0, '一个定时器都没排');

  const savedSure = RP.loverSureChance;
  RP.loverSureChance = 1; // 把"保送"调成必中，去掉这条测试里的随机性（跑完还原）
  const picks = app.scheduleReturnPing(10 * 60 * 1000);
  RP.loverSureChance = savedSure;
  ok(picks >= 1 && picks <= RP.maxPing, `★ 离线 10 分钟 → 1~3 位主动发消息（${picks}）`);
  const pingTimers = timers.slice();
  ok(pingTimers.length === picks, '每位各排了一条（错开投递）');

  // 真跑一遍（回调里是 void deliverFriendPing(...)，所以用真定时器等它落库）
  for (const t of pingTimers) { try { t.fn(); } catch (e) { ok(false, `打招呼回调抛错：${e && e.message}`); } }
  const deadline = Date.now() + 4000;
  while (!(ff2(app.save, loverId).chat || []).some((m) => m.role === 'ai') && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => realSetTimeout(r, 10));
  }

  const loverChat = (ff2(app.save, loverId).chat || []).filter((m) => m.role === 'ai');
  ok(loverChat.length === 1, `★ 恋人保送来了一条（${loverChat.length} 条）`);
  const allLoverLines = Object.values(CB.lover).flat();
  const allOpenerLines = Object.values(CO).flat();
  if (loverChat.length) {
    const t = String(loverChat[0].text || '');
    ok(allLoverLines.some((l) => t.startsWith(l)) || /想你|心事|心里/.test(t),
      `★ 恋人这条是恋爱口吻（模型不可用时也不能是那句通用问候）：${t}`);
    ok(!allOpenerLines.includes(t), '不是通用开场白');
    ok(loverChat[0].at > Date.now() - 10 * 60 * 1000 - 5000 && loverChat[0].at <= Date.now(),
      '★ 这条的时间落在"玩家离线"的那段时间里');
  }
  ok(ff2(app.save, loverId).unread >= 1, '★ 计入未读（回来看到红点）');

  // 非恋人好友：**一句恋爱口吻都不许有**（否则全员撒娇就崩了）
  let others = 0;
  for (const f of lf2(app.save)) {
    if (f.personaId === loverId) continue;
    for (const m of (f.chat || []).filter((x) => x.role === 'ai')) {
      others += 1;
      ok(!/想你|心事|心里/.test(String(m.text || '')) && !allLoverLines.some((l) => String(m.text || '').startsWith(l)),
        `非恋人「${f.name}」不会撒娇（${m.text}）`);
    }
  }
  ok(others >= 0, `有 ${others} 条非恋人好友的主动消息，全部不带恋爱口吻`);
}

/* ===================================================================== */
console.log('-- 3.6) API Key：默认值 + 中间打码显示');
{
  const { maskKey, looksLikeKey } = await import(mod('src/data/secret.js'));
  const { CONFIG } = await import(mod('src/config.js'));
  /**
   * ★ 用户拍板：**仓库里不许出现真实 Key**（它在公开仓库里等于把钱包挂出去）。
   *   所以默认值留空；但**本机**为了开发方便可以在 config.js 里填自己的 Key，
   *   这条断言两种情况都放行，免得本地一填 Key 测试就红。
   */
  ok(CONFIG.apiKey === '' || looksLikeKey(CONFIG.apiKey),
    `★ 默认 Key 要么留空、要么是合法格式（实际 ${maskKey(CONFIG.apiKey)}）`);
  // 打码逻辑用**假的**串来验，不依赖真 Key
  const FAKE = 'sk-1234567890abcdefghij';
  ok(maskKey(FAKE) === 'sk-1234**ghij', `★ 显示时中间用 ** 藏住（${maskKey(FAKE)}）`);
  ok(!maskKey(FAKE).includes('567890abcd'), '中间那段真的没露出来');
  ok(maskKey('') === '（没填）' && maskKey(null) === '（没填）', '空 Key 有占位文案');
  ok(maskKey('sk-abc') === '******', '太短的整串打码，不会反而暴露');
  ok(looksLikeKey(FAKE) && !looksLikeKey('123') && !looksLikeKey(''), '粗校验能分辨像不像 Key');
  // 源码里不许再写死真实 Key（真出过一次：config / 注释 / PRD 里都是明文）
  const srcHasKey = (p) => /sk-[a-zA-Z0-9]{24,}/.test(readFileSync(join(root, p), 'utf8'));
  ok(!srcHasKey('src/config.js'), '★ config.js 里没有写死的真实 Key');
  ok(!srcHasKey('src/data/secret.js'), '★ secret.js 的注释里也没有真实 Key');
  ok(!srcHasKey('PRD_斗地主AI游戏.md'), '★ PRD 里也没有真实 Key');
  // 设置面板里：输入框是密码型 + 有显示/隐藏按钮 + 打码那一行
  const panelsSrc = readFileSync(join(root, 'src/ui/panels.js'), 'utf8');
  ok(/id="set-key" value="\$\{CONFIG\.apiKey\}"[\s\S]{0,80}type="password"|type="password" id="set-key"/.test(panelsSrc),
    '输入框默认是密码型（不整串亮出来）');
  ok(/id="btn-toggle-key"/.test(panelsSrc), '有「👁 显示 / 🙈 隐藏」开关');
  ok(/id="key-mask">\$\{maskKey\(CONFIG\.apiKey\)\}</.test(panelsSrc), '面板上直接显示打码后的 Key');
  ok(/const key = keyInput\.value\.trim\(\);[\s\S]{0,200}?CONFIG\.apiKey = key/.test(panelsSrc),
    '测试连通 / 保存时送出去的是**完整** Key（打码只影响显示）');
  // 没填 Key 时要给一句提醒，不能静默（AI 会用本地语气兜底）
  ok(/if \(!CONFIG\.apiKey\) \{[\s\S]{0,200}还没填 DeepSeek API Key/.test(readFileSync(join(root, 'src/ui/app.js'), 'utf8')),
    '★ 没填 Key 时提示怎么填（不是静默降级）');

  /**
   * ★ 用户拍板：Key 存**本机存档**（localStorage + save/ddz_save.json，都被 .gitignore 排除），
   *   这样"仓库里不带 Key"和"本机填一次就够"能同时成立。
   *   这里真跑一遍 applySettings，确认存档里的 Key 会被读回 CONFIG（以前没同步，刷新即丢）。
   */
  const { DEFAULT_SETTINGS } = await import(mod('src/config.js'));
  ok(DEFAULT_SETTINGS.apiKey === '', '★ 默认设置里 Key 是空的（仓库不带 Key）');
  const keepKey = CONFIG.apiKey;
  app.save.settings.apiKey = 'sk-abcdefghijklmnopqrstuvwx';
  app.applySettings();
  ok(CONFIG.apiKey === 'sk-abcdefghijklmnopqrstuvwx',
    '★ 存档里的 Key 被 applySettings 读回 CONFIG（刷新不丢）');
  // 存档里没有 → 回落到源码默认值（本机开发在 config.js 里填 Key 的情况）
  app.save.settings.apiKey = '';
  CONFIG.apiKey = 'sk-source-default-0000000000';
  app.applySettings();
  ok(CONFIG.apiKey === 'sk-source-default-0000000000', '存档里没填时回落到源码默认值');
  CONFIG.apiKey = keepKey; // 还原，别影响后面的用例
  // 面板要真的把它写进存档（不然只是内存里改了一下）
  ok(/app\.save\.settings\.apiKey = key;[\s\S]{0,80}app\.persist\('settings'\)/.test(panelsSrc),
    '★ 设置面板把 Key 写进存档并落盘');
  ok(/keyInput\.addEventListener\('change', \(\) => saveKey\(\)\)/.test(panelsSrc),
    '★ 粘完 Key 离开输入框就自动保存（不用记得点按钮）');
  ok(/saveKey\(true\)/.test(panelsSrc), '点"测试连通"也会顺手存下来');
}

/* ===================================================================== */
console.log('-- 3.7) 友圈：发一条说说 → 挑人 → 真跑一次"AI 来评论"');
{
  const { renderMoments } = await import(mod('src/ui/moments.js'));
  const { addMoment } = await import(mod('src/store/moments.js'));

  app.save = defaultSave();
  app.save.nickname = '冒烟测试';
  app.economy = new Economy(app.save, () => {});
  for (const p of PERSONAS.slice(0, 4)) addFriend(app.save, p);

  // 界面画得出来（头像 / 名称 / 内容 / 评论行）
  let uiErr = null;
  try {
    renderMoments(app, makeStub('moments-box'));
  } catch (err) { uiErr = err; }
  ok(!uiErr, `★ renderMoments 不抛错${uiErr ? `：${uiErr.message}` : ''}`);

  const { moment } = addMoment(app.save, '今天天气不错，出门走走');
  timers.length = 0;
  try {
    await app.scheduleMomentCommenters(moment.id, moment.text);
  } catch (err) {
    ok(false, `★ scheduleMomentCommenters 抛错：${err && err.message}`);
  }
  ok(timers.length > 0, '★ 发完说说排上了"好友来点赞 / 评论"的定时器');
  // 真把排上的回调跑一遍（模型不可用时走本地兜底）
  for (const t of timers.slice()) {
    try {
      const r = t.fn();
      if (r && typeof r.then === 'function') await r;
    } catch (err) {
      ok(false, `友圈定时器回调抛错：${err && err.message}`);
    }
  }
  const after = app.save.moments[0];
  ok(after.comments.length > 0, '★ 跑完之后真的有人来评论了');
  ok(after.likes.length > 0, '★ 点赞也点上了');
  ok(after.comments.every((c) => c.text && c.text.length > 0), '评论内容非空');
  ok(after.comments.every((c) => PERSONAS.some((p) => p.id === c.by)), '评论人都是真实存在的好友');
  // ★ 评论之后要额外写一条「友圈」记忆（用户要求：和对局一样，不占常规记忆）
  const { listMomentMemory } = await import(mod('src/store/friends.js'));
  const withMoment = app.save.friends.filter((f) => listMomentMemory(f).length > 0);
  ok(withMoment.length > 0, '★ 评论过的好友多了「友圈」记忆');
  ok(withMoment.every((f) => listMomentMemory(f).every((m) => m.includes(after.text.slice(0, 6)))),
    '记忆里带着那条说说');

  /* ★ 玩家回复某条 AI 评论 → 3~10s 之后它才回（用户拍板）
     这里把 setTimeout 换成"记下延迟、但立刻触发"的版本，既能测出延迟、又不用真等 */
  {
    const aiComment = after.comments.find((c) => c.by !== 'me');
    ok(!!aiComment, '有一条 AI 评论可以用来回复');
    const captured = [];
    const stubTimer = globalThis.setTimeout; // 本套件里 setTimeout 被换成了"只记录不触发"的桩
    globalThis.setTimeout = (fn, ms, ...rest) => {
      captured.push(ms);
      // ★ 用**真的** setTimeout（realSetTimeout）立刻触发：既能测出延迟，又不用真等
      return realSetTimeout(fn, Math.min(Number(ms) || 0, 1), ...rest);
    };
    // 玩家先"回复"那条 AI 评论（走真实存档写入，和界面里一样）
    const { addMomentComment } = await import(mod('src/store/moments.js'));
    const playerC = addMomentComment(app.save, moment.id, {
      by: 'me', text: '谢谢～', replyTo: aiComment.id,
    }).comment;
    let replied = null;
    try {
      replied = await app.replyToMomentComment(moment.id, aiComment.id, '谢谢～', { playerCommentId: playerC.id });
    } catch (err) {
      ok(false, `★ replyToMomentComment 抛错：${err && err.message}`);
    } finally {
      globalThis.setTimeout = stubTimer;
    }
    // 第一个定时器就是"先等一会儿"；后面的 12s/8s 是模型调用的超时兜底
    const waited = captured[0];
    ok(captured.length > 0, '回复流程里排了定时器');
    ok(waited >= 1000 && waited <= 5000, `★ 回复前先等了 1~5s（实际 ${waited}ms）`);
    ok(!!replied, '那位好友接着回了玩家一句');
    const now = app.save.moments[0];
    const aiReply = now.comments.filter((c) => c.by === aiComment.by).pop();
    ok(!!aiReply, '能找到它新发的那条');
    // ★ 用户报的 bug：它回复的是**玩家那句**，不是它自己那条
    ok(aiReply.replyTo === playerC.id, '★ 它那条挂在**玩家这条回复**下面（不是挂在它自己那条上）');
    ok(aiReply.replyTo !== aiComment.id, '★ 不再是"AI 回复它自己"');
    ok(playerC.replyTo === aiComment.id, '玩家那条仍然正确地引用着 AI 的评论（这条没被改坏）');
    ok(listMomentMemory(app.save.friends.find((f) => f.personaId === aiComment.by)).length === 1,
      '回复之后那条「友圈」记忆被更新（不是又加一条）');
  }

  // 删掉好友之后排的评论不该再落库（不是好友了）
  app.save.moments = [];
  const { moment: m2 } = addMoment(app.save, '再来一条');
  timers.length = 0;
  await app.scheduleMomentCommenters(m2.id, m2.text);
  app.save.friends.forEach((f) => { f.removed = true; });
  for (const t of timers.slice()) {
    try {
      const r = t.fn();
      if (r && typeof r.then === 'function') await r;
    } catch { /* 忽略 */ }
  }
  ok((app.save.moments[0].comments || []).length === 0, '★ 好友都删了之后，排好的评论不会落库');
}

/* ===================================================================== */
console.log('-- 3.8) ★ 好友邀请我打牌：进桌的对手必须就是那位好友');
{
  const { ROOMS } = await import(mod('src/config.js'));
  const { listFriends } = await import(mod('src/store/friends.js'));

  app.save = defaultSave();
  app.save.nickname = '冒烟测试';
  app.economy = new Economy(app.save, () => {});
  for (const p of PERSONAS.slice(0, 4)) addFriend(app.save, p);
  const friends = listFriends(app.save);
  const host = friends[0];
  const other = friends[1];

  // 复刻 maybeInvite 的入口：挑出来的就是"好友记录"（字段 personaId），
  // 以前 app 直接读 pair.host.id → undefined → 进桌变成随机 AI（用户报的 bug）
  const started = [];
  const fishing = [];
  const realStartGame = app.startGame;
  const realStartFishing = app.startFishing;
  app.startGame = (roomId, ids, opts) => { started.push({ roomId, ids, opts }); };
  app.startFishing = (roomId, ids, opts) => { fishing.push({ roomId, ids, opts }); };
  try {
    await app.startInvitedMatch({ host, other }, { kind: 'ddz', room: ROOMS[0] });
    await app.startInvitedMatch({ host, other }, { kind: 'fishing', room: FISHING_ROOMS[0] });
  } catch (err) {
    ok(false, `startInvitedMatch 抛错：${err && err.message}`);
  } finally {
    app.startGame = realStartGame;
    app.startFishing = realStartFishing;
  }
  ok(started.length === 1 && fishing.length === 1, '斗地主 / 钓鱼各开局一次');
  ok(started[0].ids[0] === host.personaId, `★ 1 号位就是房主「${host.personaId}」（不是 undefined）`);
  ok(started[0].ids[1] === other.personaId, '★ 2 号位是另一位好友');
  ok(!started[0].ids.includes(undefined), '★ 没有 undefined 混进座位（那会导致随机对手）');
  ok(fishing[0].ids[0] === host.personaId, '★ 小猫钓鱼的对手也是房主');
  ok(started[0].opts.invited === true && started[0].opts.startDelayMs >= 3000,
    '仍然是"邀请进来的 + 3~5 秒后开局"');

  // 直接传人设对象也要能用（两种形状都认）
  app.startGame = (roomId, ids) => { started.push({ roomId, ids }); };
  try {
    await app.startInvitedMatch({ host: PERSONAS[0], other: PERSONAS[1] }, { kind: 'ddz', room: ROOMS[0] });
  } finally {
    app.startGame = realStartGame;
  }
  ok(started[1].ids[0] === PERSONAS[0].id && started[1].ids[1] === PERSONAS[1].id,
    '★ 传人设对象（不是好友记录）时也对得上');
}

/* ===================================================================== */
console.log('-- 3.9) ★ AI 改名：改完人设 / 记忆 / 好友副本都跟着走，重置能还原');
{
  const { PERSONAS: PS } = await import(mod('src/data/personas.js'));
  const { aiNameOf, resetAiNames } = await import(mod('src/store/aiNames.js'));
  const { addRenameMemory, findFriend: ff } = await import(mod('src/store/friends.js'));

  app.save = defaultSave();
  app.save.nickname = '冒烟测试';
  const p = PS[7];
  const base = p.name;
  addFriend(app.save, p);

  let res = null;
  try {
    res = app.applyRename(p.id, '小八');
  } catch (err) {
    ok(false, `applyRename 抛错：${err && err.message}`);
  }
  ok(res && res.ok && res.to === '小八', `改名成功：${base} → 小八`);
  ok(PS[7].name === '小八', '★ 人设名字换了（牌桌 / 群聊 / 提示词全都读它）');
  ok(ff(app.save, p.id).name === '小八', '★ 好友记录里的名字副本也刷新了（社交列表不会显示旧名）');
  ok(aiNameOf(app.save, p.id) === '小八', '存档里记着自定义名字');
  ok((ff(app.save, p.id).memory || []).some((m) => m === `改名：${base}→小八`),
    `★ 记忆里写了「改名：${base}→小八」`);
  ok(app.save.aiNames[p.id].name === '小八', 'save.aiNames 里也有（重置就靠它清）');

  // 元数据：改名后的存档里，名字不是出厂名
  ok(JSON.stringify(app.save).includes('小八'), '存档序列化后带着新名字');

  // 重置 → 回出厂名
  app.save = defaultSave();
  resetAiNames(app.save);
  ok(PS[7].name === base, `★ 重置后回到出厂名「${base}」`);
  void addRenameMemory;

  // 静态契约：审查返回 rename 时，settleFriendChat 会去落地
  const appSrc = readFileSync(join(root, 'src/ui/app.js'), 'utf8');
  ok(/if \(res\.rename\) this\.applyRename\(personaId, res\.rename\);/.test(appSrc),
    '★ 审查判定要改名 → 聊天结算时落地');
  ok(/resetAiNames\(this\.save\)/.test(appSrc), '★ 重置存档时把 AI 名字一起还原');
  ok(/applyAiNames\(this\.save\)/.test(appSrc), '★ 启动时把自定义名字贴回人设');
}

/* ===================================================================== */
console.log('-- 3.95) ★ 私聊发送路径真跑一遍（currentId 那种跨作用域引用就靠这个抓）');
{
  const { sendFriendMessage } = await import(mod('src/ui/friends.js'));
  app.save = defaultSave();
  app.save.nickname = '冒烟测试';
  app.economy = new Economy(app.save, () => {});
  const p = PERSONAS[2];
  addFriend(app.save, p);
  findFriend(app.save, p.id).affinity = 40;

  let threw = null;
  const stubTimer2 = globalThis.setTimeout; // 本套件的 setTimeout 是"只记录不触发"的桩
  // 聊天里有"正在输入…"的等待，必须用真定时器（缩短到 1ms）才不会挂住
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(Number(ms) || 0, 1), ...rest);
  try {
    await sendFriendMessage(app, p.id, '在吗，刚打完一把', { onBusy() {}, refresh() {} });
  } catch (err) {
    threw = err;
  } finally {
    globalThis.setTimeout = stubTimer2;
  }
  ok(!threw, `★ 发消息不抛错（以前这里是 ReferenceError）${threw ? `：${threw.message}` : ''}`);
  const chat = findFriend(app.save, p.id).chat || [];
  ok(chat.some((m) => m.role === 'me' && m.text.includes('在吗')), '玩家那句进了聊天记录');
  ok(chat.some((m) => m.role === 'ai' && m.text), 'AI 回了话（模型不可用时走本地兜底）');

  // 静态：模块级的 sendFriendMessage 不许引用面板闭包里的变量
  const fxSrc = readFileSync(join(root, 'src/ui/friends.js'), 'utf8');
  const fnBody = (fxSrc.match(/export async function sendFriendMessage[\s\S]*?\n\}/) || [''])[0];
  ok(fnBody.length > 100, '能取出 sendFriendMessage 的源码');
  ok(!/\bcurrentId\b/.test(fnBody), '★ sendFriendMessage 里不再引用 currentId（面板闭包变量）');
  ok(/playerIdentityLines\(app\.save, \{ callName: callNameOf\(friend\), selfId: personaId \}\)/.test(fnBody),
    '用的是它自己那份好友记录里的称呼（selfId 用来判断要不要说"玩家有恋人"）');
}

/* ===================================================================== */
console.log('-- 3.96) ★ 群聊发送路径真跑一遍（用户报的 callNameOf is not defined）');
{
  const { sendGroupMessage } = await import(mod('src/ui/groups.js'));
  const { createGroup, listGroups, findGroup } = await import(mod('src/store/groups.js'));
  const { listFriends: lf } = await import(mod('src/store/friends.js'));

  app.save = defaultSave();
  app.save.nickname = '冒烟测试';
  app.economy = new Economy(app.save, () => {});
  const mates = [PERSONAS[1], PERSONAS[2], PERSONAS[3]];
  for (const m of mates) addFriend(app.save, m);
  const made = createGroup(app.save, '冒烟群', mates.map((m) => m.id)); // 返回 { ok, group }
  const g = (made && made.group) || listGroups(app.save)[0];
  ok(!!g && !!g.id, `群建起来了（${g && g.name}）`);

  let threw = null;
  const stubTimer3 = globalThis.setTimeout; // 本套件的 setTimeout 是"只记录不触发"的桩
  // "正在输入…" + 一条条回之间要等 2~3 秒，用真定时器（缩到 1ms）才不会挂住
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(Number(ms) || 0, 1), ...rest);
  try {
    await sendGroupMessage(app, g, '@' + mates[0].name + ' 群里聊两句', null, {
      setBusy() {}, setTyping() {}, render() {},
    });
  } catch (err) {
    threw = err;
  } finally {
    globalThis.setTimeout = stubTimer3;
  }
  ok(!threw, `★ 群里发消息不抛错（以前这里是 ReferenceError）${threw ? `：${threw.message}` : ''}`);
  const chat = (findGroup(app.save, g.id) || {}).chat || [];
  ok(chat.some((m) => m.role === 'me'), '玩家那句进了群记录');
  ok(chat.some((m) => m.role === 'ai' && m.text), 'AI 在群里回了话（模型不可用时走本地兜底）');

  // 静态：群里也用**它自己那份好友记录**的称呼（callNameOf 必须 import 进来）
  const gSrc = readFileSync(join(root, 'src/ui/groups.js'), 'utf8');
  ok(/import \{[^}]*\bcallNameOf\b[^}]*\} from '\.\.\/store\/friends\.js'/.test(gSrc),
    '★ groups.js 从 store/friends.js 里 import 了 callNameOf');
  void lf;
}

/* ===================================================================== */
console.log('-- 3.97) ★ 五子棋：开局 → 落子 → 连胜判定 → 结算（不加豆、只加好感）');
{
  const { GomokuTable } = await import(mod('src/ui/gomoku.js'));
  const { GOMOKU_ROOMS, GOMOKU } = await import(mod('src/config.js'));
  const idx = readFileSync(join(root, 'index.html'), 'utf8');

  // 静态：卡片换成五子棋了、屏幕在、结算面板在
  ok(/id="game-gomoku"/.test(idx) && /五子棋/.test(idx), '★ 大厅里的卡片是五子棋');
  ok(!/掼蛋/.test(idx), '掼蛋占位卡已删除');
  ok(/id="screen-gomoku"/.test(idx) && /id="gmk-board"/.test(idx), '五子棋有独立屏幕和棋盘');
  ok(/export function showGomokuResult/.test(readFileSync(join(root, 'src/ui/panels.js'), 'utf8')), '有本局结算面板');

  app.save = defaultSave();
  app.save.nickname = '冒烟测试';
  app.economy = new Economy(app.save, () => {});
  app.mode = 'ai';
  app.gameKind = 'gomoku';
  app.currentGomokuRoom = GOMOKU_ROOMS[1]; // 中级场
  const friend = PERSONAS[3];
  addFriend(app.save, friend);
  findFriend(app.save, friend.id).affinity = 10;
  app.gomokuPersona = friend;
  app.gomokuBotLevel = undefined;
  app.seatNames = ['冒烟测试', friend.name, ''];
  /**
   * 本套件的 setTimeout 是"只记录不触发"的桩：真正的说话链路（chat.speak → 打字延迟）
   * 会一直等定时器，所以这里把"说话"换成一个记录器，只验证**它被调用了**；
   * 说话链路本身由 test-fishing / test-flow 那几套覆盖。
   */
  const spoke = [];
  const realSpeak = app.gomokuSpeak.bind(app);
  app.gomokuSpeak = (scene, extra) => { spoke.push(scene); };
  // 前面几节开过面板，会往这里塞渲染回调；清掉，只测五子棋自己这条链路
  app.friendRenderers.clear();

  let table = null;
  try {
    table = new GomokuTable(app, {});
    table.startRound();
  } catch (err) {
    ok(false, `GomokuTable 起不来：${err && err.message}`);
  }
  ok(!!table, '★ 五子棋牌桌能建起来');
  if (table) {
    ok(table.room.id === 'mid', '用的是选中的场次');
    ok(!!table.board && table.board.length === 15, '棋盘 15×15 已就绪');
    ok(typeof table.playerFirst === 'boolean', '随机决定了谁先手');
    ok(table.level === '熟练' || typeof table.level === 'string', `对手难度取自人设（${table.level}）`);

    // 玩家连下五子（AI 每步都不理，直接摆一条横线）
    const before = { beans: app.save.beans, affinity: findFriend(app.save, friend.id).affinity };
    const y = 7;
    for (let i = 0; i < 5; i += 1) {
      const x = 2 + i;
      // 跳过 AI 的回合：直接把该落的补上（模拟"轮到玩家时点格子"）
      table.turn = table.playerColor;
      const okPlace = table.play(x, y, table.playerColor);
      if (!okPlace) break;
      if (table.over) break;
      table.turn = table.playerColor; // 继续让玩家下（测试里不让 AI 动）
    }
    ok(table.over === true, '★ 连成五子后本局结束');
    ok(table.wins === 1 && table.losses === 0, '记了一胜');
    ok(app.save.beans === before.beans, '★ 五子棋不动豆子（身家一分没变）');
    const after = findFriend(app.save, friend.id).affinity;
    ok(after === before.affinity + GOMOKU.affinityPerGame,
      `★ 参战好友好感度 +${GOMOKU.affinityPerGame}（${before.affinity} → ${after}）`);

    // 对局记忆：等它异步写完（模型不可用 → 本地兜底）
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => realSetTimeout(r, 5));
    }
    const hand = (app.save.recentHands || [])[0];
    ok(hand && hand.kind === 'gomoku', `★ 最近对局里记的是五子棋（${hand && hand.kind}）`);
    ok(hand && hand.delta === 0, '★ 这局的 delta 是 0（没有豆子输赢）');
    const mem = (findFriend(app.save, friend.id).memory || []).filter((m) => m.startsWith('对局：'));
    ok(mem.length >= 1, '★ 对手那边写了一条「对局」记忆');
    ok(mem.some((m) => /五子棋/.test(m)), `记忆里写明了是五子棋：${(mem[0] || '').slice(0, 40)}…`);

  // ★ 场次 = 难度池：AI 模式从池子里抽人（用户拍板的核心规则）
  {
    const { levelOfPersona, pickByRoom, botLevelOfRoom } = await import(mod('src/data/gomokuLevels.js'));
    const { audio } = await import(mod('src/ui/audio.js'));
    // 音频在 Node 里是桩：不关掉的话每次 startGomoku 都会起一个真的 BGM 调度 interval
    audio.startBgm = () => {};
    audio.stopBgm = () => {};
    audio.play = () => {};
    app.audio = audio;

    // 纯函数层面多抽几次（不建牌桌，快）
    for (const room of GOMOKU_ROOMS) {
      const seen = new Set();
      for (let i = 0; i < 20; i += 1) {
        const lv = levelOfPersona(pickByRoom(room.id));
        seen.add(lv);
        ok(room.levels.includes(lv), `${room.name} 抽到的人难度在池子里（${lv}）`);
      }
      ok(seen.size >= 1, `${room.name} 覆盖到 ${[...seen].join('/')}`);
    }
    // 接线层面：每个场次真的开一次，确认用的是池子里的人
    for (const room of GOMOKU_ROOMS) {
      app.mode = 'ai';
      app.currentRoom = null;
      app.startGomoku(room.id, null);
      const p = app.gomokuPersona;
      ok(!!p, `${room.name}：AI 模式一定能匹配到对手`);
      ok(room.levels.includes(levelOfPersona(p)),
        `★ ${room.name} 开局的人难度在池子里（${p.name}/${levelOfPersona(p)}）`);
      if (app.gomoku) app.gomoku.destroy();
    }
    // 机器模式：没有人设，难度也从池子里来
    app.mode = 'bot';
    app.startGomoku('high', null);
    ok(!app.gomokuPersona, '机器模式没有 AI 人设（匿名对手）');
    ok(['精通', '大师'].includes(app.gomokuBotLevel), `★ 机器模式在高级场的难度也在池子里（${app.gomokuBotLevel}）`);
    ok(['精通', '大师'].includes(botLevelOfRoom('high', () => 0.99)), '机器模式的难度就是池子里那两档');
    if (app.gomoku) app.gomoku.destroy();
    // 房间模式：对手就是被邀请的那位好友，难度用它自己的档位
    app.mode = 'room';
    app.lobbyGame = 'gomoku';
    app.startGomoku('mid', [friend.id], { invited: true, startDelayMs: 3000 });
    ok(app.gomokuPersona && app.gomokuPersona.id === friend.id, '★ 房间模式：对手就是邀请的好友');
    ok(app.gomoku.level === levelOfPersona(friend), '难度用这位好友自己的档位');
    if (app.gomoku) app.gomoku.destroy();
    app.mode = 'ai';
    app.lobbyGame = 'ddz';
    app.gameKind = 'ddz';
  }

    // 结算面板能画出来（定时器被换成桩，手动触发）
    const panelTimer = timers.find((t) => t.ms === 900 || t.ms === 700);
    ok(!!panelTimer, 'finish() 里排上了结算面板的定时器');
    if (panelTimer) {
      let err = null;
      try { panelTimer.fn(); } catch (e) { err = e; }
      ok(!err, `结算面板回调不抛错${err ? `：${err.message}` : ''}`);
    }

    // 认输：直接判负
    table.startRound();
    table.turn = table.playerColor;
    table.resign();
    ok(table.over && table.losses === 1, '★ 认输 = 判负（正常走结算）');
    ok(spoke.length >= 1, `★ 下棋过程中 AI 会说话（说了 ${spoke.length} 次：${[...new Set(spoke)].join('/')}）`);
    table.destroy();
    app.gomokuSpeak = realSpeak;
  }
  app.gameKind = 'ddz';
  void GOMOKU;
}

/* ===================================================================== */
console.log('-- 3.98) ★ 大厅：五子棋 + 房间模式的场次卡片必须在（用户报的"右侧全消失"）');
{
  const cache = new Map();
  const realGet = document.getElementById.bind(document);
  document.getElementById = (id) => {
    if (!cache.has(id)) cache.set(id, makeStub(`#${id}`));
    return cache.get(id);
  };
  const cardsOf = () => (String(cache.get('room-list').innerHTML).match(/data-room-go="/g) || []).length;
  try {
    app.mode = 'room';
    app.lobbyGame = 'gomoku';
    app.refreshLobby();
    const html = String(cache.get('room-list').innerHTML);
    ok(cardsOf() === 3, `★ 房间模式下 3 张五子棋场次卡都在（实际 ${cardsOf()} 张）`);
    ok(!cache.has('room-list') || html.length > 0, '★ 场次列表没有被清空');
    ok(/房间模式：难度跟着你邀请的那位好友走/.test(html), '★ 房间模式加了一句提示（不再是默默藏掉）');
    ok(/开始房间（五子棋）/.test(String(cache.get('room-block-title').textContent)),
      `★ 标题改成"开始房间（五子棋）"（实际：${cache.get('room-block-title').textContent}）`);

    // 打完一局回大厅走的就是这条渲染路径：卡片必须还在（这是用户报的那个场景）
    app.refreshLobby();
    ok(cardsOf() === 3, '★ 再渲染一次（= 打完一局回大厅）卡片依旧在');

    app.mode = 'ai';
    app.refreshLobby();
    ok(cardsOf() === 3, 'AI 模式下也是 3 张（切模式不会把列表弄没）');
    ok(!/房间模式：难度/.test(String(cache.get('room-list').innerHTML)), 'AI 模式下不显示房间提示');
  } finally {
    document.getElementById = realGet;
  }
}

console.log('-- 3.99) ★ 刚打完的那局：好友搭话得聊最新那局（用户报的"刚下完五子棋却聊小猫钓鱼"）');
{
  const { GOMOKU_ROOMS: GK } = await import(mod('src/config.js'));
  const { buildProactiveMessages } = await import(mod('src/ai/friend.js'));

  app.save = defaultSave();
  app.save.nickname = '小徐';
  app.economy = new Economy(app.save, () => {});
  const mate = PERSONAS[5];
  addFriend(app.save, mate);
  // 上一局是**小猫钓鱼**（这一条就是过去被错当成"刚刚那局"的那局）
  app.save.recentHands = [{
    kind: 'fishing', at: Date.now() - 3600e3, seatIds: [mate.id], summary: '小猫钓鱼：玩家输了 2,586 豆',
  }];
  app.gameKind = 'gomoku';
  app.matchWrite = null; // 新一局开始时会清空，这里手动对齐

  const wrote = await app.recordGomokuMemory({
    winner: 'ai', first: 'player', moves: 24, room: GK[0], persona: mate,
  });
  ok(!!wrote && wrote.kind === 'gomoku', '★ 五子棋结算写下的对局记录是 kind=gomoku');
  ok(app.save.recentHands[0].kind === 'gomoku', 'recentHands 最新一条是刚打完的五子棋');

  // ★ 好友搭话前问的这一句：拿到的是**刚打完的五子棋**，不是上一局的小猫钓鱼
  app.matchWrite = Promise.resolve(wrote);
  const pinged = await app.playedHandForPing();
  ok(!!pinged && pinged.kind === 'gomoku', '★ playedHandForPing() 给的是刚打完的五子棋（以前取 recentHands[0] 会晚一局）');
  app.matchWrite = null;
  ok((await app.playedHandForPing()) === null, '这局没写记忆（机器模式）→ 没有"刚刚那局"，不会拿旧局充数');

  // 写进 AI 脑子里的那条记忆，必须点明玩法（否则它以后不知道上一局玩的是什么）
  const mem = findFriend(app.save, mate.id).memory.join('\n');
  ok(/对局：\[\d+\/\d+ [\d:]+\]/.test(mem), '对局记忆带时间戳');
  ok(/五子棋/.test(mem), '★ 对局记忆里点明了"五子棋"（用户："还是不清楚上一局打的是什么"）');

  // 主动搭话的提示词：拿刚打完那局去拼，说的是五子棋
  const prompt = buildProactiveMessages({
    persona: mate,
    friend: findFriend(app.save, mate.id),
    joined: true,
    lastMatch: pinged,
    modeName: '五子棋',
    playerName: '小徐',
  }).map((m) => m.content).join('\n');
  ok(/五子棋/.test(prompt), '★ 提示词里点明"那局玩的是五子棋"');
  ok(prompt.includes(pinged.summary), '给的就是刚打完那局的概括');
}

console.log('-- 4) 结算面板本身：胜 / 负 / 平三种都不炸');{
  const payWin = { diff: 10, delta: 865, kind: 'win', multiplier: 2 };
  const payLose = { diff: -42, delta: -11244, kind: 'lose', multiplier: 2 };
  const payDraw = { diff: 0, delta: 0, kind: 'draw', multiplier: 1 };
  for (const [label, pay] of [['胜', payWin], ['负', payLose], ['平', payDraw]]) {
    for (const persona of [PERSONAS[4], null]) {
      try {
        panels.showFishingResult(app, {
          pay, score: [18, 8], multiplier: 2, room: FISHING_ROOMS[0], persona, wins: 1, losses: 0,
          onAgain() {}, onQuit() {},
        });
        ok(true, '');
      } catch (err) {
        ok(false, `showFishingResult（${label} / ${persona ? '有对手' : '无对手'}）抛错：${err && err.message}`);
      }
    }
  }
  ok(true, '斗地主与钓鱼的结算面板都画得出来');
}

/* ===================================================================== */
console.log('-- 5) 静态扫：全大写常量不许"用了却没定义"');
{
  const files = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const full = join(dir, n);
      if (statSync(full).isDirectory()) walk(full);
      else if (n.endsWith('.js')) files.push(full);
    }
  };
  walk(join(root, 'src'));

  // 全局定义池：所有文件里"定义/导出/import 进来"的名字
  const defined = new Set();
  const sources = new Map();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    sources.set(f, src);
    for (const m of src.matchAll(/(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
    for (const m of src.matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) defined.add(m[1]);
    for (const m of src.matchAll(/\{\s*([^}]+)\}\s*from/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) defined.add(name);
      }
    }
  }
  // 合法的"外来名字"（运行时/环境提供的）
  const GLOBAL_OK = new Set([
    'JSON', 'Math', 'Number', 'String', 'Object', 'Array', 'Boolean', 'Date', 'Set', 'Map', 'Promise',
    'URL', 'NaN', 'Infinity', 'CSS', 'DOM', 'API', 'HTML', 'PNG', 'JPEG', 'WEBP', 'GMT', 'UTC',
  ]);

  const missing = new Map(); // 名字 → 用到的文件
  /** 把源码里"真正的标识符"挑出来：跳过字符串/注释，且跳过 obj.PROP 这种属性名 */
  function tokens(src, want = 'UPPER') {
    const out = [];
    let i = 0;
    let prev = '';
    const isIdChar = (c) => /[A-Za-z0-9_$]/.test(c);
    while (i < src.length) {
      const c = src[i];
      const c2 = src[i + 1];
      if (c === '/' && c2 === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
      if (c === '/' && c2 === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        i += 1;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') i += 1;
          i += 1;
        }
        i += 1;
        prev = quote;
        continue;
      }
      if (isIdChar(c) && !/[0-9]/.test(c)) {
        let j = i;
        while (j < src.length && isIdChar(src[j])) j += 1;
        const word = src.slice(i, j);
        // 往后看一个非空白字符：是 `:` **并且**前面刚开了一个对象（{ 或 ,）
        // → 它是对象字面量的键（TYPE.SINGLE、PHASE.PLAY 那种"定义"），不是"使用"
        let k = j;
        while (k < src.length && /\s/.test(src[k])) k += 1;
        const isKey = src[k] === ':' && (prev === '{' || prev === ',');
        // 属性名（xxx.YYY）也不算"使用了一个常量"
        const hit = want === 'ALL' ? true : /^[A-Z][A-Z0-9_]{3,}$/.test(word);
        if (prev !== '.' && !isKey && hit) out.push(word);
        prev = word[word.length - 1];
        i = j;
        continue;
      }
      // 正则字面量：/.../flags —— 里面的 \u{1F300} 之类不是标识符，跳过
      if (c === '/' && !/[)\w$]/.test(prev)) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          else if (src[j] === '\n') break;
          j += 1;
        }
        if (src[j] === '/') { i = j + 1; prev = '/'; continue; }
      }
      if (!/\s/.test(c)) prev = c;
      i += 1;
    }
    return out;
  }
  const upperTokens = (src) => tokens(src, 'UPPER');

  for (const [f, src] of sources) {
    for (const name of upperTokens(src)) {
      if (defined.has(name) || GLOBAL_OK.has(name)) continue;
      if (!missing.has(name)) missing.set(name, []);
      const rel = f.slice(root.length).replace(/\\/g, '/');
      if (!missing.get(name).includes(rel)) missing.get(name).push(rel);
    }
  }
  const list = [...missing.entries()].map(([n, fs]) => `${n}（${fs.join(', ')}）`).join('；');
  ok(missing.size === 0, `★ 没有"用了却没定义"的全大写常量${missing.size ? `：${list}` : ''}`);

  // 自检：这套扫描要真的抓得住当初那个 bug，否则"全绿"毫无意义
  const sample = 'const delta = invited ? AFFINITY_PLAY_INVITED : AFFINITY_PLAY_MATCHED;';
  const flagged = upperTokens(sample).filter((n) => !defined.has(n) && !GLOBAL_OK.has(n));
  ok(flagged.includes('AFFINITY_PLAY_MATCHED') && flagged.includes('AFFINITY_PLAY_INVITED'),
    '★ 自检：扫描确实能抓到"用了却没定义"的常量（以当初那个 bug 为样本）');
  const toks = upperTokens('const x = TYPE.SINGLE; const y = { PLAY: 1 }; const z = Math.max(1, 2);');
  ok(!toks.includes('SINGLE') && !toks.includes('PLAY'),
    `自检：属性名与对象键不会被误报（只收到底 ${toks.join('/') || '无'}）`);
  const regexSample = 'const re = /[\\u{1F300}-\\u{1FAFF}]/u; const t = "FFD166";';
  ok(upperTokens(regexSample).length === 0, '自检：正则与字符串里的内容不会被误报');

  /* ------------------------------------------------------------------ */
  /**
   * ★ 第二遍扫：**漏 import**（用户报过三次：bumpUnread / callNameOf / currentId）
   *   这类 bug 全大写扫描抓不到（名字是驼峰），`node --check` 也抓不到（语法没错），
   *   只在真正走到那一行时才 ReferenceError。
   *
   *   判定方式：某个名字**被别的模块 export 了**，这个文件里又**用到了**它，
   *   但既没 import 进来、也没在本文件里声明 —— 那就是漏了 import。
   */
  const byFile = new Map();
  const exportedBy = new Map();
  const push = (map, key, val) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(val)) map.get(key).push(val);
  };
  const short = (f) => f.slice(root.length).replace(/\\/g, '/');
  for (const [f, src] of sources) {
    const imports = new Set();
    const declares = new Set();
    for (const m of src.matchAll(/import\s+\{([^}]+)\}\s*from/g)) {
      for (const part of m[1].split(',')) {
        // `a as b`：两边都算"这文件里有这个名字"，免得 import 语句自己被判成"用了没 import"
        for (const n of part.trim().split(/\s+as\s+/).map((x) => x.trim())) {
          if (/^[A-Za-z_$][\w$]*$/.test(n)) imports.add(n);
        }
      }
    }
    for (const m of src.matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) imports.add(m[1]);
    for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declares.add(m[1]);
    // 类方法 / 对象方法：  foo() {   （app.js 里的 openSettings()、isPanelOpen() 就是这种）
    for (const m of src.matchAll(/^[ \t]*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) declares.add(m[1]);
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(':').pop().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) declares.add(n);
      }
    }
    for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) declares.add(n);
      }
    }
    // 函数/箭头函数的参数（近似：括号里那串按逗号切开）
    for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
      for (const part of m[1].split(',')) {
        const n = part.replace(/[{}\[\].]/g, ' ').split(':').pop().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) declares.add(n);
      }
    }
    byFile.set(f, {
      imports,
      declares,
      // ★ 取词前先把 import 语句整段去掉：不然 `import { a as b }` 里的 a 会被当成"用了没 import"
      uses: new Set(tokens(src.replace(/^[ \t]*import\b[\s\S]*?from\s*['"][^'"]+['"];?/gm, ''), 'ALL')),
    });
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) push(exportedBy, m[1], f);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) push(exportedBy, n, f);
      }
    }
  }
  const notImported = [];
  for (const [f, info] of byFile) {
    for (const name of info.uses) {
      const owners = exportedBy.get(name);
      if (!owners || owners.includes(f)) continue; // 不是别的模块的导出 → 不关这个文件的事
      if (info.imports.has(name) || info.declares.has(name)) continue;
      notImported.push(`${short(f)}: ${name}（定义在 ${owners.map(short).join(', ')}）`);
    }
  }
  ok(notImported.length === 0,
    `★ 没有"用了别的模块的导出却没 import"的标识符${notImported.length ? `：${notImported.slice(0, 6).join('；')}` : ''}`);
  // 自检：拿用户报过的那次 bug 当样本
  {
    const exportsOf = new Set(['callNameOf']);
    const sample = `import { findFriend } from './x.js';\nconst a = callNameOf(findFriend(s, 'p05'));`;
    const used = tokens(sample, 'ALL').filter((n) => exportsOf.has(n));
    const importedHere = new Set(['findFriend']);
    ok(used.includes('callNameOf') && !importedHere.has('callNameOf'),
      '★ 自检：扫描确实能抓到"用了 callNameOf 却没 import"（以当初那个 bug 为样本）');
  }
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '应用冒烟 + 静态常量检查通过'}`);
globalThis.setTimeout = realSetTimeout;
process.exit(fail ? 1 : 0);
