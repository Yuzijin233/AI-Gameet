/**
 * 好友系统（存档层）
 * 好友就是游戏里的 AI 人设：点"添加"直接通过，不需要对方同意
 * 每个好友独立维护：好感度 0~100、memory 列表、聊天记录
 * 重置存档会清空好友（因为走的是 defaultSave）
 */
import { FRIEND, GIFT, RETURN_PING } from '../config.js';
import { neutralizeSummary } from '../data/summaryText.js';
import {
  categoryOf, memoryPriority, isLongCategory, isSelfMemory, selfLine, SELF_PREFIX, ownedLines, OWNER_PLAYER, OWNER_SELF,
  ownerOf, looksLikeSelfFact, mergeMemoryLocally, selfAspectOf, selfValueOf,
  findSimilarMemory, mergeSimilarText, isExtraMemory, selfAboutPlayer, cleanSelfAspect, isRenameMemory,
  isSystemMemory, OWNER_SYSTEM,
} from '../data/memory.js';
import { PERSONAS } from '../data/personas.js';

/**
 * 展示用的名字与头像：以人设为唯一真相源
 * （好友记录里也存了一份副本，但人设改写后应当立即跟着变，避免老存档显示旧名字）
 */
export function friendDisplay(friend) {
  const persona = PERSONAS.find((p) => p.id === friend.personaId) || null;
  return {
    persona,
    name: (persona && persona.name) || friend.name || '好友',
    avatar: (persona && persona.avatar) || friend.avatar || 'avatar_01',
  };
}

export function ensureFriends(save) {
  if (!Array.isArray(save.friends)) save.friends = [];
  return save.friends;
}

/**
 * 把好友记录里的**名字 / 头像副本**同步成人设的当前值。
 *
 * 为什么需要：加好友时会把当时的 `name` / `avatar` 抄一份到好友记录里，
 * 而显示以人设为准（friendDisplay）。但**好友列表、房间模式那几处直接用了副本**，
 * 所以人设一改名（用户改过一批人名），老存档里就会显示旧名字。
 * 启动时跑一遍，谁的名字对不上就刷成新的。
 * @returns {number} 刷了几个人
 */
export function syncFriendIdentities(save) {
  let n = 0;
  for (const f of ensureFriends(save)) {
    const p = PERSONAS.find((x) => x.id === f.personaId);
    if (!p) continue;
    if (f.name !== p.name) { f.name = p.name; n += 1; }
    if (p.avatar && f.avatar !== p.avatar) f.avatar = p.avatar;
  }
  return n;
}

/** 当前**还在好友列表里**的好友（软删除的不算；记忆仍留在存档里） */
export function listFriends(save) {
  return ensureFriends(save).filter((f) => !f.removed);
}

/** 存档里的好友记录（**包括被删掉的**：它们的记忆还留着，加回来时能接着用） */
export function listFriendRecords(save) {
  return ensureFriends(save).slice();
}

/**
 * 找好友记录：删掉的好友**也找得到**（记忆、好感度都还在），
 * 所以"聊天记录 / 记忆 / 群成员"这些地方不会因为删好友而丢东西。
 * 需要判断"现在还是不是好友"请用 isFriend()。
 */
export function findFriend(save, personaId) {
  return ensureFriends(save).find((f) => f.personaId === personaId) || null;
}

/** 现在还是好友吗（软删除的不算） */
export function isFriend(save, personaId) {
  const f = findFriend(save, personaId);
  return !!(f && !f.removed);
}

/** 删好友时顺手处理恋人关系（见 removeFriend） */

/**
 * 添加好友：直接通过（上限 10 个）
 * @param {object} save
 * @param {object} persona PERSONAS 里的一项
 * @param {{fromMatch?:boolean}} opts
 *   fromMatch = **从结算面板加的**（"刚一起打完这局，顺手加个好友"）→ 把那几局的概括补进它的记忆；
 *   从「添加好友」列表加的（冷加）**不补** —— 否则随便加的人一上来就说"刚刚那局你…"（用户报的 bug）。
 * @returns {{ok:boolean, friend?:object, error?:string}}
 */
export function addFriend(save, persona, { fromMatch = false } = {}) {
  if (!persona || !persona.id) return { ok: false, error: '人设不存在' };
  const list = ensureFriends(save);
  const exist = list.find((f) => f.personaId === persona.id);
  if (exist && !exist.removed) return { ok: false, error: '已经是好友了', friend: exist };
  if (exist && exist.removed) {
    /**
     * ★ 以前把 TA 删了（软删除：记录还在，记忆也留着）→ 现在是"再加回来"：
     *   记忆、好感度、聊天记录**全都还在**，它记得你们之间发生过什么（包括"你删过我"）。
     */
    exist.removed = false;
    exist.addedAt = Date.now();
    exist.unread = 0;
    return { ok: true, friend: exist, restored: true };
  }
  if (list.filter((f) => !f.removed).length >= FRIEND.maxFriends) {
    return { ok: false, error: `好友已满（最多 ${FRIEND.maxFriends} 个），先删掉几个吧` };
  }
  const friend = {
    personaId: persona.id,
    name: persona.name,
    avatar: persona.avatar,
    affinity: FRIEND.startAffinity,
    memory: [],
    chat: [],
    addedAt: Date.now(),
    lastChatAt: 0,
    chatCount: 0,
    unread: 0,
    removed: false,
  };
  list.unshift(friend);
  /**
   * 只有"从结算面板加的"才把刚才那几局补进记忆 —— 那时你们**确实**刚一起打完。
   * 冷加（添加好友列表）什么都不补：记忆从零开始，聊天时也不会被喂那局的摘要。
   */
  if (fromMatch && Array.isArray(save.recentHands)) {
    for (const h of save.recentHands.slice().reverse()) { // 由旧到新，保证最新的在最后
      if (h && Array.isArray(h.seatIds) && h.seatIds.includes(persona.id) && h.summary) {
        addMatchMemory(save, persona.id, h.summary, h.at);
      }
    }
  }
  return { ok: true, friend };
}

/**
 * 删除好友（用户拍板的规则）：
 *   · ★ **恋人不能直接删** —— 得先分手（用户拍板："恋人关系不允许删除好友，除非分手"）
 *   · **记忆要留着**（软删除：记录还在，只是不在好友列表里了）→ 加回来时它还认得你
 *   · **不退群**：群成员照旧（群聊里还能见到它）
 *   · **好感度 -5**（下限 0）
 *   · 追加一条记忆：「玩家删掉了AI好友」
 * @returns {{ok:boolean, error?:string, affinity?:number}}
 */
export function removeFriend(save, personaId) {
  const list = ensureFriends(save);
  const f = list.find((x) => x.personaId === personaId);
  if (!f) return { ok: false, error: '不是好友' };
  if (f.removed) return { ok: false, error: '已经不是好友了' };
  /**
   * ★ 恋人保护（用户拍板）：想删恋人必须先分手。
   *   不然一句"删除好友"就把关系里的那个人悄悄抹掉了 —— 而分手本来是
   *   一件要走审查、会掉好感、会写进记忆的事（见 canBreakup / breakUp）。
   */
  if (save && save.loverId === personaId) {
    return { ok: false, error: 'TA 是你的恋人 —— 想删好友，先跟 TA 分手', needBreakup: true };
  }
  // 好感 -5（夹到 0，不会变负）
  const before = Number(f.affinity) || 0;
  f.affinity = Math.max(0, before - FRIEND.removeAffinityPenalty);
  // 删好友这件事要留在记忆里（加回来时它会记得）
  addMemory(save, personaId, '玩家删掉了AI好友');
  f.removed = true;
  f.removedAt = Date.now();
  f.unread = 0;
  clearLoverIf(save, personaId); // 兜底：万一还有别的路径（老存档）留下了恋人关系
  return { ok: true, affinity: f.affinity, delta: f.affinity - before };
}

