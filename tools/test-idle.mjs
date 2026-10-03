/**
 * 挂机行为测试（node tools/test-idle.mjs）
 *
 * 用户拍板的第 4、5 条：
 *   4) 停在群聊界面且 10s 没说话、群里 AI 多于 2 人 → AI 之间自己聊起来，
 *      每 5~15s 随机一个人发一句，看得到上下文、有自己的记忆，
 *      下一句由 AI 判断该谁接（保持连续），玩家一发话就停
 *   5) 退出超过 2 分钟再进来 → 随机 1~3 位好友主动发消息（≥2 好友；
 *      聊日常或编一局**自己的**游戏，不许提和玩家一起玩）
 */
import { readFileSync } from 'node:fs';
import { GROUP_IDLE, GROUP_OFFLINE, RETURN_PING, GROUP } from '../src/config.js';
import { defaultSave } from '../src/store/storage.js';
import { addFriend, findFriend, listFriends, pickPingTargets } from '../src/store/friends.js';
import { createGroup, findGroup, deleteGroup, listGroups, appendGroupChat } from '../src/store/groups.js';
import {
  buildGroupReplyMessages, buildNextSpeakerMessages, parseNextSpeaker,
  localNextSpeaker, chooseNextSpeaker, localGroupReply,
} from '../src/ai/group.js';
import { buildProactiveMessages, localGreeting } from '../src/ai/friend.js';
import { PERSONAS } from '../src/data/personas.js';
import { CHAT_OPENERS, CHAT_BUCKETS } from '../src/data/chatLines.js';
import { offlineGroupSendTimes } from '../src/data/clock.js';
import { scheduleReturnGroupChat, deliverOfflineGroupLine } from '../src/ui/returnGroup.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/* ===================================================================== */
console.log('-- 需求 4：群聊挂机自动聊天的规则');
{
  ok(GROUP_IDLE.idleMs === 10000, `玩家静默 10s 才开始（实际 ${GROUP_IDLE.idleMs}ms）`);
  ok(GROUP_IDLE.minAi === 3, `★ 群里 AI 多于 2 人（≥3）才自动聊（实际 ${GROUP_IDLE.minAi}）`);
  ok(GROUP_IDLE.minGapMs === 8000 && GROUP_IDLE.maxGapMs === 20000,
    `★ 每 8~20 秒一句（用户反馈"太快了"，已放慢；实际 ${GROUP_IDLE.minGapMs}~${GROUP_IDLE.maxGapMs}）`);
  ok(GROUP_IDLE.maxRounds > 0, '有"防跑飞"的轮数上限');
  ok(GROUP.recent >= 6, '它们能看到最近若干条上下文（GROUP.recent）');

  const members = PERSONAS.slice(0, 3);
  const group = { id: 'g1', name: '测试群', members: members.map((m) => m.id) };
  const recent = ['不吃香菜：今天手气不行', '小柳先生：在下也觉得'];

  // mingle 提示词：明确"玩家没说话、你们自己聊、别硬拉玩家"
  const mingle = buildGroupReplyMessages({
    persona: members[0], group, members, recentLines: recent, playerText: '', mingle: true, lastSpeaker: members[1].name,
  }).map((m) => m.content).join('\n');
  ok(/玩家\*\*这轮没说话\*\*/.test(mingle), '★ 明确告诉它"玩家这轮没说话，是你们自己聊"');
  ok(/话题不必和玩家有关/.test(mingle), '★ 话题不必和玩家有关');
  ok(/不要每句都问玩家/.test(mingle), '★ 不要硬把玩家拉进来');
  ok(/刚才最后说话的是/.test(mingle), '告诉它上一位是谁（接着他说）');
  ok(mingle.includes(recent[0]) || mingle.includes('今天手气不行'), '带着上下文（最近群消息）');

  // 玩家说话时（非 mingle）不该出现这些字眼
  const normal = buildGroupReplyMessages({
    persona: members[0], group, members, recentLines: recent, playerText: '在吗',
  }).map((m) => m.content).join('\n');
  ok(!/玩家\*\*这轮没说话\*\*/.test(normal), '玩家说话时沿用原来的提示词口径');
  ok(/玩家刚刚在群里说/.test(normal), '玩家说话时是"回应玩家"');

  // 挑下一个说话的人：不会挑刚说过的那位
  const last = members[0].name;
  for (let i = 0; i < 30; i += 1) {
    const who = localNextSpeaker({ members, lastSpeaker: last });
    ok(who && who.name !== last, `★ 本地兜底不会挑刚说过话的「${last}」`);
  }
  const parsed = parseNextSpeaker(`{"next":"${members[1].name}"}`, members, { lastSpeaker: members[1].name });
  ok(parsed && parsed.name !== members[1].name, '★ 模型挑了刚说过的人 → 退回本地兜底（不重复）');
  const parsed2 = parseNextSpeaker(`{"next":"${members[2].name}"}`, members, { lastSpeaker: members[1].name });
  ok(parsed2 && parsed2.name === members[2].name, '模型挑的合法人选直接用');
  ok(parseNextSpeaker('乱七八糟', members, {}).id, '解析不出来也不哑巴（本地兜底）');
  const speakMsgs = buildNextSpeakerMessages({ group, members, recentLines: recent, lastSpeaker: last });
  const speak = speakMsgs.map((m) => m.content).join('\n');
  ok(/下一句该谁说/.test(speak) && speak.includes(members[1].name), '选人提示词里有名单');
  ok(/不要选刚说过话的/.test(speak), '选人提示词明确排除上一位');

  // 本地兜底台词走的是私聊语料（不是牌桌台词）
  const line = localGroupReply(members[0], '');
  ok(line && !/叫地主|要不起|出牌/.test(line), `挂机台词不掺牌桌话（${line}）`);
}

