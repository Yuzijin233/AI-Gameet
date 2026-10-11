/**
 * 称号状态：解锁（按豆子 / 连续签到）/ 购买（花豆）/ 佩戴
 */
import { TITLES, titleById } from '../data/titles.js';

export function ensureTitleState(save) {
  if (!save.titles || typeof save.titles !== 'object') save.titles = { unlocked: [], equipped: '', manual: false };
  if (!Array.isArray(save.titles.unlocked)) save.titles.unlocked = [];
  if (typeof save.titles.equipped !== 'string') save.titles.equipped = '';
  if (typeof save.titles.manual !== 'boolean') save.titles.manual = false;
  return save.titles;
}

/** 当前连续签到天数（存档缺字段时按 0 处理） */
export function signInStreak(save) {
  const s = save && save.signIn;
  return s && Number.isFinite(s.streak) ? Math.max(0, s.streak) : 0;
}

/** 该称号当前是否达成条件（豆子档看身家、签到档看连续天数） */
export function titleCondMet(save, t) {
  if (!t) return false;
  if (t.kind === 'beans') return save.beans >= t.beans;
  if (t.kind === 'signin') return signInStreak(save) >= t.days;
  return false;
}

/**
 * 结算一次可自动获得的称号（身家档 + 连续签到档）；返回本次新解锁的（用于弹提示）
 * 解锁后永久保留：签到断签只会停下进度，不会收回已经拿到的称号
 */
export function syncBeanTitles(save) {
  const st = ensureTitleState(save);
  const got = [];
  for (const t of TITLES) {
    if (t.kind !== 'beans' && t.kind !== 'signin') continue;
    if (titleCondMet(save, t) && !st.unlocked.includes(t.id)) {
      st.unlocked.push(t.id);
      got.push(t);
    }
  }
  // 玩家还没手动选过称号时，自动佩戴当前能拿到的最高档
  if (!st.manual) {
    const owned = TITLES.filter((t) => st.unlocked.includes(t.id));
    if (owned.length) st.equipped = owned[owned.length - 1].id;
  }
  return got;
}

export function isTitleUnlocked(save, id) {
  return ensureTitleState(save).unlocked.includes(id);
}

/**
 * 直接授予一个称号（活动 / 关系达成这类"系统送"的，不走豆子或签到判定）
 * @returns {{ok:boolean, isNew:boolean, title:object|null}}
 */
export function awardTitle(save, id) {
  const t = titleById(id);
  if (!t) return { ok: false, isNew: false, title: null };
  const st = ensureTitleState(save);
  if (st.unlocked.includes(id)) return { ok: true, isNew: false, title: t };
  st.unlocked.push(id);
  return { ok: true, isNew: true, title: t };
}

export function equippedTitle(save) {
  const st = ensureTitleState(save);
  const t = st.equipped ? titleById(st.equipped) : null;
  return t && st.unlocked.includes(t.id) ? t : null;
}

export function equipTitle(save, id) {
  const st = ensureTitleState(save);
  if (id && !st.unlocked.includes(id)) return { ok: false, error: '还没有这个称号' };
  st.equipped = id || '';
  st.manual = true; // 手动选择后，不再自动升级
  return { ok: true };
}

/** 花豆购买称号（★ 充值称号不能用豆子买，见 store/cosmetics.js 的 buyCosmeticWithCash） */
export function buyTitle(economy, id) {
  const t = titleById(id);
  if (!t) return { ok: false, error: '称号不存在' };
  if (t.kind !== 'shop') return { ok: false, error: '这个称号不能购买，要靠身家或签到获得' };
  if (Number(t.cashPrice) > 0) {
    return { ok: false, error: `${t.name}是充值商品，需要 ¥${Number(t.cashPrice)}`, needCash: Number(t.cashPrice) };
  }
  const st = ensureTitleState(economy.save);
  if (st.unlocked.includes(id)) return { ok: false, error: '已经拥有这个称号了' };
  if (economy.beans < t.price) return { ok: false, error: `豆子不足，需要 💰${t.price.toLocaleString()}` };
  economy.addBeans(-t.price, 'title');
  st.unlocked.push(id);
  return { ok: true, title: t };
}

/** 面板用列表 */
export function titleList(save) {
  const st = ensureTitleState(save);
  const streak = signInStreak(save);
  return TITLES.map((t) => ({
    ...t,
    /** ★ 充值称号（斗地主之王 ¥128）：界面上要显示 ¥ 而不是豆子，也不能用豆子买 */
    cashPrice: Number(t.cashPrice) > 0 ? Number(t.cashPrice) : 0,
    isCash: Number(t.cashPrice) > 0,
    unlocked: st.unlocked.includes(t.id),
    equipped: st.equipped === t.id,
    affordable: Number(t.cashPrice) > 0 ? false : save.beans >= (t.kind === 'beans' ? t.beans : t.price),
    // 签到档的进度（面板显示"3/8 天"）
    progress: t.kind === 'signin' ? Math.min(streak, t.days) : 0,
  }));
}