/**
 * 追加一条聊天（自动裁剪长度）
 * @param {{gift?:object, at?:number}} [extra] 赠礼消息带礼物对象；at = 指定时间
 *   ★ at 的用处（用户拍板）：离线回来时 AI 那些消息是**玩家不在的那段时间里
 *     它自己发的**，所以时间要按"模拟出来的发送时刻"落库，而不是玩家上线的时刻。
 *     给了 at 就按时间顺序插进去，聊天记录仍然是顺序读的。
 */
export function appendChat(save, personaId, role, text, extra = null) {
  const f = findFriend(save, personaId);
  if (!f) return null;
  const at = extra && Number.isFinite(Number(extra.at)) ? Number(extra.at) : Date.now();
  const msg = { role, text, at };
  if (extra && extra.gift) msg.gift = { id: extra.gift.id, name: extra.gift.name, emoji: extra.gift.emoji };
  // 补历史（at 早于最后一条）时插到正确位置，避免聊天记录时间倒着走
  if (f.chat.length && at < (f.chat[f.chat.length - 1].at || 0)) {
    let i = f.chat.length;
    while (i > 0 && (f.chat[i - 1].at || 0) > at) i -= 1;
    f.chat.splice(i, 0, msg);
  } else {
    f.chat.push(msg);
  }
  if (f.chat.length > FRIEND.maxHistory) f.chat.splice(0, f.chat.length - FRIEND.maxHistory);
  f.lastChatAt = Math.max(Number(f.lastChatAt) || 0, at);
  if (role === 'me') {
    f.chatCount = (f.chatCount || 0) + 1;
    /**
     * ★ 玩家回了一句 → " unanswered 主动消息" 计数清零（用户拍板）：
     *   AI 连着发满 maxUnansweredPings 条而玩家不回，就该安静下来；
     *   只要玩家回一次，它就又可以主动找你了。
     */
    f.pendingPings = 0;
    f.pingMutedAt = 0;
  }
  return f;
}

/* ---------------- AI 主动发消息的节流（用户拍板） ---------------- */

/** 这个 AI 现在还能不能主动给玩家发消息（连着发满 2 条没被回 → 不能） */
export function canPingPlayer(save, personaId) {
  const f = findFriend(save, personaId);
  if (!f) return false;
  return (f.pendingPings || 0) < FRIEND.maxUnansweredPings;
}

/** 记一次"AI 主动发消息"（玩家回话时会自动清零） */
export function bumpPendingPing(save, personaId) {
  const f = findFriend(save, personaId);
  if (!f) return 0;
  f.pendingPings = (f.pendingPings || 0) + 1;
  return f.pendingPings;
}

/** 还有几个好友"愿意主动找你"（全都被挡住了就一个都没有） */
export function friendsWhoCanPing(save) {
  return listFriends(save).filter((f) => canPingPlayer(save, f.personaId));
}

/**
 * ★ 离线回来"这次谁来找你"（用户拍板：**恋人权重更高**）
 *
 * 规则（两道叠加，参数见 config.js 的 RETURN_PING.loverSureChance / loverWeight）：
 *   ① **保送**：先掷一次骰子，中了就直接把恋人放进名单（不是 100%，否则每次都一样）
 *   ② **加权**：剩下的名额按权重抽 —— 恋人的权重是 loverWeight（默认 3），普通好友 = 1
 *   所以恋人被选中的概率**一眼看出更大**，但偶尔也会是别的好友（关系再好也不该霸屏）。
 *
 * 防御性：恋人不在名单里（被删好友 / 被节流挡住 / 已经不是恋人）→ 退化成纯随机；
 *         名单为空、count ≤ 0 → 返回空数组；返回的人**不重复**，最多 count 位。
 *
 * @param {object[]} friends 候选好友（调用方已经过滤过"还能主动发消息"）
 * @param {{loverId?:string, count?:number, sureChance?:number, loverWeight?:number, rnd?:Function}} [opts]
 * @returns {object[]} 被挑中的人（恋人在里面的话排第一个）
 */
export function pickPingTargets(friends, {
  loverId = '', count = 1,
  sureChance = RETURN_PING.loverSureChance,
  loverWeight = RETURN_PING.loverWeight,
  rnd = Math.random,
} = {}) {
  const pool = (Array.isArray(friends) ? friends : []).filter(Boolean);
  const want = Math.max(0, Math.floor(Number(count) || 0));
  if (!pool.length || !want) return [];
  const roll = () => {
    const v = Number(rnd());
    return Number.isFinite(v) ? Math.min(0.999999, Math.max(0, v)) : 0;
  };
  const lover = loverId ? pool.find((f) => f.personaId === loverId) || null : null;
  const picks = [];
  // ① 恋人"保送"一个名额（概率 loverSureChance）
  if (lover && roll() < Math.max(0, Math.min(1, Number(sureChance) || 0))) picks.push(lover);
  // ② 其余名额按权重抽，不重复
  const rest = pool.filter((f) => !picks.includes(f));
  const w = Math.max(1, Math.floor(Number(loverWeight) || 1));
  while (picks.length < want && rest.length) {
    const bag = [];
    for (const f of rest) {
      const weight = (lover && f.personaId === lover.personaId) ? w : 1;
      for (let i = 0; i < weight; i += 1) bag.push(f);
    }
    const hit = bag[Math.floor(roll() * bag.length)] || rest[0];
    picks.push(hit);
    rest.splice(rest.indexOf(hit), 1);
  }
  return picks;
}

export function adjustAffinity(save, personaId, delta) {
  const f = findFriend(save, personaId);
  if (!f) return null;
  const before = f.affinity;
  f.affinity = Math.max(0, Math.min(FRIEND.maxAffinity, before + delta));
  return { before, after: f.affinity, changed: f.affinity - before };
}

/** 「分类：内容」或「自设：方面=内容」→ 只取内容（用来比相似度 / 合并） */
export const contentOfLine = (line) => (isSelfMemory(line)
  ? selfValueOf(line)
  : String(line || '').replace(/^[^：:]{1,6}[：:]/, '').trim());

/**
 * 写入 memory
 * 「唯一类」分类（称呼/性格/身份）只保留最新一条：玩家改口就覆盖，避免提示词自相矛盾
 * 「对局」「友圈」这类自动记忆允许更长（long）且只保留最近 N 条（keep），
 * 而且**不占用常规的 maxMemory 条数**（用户要求）
 */