console.log('-- 需求 4：挂机循环真跑一遍（DOM 桩 + 假定时器）');
{
  // 只测 groups.js 的那段循环：DOM 桩够它用就行
  const fn = function () { return makeStub('x'); };
  const bag = { hidden: false, isConnected: true, value: '', innerHTML: '', textContent: '' };
  const makeStub = (name) => {
    const f2 = function () { return makeStub(name); };
    bag.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    return new Proxy(f2, {
      get(t, k) {
        if (k === 'toString') return () => `<${name}>`;
        if (k === 'then') return undefined;
        if (k === 'querySelectorAll') return () => [];
        if (k === 'querySelector') return () => makeStub('child');
        if (k === 'addEventListener' || k === 'removeEventListener') return () => {};
        if (k === 'focus' || k === 'select' || k === 'click' || k === 'remove') return () => {};
        if (k in bag) return bag[k];
        return makeStub(`${name}.${String(k)}`);
      },
      set(t, k, v) { bag[k] = v; return true; },
      apply() { return makeStub(name); },
    });
  };
  globalThis.document = makeStub('document');
  globalThis.document.activeElement = null;
  const box = makeStub('box');
  box.isConnected = true;
  box.hidden = false;

  // 假定时器：只入队、不自动跑，测试手动推进（否则递归的挂机循环会跑飞）
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realFetch = globalThis.fetch;
  /**
   * ★ 必须把 fetch 也掐掉：workspace 的 src/config.js 里是**有真 Key** 的，
   *   不拦的话这一轮会真的去请求 DeepSeek，测试又慢又联网。
   *   掐掉之后 callDeepSeek 立刻失败 → 走本地兜底（这正是我们要测的那条路）。
   */
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
  globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };

  const { renderGroups } = await import('../src/ui/groups.js');
  globalThis.setTimeout = realSetTimeout;

  const save = defaultSave();
  save.nickname = '小徐';
  const mates = [PERSONAS[0], PERSONAS[1], PERSONAS[2]];
  for (const m of mates) addFriend(save, m);
  const made = createGroup(save, '挂机群', mates.map((m) => m.id));
  const gid = made.group.id;
  const app = { save, playerName: '小徐', persist() {}, economy: { beans: 1000 } };

  globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };
  let view = null;
  try {
    view = renderGroups(app, box);
  } catch (err) {
    ok(false, `renderGroups 起不来：${err && err.message}`);
  }
  // 注意：假定时器要**一直挂着**到这一节结束，否则挂机循环排的"下一条"会跑到真事件循环里
  ok(!!view && typeof view.destroy === 'function', '★ 群里返回 destroy/poke 把手（面板关掉时能停）');
  ok(typeof view.poke === 'function', '有 poke（玩家发话后重置 10 秒计时）');

  // 手动推进：第一次定时器应该是"静默 10 秒后开始"
  const first = timers.shift();
  ok(!!first && first.ms === GROUP_IDLE.idleMs, `★ 第一个定时器是静默 ${GROUP_IDLE.idleMs}ms`);

  // 跑一轮挂机：里面会 await 若干次（本地兜底同步返回），事后排下一个 5~15s
  // 注意：定时器回调里是 `void idleRoundOnce()`，所以这里不能用 await 等它，
  // 要给几个 tick 让它把 await 走完（用真定时器兜一下）。
  const before = (findGroup(save, gid).chat || []).length;
  first.cb();
  await new Promise((r) => realSetTimeout(r, 30));
  const chat = findGroup(save, gid).chat || [];
  ok(chat.length > before, `★ 挂机真的往群里发了一条（${before} → ${chat.length}）`);
  const lastMsg = chat[chat.length - 1];
  ok(lastMsg && lastMsg.role === 'ai' && lastMsg.by !== 'me', '发出来的是 AI 说的话');
  ok(lastMsg && lastMsg.text && lastMsg.text.length > 0, `有话可说（${lastMsg && lastMsg.text}）`);
  const next = timers[timers.length - 1];
  ok(next && next.ms >= GROUP_IDLE.minGapMs && next.ms <= GROUP_IDLE.maxGapMs,
    `★ 下一条排在 8~20 秒之间（实际 ${next && next.ms}）`);

  /**
   * ★ 用户报的 bug：挂机时群聊会先闪一行**空头像 + 空名字**（看起来像"加载不出来"），
   *   因为我们先塞了 `{ name: '…', src: '' }` 的空壳再挑人。
   *   现在改成"先定人、再显示打字提示"，源码里不该再出现空壳。
   */
  const gsrc = read('../src/ui/groups.js');
  ok(!/typing = \{ name: '…'/.test(gsrc), '★ 不再有"空头像 + 空名字"的打字提示');
  ok(/typing = \{ name: persona\.name, src: ASSETS\.avatar\(persona\.avatar\) \}/.test(gsrc),
    '★ 打字提示用的是**真实**的名字与头像');
  {
    const iPick = gsrc.indexOf('const who = await chooseNextSpeaker');
    const iTyping = gsrc.indexOf('typing = { name: persona.name');
    ok(iPick > 0 && iTyping > iPick, '★ 先挑人（chooseNextSpeaker）再显示"正在输入…"');
  }

  // 玩家发话 → 立刻停（destroy 之后不再有新的定时器）
  view.poke();
  view.destroy();
  ok(timers.length > 0, 'destroy 之前队列里还有排着的挂机定时器');
  globalThis.setTimeout = realSetTimeout;
  globalThis.fetch = realFetch;
}

