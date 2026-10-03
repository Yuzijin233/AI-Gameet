/**
 * 礼物系统（store 层）
 *
 * 两个方向，各自一条每日上限（用户拍板：每天每人最多 3 次）：
 *   · **玩家 → 好友**：在好友界面点「🎁 赠送礼物」，礼物从**自己的道具库存**里扣，
 *     送完写一条「礼物」记忆 + 发一条赠礼消息，好友据此回应。
 *   · **AI → 玩家**：审查 AI（analyzeMessage）多判一层"这次要不要送点什么"，
 *     受**自己的身家**与**关系档位**约束（不可能强行送最贵的），
 *     送出去的东西进**玩家的库存**（牌桌上能用），并从 AI 身家里扣掉。
 *
 * 账本按天记（`save.gifts.d` 换天就清空），所以"每天 3 次"不需要额外的定时任务。
 */
import { GIFTS, GIFT, giftById } from '../config.js';
import { todayStr } from './economy.js';
import { addItems, itemCount, consumeItem } from './items.js';
import { adjustAffinity, addGiftMemory, findFriend } from './friends.js';
import { aiBeansOf, addAiBeans } from './aiBeans.js';

/** 账本：{ d: '2026-09-22', sent: {personaId: n}, aiSent: {personaId: n} } */
export function ensureGiftLedger(save, today = todayStr()) {
  if (!save.gifts || typeof save.gifts !== 'object') save.gifts = {};
  const g = save.gifts;
  if (g.d !== today) { g.d = today; g.sent = {}; g.aiSent = {}; }
  if (!g.sent || typeof g.sent !== 'object') g.sent = {};
  if (!g.aiSent || typeof g.aiSent !== 'object') g.aiSent = {};
  return g;
}

/** 今天已经给这位好友送了几次 */
export function giftsSentToday(save, personaId, today = todayStr()) {
  const g = ensureGiftLedger(save, today);
  const n = Number(g.sent[personaId]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 今天这位 AI 已经送过几次（AI → 玩家） */
export function aiGiftsToday(save, personaId, today = todayStr()) {
  const g = ensureGiftLedger(save, today);
  const n = Number(g.aiSent[personaId]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 今天还能给这位好友送几次 */
export function giftsLeftFor(save, personaId, today = todayStr()) {
  return Math.max(0, GIFT.dailyPerFriend - giftsSentToday(save, personaId, today));
}

/** 今天这个 AI 还能送几次 */
export function aiGiftsLeft(save, personaId, today = todayStr()) {
  return Math.max(0, GIFT.aiDailyMax - aiGiftsToday(save, personaId, today));
}

/**
 * 玩家赠礼。
 * @param {object} save
 * @param {object} economy 用来弹提示/记账的 Economy（这里不强依赖，可为 null）
 * @param {string} personaId
 * @param {string} giftId
 * @param {object} [opts] { today } 便于测试
 * @returns {{ok:true, gift:object, affinity:number, left:number} | {ok:false, error:string}}
 */
export function sendGiftToFriend(save, economy, personaId, giftId, opts = {}) {
  void economy;
  const gift = giftById(giftId);
  if (!gift) return { ok: false, error: '没有这个礼物' };
  const friend = findFriend(save, personaId);
  if (!friend) return { ok: false, error: '还不是好友' };
  const today = opts.today || todayStr();
  // 每日次数先判：额度用完了就说额度的事（比"没有礼物了"更贴近用户想知道的）
  if (giftsSentToday(save, personaId, today) >= GIFT.dailyPerFriend) {
    return { ok: false, error: `今天已经给「${friend.name || personaId}」送过 ${GIFT.dailyPerFriend} 次了，明天再来` };
  }
  if (itemCount(save, giftId) <= 0) {
    return { ok: false, error: `没有${gift.emoji}${gift.name}了，先去商城买` };
  }
  if (!consumeItem(save, giftId)) return { ok: false, error: '礼物不够' };
  const g = ensureGiftLedger(save, today);
  g.sent[personaId] = giftsSentToday(save, personaId, today) + 1;
  adjustAffinity(save, personaId, gift.affinity);
  addGiftMemory(save, personaId, 'player', gift);
  return { ok: true, gift, affinity: gift.affinity, left: giftsLeftFor(save, personaId, today) };
}

/**
 * AI 回赠：从它自己的身家里扣钱，东西进玩家库存。
 * @returns {{ok:true, gift:object, beans:number} | {ok:false, error:string}}
 */
export function sendGiftToPlayer(save, personaId, giftId, opts = {}) {
  const gift = giftById(giftId);
  if (!gift) return { ok: false, error: '没有这个礼物' };
  const friend = findFriend(save, personaId);
  if (!friend) return { ok: false, error: '还不是好友' };
  const today = opts.today || todayStr();
  if (aiGiftsToday(save, personaId, today) >= GIFT.aiDailyMax) {
    return { ok: false, error: '它今天已经送过了' };
  }
  const beans = aiBeansOf(save, personaId);
  if (gift.price > beans - GIFT.beanFloor || gift.price > beans * GIFT.beanRatio) {
    return { ok: false, error: '它自己也不宽裕' };
  }
  const g = ensureGiftLedger(save, today);
  g.aiSent[personaId] = aiGiftsToday(save, personaId, today) + 1;
  addAiBeans(save, personaId, -gift.price); // 送礼是它自己花的钱
  addItems(save, gift.id, 1); // 礼物进玩家库存（牌桌上能当道具用）
  addGiftMemory(save, personaId, 'ai', gift);
  return { ok: true, gift, beans: aiBeansOf(save, personaId) };
}

/**
 * AI 这次**能送**哪些礼物（给审查 AI 的选项清单）
 * 三个条件同时满足才会出现在清单里：关系够、今天还有次数、自己买得起。
 * @returns {Array<{id:string, name:string, emoji:string, price:number, affinity:number}>}
 */
export function giftOptionsForAi(save, personaId, today = todayStr()) {
  const friend = findFriend(save, personaId);
  if (!friend) return [];
  if (aiGiftsLeft(save, personaId, today) <= 0) return [];
  const beans = aiBeansOf(save, personaId);
  const budget = Math.min(beans - GIFT.beanFloor, beans * GIFT.beanRatio);
  return GIFTS.filter((g) => friend.affinity >= g.minAffinity && g.price <= budget)
    .map((g) => ({ id: g.id, name: g.name, emoji: g.emoji, price: g.price, affinity: g.affinity }));
}

/** 面板用：玩家自己每种礼物各有多少 */
export function giftStockRows(save) {
  return GIFTS.map((g) => ({ ...g, count: itemCount(save, g.id) }));
}