export function addMemory(save, personaId, text) {
  const f = findFriend(save, personaId);
  if (!f) return null;
  const cat0 = categoryOf(String(text || '').trim());
  const long = isLongCategory(text);
  // 分类可以自带长度上限（「友圈」那条比「对局」还长：要放下最后 3 轮对话）
  const limit = (cat0 && cat0.limit) ? cat0.limit : (long ? FRIEND.maxMatchChars : FRIEND.maxMemoryChars);
  const t = String(text || '').trim().slice(0, limit);
  if (!t) return { added: false };

  const cat = categoryOf(t);
  if (cat && cat.unique) {
    const idx = f.memory.findIndex((m) => {
      const c = categoryOf(m);
      return c && c.key === cat.key;
    });
    if (idx >= 0) {
      if (f.memory[idx] === t) return { added: false, duplicate: true };
      const replaced = f.memory[idx];
      f.memory[idx] = t;
      return { added: true, memory: t, replaced };
    }
  }

  if (f.memory.includes(t)) return { added: false, duplicate: true };

  /**
   * ★ 写入前先看**以往的记忆里有没有能合到一起的**（用户要求）：
   *   `自设：作息=睡前会刷会儿手机，睡得比较晚` +
   *   `习惯：睡前刷手机，睡得晚` + `习惯：睡前刷手机停不下来`
   * 其实是同一件事 → 合成一条，而不是越堆越多。
   *    · 只在**非对局/关系**的记忆里找近似项（对局、关系是系统写的，不参与）
   *    · 近似判定用字符相似度 + 连续重合片段（见 data/memory.js）
   *    · 归属：只要有一边是"自设"，合并结果就按**自设**算（那是 AI 自己在说自己）
   *    · **称呼 / 性格 / 身份 这类"身份牌"不跨归属合并** ——
   *      `身份：大学生`（玩家是大学生）和 `自设：职业=大学生`（我是大学生）是两件事，
   *      合并会直接把玩家的身份吞掉
   */
  const IDENTITY_KEYS = ['call', 'trait', 'ident'];
  const newIsSelfLine = isSelfMemory(t);
  const newKey = newIsSelfLine ? 'self' : ((categoryOf(t) || {}).key || 'other');
  const dup = findSimilarMemory(f.memory, contentOfLine(t), {
    skip: (line) => {
      const c = categoryOf(line);
      if (c && ['match', 'rel', 'moment', 'rename'].includes(c.key)) return true;
      const lineIsSelf = isSelfMemory(line);
      if (lineIsSelf === newIsSelfLine) return false; // 同一归属：可以合
      const lineKey = lineIsSelf ? 'self' : ((c || {}).key || 'other');
      return IDENTITY_KEYS.includes(lineKey) || IDENTITY_KEYS.includes(newKey);
    },
  });
  if (dup) {
    const oldLine = String(dup.line || '');
    const oldIsSelf = isSelfMemory(oldLine);
    const newIsSelf = isSelfMemory(t);
    const merged = mergeSimilarText(contentOfLine(oldLine), contentOfLine(t), FRIEND.maxMemoryChars);
    let line;
    if (oldIsSelf || newIsSelf) {
      const aspect = (oldIsSelf && selfAspectOf(oldLine)) || (newIsSelf && selfAspectOf(t)) || categoryOf(oldLine || t)?.label || '自述';
      line = selfLine(aspect, merged);
    } else {
      const label = (categoryOf(oldLine) || categoryOf(t) || {}).label || '其他';
      line = `${label}：${merged}`;
    }
    // 替换掉旧的那条（位置不变，免得打乱顺序），新的不再单独入列
    f.memory[dup.index] = line.slice(0, FRIEND.maxMatchChars);
    f.memoryDedupedAt = Date.now();
    /**
     * 同时标记"该让 AI 再整理一遍"：本地合并是**立即生效的兜底**（不让记忆越堆越多），
     * AI 那一遍会把它润色成更自然的一条（见 ai/friend.js 的 compressMemory）。
     */
    f.memoryNeedCompress = true;
    return {
      added: true, merged: true, memory: f.memory[dup.index], replaced: oldLine, incoming: t,
    };
  }

  f.memory.push(t);

  // 限定条数的分类（对局）：只留最近 keep 条，最旧的先淘汰
  const keep = cat && cat.keep ? cat.keep : 0;
  if (keep > 0) {
    const idxs = [];
    f.memory.forEach((m, i) => {
      const c = categoryOf(m);
      if (c && c.key === cat.key) idxs.push(i);
    });
    while (idxs.length > keep) {
      const drop = idxs.shift();
      f.memory.splice(drop, 1);
      for (let k = 0; k < idxs.length; k += 1) idxs[k] -= 1; // 后面的下标左移
    }
  } else if (regularMemoryCount(f) > FRIEND.maxMemory) {
    /**
     * ★ 超过上限（第 17 条）**不再直接淘汰最旧的** —— 用户要求"把相似的合并，
     * 这样记忆能更长"。这里只打个标记，真正的合并由 AI 做（见 ai/friend.js 的
     * compressMemory，失败则用 data/memory.js 的本地合并兜底）。
     * 同时留一个硬上限：万一合并不停失败，也不能让记忆无限涨。
     *
     * ★ 数的时候**只数常规记忆**（「对局」「友圈」是额外的，用户明确要求它们
     *   不占用常规条数）；真要裁也只裁常规里最旧的，额外记忆交给各自的 keep 管。
     */
    f.memoryNeedCompress = true;
    const extra = extraMemoryCount(f);
    const hard = (FRIEND.maxMemoryHardCap || FRIEND.maxMemory) + extra;
    if (f.memory.length > hard) {
      let drop = f.memory.length - (FRIEND.maxMemory + extra);
      for (let i = 0; i < f.memory.length && drop > 0; i += 1) {
        if (isExtraMemory(f.memory[i])) continue;
        f.memory.splice(i, 1);
        i -= 1;
        drop -= 1;
      }
    }
  }
  return { added: true, memory: t, needCompress: !!f.memoryNeedCompress };
}

/** 「额外记忆」的条数（对局 / 友圈：不占常规上限） */
export const extraMemoryCount = (friend) => ((friend && friend.memory) || []).filter(isExtraMemory).length;

/** 常规记忆的条数（不含对局 / 友圈）—— 判断"记满了没有"看这个 */
export const regularMemoryCount = (friend) => ((friend && friend.memory) || [])
  .filter((m) => !isExtraMemory(m)).length;

/**
 * 每局结束写入一条「对局」记忆（系统自动，玩家不用开口）
 *
 * ★ 一定带上时间戳：一个 AI 会同时记着好几局（小猫钓鱼一局、斗地主一局…），
 *   没有时间的话它根本分不清哪局是"刚刚那局"—— 用户就碰到过
 *   "刚打完斗地主，AI 却在聊上一局的小猫钓鱼"。
 *   格式：`对局：[8/19 22:40] 这局…`（保留「对局：」前缀，分类识别不受影响）
 */
export function addMatchMemory(save, personaId, summary, at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const text = `对局：[${stamp}] ${String(summary || '').trim()}`;
  return addMemory(save, personaId, text);
}

/** 从「对局：[8/19 22:40] …」里取出时间戳（毫秒；取不到返回 0） */
export function matchStampOf(line, now = new Date()) {
  const m = /^对局：\[(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\]/.exec(String(line || ''));
  if (!m) return 0;
  const y = now.getFullYear();
  const t = new Date(y, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4])).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 这条记忆是不是「对局」 */
export const isMatchMemory = (line) => String(line || '').startsWith('对局：');

/* ---------------- 友圈记忆（玩家发说说 + 我评论） ---------------- */

