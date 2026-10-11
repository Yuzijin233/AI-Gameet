/**
 * AI 身家（PRD §2.14）
 * ---------------------------------------------------------------
 * 每个 AI 都有一份**全局**身家，存在存档里，跨局、跨场次、跨模式共享：
 *   1) 初始分配：1000 ~ 2,000,000，幂律偏小（小身家的 AI 多，富豪少）
 *   2) 玩家每局**正常打完**（中途退出不算）后：
 *      - 参战的两个 AI 按本局结算增减
 *      - 其他 AI 按当前身家随机 +0~20% 或 -0~10%
 *   3) 身家低于低保线 → 每日一次补到能玩（低保）
 *   4) 身家决定 AI 戴哪个称号，也决定它能不能进对应场次
 *   5) 极端兜底：某场次一个能打的 AI 都没有时，给几个非好友 AI"输血"
 */
import { AI_ECON } from '../config.js';
import { PERSONAS } from '../data/personas.js';
import { TITLES, titleById } from '../data/titles.js';
import { todayStr } from './economy.js';

/* ------------------------------------------------------------------ */
/* 随机分布                                                            */
/* ------------------------------------------------------------------ */

/**
 * 幂律随机：[min, max] 内取值，`u^skew` 让结果明显偏向 min
 * skew=1 即均匀分布；skew=3 时约一半结果落在靠近 min 的 1/8 区间
 */
export function skewedRandom(min, max, skew = 1, rnd = Math.random) {
  const u = Math.pow(Math.max(0, Math.min(1, rnd())), skew);
  return Math.round(min + (max - min) * u);
}

/** 区间内均匀取整（含两端） */
export function uniformRandom(min, max, rnd = Math.random) {
  return Math.round(min + (max - min) * Math.max(0, Math.min(1, rnd())));
}

const clampBeans = (v) => Math.max(0, Math.min(AI_ECON.maxBeans, Math.round(v)));

/* ------------------------------------------------------------------ */
/* 存档结构                                                            */
/* ------------------------------------------------------------------ */

export function ensureAiEcon(save, rnd = Math.random) {
  if (!save.aiEcon || typeof save.aiEcon !== 'object') {
    save.aiEcon = { v: 1, beans: {}, relief: {} };
  }
  const ec = save.aiEcon;
  if (!ec.beans || typeof ec.beans !== 'object') ec.beans = {};
  if (!ec.relief || typeof ec.relief !== 'object') ec.relief = {};
  const created = [];
  for (const p of PERSONAS) {
    const v = ec.beans[p.id];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      // 初始身家：幂律偏小（1000 ~ 2,000,000）
      ec.beans[p.id] = skewedRandom(AI_ECON.minStart, AI_ECON.maxStart, AI_ECON.startSkew, rnd);
      created.push(p.id);
    } else {
      ec.beans[p.id] = clampBeans(v);
    }
  }
  return { save, created };
}

export function aiBeansOf(save, personaId) {
  const ec = ensureAiEcon(save);
  void ec;
  return save.aiEcon.beans[personaId] || 0;
}

export function setAiBeans(save, personaId, value) {
  ensureAiEcon(save);
  save.aiEcon.beans[personaId] = clampBeans(value);
  return save.aiEcon.beans[personaId];
}

export function addAiBeans(save, personaId, delta) {
  return setAiBeans(save, personaId, aiBeansOf(save, personaId) + delta);
}

/**
 * AI 按身家决定戴哪个称号（复用玩家的身家档称号）
 *
 * ★ 用户拍板（称号增补）：**一部分 AI 戴的是商城买的称号**，像真人那样买了就戴上；
 *   剩下的人仍然按身家档自动升级（老行为不变）。判定规则见下面几个纯函数 ——
 *   完全由 personaId 决定，**同一个 AI 每次进游戏看到的都是同一个称号**（刷新不会变脸）。
 */
