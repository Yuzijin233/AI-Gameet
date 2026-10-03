/**
 * 活动中心状态（PRD §2.16）：免费礼包 / 首充 / 每日限时礼包 / 累计充值 / 限时折扣 / 大转盘
 *
 * 所有"充值"都是**模拟支付**（和商城买豆子同一套仪式），不接真实支付。
 * 累计充值看的是 `save.wallet.totalYuan` —— 商城买豆子与限时礼包都会累加进去。
 */
import {
  FREE_DAILY, FREE_WEEKLY, FIRST_PAY, PAY_TIERS, DAILY_PACKS, WHEEL,
  dayKey, weekKey, dailyPackOf, dailyPacksOf, discountOf, discountPrice, discountMaxBuys,
  spinPrize, jackpotChance,
} from '../data/activities.js';
import { pushMail, applyRewards } from './rewards.js';
import { ensureCosmetics, ownsFrame } from './cosmetics.js';
import { ensureTitleState } from './titles.js';

/** 礼包价格：`type` = 'daily' | 'weekly' | 'first' | 'pack' | 'tier' */
const PACK_MAIL_FROM = '活动中心';

export function ensureActivity(save) {
  if (!save.activity || typeof save.activity !== 'object') save.activity = {};
  const a = save.activity;
  if (typeof a.daily !== 'string') a.daily = '';
  if (typeof a.weekly !== 'string') a.weekly = '';
  if (typeof a.firstPay !== 'boolean') a.firstPay = false;
  if (typeof a.packDate !== 'string') a.packDate = '';
  // 今日限时礼包每天两款：记的是"今天买过哪几个 id"
  if (!Array.isArray(a.packsBought)) a.packsBought = [];
  a.packsBought = a.packsBought.filter((id) => typeof id === 'string');
  if (!Array.isArray(a.tiers)) a.tiers = [];
  if (typeof a.discountDate !== 'string') a.discountDate = '';
  // 折扣是"今天买了几次"（道具类可以买 5 次，见 DISCOUNT_ITEM_BUYS）
  if (!Number.isFinite(a.discountCount) || a.discountCount < 0) a.discountCount = 0;
  if (!Number.isFinite(a.spins) || a.spins < 0) a.spins = 0;
  if (!Number.isFinite(a.bestWin) || a.bestWin < 0) a.bestWin = 0;
  if (!save.wallet || typeof save.wallet !== 'object') save.wallet = { totalYuan: 0, orders: [] };
  if (!Number.isFinite(save.wallet.totalYuan) || save.wallet.totalYuan < 0) save.wallet.totalYuan = 0;
  if (!Array.isArray(save.wallet.orders)) save.wallet.orders = [];
  return a;
}

/* ===================================================================== */
/*                          模拟充值记录                                  */
/* ===================================================================== */
/**
 * 记一笔模拟充值（商城买豆子、买限时礼包都会走这里）
 * @returns {object} 订单
 */
export function recordPayment(save, { price = 0, label = '', kind = 'beans' } = {}) {
  ensureActivity(save);
  const order = {
    id: `DDZ${Date.now()}${Math.floor(Math.random() * 1000)}`,
    price: Number(price) || 0,
    label,
    kind,
    at: new Date().toISOString(),
  };
  save.wallet.totalYuan += order.price;
  save.wallet.orders.unshift(order);
  if (save.wallet.orders.length > 60) save.wallet.orders.length = 60; // 只留最近 60 笔
  return order;
}

export const totalPaidYuan = (save) => {
  ensureActivity(save);
  return save.wallet.totalYuan;
};
export const hasPaid = (save) => totalPaidYuan(save) > 0;

/* ===================================================================== */
/*                          免费礼包：每日 / 每周                          */
/* ===================================================================== */
/** @param {'daily'|'weekly'} kind */
export function freeGiftState(save, kind, now = new Date()) {
  const a = ensureActivity(save);
  const gift = kind === 'weekly' ? FREE_WEEKLY : FREE_DAILY;
  const key = kind === 'weekly' ? weekKey(now) : dayKey(now);
  const claimed = kind === 'weekly' ? a.weekly === key : a.daily === key;
  return { gift, key, claimed, canClaim: !claimed };
}

/** 领免费礼包（直接到账，即时反馈） */
export function claimFreeGift(save, kind, now = new Date()) {
  const st = freeGiftState(save, kind, now);
  if (st.claimed) return { ok: false, error: kind === 'weekly' ? '这周的还没刷新，下周再来' : '今天已经领过了，明天再来' };
  const a = ensureActivity(save);
  if (kind === 'weekly') a.weekly = st.key; else a.daily = st.key;
  return { ok: true, gift: st.gift, got: applyRewards(save, st.gift.rewards) };
}