/** 时间戳文案 `[8/19 22:40]`（对局/友圈共用） */
function stampOf(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 这条记忆是不是「友圈」 */
export const isMomentMemory = (line) => String(line || '').startsWith('友圈：');

/**
 * 评论区里"**这位 AI 和玩家**"的最后几轮对话（用户要求：最后 3 轮也进记忆）
 *   一轮 = 玩家说一句 + 它接一句；别的 AI 在旁边的评论不算（那是别人的事）。
 *   每句截到 FRIEND.momentThreadChars，整条长度由分类的 limit 兜着。
 * @returns {string} 例：`玩家「下次一起」我「好呀」玩家「周末？」我「行」`
 */
export function momentThreadOf(comments, personaId, {
  rounds = FRIEND.momentRounds, perChar = FRIEND.momentThreadChars,
} = {}) {
  const list = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && c.text && (c.by === 'me' || c.by === personaId));
  if (!list.length) return '';
  // 从"倒数第 rounds 次玩家发言"开始取；玩家还没开口就从头取
  const starts = [];
  list.forEach((c, i) => { if (c.by === 'me') starts.push(i); });
  const from = starts.length > rounds ? starts[starts.length - rounds] : 0;
  return list.slice(from).map((c) => {
    const who = c.by === 'me' ? '玩家' : '我';
    const say = String(c.text).replace(/[\r\n]+/g, ' ').trim().slice(0, perChar);
    return `${who}「${say}」`;
  }).join('');
}

/**
 * 写一条「友圈」记忆：玩家在友圈发了什么 + 我在下面评论了什么 +
 * **评论区里我和他最后 3 轮对话**（用户拍板）。
 *
 * 三条要求：
 *   1. AI 评论友圈时要用**说说内容 + 相关记忆 + 基本信息**当提示词；
 *   2. 它评论过的**最新 2 条友圈**要额外进记忆（和对局一样，**不占常规记忆**）；
 *   3. 记忆里要带上**评论区最后 3 轮对话**（不只记那条评论）。
 *
 * 同一条说说被评论多次（玩家回复 → 它又回）时**只保留最新那条**，不会越堆越多：
 * 用说说开头的指纹定位旧行，就地替换。
 *
 * 格式：`友圈：[9/21 14:30] 说说「今天天气不错」｜我评论：带我一个｜对话：玩家「下次一起」我「好呀」`
 */
export function addMomentMemory(save, personaId, {
  text = '', comment = '', comments = [], at = Date.now(),
} = {}) {
  const say = String(text || '').trim().replace(/[\r\n]+/g, ' ').slice(0, FRIEND.momentEchoChars);
  const my = String(comment || '').trim().replace(/[\r\n]+/g, ' ').slice(0, FRIEND.momentEchoChars);
  const thread = momentThreadOf(comments, personaId);
  if (!say && !my && !thread) return { added: false };
  const parts = [];
  if (say) parts.push(`说说「${say}」`);
  if (my) parts.push(`我评论：${my}`);
  if (thread) parts.push(`对话：${thread}`);
  const head = `友圈：[${stampOf(at)}]`;
  const line = parts.length ? `${head} ${parts.join('｜')}` : head;
  const f = findFriend(save, personaId);
  if (!f) return { added: false };
  // 同一条说说：把旧行就地换成最新的（≤2 条的上限由 addMemory 的 keep 管）
  const fp = say.slice(0, FRIEND.momentEchoChars);
  const i = (f.memory || []).findIndex((m) => isMomentMemory(m) && (!fp || String(m).includes(fp)));
  if (i >= 0) {
    const cat = categoryOf(line) || {};
    f.memory[i] = line.slice(0, cat.limit || FRIEND.maxMatchChars);
    return { added: true, updated: true, memory: f.memory[i] };
  }
  return { ...(addMemory(save, personaId, line) || { added: false }), memory: line };
}

/** 这位好友记着的友圈记忆（新→旧） */
export const listMomentMemory = (friend) => ((friend && friend.memory) || []).filter(isMomentMemory);

/* ---------------- 改名记忆（AI 在聊天里改了名字） ---------------- */

/**
 * 把改名记录写进记忆：`改名：旧名→新名`（多次改名 → `旧名→新名，又改名更新的名`）。
 *
 * 这个分类是 unique，所以**永远是同一条**在更新（旧行就地替换，位置不变），
 * 不会因为改了几次名就堆出好几条；也不占常规的 16 条。
 * @returns {{added:boolean, memory?:string}}
 */
export function addRenameMemory(save, personaId, line) {
  const f = findFriend(save, personaId);
  const text = String(line || '').trim();
  if (!f || !text) return { added: false };
  const i = (f.memory || []).findIndex((m) => isRenameMemory(m));
  if (i >= 0) {
    if (f.memory[i] === text) return { added: false, duplicate: true };
    const replaced = f.memory[i];
    f.memory[i] = text.slice(0, FRIEND.maxMatchChars);
    return { added: true, updated: true, memory: f.memory[i], replaced };
  }
  return { ...(addMemory(save, personaId, text) || { added: false }), memory: text };
}

/**
 * ★ 玩家自己改名（用户拍板）：**所有好友都要知道这件事**，而且**只留最近 1 条**。
 *
 * 为什么需要：改名之后昵称确实进了提示词，但 AI 的记忆里还留着旧名字
 * （或者它以前问过"你叫什么"，记的是旧回答），于是聊天时它还会叫旧名 —— 玩家会觉得它没意识到。
 * 所以改名时给每位好友写一条 `改名：玩家把昵称从「旧」改成「新」`，
 * 并且**同一类记录只保留最新的那条**（旧的先删掉再写，不会越堆越多）。
 *
 * @returns {{updated:number, line:string}} 受影响的好友数
 */
export function syncPlayerRename(save, oldName, newName) {
  const from = String(oldName || '').trim();
  const to = String(newName || '').trim();
  if (!to || from === to) return { updated: 0, line: '' };
  const line = `改名：玩家把昵称${from ? `从「${from}」` : ''}改成了「${to}」 —— 以后要叫他「${to}」`;
  let updated = 0;
  for (const f of (save.friends || [])) {
    if (!f || f.removed) continue;
    // 先把旧的"玩家改名"记录清掉（只留最近 1 条）
    f.memory = (f.memory || []).filter((m) => !isPlayerRenameMemory(m));
    if (addMemory(save, f.personaId, line)) updated += 1;
  }
  return { updated, line };
}

/** 是不是"玩家改名"这一类记忆（系统记的，不是玩家说的话） */
export const isPlayerRenameMemory = (line) => /^改名：玩家/.test(String(line || ''));

/**
 * 礼物记忆（用户要求：赠礼之后"写入单独一条记忆，对方赠送了我哪些东西"）
 *
 * 两个方向各一条，同类**累加件数**（不越堆越多）：
 *   player 方向：`礼物：玩家送过我 🌹玫瑰花×2、💎钻石×1`
 *   ai 方向    ：`礼物：我送过玩家 🎁礼盒×1`
 *
 * @param {'player'|'ai'} direction player = 玩家送给它
 * @param {{id:string, name:string, emoji:string}} gift
 * @returns {{added:boolean, memory?:string, updated?:boolean}}
 */
