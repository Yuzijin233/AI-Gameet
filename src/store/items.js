/**
 * 道具库存（商城第三类商品，PRD §2.2）
 * 牌桌上每种道具每局最多用 CONFIG.toolPerHand 次，且库存要够
 *
 * ★ 礼物（GIFTS）也放在同一个库存里（`save.items`），但它们**不是牌桌道具**：
 *   牌桌上的道具行只列 ITEMS，礼物只在好友界面赠送时消耗。
 */
import { ITEMS, GIFTS, CONFIG } from '../config.js';

export function ensureItems(save) {
  if (!save.items || typeof save.items !== 'object') save.items = {};
  for (const it of [...ITEMS, ...GIFTS]) {
    const v = save.items[it.id];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) save.items[it.id] = 0;
    else save.items[it.id] = Math.floor(v);
  }
  return save.items;
}

export function itemCount(save, id) {
  ensureItems(save);
  return save.items[id] || 0;
}

export function addItems(save, id, n = 1) {
  ensureItems(save);
  // 礼物和道具共用一份库存（save.items），这里两种都要认
  if (!ITEMS.some((it) => it.id === id) && !GIFTS.some((g) => g.id === id)) return 0;
  save.items[id] = Math.max(0, save.items[id] + n);
  return save.items[id];
}

export function stockTotal(save) {
  ensureItems(save);
  return ITEMS.reduce((s, it) => s + (save.items[it.id] || 0), 0);
}

/**
 * 本局还剩几次可用：受"库存"和"每局上限"双重限制
 * @param {object} save
 * @param {string} id 道具 id
 * @param {number} usedThisHand 本局已经用了几次
 */
export function toolLeft(save, id, usedThisHand = 0) {
  const stock = itemCount(save, id);
  const quota = Math.max(0, CONFIG.toolPerHand - usedThisHand);
  return Math.max(0, Math.min(stock, quota));
}

/** 用掉一个道具（扣库存），库存不足返回 false */
export function consumeItem(save, id) {
  ensureItems(save);
  if ((save.items[id] || 0) <= 0) return false;
  save.items[id] -= 1;
  return true;
}

/** 花开心豆买一个道具 / 礼物（商城第三、四类商品） */
export function buyItem(economy, id) {
  const it = ITEMS.find((x) => x.id === id) || GIFTS.find((x) => x.id === id);
  if (!it) return { ok: false, error: '道具不存在' };
  if (economy.beans < it.price) {
    return { ok: false, error: `开心豆不足，需要 💰${it.price.toLocaleString()}` };
  }
  economy.addBeans(-it.price, 'item');
  addItems(economy.save, id, 1);
  return { ok: true, item: it, count: itemCount(economy.save, id) };
}