/* ===================================================================== */
/*                            首充礼包                                   */
/* ===================================================================== */
export function firstPayState(save) {
  const a = ensureActivity(save);
  return {
    gift: FIRST_PAY,
    paid: hasPaid(save),
    claimed: a.firstPay,
    canClaim: hasPaid(save) && !a.firstPay,
  };
}

/**
 * 领首充礼包：**只有它走邮箱**（真游戏都这样，仪式感在"收到一封邮件、点领取"那一刻）
 */
export function claimFirstPay(save) {
  const st = firstPayState(save);
  if (st.claimed) return { ok: false, error: '首充礼包已经领过了' };
  if (!st.paid) return { ok: false, error: '先充值任意金额（商城买任意一袋开心豆）才能领' };
  const a = ensureActivity(save);
  a.firstPay = true;
  const mail = pushMail(save, {
    from: PACK_MAIL_FROM,
    title: `【${FIRST_PAY.name}】奖励已发放`,
    body: '感谢你的第一次充值，这是给你的见面礼。以后也常来坐坐。',
    rewards: FIRST_PAY.rewards,
  });
  return { ok: true, mail };
}

/* ===================================================================== */
/*                        每日限时礼包（每天随机两款）                    */
/* ===================================================================== */
/**
 * 今天的两款限时礼包（档位不同），以及各自"买过没有"
 * @returns {{key:string, packs:object[], boughtCount:number, canBuy:boolean, allBought:boolean}}
 *   packs[i] = { ...礼包数据, bought:boolean, canBuy:boolean }
 */
export function dailyPackState(save, now = new Date()) {
  const a = ensureActivity(save);
  const key = dayKey(now);
  // 跨天就换（不用写存档，按日期算出来就是稳定的）
  const list = dailyPacksOf(key).length ? dailyPacksOf(key) : DAILY_PACKS.slice(0, 2);
  // 今天买过哪几个；老存档的布尔字段 packBought（当年只有一款）折算成"第一款已买"
  let bought = a.packDate === key ? a.packsBought.slice() : [];
  if (a.packDate === key && a.packBought === true && !bought.length && list[0]) bought = [list[0].id];
  const packs = list.map((p) => ({
    ...p,
    bought: bought.includes(p.id),
    canBuy: !bought.includes(p.id),
  }));
  return {
    key,
    packs,
    boughtCount: packs.filter((p) => p.bought).length,
    canBuy: packs.some((p) => p.canBuy),
    allBought: packs.every((p) => p.bought),
  };
}

/**
 * 买今日限时礼包（模拟支付）→ **直接到账**（只有首充礼包走邮箱）
 * @param {string} [packId] 不传就买今天**还没买的第一款**
 * @returns {{ok:boolean, error?:string, order?:object, got?:string[], pack?:object}}
 */
export function buyDailyPack(save, packId = '', now = new Date()) {
  const st = dailyPackState(save, now);
  const target = packId
    ? st.packs.find((p) => p.id === packId)
    : st.packs.find((p) => p.canBuy);
  if (!target) return { ok: false, error: packId ? '今天没有这款礼包' : '今天的礼包都买过了，明天换新的' };
  if (target.bought) return { ok: false, error: '这款今天的礼包已经买过了' };
  const a = ensureActivity(save);
  const order = recordPayment(save, { price: target.price, label: target.name, kind: 'pack' });
  // 以"今天已经买过的 + 刚买的这款"为准落库（跨天时 st 里已经是空的了）
  a.packDate = st.key;
  a.packsBought = [...st.packs.filter((p) => p.bought).map((p) => p.id), target.id];
  a.packBought = false; // 老字段留着但不再使用（老存档读一次就折算了）
  return { ok: true, order, pack: target, got: applyRewards(save, target.rewards) };
}

/* ===================================================================== */
/*                          累计充值礼包                                  */
/* ===================================================================== */
export function payTierState(save) {
  const a = ensureActivity(save);
  const total = totalPaidYuan(save);
  return {
    total,
    tiers: PAY_TIERS.map((t) => ({
      ...t,
      reached: total >= t.yuan,
      claimed: a.tiers.includes(t.yuan),
      canClaim: total >= t.yuan && !a.tiers.includes(t.yuan),
    })),
  };
}

/** 领某一档累计充值奖励：**直接到账**（只有首充礼包走邮箱） */
export function claimPayTier(save, yuan) {
  const st = payTierState(save);
  const tier = st.tiers.find((t) => t.yuan === Number(yuan));
  if (!tier) return { ok: false, error: '没有这一档' };
  if (tier.claimed) return { ok: false, error: '这一档已经领过了' };
  if (!tier.reached) {
    return { ok: false, error: `累计充值到 ¥${tier.yuan} 才能领（现在 ¥${st.total}）` };
  }
  const a = ensureActivity(save);
  a.tiers.push(tier.yuan);
  return { ok: true, tier, got: applyRewards(save, tier.rewards) };
}