console.log('-- 需求 5：退出超过 2 分钟回来，好友来打招呼');
{
  ok(RETURN_PING.minAwayMs === 120000, `★ 离线超过 2 分钟才算"回来"（实际 ${RETURN_PING.minAwayMs}ms）`);
  ok(RETURN_PING.minFriends === 2, '★ 至少 2 位好友才会有人来');
  ok(RETURN_PING.maxPing === 3, '★ 一次最多 3 位');
  ok(RETURN_PING.firstMinMs >= 1000, '不会和开屏动画撞在一起');

  const app = read('../src/ui/app.js');
  ok(/scheduleReturnPing\(awayMs\)/.test(app), '★ 启动时会按"离线多久"决定要不要打招呼');
  ok(/awayMs < RETURN_PING\.minAwayMs/.test(app), '不到 2 分钟就不打扰');
  ok(/friends\.length < RETURN_PING\.minFriends/.test(app), '好友不到 2 位就没人来');
  ok(/lastHand = null|, null, \{ selfMatch: true \}/.test(app.replace(/\s+/g, ' ')) || /deliverFriendPing\(persona, f\.personaId, null/.test(app),
    '★ 用的不是"刚打完那局"，而是让它聊日常 / 编一局自己的');
  ok(/bindAwayTracking/.test(app) && /pagehide/.test(app), '关页面/切后台会记下"最后一次在"');
  const storage = read('../src/store/storage.js');
  ok(/lastSeenAt: 0/.test(storage), '存档里有 lastSeenAt 字段');

  // 提示词：编一局自己的游戏时**不许提玩家**
  const persona = PERSONAS[3];
  const friend = { personaId: persona.id, name: persona.name, affinity: 30, memory: [], chat: [] };
  const prompt = buildProactiveMessages({
    persona, friend, joined: false, selfMatch: true, lastMatch: null, playerName: '小徐',
  }).map((m) => m.content).join('\n');
  ok(/绝对不能提玩家/.test(prompt), '★ 编自己的那局时明确"绝对不能提玩家"');
  ok(/也可以完全聊别的话题/.test(prompt), '也允许聊日常话题（用户要求"随便开启日常话题"）');
  ok(!/你们刚一起打完/.test(prompt), '不会说"你们刚一起打完"（那是刚打完一局时的口径）');
}

/* ===================================================================== */
console.log('-- 需求 6：离线回来时"恋人权重更高 + 恋人能表达想念"');
{
  // 1) 配置：两个旋钮（保送概率 + 权重），且都不是 100%
  ok(RETURN_PING.loverSureChance > 0 && RETURN_PING.loverSureChance < 1,
    `★ 恋人"保送"是个概率、不是 100%（实际 ${RETURN_PING.loverSureChance}）`);
  ok(RETURN_PING.loverWeight > 1,
    `★ 恋人没保送时在随机池里权重更高（实际 ${RETURN_PING.loverWeight}，普通好友 = 1）`);

  // 2) 纯逻辑：pickPingTargets 的边界（防御性 —— 没恋人 / 恋人被删 / 空名单都不许崩）
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ personaId: `p${i}` }));
  const pool = mk(3);
  ok(pickPingTargets([], { loverId: 'p0', count: 2 }).length === 0, '一个好友都没有 → 挑不出人');
  ok(pickPingTargets(pool, { loverId: 'p0', count: 0 }).length === 0, '要 0 位 → 不挑');
  ok(pickPingTargets(pool, { loverId: 'p9', count: 2 }).every((f) => f.personaId !== 'p9'),
    '★ 恋人不在候选名单里（被删好友 / 被节流挡住）→ 不会硬塞');
  ok(pickPingTargets(pool, { loverId: 'p0', count: 99 }).length === pool.length,
    '要的人比名单还多 → 最多全员，且不重复');
  {
    const picks = pickPingTargets(pool, { loverId: 'p0', count: 2 });
    ok(new Set(picks.map((f) => f.personaId)).size === picks.length, '不会挑出重复的人');
  }

  // 3) 保送命中 → 恋人必在
  let sure = 0;
  for (let i = 0; i < 200; i += 1) {
    const picks = pickPingTargets(pool, { loverId: 'p0', count: 1, sureChance: 1, loverWeight: 1 });
    if (picks[0] && picks[0].personaId === 'p0') sure += 1;
  }
  ok(sure === 200, `★ 保送命中时恋人一定在里面（${sure}/200）`);

  // 4) 只靠权重：恋人被挑中的比例要明显高于均分（3 位 → 均分 33%）
  const N = 4000;
  let hit = 0;
  for (let i = 0; i < N; i += 1) {
    if (pickPingTargets(pool, { loverId: 'p0', count: 1, sureChance: 0, loverWeight: RETURN_PING.loverWeight })[0].personaId === 'p0') hit += 1;
  }
  ok(hit / N > 0.5, `★ 只有权重时也明显偏爱恋人（${((hit / N) * 100).toFixed(0)}%，均分只有 33%）`);
  // 5) 默认参数（保送 + 权重）：几乎总在里面，但**不是 100%**
  let hit2 = 0;
  for (let i = 0; i < N; i += 1) {
    if (pickPingTargets(pool, { loverId: 'p0', count: 2 }).some((f) => f.personaId === 'p0')) hit2 += 1;
  }
  const rate2 = hit2 / N;
  ok(rate2 > 0.9 && rate2 < 1, `★ 默认参数下恋人几乎总在里面、但不是 100%（${(rate2 * 100).toFixed(1)}%）`);

  // 6) 提示词：只有"恋人 + loverTone"才多那一行；非恋人拿不到（否则全员撒娇）
  const persona = PERSONAS[6];
  const friend = { personaId: persona.id, name: persona.name, affinity: 100, memory: [], chat: [] };
  const base = { persona, friend, joined: false, selfMatch: true, lastMatch: null, playerName: '小徐' };
  const tone = buildProactiveMessages({ ...base, lover: true, loverTone: true }).map((m) => m.content).join('\n');
  ok(/说想他/.test(tone), '★ 恋人这一条多了"可以说想他"的提示词');
  ok(/心事/.test(tone) && /别腻/.test(tone), '并且明确"可以说心事、但别腻"');
  const loverNoTone = buildProactiveMessages({ ...base, lover: true }).map((m) => m.content).join('\n');
  ok(!/说想他/.test(loverNoTone) && !/心事/.test(loverNoTone),
    '★ 没传 loverTone 就没有那一行（赛后搭话口径不变）');
  const notLover = buildProactiveMessages({ ...base, lover: false, loverTone: true }).map((m) => m.content).join('\n');
  ok(!/说想他/.test(notLover) && !/心事/.test(notLover),
    '★ 非恋人就算调用方传了 loverTone 也拿不到那一行');
  ok(!/已经是恋人/.test(notLover), '非恋人的提示词里没有"你们是恋人"');

  // 7) 本地兜底：恋人给一句专属的（模型不可用时不能还是那句通用问候）
  const allLover = Object.values(CHAT_BUCKETS.lover).flat();
  const allOpener = Object.values(CHAT_OPENERS).flat();
  const lp = PERSONAS[2];
  const loverLine = localGreeting(lp, 'lover');
  ok(typeof loverLine === 'string' && loverLine.length > 0 && loverLine.length <= 32,
    `恋人兜底问候可用（${loverLine}）`);
  ok(allLover.some((l) => loverLine.startsWith(l)),
    `★ 恋人兜底走的是 lover 语料（${loverLine}）`);
  // 通用问候里**一句恋爱口吻都没有**（兜底给恋人专属的，不能还是那句通用问候）
  ok(allOpener.every((l) => !/想你|心事|心里/.test(l)), '通用开场白里本来就没有恋爱口吻');
  const genericSeen = new Set();
  for (let i = 0; i < 300; i += 1) {
    genericSeen.add(localGreeting(lp).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+$/u, ''));
  }
  ok([...genericSeen].every((l) => !/想你|心事|心里/.test(l)),
    `★ 通用兜底永远不会说出"想你 / 心事"（抽了 ${genericSeen.size} 句）`);
  {
    let romantic = 0;
    for (let i = 0; i < 200; i += 1) {
      if (/想你|心事|心里|想你/.test(localGreeting(lp, 'lover'))) romantic += 1;
    }
    ok(romantic > 0, `★ 恋人兜底里出现过"想你 / 心事"这种话（${romantic}/200）`);
  }
  let distinct = 0;
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    const l = localGreeting(lp, 'lover');
    if (!seen.has(l.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]$/u, ''))) distinct += 1;
    seen.add(l.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]$/u, ''));
  }
  ok(distinct >= 3, `★ 恋人兜底不是永远同一句（${distinct} 种变化）`);
  ok(localGreeting({ lines: {} }, 'lover').length > 0, '没有人设语料时恋人兜底也不哑巴');

  // 8) 接线：app.js 挑人走 pickPingTargets，只有恋人那条带 loverTone
  const appSrc = read('../src/ui/app.js');
  ok(/pickPingTargets\(friends, \{ loverId, count: n \}\)/.test(appSrc),
    '★ 离线挑人走 pickPingTargets（带恋人优先）');
  ok(/const loverId = \(this\.save\.loverId && friends\.some/.test(appSrc),
    '★ 恋人必须"这次能主动发消息"才算（被删 / 被节流挡住就按普通好友挑）');
  ok(/loverTone: isLoverPick/.test(appSrc), '★ 只有恋人那条消息带 loverTone');
  ok(/const tone = lover && !!loverTone;/.test(appSrc) && /loverTone: tone,/.test(appSrc),
    '★ deliverFriendPing 里再用 isLover 兜一道（非恋人永远拿不到）');
}

