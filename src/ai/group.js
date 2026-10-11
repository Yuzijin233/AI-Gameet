/**
 * 群聊的 AI 层（PRD §2.20）
 *
 * 一次玩家发言，前前后后一共这些调用：
 *   1. **选谁回答**（1 次）：把群成员 + 最近 10 条消息 + 玩家这句交给模型，让它挑 2~4 个人
 *      —— 点名的人**必须**回答（不走模型判断，脚本直接锁定）
 *   2. **每人一句回复**（N 次，N = 2~4）：每个被挑中的人各自一次，能看到前面的人已经说了什么
 *   3. **群聊内容审查**（1 次）：一次性判断这段对话要不要写进**各自**的 memory
 *      —— **群聊不加好感度**，所以这次调用只要 memory
 *
 * 模型不可用时全部走本地兜底（关键词匹配 + 私聊语料），功能不缺失。
 */
import { CONFIG, FRIEND, GROUP } from '../config.js';
import { callDeepSeek } from './chat.js';
import { genderPromptLine, agePromptLine } from '../data/personas.js';
import { timeContextLine } from '../data/clock.js';
import { styleRules, maxReplyCharsOf, decorateLine, personaReactionLine } from '../data/style.js';
import { pickChatLine, chatBucket } from '../data/chatLines.js';
import { MEMORY_CATEGORIES, MEMORY_EXCLUDE, ownedLines, OWNER_PLAYER, OWNER_SELF, OWNER_SYSTEM } from '../data/memory.js';
import { listSelfMemory, listPlayerMemory, selfDisclosureLine, memoryGroups } from '../store/friends.js';
import { extractMemory, extractSelfMemory, guardSelfFacts, guardPlayerMemory, aiEconomyLine } from './friend.js';

function sanitize(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
}

/* ===================================================================== */
/*                        1) 点名 / 选谁回答                             */
/* ===================================================================== */

/**
 * 玩家这句里点到了谁（**点到的人必须回答**）
 * 支持 `@冷面棋手` 和直接写名字两种写法。
 * @returns {string[]} personaId
 */
export function findMentioned(text, members) {
  const t = String(text || '');
  if (!t) return [];
  const out = [];
  for (const p of members || []) {
    if (!p || !p.name) continue;
    const plain = t.includes(p.name);
    const at = t.includes(`@${p.name}`);
    if (plain || at) out.push(p.id);
  }
  return out;
}

/**
 * 群里大概几个人回答（人越多说话的人越多，但最少 1 个、最多 4 个）
 * @param {number} memberCount
 * @param {Function} rnd
 */
export function replyCountFor(memberCount, rnd = Math.random) {
  const n = Math.max(0, Number(memberCount) || 0);
  if (n <= 0) return 0;
  const band = GROUP.replyRange.find((b) => n >= b.min) || GROUP.replyRange[GROUP.replyRange.length - 1];
  const pick = band.lo + Math.floor(rnd() * (band.hi - band.lo + 1));
  return Math.max(1, Math.min(n, pick));
}