export function addGiftMemory(save, personaId, direction, gift) {
  const f = findFriend(save, personaId);
  if (!f || !gift || !gift.name) return { added: false };
  const head = direction === 'ai' ? '礼物：我送过玩家' : '礼物：玩家送过我';
  const idx = (f.memory || []).findIndex((m) => isGiftMemory(m) && String(m).startsWith(head));
  const tag = `${gift.emoji || '🎁'}${gift.name}`;
  if (idx >= 0) {
    // 同类累加：`🌹玫瑰花×2` → `🌹玫瑰花×3`
    const line = String(f.memory[idx]);
    const re = new RegExp(`${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:×(\\d+))?`);
    const m = line.match(re);
    let next;
    if (m) {
      const n = (Number(m[1]) || 1) + 1;
      next = line.replace(re, `${tag}×${n}`);
    } else {
      next = `${line}、${tag}`;
    }
    next = next.slice(0, GIFT.memoryLimit);
    if (next === line) return { added: false, duplicate: true };
    f.memory[idx] = next;
    return { added: true, updated: true, memory: next };
  }
  const text = `${head} ${tag}`.slice(0, GIFT.memoryLimit);
  return { ...(addMemory(save, personaId, text) || { added: false }), memory: text };
}

/** 这条记忆是不是「礼物」 */
export const isGiftMemory = (line) => String(line || '').startsWith('礼物：');

/** 这位好友记着的礼物记忆（玩家送我的 / 我送玩家的，各一条） */
export const listGiftMemory = (friend) => ((friend && friend.memory) || []).filter(isGiftMemory);

/**
 * 排好序、并分好组的记忆（提示词各处共用同一份口径）——**分三块**（用户要求）：
 *   · player：关于玩家的（称呼 / 偏好 / 身份…）
 *   · system：系统记的（对局 / 友圈 / 改名 / 关系）—— 里面既有玩家的话也有它自己的话，
 *             混进"关于玩家"那栏会被读成"玩家说过的话"，所以单独一块
 *   · self  ：AI 自己的设定（自设）
 */
export function memoryGroups(friend) {
  const all = sortedMemory(friend);
  const self = all.filter((m) => isSelfMemory(m));
  const system = all.filter((m) => isSystemMemory(m));
  const player = all.filter((m) => !isSelfMemory(m) && !isSystemMemory(m));
  return { player, system, self, all };
}

/** 一条记忆该用哪个归属前缀（提示词里每条都标清楚，配合分块一起用） */
export const ownerTagOf = (line) => {
  if (isSelfMemory(line)) return OWNER_SELF;
  if (isSystemMemory(line)) return OWNER_SYSTEM;
  return OWNER_PLAYER;
};

/* ---------------- 自设：AI 自己在聊天里补充的设定 ---------------- */

/** 这个好友的"自设"（AI 自己的设定） */
export function listSelfMemory(friend) {
  return ((friend && friend.memory) || []).filter((m) => isSelfMemory(m));
}

/** 关于玩家的那些记忆（不含自设与关系这类"关于 AI/关系"的） */
export function listPlayerMemory(friend) {
  return ((friend && friend.memory) || []).filter((m) => !isSelfMemory(m));
}

/**
 * 写一条「自设」（AI 自己临时说的设定）
 * **按"方面"覆盖**：老家已经记过杭州，这次说了成都就换掉，绝不两条并存
 * @returns {{added:boolean, updated?:boolean, memory?:string}}
 */
export function setSelfMemory(save, personaId, aspect, value) {
  const f = findFriend(save, personaId);
  if (!f) return { added: false };
  // 方面统一过 cleanSelfAspect：模型偶尔会把「自设：作息」整个当方面返回（会拼出双层前缀）
  const a = cleanSelfAspect(aspect);
  const v = String(value || '').trim().slice(0, FRIEND.maxMemoryChars);
  if (!a || !v) return { added: false };
  const line = selfLine(a, v);
  const key = `${SELF_PREFIX}${a}=`;
  const i = f.memory.findIndex((m) => String(m).startsWith(key));
  if (i >= 0) {
    if (f.memory[i] === line) return { added: false, duplicate: true };
    const replaced = f.memory[i];
    f.memory[i] = line;
    return { added: true, updated: true, memory: line, replaced };
  }
  const res = addMemory(save, personaId, line);
  return { ...(res || { added: false }), memory: line };
}

/** 一次写一批自设：`{ 老家: '杭州', 职业: '大学生' }` */
export function setSelfMemories(save, personaId, map) {
  const out = [];
  if (!map || typeof map !== 'object') return out;
  for (const [aspect, value] of Object.entries(map)) {
    const r = setSelfMemory(save, personaId, aspect, value);
    if (r && r.added) out.push(r.memory);
  }
  return out;
}

/**
 * 按分类优先级排序（称呼最重要，放最前面，提示词里更醒目）
 * ★ 「对局」「友圈」这两类**按时间从新到旧**排：最上面那条才是"刚刚"的，
 *   免得 AI 把更早的一局当成刚打完的（用户报过：刚打完斗地主却在聊小猫钓鱼）。
 */
export function sortedMemory(friend) {
  const list = (friend && friend.memory) || [];
  return list
    .map((m, i) => ({ m, i, p: memoryPriority(m), recent: isMatchMemory(m) || isMomentMemory(m) }))
    .sort((a, b) => (a.p - b.p) || (a.recent && b.recent ? b.i - a.i : a.i - b.i))
    .map((x) => x.m);
}

/** 未读消息：好友主动搭话时 +1，打开他的聊天窗口时清零 */
export function bumpUnread(save, personaId, n = 1) {
  const f = findFriend(save, personaId);
  if (!f) return 0;
  f.unread = (f.unread || 0) + n;
  return f.unread;
}

export function clearUnread(save, personaId) {
  const f = findFriend(save, personaId);
  if (f && f.unread) { f.unread = 0; return true; }
  return false;
}

export function unreadTotal(save) {
  return ensureFriends(save).reduce((sum, f) => sum + (f.unread || 0), 0);
}

/**
 * 好感度 → 关系描述（给提示词和界面用）；成了恋人就直接显示「恋人」
 *
 * 用户拍板的档位（**左闭右开**，共 5 档）：
 *   0~20 陌生 · 20~40 点头之交 · 40~60 朋友 · 60~80 密友 · 80~100 挚友
 * 默认好感度是 **0（陌生）**，一起打牌、聊天才慢慢涨上来。
 */
export const AFFINITY_TIERS = [
  { key: 'stranger', min: 80, label: '挚友', color: '#FF7BAC' },
  { key: 'close', min: 60, label: '密友', color: '#FFD166' },
  { key: 'friend', min: 40, label: '朋友', color: '#4CD964' },
  { key: 'nod', min: 20, label: '点头之交', color: '#6FD6FF' },
  { key: 'strange', min: 0, label: '陌生', color: '#9aa4b2' },
];

export function affinityTier(affinity, isLover = false) {
  if (isLover) return { key: 'lover', label: '恋人', color: '#FF5C8A' };
  const n = Number(affinity);
  const v = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  return AFFINITY_TIERS.find((t) => v >= t.min) || AFFINITY_TIERS[AFFINITY_TIERS.length - 1];
}