/* ===================================================================== */
console.log('-- 需求 7：离线超过 20 分钟 → 群里 AI 连着聊 5~10 条（计入未读）');
{
  // 1) 配置
  ok(GROUP_OFFLINE.minAwayMs === 20 * 60 * 1000,
    `★ 和"离线补友圈"同一个 20 分钟门槛（实际 ${GROUP_OFFLINE.minAwayMs}ms）`);
  ok(GROUP_OFFLINE.minLines === 5 && GROUP_OFFLINE.maxLines === 10,
    `★ 一次补 5~10 条（实际 ${GROUP_OFFLINE.minLines}~${GROUP_OFFLINE.maxLines}）`);
  ok(GROUP_OFFLINE.minAi >= 2, '群里至少 2 位 AI 才叫"互相接话"');
  ok(GROUP_OFFLINE.minGapMs > 0 && GROUP_OFFLINE.staggerMs > 0, '相邻两条有间隔（时间递增 + 错开投递）');
  {
    // 接线：离线超过门槛时，启动流程里会补一批群聊（和"离线招呼 / 补友圈"并列）
    const appSrc2 = read('../src/ui/app.js');
    ok(/scheduleReturnGroupChat\(this, awayMs\)/.test(appSrc2),
      '★ 启动时按"离线多久"决定要不要补群聊');
    const rg = read('../src/ui/returnGroup.js');
    ok(/away < GROUP_OFFLINE\.minAwayMs/.test(rg), '不到 20 分钟就不补');
    ok(/members\.length < GROUP_OFFLINE\.minAi/.test(rg), '★ 群里 AI 不够就跳过（防御性）');
    ok(/bumpGroupUnread\(app\.save, groupId\)/.test(rg), '★ 每条都计入未读（回来看到红点）');
    ok(/if \(!group\) return null;/.test(rg), '★ 群被解散 → 直接跳过，不许崩');
  }

  // 2) 时间：都落在离线窗口里、按时间递增
  {
    const backAt = Date.now();
    const leftAt = backAt - 60 * 60 * 1000;
    for (const count of [5, 10]) {
      const ts = offlineGroupSendTimes({
        leftAt, backAt, count, personas: PERSONAS.slice(0, 3), minGapMs: GROUP_OFFLINE.minGapMs,
      });
      ok(ts.length === count, `${count} 条都排到了时间`);
      ok(ts.every((t) => t >= leftAt && t <= backAt), '★ 每条都落在"玩家不在线"的那段时间里');
      ok(ts.every((t, i) => i === 0 || t > ts[i - 1]), '★ 时间严格递增（不倒着）');
      ok(ts.every((t, i) => i === 0 || t - ts[i - 1] >= GROUP_OFFLINE.minGapMs), '★ 相邻至少隔最小间隔');
    }
    ok(offlineGroupSendTimes({ leftAt, backAt, count: 0 }).length === 0, '条数 0 → 空数组');
    ok(offlineGroupSendTimes({ leftAt: 5, backAt: 1, count: 3 }).length === 3, '窗口不合法也不炸');
    ok(offlineGroupSendTimes({ leftAt: 0, backAt: NaN, count: 3 }).length === 0, '时间戳不合法 → 不给时间');
    const narrow = offlineGroupSendTimes({ leftAt: backAt - 3 * 60 * 1000, backAt, count: 10 });
    ok(narrow.length === 10 && narrow.every((t) => t >= backAt - 3 * 60 * 1000 && t <= backAt),
      '窗口很窄时也全在窗口里（不会跑到窗口外）');
    ok(narrow.every((t, i) => i === 0 || t >= narrow[i - 1]), '窄窗口下也不倒着');
  }

  // 3) 行为：排期 5~10 条 + 逐条真投递（假定时器只入队；fetch 失败 → 本地兜底）
  {
    const save = defaultSave();
    save.nickname = '小徐';
    const mates = [PERSONAS[0], PERSONAS[1], PERSONAS[2]];
    for (const m of mates) addFriend(save, m);
    const g1 = createGroup(save, '离线群', mates.map((m) => m.id)).group;
    let dots = 0;
    const fakeApp = { save, playerName: '小徐', persist() {}, updateFriendDot() { dots += 1; } };

    ok(scheduleReturnGroupChat(fakeApp, 5 * 60 * 1000) === 0, '★ 离线不到 20 分钟 → 不补群聊');
    ok((findGroup(save, g1.id).chat || []).length === 0, '什么都没多出来');

    const realSetTimeout2 = globalThis.setTimeout;
    const realFetch2 = globalThis.fetch;
    const timers = [];
    globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };
    const n = scheduleReturnGroupChat(fakeApp, 60 * 60 * 1000);
    globalThis.setTimeout = realSetTimeout2;
    ok(n >= GROUP_OFFLINE.minLines && n <= GROUP_OFFLINE.maxLines,
      `★ 离线超过 20 分钟 → 排 5~10 条（这次 ${n}）`);
    ok(timers.length === n, '每条都排了一个定时器（错开真实投递）');
    ok(timers.every((t, i) => i === 0 || t.ms > timers[i - 1].ms), '投递是按顺序错开的');

    // 4) 真投递：按排好的时刻**逐条顺序**发（await 保证确定性），仍要落库 / 计未读
    const leftAt = Date.now() - 60 * 60 * 1000;
    const backAt = Date.now();
    const times = offlineGroupSendTimes({
      leftAt, backAt, count: n, personas: mates, minGapMs: GROUP_OFFLINE.minGapMs,
    });
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
    let landed = 0;
    for (const at of times) {
      const entry = await deliverOfflineGroupLine(fakeApp, g1.id, { at, leftAt, backAt });
      if (entry && entry.text) landed += 1;
    }
    globalThis.fetch = realFetch2;
    const g = findGroup(save, g1.id);
    ok(landed === n, `★ 每一条都真的落库了（${landed}/${n}）`);
    ok(g.chat.length === n, `群里正好多了 ${n} 条（实际 ${g.chat.length}）`);
    ok(g.chat.every((m) => m.role === 'ai' && m.by && m.by !== 'me'), '补的全是 AI 说的话');
    ok(g.chat.every((m) => m.text && m.text.length > 0), '每条都有内容（模型不可用也有本地兜底）');
    ok(g.chat.every((m, i) => i === 0 || m.at > g.chat[i - 1].at), '★ 群消息时间严格递增（点进去是有序历史）');
    ok(g.chat.every((m) => m.at >= leftAt && m.at <= Date.now()),
      '★ 每条的时间都在"玩家离线"的那段时间里');
    ok(g.unread >= n, `★ 计入未读（玩家回来看到群聊上有红点）（unread=${g.unread}）`);
    ok(dots >= n, '每补一条都刷新了红点（updateFriendDot）');
  }

  // 4) 防御性：没群 / 群里只有 1 位 AI / 群被解散 / 群被删，都不许崩
  {
    const empty = defaultSave();
    ok(scheduleReturnGroupChat({ save: empty, persist() {} }, 60 * 60 * 1000) === 0, '★ 一个群都没有 → 跳过（不崩）');
    ok(scheduleReturnGroupChat({ save: null }, 60 * 60 * 1000) === 0, '没有存档也不崩');
    ok(scheduleReturnGroupChat({ save: empty }, 60 * 1000) === 0, '离线不够也不崩');

    const one = defaultSave();
    const p0 = PERSONAS[0];
    addFriend(one, p0);
    one.groups = [{ id: 'gOne', name: '一个人的群', members: [p0.id], chat: [], unread: 0 }];
    ok(scheduleReturnGroupChat({ save: one, persist() {} }, 60 * 60 * 1000) === 0,
      '★ 群里只有 1 位 AI → 自言自语没意思，跳过');

    const gone = defaultSave();
    addFriend(gone, p0);
    const app3 = { save: gone, persist() {}, updateFriendDot() {} };
    const r0 = await deliverOfflineGroupLine(app3, '不存在的群', { at: Date.now() - 1000 });
    ok(r0 === null, '★ 群被解散了 → 这一条直接跳过');

    // 排完之后群被删：定时器跑起来也不能崩、不能写进别的地方
    const save2 = defaultSave();
    const ms = [PERSONAS[0], PERSONAS[1]];
    for (const m of ms) addFriend(save2, m);
    const g2 = createGroup(save2, '要解散的群', ms.map((m) => m.id)).group;
    const app4 = { save: save2, persist() {}, updateFriendDot() {} };
    const realSetTimeout3 = globalThis.setTimeout;
    const realFetch3 = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
    const timers3 = [];
    globalThis.setTimeout = (cb, ms2) => { timers3.push({ cb, ms: ms2 }); return timers3.length; };
    const n3 = scheduleReturnGroupChat(app4, 60 * 60 * 1000);
    globalThis.setTimeout = realSetTimeout3;
    ok(n3 >= GROUP_OFFLINE.minLines, '排期成功（接下来把群删掉）');
    deleteGroup(save2, g2.id);
    let threw = null;
    try {
      for (const t of timers3) t.cb();
      await new Promise((r) => realSetTimeout3(r, 120));
    } catch (err) { threw = err; }
    globalThis.fetch = realFetch3;
    ok(!threw, `★ 期间群被解散 → 不抛错${threw ? `：${threw.message}` : ''}`);
    ok(listGroups(save2).length === 0, '群确实不在了，也没有凭空冒出来');

    // 群里的人被删好友（但没退群）→ 仍然能聊（群成员不因为是好友才留下）
    const save3 = defaultSave();
    const ms3 = [PERSONAS[3], PERSONAS[4]];
    for (const m of ms3) addFriend(save3, m);
    const g3 = createGroup(save3, '删了好友的群', ms3.map((m) => m.id)).group;
    const app5 = { save: save3, persist() {}, updateFriendDot() {} };
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
    let entry = null;
    try {
      entry = await deliverOfflineGroupLine(app5, g3.id, { at: Date.now() - 30 * 1000 });
    } catch (err) { ok(false, `群成员被删好友后补聊抛错：${err && err.message}`); }
    globalThis.fetch = realFetch3;
    ok(!!entry && !!entry.text, '群里有人（哪怕已删好友）就还能说一句');
  }
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '挂机群聊 / 离线招呼 / 恋人权重 / 离线补群聊检查通过'}`);
process.exit(fail ? 1 : 0);