/** 选谁回答的提示词 */
export function buildChooseMessages({ group, members, recentLines, playerText, replyToName, want }) {
  const roster = members.map((p) => `  · ${p.name}（${p.tags.join('、')}）`).join('\n');
  const system = [
    '你在模拟一个微信群，需要判断"玩家发了这句话之后，群里哪几个人会出来回"。',
    '硬性规则：',
    `1) 只从下面这份名单里选人，最多 ${GROUP.maxMentions} 个，一般选 ${want} 个左右。`,
    '2) **被点名的人必须选上**（点名包括 @某人 或直接写了名字）。',
    '3) 挑"最可能接这句话"的人：话题对得上、性格爱说话、和玩家关系好的优先；别每次都挑同一批人。',
    '4) 不要选已经在下面聊天记录里刚说过话的人，除非被点名。',
    '只输出 JSON，不要解释、不要代码块：{"pick": ["名单里的名字", ...]}',
  ].join('\n');
  const user = [
    `群成员名单：\n${roster}`,
    recentLines.length ? `最近的群消息（从早到晚）：\n${recentLines.join('\n')}` : '群里还没人说过话。',
    replyToName ? `玩家这句是**点着「${replyToName}」那条消息在回复**，${replyToName} 必须回答。` : '',
    `玩家刚刚说：${playerText}`,
    '请输出 JSON。',
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 把模型返回的名字解析成 personaId（容忍各种脏输出） */
export function parseChoose(raw, members, { forceIds = [], want = 2 } = {}) {
  const byName = new Map((members || []).map((p) => [p.name, p.id]));
  const byId = new Set((members || []).map((p) => p.id));
  const picked = [];
  for (const id of forceIds) if (byId.has(id) && !picked.includes(id)) picked.push(id);

  const s = String(raw || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  let names = [];
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(s.slice(start, end + 1));
      if (Array.isArray(arr)) names = arr.map((x) => String(x).trim());
    } catch { names = []; }
  }
  if (!names.length) {
    // 抠不出 JSON 时：直接在文本里找名字（模型经常直接写"我觉得冷面棋手会回"）
    names = (members || []).map((p) => p.name).filter((n) => s.includes(n));
  }
  for (const n of names) {
    const id = byName.get(n) || (byId.has(n) ? n : null);
    if (id && !picked.includes(id)) picked.push(id);
    if (picked.length >= Math.max(want, forceIds.length, GROUP.maxMentions)) break;
  }
  return picked.slice(0, GROUP.maxMentions);
}

/**
 * 本地兜底：没有模型时也能"挑人"
 * 思路：谁的名字/标签/人设文字和这句话沾得上，谁就更可能开口；再掺一点随机和好感度。
 */
export function localChoose({ members, playerText, forceIds = [], want = 2, friends = [], rnd = Math.random }) {
  const picked = [];
  for (const id of forceIds) if (members.some((p) => p.id === id) && !picked.includes(id)) picked.push(id);

  const text = String(playerText || '');
  const affOf = (id) => {
    const f = (friends || []).find((x) => x.personaId === id);
    return f ? f.affinity : 50;
  };
  const score = (p) => {
    let s = rnd() * 0.6; // 随机垫底，保证每次挑的人不完全一样
    for (const tag of p.tags || []) if (tag && text.includes(tag)) s += 3;
    // 名字里提到相关字也算一点点
    if (p.name && text.includes(p.name.slice(0, 1))) s += 0.4;
    s += (affOf(p.id) - 50) / 60; // 关系好一点更爱搭话
    if (p.talky) s += 0.5; // 话痨更容易冒泡
    if (p.quiet) s -= 0.4; // 惜字如金的更少开口
    // 刚说过话的先让一让（除非被点名）
    return s;
  };
  const rest = members
    .filter((p) => !picked.includes(p.id))
    .map((p) => ({ p, s: score(p) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
  for (const p of rest) {
    if (picked.length >= Math.max(1, Math.min(GROUP.maxMentions, want))) break;
    picked.push(p.id);
  }
  return picked.slice(0, GROUP.maxMentions);
}

/** 一次调用：让模型挑人（失败返回 null，交给本地兜底） */
export async function chooseResponders({
  group, members, recentLines, playerText, replyToName, forceIds = [], want = 2,
}) {
  const messages = buildChooseMessages({
    group, members, recentLines, playerText, replyToName, want,
  });
  try {
    const raw = await callDeepSeek(messages, { timeoutMs: GROUP.chooseTimeout });
    const picked = parseChoose(raw, members, { forceIds, want });
    if (picked.length) return { ids: picked, source: 'llm' };
    return { ids: localChoose({ members, playerText, forceIds, want }), source: 'fallback' };
  } catch (err) {
    return {
      ids: localChoose({ members, playerText, forceIds, want }),
      source: 'fallback',
      error: err && err.message,
    };
  }
}

/* ===================================================================== */
/*                        2) 某个人的一句回复                            */
/* ===================================================================== */

/**
 * 发言提示词
 * @param {{persona, group, members, recentLines, playerText, replyTo, friends}} opts
 *   replyTo = { name, text } 玩家正在回复的那条消息（没有就是普通发言）
 */
export function buildGroupReplyMessages({
  persona, group, members, recentLines, playerText, replyTo, friends = [], playerName, playerGender = '',
  playerIdentity = '', mingle = false, lastSpeaker = '', myBeans = null, myTitle = '',
}) {
  const limit = maxReplyCharsOf(persona, GROUP.maxReplyChars);
  const style = styleRules(persona, { maxChars: limit, scene: 'chat' });
  const others = (members || []).filter((p) => p.id !== persona.id).map((p) => p.name);
  const me = (friends || []).find((f) => f.personaId === persona.id) || null;
  // ★ 记忆分三块、各自标归属：免得把自己说的当成玩家的、或反过来（用户报的问题）
  //   用 memoryGroups：对局/友圈按时间从新到旧，最上面那条才是"刚刚那局"
  const grp = me ? memoryGroups(me) : { player: [], self: [], system: [] };
  const hisMem = grp.player.slice(0, 8);
  const myMem = grp.self.slice(0, 6);
  const sysMem = grp.system.slice(0, 4);
  if (me && !hisMem.length && !myMem.length) {
    const legacy = Array.isArray(me.memory) ? me.memory.slice(0, 6) : [];
    hisMem.push(...legacy);
  }

  const system = [
    '你在一个卡牌游戏 App 的**微信群聊**里，正在群里跟玩家和其他朋友聊天。',
    `你是「${persona.name}」。你的人设：${persona.prompt || (persona.tags || []).join('、')}`,
    genderPromptLine(persona),
    agePromptLine(persona),
    // ★ 玩家是谁：明确的一段背景知识（群里最容易叫错、也最容易问"你是谁"）
    playerIdentity || playerGender,
    // ★ 看人下菜：有些 AI 对"玩家性别 + 好感度"有额外反应（例如说的道理）
    personaReactionLine(persona, { playerGender, affinity: me ? me.affinity : 0 }),
    timeContextLine(),
    // ★ 它自己的身家与称号（实时注入；只是背景知识，别刻意提钱）
    aiEconomyLine(myBeans, myTitle),
    ...style,
    `这个群叫「${group.name}」，群里有：你、${others.join('、') || '（没有别人）'}，还有玩家${playerName ? `（${playerName}）` : ''}。`,
    // 玩家是谁：告知昵称即可（没给完整背景知识时才用这句兜底）
    (!playerIdentity && playerName) ? `玩家的昵称是「${playerName}」。` : '',
    hisMem.length ? `你记得【关于玩家】的事：\n${ownedLines(hisMem, OWNER_PLAYER).join('\n')}` : '',
    hisMem.some((m) => String(m).startsWith('对局：'))
      ? '（对局记忆按时间从新到旧，带 [月/日 时:分] 的是对局；只有最上面那条才是"刚刚那局"。）'
      : '',
    myMem.length ? `**你自己**说过的设定（不能矛盾）：\n${ownedLines(myMem, OWNER_SELF).join('\n')}` : '',
    sysMem.length
      ? '【系统记录】你经历过的（对局 / 友圈 / 改名 / 关系）——**不是"玩家说过的话"**：\n'
        + ownedLines(sysMem, OWNER_SYSTEM).join('\n')
      : '',
    me ? selfDisclosureLine(me) : '',
    mingle
      ? [
        '【重要：玩家**这轮没说话**，是你们几个自己接着聊】',
        '  · 你们在群里闲聊，**话题不必和玩家有关**（聊自己今天干了什么、吐槽、抬杠、约下次一起玩都行）',
        '  · **接着上面最后几条说**，像真的群里那样有来有回；可以接某个人那句话，也可以抛个新话题',
        '  · **不要每句都问玩家、不要硬把玩家拉进来**；玩家想说话自己会说',
        '  · 不要重复别人刚说过的内容，别 @ 所有人',
      ].join('\n')
      : [
        '【重要：这是群聊，不是私聊也不是牌桌】',
        '  · 群里有好几个人，**不要抢答**，只说你自己想说的那一句；别人说过的话不用重复',
        '  · 可以用"我也觉得""楼上说得对"这种群聊口气，也可以只回一半、插一句嘴',
        '  · 不要用"出牌""叫地主""要不起"这类牌桌喊话的口气（聊刚才那局牌可以）',
        '  · **不要报牌**：不要说自己手里有什么牌',
        '  · 不要每条都接话，也别 @ 所有人',
      ].join('\n'),
    '【要求】',
    `1) 只输出一句中文，${limit} 个字以内，不要引号、不要换行、不要前缀（不要写"${persona.name}："）。`,
    '2) 群里可以热闹、可以损人、可以吐槽，但不要脏话、人身攻击、政治与宗教内容。',
    '3) 不要主动报时间、不要主动提年龄。',
  ].filter(Boolean).join('\n');

  const user = [
    recentLines.length ? `最近的群消息（从早到晚，最多 ${GROUP.recent} 条）：\n${recentLines.join('\n')}` : '群里还没人说过话，你是第一个开口的。',
    mingle
      ? (lastSpeaker ? `刚才最后说话的是「${lastSpeaker}」。现在轮到你接一句。` : '现在轮到你开口。')
      : (replyTo
        ? `玩家刚刚在**回复「${replyTo.name}」的那条消息**（那条是：${replyTo.text}），玩家说：${playerText}`
        : `玩家刚刚在群里说：${playerText}`),
    mingle
      ? '请说一句符合你人设的群聊发言（接着上面的话说，别问玩家、也别写名字前缀）。'
      : '请说一句符合你人设的群聊回复（只回一句，不要写名字前缀）。',
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 清理模型输出：去掉名字前缀、引号、换行 */
export function cleanGroupReply(raw, persona, limit = GROUP.maxReplyChars) {
  let t = sanitize(raw);
  if (persona && persona.name) {
    const prefix = new RegExp(`^${persona.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：]\\s*`);
    t = t.replace(prefix, '');
  }
  t = t.replace(/^(我|回复)[:：]\s*/, '');
  return t.slice(0, limit);
}

/** 本地兜底：借用**私聊语料**（群聊也是闲聊，绝不能用牌桌台词） */
export function localGroupReply(persona, text) {
  return decorateLine(pickChatLine(chatBucket(text), (persona && persona.style) || 'balanced'), persona);
}

/** 生成一句（模型优先，失败兜底） */
export async function groupReply(opts) {
  const messages = buildGroupReplyMessages(opts);
  try {
    const raw = await callDeepSeek(messages, { timeoutMs: CONFIG.ai.timeout });
    const text = cleanGroupReply(raw, opts.persona, maxReplyCharsOf(opts.persona, GROUP.maxReplyChars));
    if (text) return { text, source: 'llm' };
    throw new Error('空回复');
  } catch (err) {
    return { text: localGroupReply(opts.persona, opts.playerText || ''), source: 'fallback', error: err && err.message };
  }
}

/* ===================================================================== */
/*              4) 挂机时 AI 之间自己聊（用户拍板）                       */
/* ===================================================================== */
/**
 * 下一句该谁说（"AI 和 AI 聊天要连续"：由 AI 判断这句话由哪个其他人接比较合适）
 *   · 只从**群里的 AI 成员**里挑，且**不挑刚说过话的那位**（不然像自言自语）
 *   · 模型不可用时用本地兜底：优先话痨 / 关系好的，随机加权
 * @returns {Promise<{id:string, name:string}>}
 */
export function buildNextSpeakerMessages({ group, members, recentLines, lastSpeaker = '' }) {
  const roster = members.map((p) => `  · ${p.name}（${(p.tags || []).join('、')}）`).join('\n');
  const system = [
    '你在模拟一个微信群：现在**玩家没有说话**，群里几个朋友在自己聊天。',
    '你的任务：判断**下一句该谁说**，让对话像真的群聊那样接得下去。',
    '硬性规则：',
    `1) 只从下面这份名单里选**一个人**（不是玩家，玩家没说话）。`,
    lastSpeaker ? `2) **不要选刚说过话的「${lastSpeaker}」**（除非名单里只有他一个）。` : '2) 随便挑一个最可能接话的。',
    '3) 挑"最可能接上一句"的人：话题对得上、性格爱说话、平时话多的优先；别每次都同一个人。',
    '只输出 JSON，不要解释、不要代码块：{"next": "名单里的名字"}',
  ].join('\n');
  const user = [
    `群成员名单：\n${roster}`,
    recentLines.length ? `最近的群消息（从早到晚）：\n${recentLines.join('\n')}` : '群里还没人说过话。',
    '请输出 JSON。',
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 解析"下一句谁说" */
export function parseNextSpeaker(raw, members, { lastSpeaker = '' } = {}) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  let name = '';
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(s.slice(start, end + 1));
      name = sanitize(obj.next || obj.name || '');
    } catch { name = ''; }
  }
  let hit = members.find((p) => p.name === name) || null;
  if (hit && members.length > 1 && hit.name === lastSpeaker) hit = null;
  if (!hit) return localNextSpeaker({ members, lastSpeaker });
  return { id: hit.id, name: hit.name };
}

/** 本地兜底：随机挑一个（尽量不重复上一位；话痨加权） */
export function localNextSpeaker({ members, lastSpeaker = '', rnd = Math.random }) {
  const pool = members.filter((p) => p.name !== lastSpeaker);
  const list = pool.length ? pool : members;
  if (!list.length) return null;
  // 话痨（quiet 为 false 的人设）拿两份权重，让"群里话多的人"更容易接话
  const bag = [];
  for (const p of list) {
    bag.push(p);
    if (!p.quiet) bag.push(p);
  }
  return bag[Math.floor(rnd() * bag.length)] || list[0];
}

/** 决定下一句谁说（模型优先，失败本地兜底） */
export async function chooseNextSpeaker({ group, members, recentLines, lastSpeaker = '' }) {
  if (!members || !members.length) return null;
  if (members.length === 1) return { id: members[0].id, name: members[0].name };
  try {
    const raw = await callDeepSeek(buildNextSpeakerMessages({ group, members, recentLines, lastSpeaker }), {
      timeoutMs: CONFIG.ai.timeout,
    });
    const hit = parseNextSpeaker(raw, members, { lastSpeaker });
    if (hit) return hit;
    throw new Error('挑不出来');
  } catch {
    return localNextSpeaker({ members, lastSpeaker });
  }
}

/* ===================================================================== */
/*                     3) 群聊内容审查（只判 memory）                     */
/* ===================================================================== */

/**
 * 一次调用判断"这段群聊里，哪几个人该记点什么"
 * **不判好感度**（群聊不影响好感度，这是用户明确要求的）
 * @param {{responders:object[], playerText:string, replies:{name:string,text:string}[], recentLines:string[]}} opts
 */
export function buildGroupAnalyzeMessages({ responders, playerText, replies, recentLines, playerName = '' }) {
  const catLines = MEMORY_CATEGORIES.filter((c) => !c.auto)
    .map((c) => `  · ${c.label}（${c.hint}）`);
  const system = [
    '你在审查一段**群聊**，判断群里每个人都有没有值得长期记住的信息。',
    '只输出 JSON，不要解释、不要代码块。',
    '格式：{"记忆": {"某人名字": "分类：内容"}, "自设": {"某人名字": {"方面": "内容"}}}',
    '【记忆】只写**玩家**透露出来的、稳定且以后还能用上的信息；',
    ...catLines,
    `  · 每人最多一条，不超过 ${FRIEND.maxMemoryChars} 个字，写成短语不要整句。`,
    '  · 没有值得记的就**不要出现这个名字**（不要写空字符串占位）。',
    '  · **好感度不归你管**：群里发生什么都不要判断好感度、不要输出 delta。',
    '不要记的内容：',
    ...MEMORY_EXCLUDE.map((x) => `  · ${x}`),
    '',
    '【自设】**群里某个 AI 自己顺口补充的设定**（人设里没写的那些）：',
    '  · 例：玩家问"你哪儿人"，某个人答"我杭州的" → 把它记进 `自设`：{"某人名字": {"老家": "杭州"}}',
    '  · 只有**说话的人自己**的设定才写进他名下，不要张冠李戴；玩家的事写进「记忆」，不是「自设」。',
    '  · 方面用 2~4 个字的短词（老家 / 职业 / 爱好 / 宠物 / 作息 …），内容不超过 '
      + `${FRIEND.maxMemoryChars} 个字。`,
    '  · ★ 方面必须是**那个人自己**的属性；"怎么称呼玩家""玩家是谁"这类**不算自设**：',
    '    玩家让你改口叫他什么 → 写进「记忆」的 `称呼：XXX`；他只是用了自己的名字 → 什么都别记。',
    '    反例（绝对不要写）：`{"某人": {"称呼对方": "管对方叫汽水偶像"}}` —— "对方"是玩家，不是他。',
    '  · **只写这次新说的**；没人补充新设定就写 {}。',
    '',
    '两项都可以是空对象 {}，但两个键都要有。',
  ].join('\n');

  const who = responders.map((p) => p.name).join('、');
  const user = [
    `群里有这几个人在场：${who}`,
    playerName ? `玩家的昵称是「${playerName}」—— 谁叫他这个名字都是理所当然的，**不算谁的设定**。` : '',
    recentLines && recentLines.length ? `最近的群消息：\n${recentLines.join('\n')}` : '',
    `玩家说：${playerText}`,
    replies && replies.length ? `他们分别回了：\n${replies.map((r) => `${r.name}：${r.text}`).join('\n')}` : '',
    '请输出 JSON。',
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 解析成 `{ memory: {名字: 文本}, self: {名字: {方面: 内容}} }` */
export function parseGroupAnalyze(raw, responders) {
  const valid = new Set((responders || []).map((p) => p.name));
  const out = {};
  const self = {};
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { memory: out, self };
  let obj = null;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch {
    return { memory: out, self };
  }
  const bucket = obj && (obj['记忆'] || obj.memory || obj);
  if (bucket && typeof bucket === 'object') {
    for (const [name, val] of Object.entries(bucket)) {
      if (!valid.has(name)) continue;
      if (val && typeof val === 'object') continue; // 别把 self 那层当记忆
      const text = String(val || '').trim().slice(0, FRIEND.maxMemoryChars);
      if (text) out[name] = text;
    }
  }
  const selfBucket = obj && (obj['自设'] || obj.self);
  if (selfBucket && typeof selfBucket === 'object') {
    for (const [name, map] of Object.entries(selfBucket)) {
      if (!valid.has(name) || !map || typeof map !== 'object') continue;
      const one = {};
      for (const [aspect, value] of Object.entries(map)) {
        const a = String(aspect || '').trim().slice(0, 10);
        const v = String(value || '').trim().slice(0, FRIEND.maxMemoryChars);
        if (a && v) one[a] = v;
      }
      if (Object.keys(one).length) self[name] = one;
    }
  }
  return { memory: out, self };
}

/** 本地兜底：正则抽一下玩家那句话里的稳定信息，给在场每个人各记一份 */
export function localGroupAnalyze({ responders, playerText, replies }) {
  const mem = extractMemory(playerText);
  const out = {};
  if (mem) for (const p of responders || []) out[p.name] = mem;
  // 自设：从**每个人自己那句回复**里抠（本地兜底也能保证不前后矛盾）
  const self = {};
  for (const r of replies || []) {
    if (!r || !r.name) continue;
    const facts = extractSelfMemory(r.text);
    if (Object.keys(facts).length) self[r.name] = facts;
  }
  return { memory: out, self };
}

/** 取某个人在这次对话里说的那句 */
const replyOf = (name, replies) => {
  const r = (replies || []).find((x) => x && x.name === name);
  return r ? r.text : '';
};

/**
 * ★ 防"记反"：自设必须是**说话的人自己**说的
 * （群里也会出现"玩家说我南京人、AI 说我溧阳人"被串掉的情况，同一个坑）
 */
export function guardGroupSelf(self, { replies, playerText, playerName = '' }) {
  const out = {};
  for (const [name, map] of Object.entries(self || {})) {
    const kept = guardSelfFacts(map, replyOf(name, replies), playerText, '', playerName);
    if (Object.keys(kept).length) out[name] = kept;
  }
  return out;
}

/** ★ 防"记反"：玩家记忆只出现在"别人说的那几句"里 → 那是别人的事，不该记成玩家的 */
export function guardGroupMemory(memory, { replies, playerText }) {
  const allReplies = (replies || []).map((r) => r.text).join(' ');
  const out = {};
  for (const [name, mem] of Object.entries(memory || {})) {
    const kept = guardPlayerMemory(mem, playerText, allReplies);
    if (kept) out[name] = kept;
  }
  return out;
}

/**
 * 一次调用做完审查（模型优先，失败兜底）
 * @returns {Promise<{memory:object, self:object, source:string}>}
 */
export async function analyzeGroupChat(opts) {
  try {
    const raw = await callDeepSeek(buildGroupAnalyzeMessages(opts), { timeoutMs: GROUP.chooseTimeout });
    const parsed = parseGroupAnalyze(raw, opts.responders);
    // ★ 统一过一遍"防记反"校验
    return {
      memory: guardGroupMemory(parsed.memory, opts),
      self: guardGroupSelf(parsed.self, opts),
      source: 'llm',
    };
  } catch (err) {
    // 兜底路径也过一遍同样的校验，免得本地规则蹦出"自设：称呼对方=玩家昵称"这种
    const local = localGroupAnalyze(opts);
    return {
      ...local,
      memory: guardGroupMemory(local.memory, opts),
      self: guardGroupSelf(local.self, opts),
      source: 'fallback',
      error: err && err.message,
    };
  }
}