/**
 * 自我披露的门槛（用户拍板，两轮改下来的最终口径）
 *
 *   · 好感 **< 20（陌生）**：不主动说自己的私事；但他直接问，**简短答一句也行** ——
 *     **别编假话、也别装神秘**（"极力回避"看起来比回答更奇怪）
 *   · 好感 **20~40（点头之交）**：问到家乡、在哪儿生活，可以正常说，**不用躲**
 *   · 好感 **≥ 40（朋友 / 密友 / 挚友 / 恋人）**：★ **不用刻意回避** ——
 *     他问姓什么、哪里人、做什么，就自然回答；但**不主动提**（别自己凑上去讲）
 *   · 好感 **≥ 60（密友以上）**：上面这些之外，**偶尔**可以主动讲一点自己的经历 / 小秘密
 *
 * 为什么单独强调"不用刻意回避"：以前 40~60 这一档**没有分支**，掉进了最后那句
 * "你们还很陌生：不要主动说自己的私事"，于是关系都到朋友了，AI 还在拼命绕开
 * "你姓什么""你是哪里人"（用户报的 bug）。
 *
 * 返回一句话插进提示词；私聊、牌桌、群聊、房间弹幕、友圈共用这一份，口径一致。
 */
export function selfDisclosureLine(friend, { isLover = false } = {}) {
  const tier = affinityTier(friend && friend.affinity, isLover);
  // 恋人 / 挚友（80+）：最放开
  if (tier.key === 'lover' || tier.key === 'stranger') {
    return '关系已经很近了：他问什么都可以正常答（姓什么、哪里人、做什么、以前的事都行），'
      + '偶尔也可以主动分享一点；但别一次倒完、别反复讲同一件事。';
  }
  // 密友（60~80）
  if (tier.key === 'close') {
    return '关系到了「密友」：他问起你的事就正常答（姓什么、哪里人、在忙什么都可以说），'
      + '**偶尔**也可以主动讲一点自己的经历或小秘密（别每次都说、别一次说太多，更不用炫耀）。';
  }
  /**
   * ★ 朋友（40~60）：用户拍板 —— **不用刻意回避，也不主动提**
   * （这一档以前没有分支，掉到"你们还很陌生…别说私事"去了，见上面的说明）
   */
  if (tier.key === 'friend') {
    return '关系到了「朋友」：**不用刻意回避自己的事** —— 他问起姓什么、哪里人、做什么，'
      + '就自然回答（躲躲闪闪反而奇怪）；但**你不主动提**，别自己凑上去讲这些。';
  }
  // 点头之交（20~40）
  if (tier.key === 'nod') {
    return '关系到了「点头之交」：他问到家乡、在哪儿生活，可以正常说，**不用躲**；'
      + '但经历、私事、秘密先不提，也别主动说。';
  }
  // 陌生（<20）
  return '你们还不熟：**不主动说自己的私事**（老家、经历、秘密先别提）；'
    + '他要是直接问，就简短答一句，或者说"还没到聊这个的时候"也行 —— **别编假话、也别装神秘**。';
}

/* ---------------- 记忆归属修复（老存档里可能记串了） ---------------- */

/**
 * 把"记到玩家名下、其实是 AI 自己说的"那些记忆搬到自设里。
 *
 * 判断依据：拿聊天记录当证据 —— 这条信息只在 **AI 说过的话**里出现、玩家从没说过，
 * 那它就该是 AI 自己的设定（例如 `身份：山东临沂人` 其实是它在说自己）。
 * 只在"证据充分"时才搬（一边出现过、另一边完全没出现），避免误伤。
 *
 * @returns {number} 修好了几条
 */
export function repairMemoryOwnership(friend) {
  if (!friend || !Array.isArray(friend.memory) || !Array.isArray(friend.chat)) return 0;
  const aiSaid = friend.chat.filter((m) => m && m.role === 'ai').map((m) => String(m.text || '')).join('\n');
  const meSaid = friend.chat.filter((m) => m && m.role === 'me').map((m) => String(m.text || '')).join('\n');
  if (!aiSaid) return 0;

  let fixed = 0;
  for (let i = friend.memory.length - 1; i >= 0; i -= 1) {
    const line = String(friend.memory[i] || '');
    if (isSelfMemory(line)) continue; // 已经是自设，不用管
    const cat = categoryOf(line);
    if (!cat || ['match', 'rel', 'moment', 'rename'].includes(cat.key)) continue; // 系统写的别动
    const value = line.slice(cat.label.length + 1).trim(); // 「身份：山东临沂人」→「山东临沂人」
    if (value.length < 2) continue;
    const key = value.slice(0, 6); // 有辨识度的一截
    const inAi = aiSaid.includes(value) || (key.length >= 2 && aiSaid.includes(key));
    const inMe = meSaid.includes(value) || (key.length >= 2 && meSaid.includes(key));
    /**
     * ★ 第二种证据：这条里出现第一人称「我」，但**玩家从头到尾没用过"我"说这件事**
     *（用户报的那类：`习惯：玩家拉我打游戏时用哈哈哈` 其实是 AI 自己的说话习惯）。
     * 只在"AI 说过、玩家没说"时才搬，绝不硬猜。
     */
    let selfish = false;
    if (!inMe && looksLikeSelfFact(value)) {
      // 取 4~8 字的片段，看它是不是只出现在 AI 的话里
      for (let n = Math.min(8, value.length); n >= 4 && !selfish; n -= 1) {
        for (let s = 0; s + n <= value.length; s += 1) {
          const frag = value.slice(s, s + n);
          if (/^[，。、；：\s]+$/.test(frag) || frag.includes('我')) continue;
          if (aiSaid.includes(frag) && !meSaid.includes(frag)) { selfish = true; break; }
        }
      }
    }
    if (inAi && !inMe) {
      friend.memory.splice(i, 1);
      setSelfMemory({ friends: [friend] }, friend.personaId, cat.label, value);
      fixed += 1;
    } else if (selfish) {
      friend.memory.splice(i, 1);
      setSelfMemory({ friends: [friend] }, friend.personaId, cat.label, value);
      fixed += 1;
    }
  }
  return fixed;
}

/**
 * ★ 把"其实在说玩家"的假自设清理掉（用户报的 bug）
 *
 * 玩家昵称叫「汽水偶像」时，模型会写出 `自设：称呼对方=管对方叫汽水偶像`，
 * 读起来像"它自己叫汽水偶像"。这种自设要**删掉**，如果抠得出称呼，
 * 就转成玩家名下的 `称呼：X`（本来就是这个意思）。
 *
 * @returns {number} 清掉几条
 */
export function repairFakeSelf(friend, playerName = '') {
  if (!friend || !Array.isArray(friend.memory)) return 0;
  let fixed = 0;
  for (let i = friend.memory.length - 1; i >= 0; i -= 1) {
    const line = String(friend.memory[i] || '');
    if (!isSelfMemory(line)) continue;
    const aspect = selfAspectOf(line);
    const value = selfValueOf(line);
    const { hit, name } = selfAboutPlayer(aspect, value, playerName);
    if (!hit) continue;
    friend.memory.splice(i, 1);
    fixed += 1;
    // 抠得出称呼 → 补一条「称呼：X」（"你该怎么叫他"本来就是玩家的事）
    if (name && !friend.memory.some((m) => String(m).startsWith('称呼：'))) {
      addMemory({ friends: [friend] }, friend.personaId, `称呼：${name}`);
    }
  }
  return fixed;
}