export function aiTitleOf(save, personaId) {
  /**
   * ⓪ ★ 用户拍板：**恋人固定佩戴「神仙眷侣」**（不管身家多少、也不管是不是"商城称号党"）。
   *   称号本身还是玩家那份关系称号（t_lovers），玩家第一次有恋人时解锁的。
   */
  if (save && save.loverId && save.loverId === personaId) {
    const lovers = titleById('t_lovers');
    if (lovers) return lovers;
  }
  // ① 是"商城称号党" → 直接戴它买的那一个（身家档只是没买之前的默认）
  if (isShopTitlePersona(personaId)) {
    const t = shopTitleOf(personaId);
    if (t) return t; // 兜底：万一以后商城称号全下线了，还能落到身家档（不会返回 null）
  }
  // ② 其余人不变：按身家取当前能拿到的最高身家档
  const beans = aiBeansOf(save, personaId);
  let best = null;
  for (const t of TITLES) {
    if (t.kind !== 'beans') continue;
    if (beans >= t.beans) best = t;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 商城称号：确定性分配（同一 AI 永远是同一个称号）                     */
/* ------------------------------------------------------------------ */
/**
 * 32 位整数哈希（FNV-1a 变体）—— **纯函数、与存档无关**，
 * 所以同一个 personaId 在任何设备、任何时候都得到同一个值。
 */
function hashText(text) {
  let h = 2166136261;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0; // 保持 32 位无符号
  }
  return h >>> 0;
}

/** 商城在售的称号（kind === 'shop'，顺序就是 TITLES 里的声明顺序） */
export const SHOP_TITLES = TITLES.filter((t) => t.kind === 'shop');

/**
 * 这位是不是"商城称号党"？
 * 规则：`hash(注入固定种子的 id) % SHOP_TITLE_EVERY === 0`
 *   —— 每隔 SHOP_TITLE_EVERY 位挑一个（按哈希散开，不是简单的 p01/p11/…）
 *   —— 只有**存在商城称号**时才会有商城称号党（商城一个都没有 → 全员按身家档）
 */
export const SHOP_TITLE_SEED = 'ai-title-shop:';
export const SHOP_TITLE_EVERY = 3;

export function isShopTitlePersona(personaId) {
  if (!SHOP_TITLES.length) return false;
  if (!personaId) return false;
  return hashText(SHOP_TITLE_SEED + personaId) % SHOP_TITLE_EVERY === 0;
}

/**
 * 这位"买"的是哪一个商城称号（不是商城称号党 → null）
 * 按 id 哈希在商城列表里取一个：`floor(hash / 2^32 * 长度)`。
 *
 * ★ 这里**必须再掺一次 id 本身**（`pick:<id>|<id>`）：FNV 对 `p01 / p03 / p09` 这类
 *   只差一两个字符的短串，直接 `hash % 长度` 会**全都落到同一个桶**（实测过：
 *   10 个商城称号党会全戴最便宜那个「牌桌萌新」）—— 掺一遍 id 就散开了。
 */
export function shopTitleOf(personaId) {
  if (!isShopTitlePersona(personaId)) return null;
  const h = hashText(`${SHOP_TITLE_SEED}pick:${personaId}|${personaId}`);
  return SHOP_TITLES[Math.floor((h / 4294967296) * SHOP_TITLES.length)] || null;
}

/* ------------------------------------------------------------------ */
/* 抽对手 / 极端兜底                                                    */
/* ------------------------------------------------------------------ */

/** 身家达到该场次门槛的 AI */
export function eligiblePersonas(save, room) {
  return PERSONAS.filter((p) => aiBeansOf(save, p.id) >= room.minBeans);
}

/**
 * 极端兜底：如果一个能打的 AI 都没有，就随机挑非好友的 AI 输血
 * （3 个改成 10,000~100,000 能打中级场；3 个改成 100,000~2,000,000 能打高级场）
 * @returns {{rescued:Array, mid:Array, high:Array}}
 */
export function rescueAiIfNeeded(save, room, rnd = Math.random) {
  if (eligiblePersonas(save, room).length > 0) {
    return { rescued: false, mid: [], high: [] };
  }
  const friendIds = new Set((save.friends || []).map((f) => f.personaId));
  const pool = PERSONAS.filter((p) => !friendIds.has(p.id));
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const mid = pool.slice(0, AI_ECON.rescueMidCount);
  const high = pool.slice(AI_ECON.rescueMidCount, AI_ECON.rescueMidCount + AI_ECON.rescueHighCount);
  for (const p of mid) {
    setAiBeans(save, p.id, uniformRandom(AI_ECON.rescueMidMin, AI_ECON.rescueMidMax, rnd));
  }
  for (const p of high) {
    setAiBeans(save, p.id, uniformRandom(AI_ECON.rescueHighMin, AI_ECON.rescueHighMax, rnd));
  }
  return { rescued: true, mid, high, room: room.id };
}

/**
 * 抽 count 个能打的 AI（不重复）；抽不到就先兜底再抽
 * @returns {{picks:Array, rescued:boolean}}
 */
export function pickEligiblePersonas(save, room, count = 2, rnd = Math.random) {
  const { rescued } = rescueAiIfNeeded(save, room, rnd);
  let pool = eligiblePersonas(save, room);
  if (pool.length < count) {
    // 兜底之后还是不够（例如场次门槛高于输血上限）：退化为"最富的几个"
    pool = [...PERSONAS].sort((a, b) => aiBeansOf(save, b.id) - aiBeansOf(save, a.id));
  }
  const picks = [];
  const rest = [...pool];
  while (picks.length < count && rest.length) {
    const i = Math.floor(rnd() * rest.length);
    picks.push(rest.splice(i, 1)[0]);
  }
  return { picks, rescued };
}

/** 房间模式：手动邀请的 AI 身家不够门槛时补足到门槛（保证这局公平，不会"对方付不出"） */
export function topUpForRoom(save, personaId, room) {
  const have = aiBeansOf(save, personaId);
  if (have >= room.minBeans) return { topped: false, beans: have };
  setAiBeans(save, personaId, room.minBeans);
  return { topped: true, beans: room.minBeans, from: have };
}

/* ------------------------------------------------------------------ */
/* 每局结束后的身家变化                                                */
/* ------------------------------------------------------------------ */

/**
 * 参战 AI 结算：deltas 按座位，seatIds 是座位 → personaId（座位 0 是玩家，跳过）
 */
export function applyAiSettlement(save, seatIds, deltas) {
  const changes = [];
  for (let seat = 1; seat < deltas.length; seat += 1) {
    const id = seatIds[seat];
    if (!id) continue;
    const before = aiBeansOf(save, id);
    const after = setAiBeans(save, id, before + deltas[seat]);
    changes.push({ id, before, after, delta: after - before });
  }
  return changes;
}

/**
 * 没参战的 AI：按当前身家随机涨 0~20% 或跌 0~10%（PRD §2.14）
 * @returns {Array<{id, before, after, delta, up:boolean}>}
 */
export function pulseIdleAi(save, participantIds, rnd = Math.random) {
  ensureAiEcon(save);
  const skip = new Set(participantIds.filter(Boolean));
  const changes = [];
  for (const p of PERSONAS) {
    if (skip.has(p.id)) continue;
    const before = aiBeansOf(save, p.id);
    if (before <= 0) continue;
    const up = rnd() < AI_ECON.idleGainChance;
    const rate = up
      ? AI_ECON.idleGainRate * rnd()
      : AI_ECON.idleLoseRate * rnd();
    const delta = Math.round(before * rate) * (up ? 1 : -1);
    if (!delta) continue;
    const after = setAiBeans(save, p.id, before + delta);
    changes.push({ id: p.id, before, after, delta: after - before, up });
  }
  return changes;
}

/**
 * 低保：身家低于阈值且今天没领过的 AI，补一笔（每个 AI 每日一次）
 * @returns {Array<{id, before, after, amount}>}
 */
export function grantAiRelief(save, today = todayStr(), rnd = Math.random) {
  void rnd;
  ensureAiEcon(save);
  const got = [];
  for (const p of PERSONAS) {
    const before = aiBeansOf(save, p.id);
    if (before >= AI_ECON.reliefThreshold) continue;
    if (save.aiEcon.relief[p.id] === today) continue;
    save.aiEcon.relief[p.id] = today;
    const after = setAiBeans(save, p.id, before + AI_ECON.reliefBeans);
    got.push({ id: p.id, before, after, amount: after - before });
  }
  return got;
}

/** 面板/调试用摘要 */
export function aiEconSummary(save) {
  ensureAiEcon(save);
  const rows = PERSONAS.map((p) => ({
    id: p.id,
    name: p.name,
    beans: aiBeansOf(save, p.id),
    title: aiTitleOf(save, p.id),
  }));
  const total = rows.reduce((s, r) => s + r.beans, 0);
  return {
    rows,
    total,
    avg: Math.round(total / (rows.length || 1)),
    max: rows.reduce((a, b) => (a.beans >= b.beans ? a : b)),
    min: rows.reduce((a, b) => (a.beans <= b.beans ? a : b)),
  };
}