/* ===================================================================== */
/*                          今日限时折扣                                  */
/* ===================================================================== */
/**
 * 今日折扣状态
 *   · 道具类（番茄 / 鲜花 / 鸡蛋 / 卡布奇诺）**今天可以买 5 次** —— 消耗品一次一个不够用
 *   · 装扮类（头像框 / 牌背）只能买 1 次
 */
export function discountState(save, now = new Date()) {
  const a = ensureActivity(save);
  const key = dayKey(now);
  const item = discountOf(key);
  if (!item) return null;
  const price = discountPrice(item.price);
  const maxBuys = discountMaxBuys(item);
  // 今天买过几次；老存档的布尔字段 discountBought 折算成"已经买过 1 次"
  let count = a.discountDate === key ? a.discountCount : 0;
  if (a.discountDate === key && a.discountBought === true && count < 1) count = 1;
  count = Math.max(0, Math.min(maxBuys, count));
  return {
    item,
    key,
    price,
    off: item.price - price,
    rate: item.price ? 1 - price / item.price : 0,
    maxBuys,
    boughtCount: count,
    left: Math.max(0, maxBuys - count),
    /** 能不能再买（道具类买满 5 次才关门） */
    canBuy: count < maxBuys,
  };
}

/**
 * 用折扣价买今天的商品（开心豆结算，不是充值）
 * @param {object} economy 有 beans / addBeans / save
 */
export function buyDiscount(economy, now = new Date()) {
  const save = economy.save;
  const st = discountState(save, now);
  if (!st) return { ok: false, error: '今天没有折扣商品' };
  if (!st.canBuy) {
    return {
      ok: false,
      error: st.maxBuys > 1
        ? `今天的折扣已经买满 ${st.maxBuys} 次了，明天再来`
        : '今天的折扣已经用过了，明天再来',
    };
  }
  if (economy.beans < st.price) {
    return { ok: false, error: `开心豆不足，需要 💰${st.price.toLocaleString()}` };
  }
  const a = ensureActivity(save);
  economy.addBeans(-st.price, 'discount');
  a.discountDate = st.key;
  a.discountCount = st.boughtCount + 1;
  a.discountBought = false; // 老字段留着但不再使用
  let reward;
  if (st.item.kind === 'item') reward = { kind: 'item', id: st.item.id, n: 1 };
  else if (st.item.kind === 'cardBack') reward = { kind: 'cardBack', id: st.item.id };
  else reward = { kind: 'frame', id: st.item.id };
  const got = applyRewards(save, [reward]);
  return {
    ok: true, item: st.item, price: st.price, got, count: a.discountCount, left: Math.max(0, st.maxBuys - a.discountCount),
  };
}

/* ===================================================================== */
/*                            大转盘                                     */
/* ===================================================================== */
export function wheelState(save) {
  const a = ensureActivity(save);
  return {
    cost: WHEEL.cost,
    prizes: WHEEL.prizes,
    spins: a.spins,
    bestWin: a.bestWin,
    affordable: save.beans >= WHEEL.cost,
    jackpotChance: jackpotChance(),
  };
}

/**
 * 转一次（先扣豆子，再按权重开奖）
 * 已经有的装扮重复抽到 → 折算成豆子，不做空奖
 * @returns {{ok:boolean, error?:string, index?:number, prize?:object, got?:string[], duplicate?:boolean}}
 */
export function spinWheel(economy, rnd = Math.random) {
  const save = economy.save;
  const st = wheelState(save);
  if (economy.beans < st.cost) {
    return { ok: false, error: `开心豆不足，转一次需要 💰${st.cost.toLocaleString()}` };
  }
  const prize = spinPrize(rnd);
  const index = WHEEL.prizes.indexOf(prize);
  economy.addBeans(-st.cost, 'wheel');
  const a = ensureActivity(save);
  a.spins += 1;

  let reward = prize;
  let duplicate = false;
  if (prize.limited) {
    const owned = prize.kind === 'frame'
      ? ownsFrame(save, prize.id)
      : ensureTitleState(save).unlocked.includes(prize.id);
    if (owned) {
      duplicate = true;
      reward = { kind: 'beans', amount: WHEEL.duplicateBeans };
    }
  }
  const got = applyRewards(save, [reward]);
  if (reward.kind === 'beans') a.bestWin = Math.max(a.bestWin, reward.amount);
  return { ok: true, index, prize, got, duplicate, reward };
}

/* ===================================================================== */
/*                          面板总览（一次取全）                          */
/* ===================================================================== */
export function activityOverview(save, now = new Date()) {
  ensureActivity(save);
  ensureCosmetics(save);
  return {
    daily: freeGiftState(save, 'daily', now),
    weekly: freeGiftState(save, 'weekly', now),
    first: firstPayState(save),
    pack: dailyPackState(save, now),
    tiers: payTierState(save),
    discount: discountState(save, now),
    wheel: wheelState(save),
  };
}