/**
 * ★ 修掉双层前缀的自设（用户存档里真出现过：`自设：自设：作息=夜深了会劝人早点歇着`）
 * 原因：模型把「自设：作息」整个当成"方面"返回了。这里还原成 `自设：作息=…`，
 * 同一个方面出现多条时只留最新那条（和 setSelfMemory 的覆盖规则一致）。
 * @returns {number} 修了几条
 */
export function repairSelfPrefix(friend) {
  if (!friend || !Array.isArray(friend.memory)) return 0;
  let fixed = 0;
  const seen = new Map();
  const out = [];
  for (const raw of friend.memory) {
    let line = String(raw || '');
    if (/^自设：(?:自设[：:])+/.test(line)) {
      line = line.replace(/^自设：(?:自设[：:])+/, '自设：');
      fixed += 1;
    }
    // 同一个方面只留最新一条（倒着走更直观：这里用 map 记最后出现的下标）
    if (isSelfMemory(line)) {
      const aspect = selfAspectOf(line);
      if (aspect) {
        if (seen.has(aspect)) out[seen.get(aspect)] = null; // 丢掉旧的那条
        seen.set(aspect, out.length);
      }
    }
    out.push(line);
  }
  const cleaned = out.filter((x) => x !== null);
  if (cleaned.length !== friend.memory.length) fixed += friend.memory.length - cleaned.length;
  friend.memory = cleaned;
  return fixed;
}

/** 把所有好友的记忆收拾一遍（老存档迁移 / 进游戏时顺手跑一次） */
export function ensureOwnership(save) {
  const playerName = (save && save.nickname) || '';
  let n = 0;
  for (const f of ensureFriends(save)) {
    n += repairMemoryOwnership(f);
    n += repairMatchWording(f);
    n += repairFakeSelf(f, playerName);
    n += repairSelfPrefix(f);
  }
  // 最近几局的概括也要一起修（AI 还会用它回忆"上次那局"）
  if (Array.isArray(save && save.recentHands)) {
    for (const h of save.recentHands) {
      if (!h || typeof h.summary !== 'string') continue;
      const fixed = neutralizeSummary(h.summary);
      if (fixed !== h.summary) { h.summary = fixed; n += 1; }
    }
  }
  return n;
}

/**
 * 老存档里「对局：」那段概括是用"你"写的（"你最后输了…"），
 * 存进 AI 记忆后"你"就变成了它自己 —— 于是它以为输的是它（用户报的 bug）。
 * 这里统一把第二人称换成"玩家"，谁输谁赢就认不错了。
 * @returns {number} 修了几条
 */
export function repairMatchWording(friend) {
  if (!friend || !Array.isArray(friend.memory)) return 0;
  let fixed = 0;
  friend.memory = friend.memory.map((m) => {
    const line = String(m || '');
    if (!line.startsWith('对局：')) return line;
    const out = neutralizeSummary(line);
    if (out !== line) fixed += 1;
    return out;
  });
  return fixed;
}

/* ---------------- 记忆超过上限 → 合并（AI 为主，本地兜底） ---------------- */

/** 这个好友的记忆是不是"超了、等着合并" */
export const memoryNeedsCompress = (friend) => !!(friend && friend.memoryNeedCompress);

/** 所有等着合并的好友（启动时扫一遍用） */
export function listFriendsNeedingCompress(save) {
  return ensureFriends(save).filter((f) => memoryNeedsCompress(f));
}

/**
 * 把合并结果写回去（AI 合并 / 本地合并共用）
 * @param {object} friend
 * @param {string[]} lines 合并后的记忆
 * @returns {{before:number, after:number}|null}
 */
export function applyCompressedMemory(friend, lines) {
  if (!friend || !Array.isArray(lines) || !lines.length) return null;
  const before = (friend.memory || []).length;
  // 上限要**加上额外记忆**（对局/友圈不占常规条数），否则压缩会把它们挤掉
  const cap = (FRIEND.maxMemoryHardCap || FRIEND.maxMemory) + extraMemoryCount(friend);
  friend.memory = lines
    .map((m) => String(m || '').trim().slice(0, FRIEND.maxMatchChars))
    .filter(Boolean)
    .slice(0, cap)
    // 兜一层：压缩结果里丢了「对局」「友圈」就原样补回来（系统记忆不许被模型吞掉）
    .concat((friend.memory || []).filter((m) => isExtraMemory(m) && !lines.includes(m)));
  friend.memory = [...new Set(friend.memory)].slice(0, cap);
  friend.memoryNeedCompress = false;
  friend.memoryMergedAt = Date.now();
  return { before, after: friend.memory.length };
}

/**
 * 本地合并（不联网 / AI 失败时的兜底）：把同分类的并成一条
 * @returns {{before:number, after:number}|null}
 */
export function compressMemoryLocally(save, personaId) {
  const f = findFriend(save, personaId);
  if (!f || !Array.isArray(f.memory)) return null;
  const merged = mergeMemoryLocally(f.memory, {
    maxChars: FRIEND.maxMemoryChars,
    maxLines: FRIEND.maxMemory + extraMemoryCount(f),
  });
  if (merged.length >= f.memory.length) {
    // 一条都合不动（每个分类都只有一条）→ 直接照硬上限裁，避免卡在"等合并"状态
    f.memoryNeedCompress = false;
    return { before: f.memory.length, after: f.memory.length };
  }
  return applyCompressedMemory(f, merged);
}

/** 删除好友时顺手清掉恋人关系（唯一的恋人不能指向一个已经删掉的人） */
export function clearLoverIf(save, personaId) {
  if (save && save.loverId === personaId) save.loverId = '';
}

/** 这个人是不是玩家的恋人 */
export function isLover(save, personaId) {
  return !!save && !!save.loverId && save.loverId === personaId;
}

/** 玩家当前的恋人（好友记录；没有就是 null） */
export function loverFriend(save) {
  return save && save.loverId ? findFriend(save, save.loverId) : null;
}

/**
 * 确立恋人关系
 * 边界（用户拍板）：**全局只能有 1 个**，已经有了就不换人
 */
export function setLover(save, personaId) {
  const f = findFriend(save, personaId);
  if (!f) return { ok: false, error: '还不是好友' };
  if (save.loverId && save.loverId !== personaId) return { ok: false, error: '已经有恋人了' };
  save.loverId = personaId;
  f.refusedAt = 0; // 他这次答应了 → 清掉"拒绝过"的冷却
  return { ok: true };
}

/** 分手：清掉恋人关系，好感度落到「朋友」 */
export function breakUp(save, personaId) {
  if (!isLover(save, personaId)) return { ok: false, error: '你们还不是恋人' };
  const f = findFriend(save, personaId);
  save.loverId = '';
  if (f) f.affinity = Math.min(f.affinity, FRIEND.breakupAffinity);
  return { ok: true, affinity: f ? f.affinity : 0 };
}

/** 带上"是不是恋人"的关系描述（界面与提示词都用这个） */
export function tierOf(save, friend) {
  return affinityTier(friend ? friend.affinity : 0, isLover(save, friend && friend.personaId));
}

/**
 * 现在要不要去审查"玩家是不是在表白"
 * 三个条件都满足才查：好感度满、还没有恋人、而且还是好友
 *
 * ★ 不需要额外的时间冷却（用户拍板）：被拒会**扣 10 好感**，
 *   好感退回 90 就不再触发审查 —— "想再表白就重新刷满 100"，这就够了。
 */
export function canConfess(save, friend) {
  if (!friend) return false;
  if (save.loverId) return false; // 已经有恋人了 → 不触发表白审查
  return friend.affinity >= FRIEND.loverAffinity;
}

/**
 * 拒绝表白（用户拍板：**好感 -10**，并在记忆里留一笔）
 *
 * 扣完好感就不再是"满 100"，想再表白得重新刷满 —— 玩家能感受到"被拒绝是有代价的"，
 * 也因此不需要额外的时间冷却来防重复审查。
 *
 * @returns {{ok:boolean, penalty:number, affinity:number, memory?:string}}
 */
export function refuseConfess(save, personaId, at = Date.now()) {
  const f = findFriend(save, personaId);
  if (!f) return { ok: false, penalty: 0, affinity: 0 };
  const penalty = FRIEND.confessRefusePenalty || 0;
  f.refusedAt = at;
  f.refusedCount = (Number(f.refusedCount) || 0) + 1;
  const before = Number(f.affinity) || 0;
  f.affinity = Math.max(0, before - penalty);
  const line = '关系：玩家表白过，我婉拒了（还是好朋友）';
  addMemory(save, personaId, line);
  return { ok: true, penalty, affinity: f.affinity, memory: line };
}

/** 现在要不要去审查"玩家是不是在提分手"（只有已经是恋人时才查） */
export function canBreakup(save, friend) {
  return !!(friend && isLover(save, friend.personaId));
}

/**
 * 把好友的 memory 整理成提示词里的文字 —— **分三块**（用户要求）：
 *
 *   【关于玩家】
 *   - 【关于玩家】称呼：小徐
 *   【你自己的设定】
 *   - 【你自己】自设：老家=杭州
 *   【系统记录】（对局 / 友圈 / 改名 / 关系 —— 不是"玩家说过的话"）
 *   - 【系统记录】友圈：说说「…」｜我评论：…
 *
 * 为什么分块：以前平铺一列，`友圈：…我评论…` 这种混合行会被读成"玩家说过的话"，
 * `自设：午饭=泡面` 也容易和玩家的「偏好」混成一锅（用户报的"还是没法区分"）。
 * 每条前面还保留归属前缀，双保险。
 */
export function memoryText(friend) {
  const grp = memoryGroups(friend);
  if (!grp.all.length) return '（还没有特别的记忆）';
  const blocks = [];
  if (grp.player.length) blocks.push(ownedLines(grp.player, OWNER_PLAYER).join('\n'));
  if (grp.self.length) blocks.push(ownedLines(grp.self, OWNER_SELF).join('\n'));
  if (grp.system.length) blocks.push(ownedLines(grp.system, OWNER_SYSTEM).join('\n'));
  return blocks.join('\n');
}

/* ---------------- 和玩家的关系（任何"AI 要开口"的地方都用这一份） ---------------- */

/** 玩家让这个 AI 怎么称呼他（memory 里的「称呼：X」）；没有就返回空串 */
export function callNameOf(friend) {
  const line = ((friend && friend.memory) || []).find((m) => /^称呼[：:]/.test(String(m)));
  return line ? String(line).replace(/^称呼[：:]\s*/, '').trim() : '';
}

/**
 * 给提示词用的"你和玩家是什么关系"那几行
 *
 * 私聊、房间弹幕、牌桌台词、小猫钓鱼**全都用这一份**，
 * 所以 AI 在任何场合都知道：好感度多少、什么关系、平时怎么称呼他、记得他什么事。
 * @param {object} save
 * @param {object} friend 好友记录（不是好友就传 null，返回空数组）
 * @param {{table?:boolean}} [opts] table = 牌桌上用，话少一点
 */
export function friendContextLines(save, friend, opts = {}) {
  if (!friend) return [];
  const personaId = friend.personaId;
  const tier = tierOf(save, friend);
  const name = (save && save.nickname) || '玩家';
  const out = [`你和玩家（${name}）的关系：${tier.label}（好感度 ${friend.affinity}/100）`];
  const call = callNameOf(friend);
  if (call) out.push(`你平时叫他「${call}」，可以直接用这个称呼。`);
  // ★ 分三块：关于玩家的 / 你自己的设定 / 系统记录（对局·友圈·改名·关系）
  const grp = memoryGroups(friend);
  const his = grp.player.filter((m) => !/^称呼[：:]/.test(String(m)));
  // ★ 每条都标清楚归属，免得和"你自己的设定"混起来
  if (his.length) out.push(`你记得**关于他**的事：\n${ownedLines(his, OWNER_PLAYER).join('\n')}`);
  const mine = grp.self;
  if (mine.length) out.push(`**你自己**说过的设定（不能前后矛盾）：\n${ownedLines(mine, OWNER_SELF).join('\n')}`);
  if (grp.system.length) {
    out.push('【系统记录】你经历过的（对局 / 友圈 / 改名 / 关系）——'
      + '**这些不是"玩家说过的话"**，是系统替你记的事件：\n'
      + ownedLines(grp.system, OWNER_SYSTEM).join('\n'));
  }
  if (grp.system.some((m) => isMatchMemory(m))) {
    out.push('（对局记忆按时间从新到旧，带 [月/日 时:分]；只有最上面那条才是"刚刚那局"。）');
  }
  if (grp.system.some((m) => isMomentMemory(m))) {
    out.push('（「友圈：」= 玩家发的说说 + 你在下面评论过什么 + 评论区里你和他最后几轮对话，'
      + '按时间从新到旧，只留最近 2 条。）');
  }
  // 玩家是谁：告知昵称即可
  if (save && save.nickname) out.push(`玩家的昵称是「${save.nickname}」。`);
  // ★ 关系到了哪一档，决定能说多少自己的事（点头之交可以说家乡、密友才偶尔讲经历）
  out.push(selfDisclosureLine(friend, { isLover: tier.key === 'lover' }));

  // 按关系给"该怎么说话"的尺度 —— 这就是"以此发言"
  // 档位和 affinityTier 一一对应：0~20 陌生 / 20~40 点头之交 / 40~60 朋友 / 60~80 密友 / 80~100 挚友
  if (tier.key === 'lover') {
    out.push('**你们是恋人** —— 语气可以亲近、可以护着他，但别腻、也别每句都提关系。');
  } else if (tier.key === 'stranger') {
    out.push('你们是**挚友**，关系很铁：说话随便些，开玩笑、损他两句都行。');
  } else if (tier.key === 'close') {
    out.push('你们是**密友**，关系很好：说话自然、可以多聊两句。');
  } else if (tier.key === 'friend') {
    out.push('你们算聊得来的**朋友**，礼貌但不用太客气。');
  } else if (tier.key === 'nod') {
    out.push('你们只是**点头之交**，别太热络、别自来熟。');
  } else {
    out.push('你们还**很陌生**（基本没聊过），说话客气一点、别主动套近乎。');
  }
  if (!opts.table) out.push('（好感度是背景知识，**不要报出数值**，也别拿它当话题。）');
  else out.push('（这些只是背景知识：**不要报好感度、不要提关系与称呼的来历**，只是让口气对得上。）');
  return out;
}
