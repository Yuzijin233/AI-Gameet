/**
 * 装扮拥有状态：头像框 / 牌背 / 整体风格 / 改名卡（PRD §2.17）
 *
 * 边界：装扮只影响"看起来"，**绝不影响出牌与结算**（和道具一样是纯表达）。
 * 头像框不需要图片素材，佩戴后就是给头像加一个 CSS 类（描边 + 发光）。
 * 风格也不需要图片素材：只换 CSS 令牌（见 styles/theme-light.css）。
 */
import {
  FRAMES, FRAMES_FOR_SALE, CARD_BACKS, FREE_CARD_BACK, RENAME_CARD, THEMES, THEMES_FOR_SALE, FREE_THEME,
  NO_LONGER_FREE_THEMES,
  frameById, cardBackById, themeById, DEFAULT_THEME,
} from '../data/cosmetics.js';
import { recordPayment } from './activity.js';
import { titleById } from '../data/titles.js';
import { ensureTitleState } from './titles.js';

export function ensureCosmetics(save) {
  if (!save.cosmetics || typeof save.cosmetics !== 'object') save.cosmetics = {};
  const c = save.cosmetics;
  if (!Array.isArray(c.frames)) c.frames = [];
  if (!Array.isArray(c.cardBacks)) c.cardBacks = [];
  if (!Array.isArray(c.themes)) c.themes = [];
  // 免费牌背永远算拥有
  if (!c.cardBacks.includes(FREE_CARD_BACK)) c.cardBacks.push(FREE_CARD_BACK);
  c.cardBacks = c.cardBacks.filter((id) => !!cardBackById(id));
  c.frames = c.frames.filter((id) => !!frameById(id));
  /**
   * ★ 唯一免费的风格「午后会客厅」永远算拥有 —— 否则老存档一进来就没有主题可用。
   *
   * ★ 曾经免费、现在改成收费的「霓虹夜」（¥188）要**在老存档上收回一次**，
   *   而且是**只收一次**：用 `paidThemes` 这个一次性迁移标记来区分
   *   "老存档白拿的" 和 "后来真花钱买的" —— 不能每次读取都从列表里剔掉，
   *   否则充值买完立刻又被抹掉（买了一直不生效）。
   */
  if (!c.paidThemes) {
    c.themes = c.themes.filter((id) => !NO_LONGER_FREE_THEMES.includes(id));
    c.paidThemes = true;
  }
  if (!c.themes.includes(FREE_THEME)) c.themes.push(FREE_THEME);
  c.themes = c.themes.filter((id) => !!themeById(id));
  if (typeof c.frame !== 'string') c.frame = '';
  if (c.frame && !c.frames.includes(c.frame)) c.frame = ''; // 卸下不存在的框
  if (typeof c.theme !== 'string') c.theme = '';
  if (c.theme && !c.themes.includes(c.theme)) c.theme = ''; // 卸下不存在的风格
  if (!Number.isFinite(c.renameCards) || c.renameCards < 0) c.renameCards = 0;
  c.renameCards = Math.floor(c.renameCards);
  return c;
}

/* ---------------- 头像框 ---------------- */
export function ownedFrames(save) {
  return ensureCosmetics(save).frames.slice();
}
export const ownsFrame = (save, id) => ensureCosmetics(save).frames.includes(id);

/** 记一个框为已拥有（重复调用无副作用）；返回 true 表示这次是新的 */
export function ownFrame(save, id) {
  const c = ensureCosmetics(save);
  if (!frameById(id) || c.frames.includes(id)) return false;
  c.frames.push(id);
  return true;
}

export function equippedFrame(save) {
  const c = ensureCosmetics(save);
  return c.frame && c.frames.includes(c.frame) ? c.frame : '';
}

/** 佩戴 / 卸下（传空字符串 = 卸下） */
export function equipFrame(save, id) {
  const c = ensureCosmetics(save);
  if (id && !c.frames.includes(id)) return { ok: false, error: '还没有这个头像框' };
  c.frame = id || '';
  return { ok: true, frame: c.frame };
}

/** 头像框的 CSS 类名（佩戴了才返回，没佩戴返回空串） */
export function frameClassOf(save) {
  const id = equippedFrame(save);
  return id ? `frame-${id.replace(/^f_/, '')}` : '';
}

/* ---------------- 牌背 ---------------- */
export function ownedCardBacks(save) {
  return ensureCosmetics(save).cardBacks.slice();
}
export const ownsCardBack = (save, id) => ensureCosmetics(save).cardBacks.includes(id);

export function ownCardBack(save, id) {
  const c = ensureCosmetics(save);
  if (!cardBackById(id) || c.cardBacks.includes(id)) return false;
  c.cardBacks.push(id);
  return true;
}

/* ---------------- 整体风格（主题） ---------------- */
/** 已拥有的风格 id（免费的"霓虹夜"永远在里面） */
export function ownedThemes(save) {
  return ensureCosmetics(save).themes.slice();
}
export const ownsTheme = (save, id) => ensureCosmetics(save).themes.includes(id);

/** 记一个风格为已拥有；返回 true 表示这次是新的 */
export function ownTheme(save, id) {
  const c = ensureCosmetics(save);
  if (!themeById(id) || c.themes.includes(id)) return false;
  c.themes.push(id);
  return true;
}

/** 空选择使用全新默认主题；原有明确选择（含付费浅色）继续保留。 */
export function equippedTheme(save) {
  const c = ensureCosmetics(save);
  return c.theme && c.themes.includes(c.theme) ? c.theme : DEFAULT_THEME;
}

/** 佩戴 / 还原默认。经典深色必须存明确 id，避免与新默认混淆。 */
export function equipTheme(save, id) {
  const c = ensureCosmetics(save);
  if (id && !c.themes.includes(id)) return { ok: false, error: '还没有这个风格' };
  c.theme = id && id !== DEFAULT_THEME ? id : '';
  return { ok: true, theme: c.theme };
}

/**
 * 给 <html> 用的 data-theme：social 为新默认，light 为经典浅色，空值为经典深色。
 * 三套样式隔离，旧款始终可切回，空存档选择则使用 DEFAULT_THEME。
 */
export function themeNameOf(save) {
  const t = themeById(equippedTheme(save));
  return t && t.tone !== 'dark' ? t.tone : '';
}

/* ---------------- 改名卡 ---------------- */
export const renameCardCount = (save) => ensureCosmetics(save).renameCards;

export function addRenameCard(save, n = 1) {
  const c = ensureCosmetics(save);
  c.renameCards = Math.max(0, c.renameCards + Math.floor(n));
  return c.renameCards;
}

/** 用掉一张（改名前调用）；没有卡就返回 false */
export function useRenameCard(save) {
  const c = ensureCosmetics(save);
  if (c.renameCards <= 0) return false;
  c.renameCards -= 1;
  return true;
}

/* ---------------- 商城购买 ---------------- */
/**
 * 这一款是不是**充值购买**（有 cashPrice 的：霓虹脉冲 ¥18 / 霓虹夜 ¥188 / 斗地主之王 ¥128）
 * 充值的也走 `recordPayment`，所以累计充值礼包照样算得进去。
 */
export function cashPriceOf(target) {
  const n = Number(target && target.cashPrice);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 按 id 找一块装扮（框 / 牌背 / 风格），只认在售的 */
function saleTarget(kind, id) {
  if (kind === 'frame') return FRAMES_FOR_SALE.find((f) => f.id === id) || null;
  if (kind === 'cardBack') return CARD_BACKS.find((b) => b.id === id && b.price > 0) || null;
  if (kind === 'theme') return THEMES_FOR_SALE.find((t) => t.id === id) || null;
  return null;
}

const KIND_LABEL = { frame: '头像框', cardBack: '牌背', theme: '风格' };

function ownsKind(save, kind, id) {
  if (kind === 'frame') return ownsFrame(save, id);
  if (kind === 'cardBack') return ownsCardBack(save, id);
  return ownsTheme(save, id);
}

function grantKind(save, kind, id) {
  if (kind === 'frame') ownFrame(save, id);
  else if (kind === 'cardBack') ownCardBack(save, id);
  else ownTheme(save, id);
}

/**
 * 花开心豆买装扮
 * @param {object} economy 有 beans / addBeans / save 的经济对象
 * @param {{kind:'frame'|'cardBack'|'theme'|'renameCard', id?:string}} what
 */
export function buyCosmetic(economy, what) {
  const save = economy.save;
  ensureCosmetics(save);
  const kind = what && what.kind;
  if (kind === 'renameCard') {
    if (economy.beans < RENAME_CARD.price) {
      return { ok: false, error: `开心豆不足，需要 💰${RENAME_CARD.price.toLocaleString()}` };
    }
    economy.addBeans(-RENAME_CARD.price, 'renameCard');
    const count = addRenameCard(save, 1);
    return { ok: true, name: RENAME_CARD.name, count };
  }
  const target = saleTarget(kind, what && what.id);
  if (!target) return { ok: false, error: '这个装扮不在售' };
  /**
   * ★ 充值货不能用豆子买：豆子买到就违背了"改成充值购买"（用户拍板）。
   *   这些只有"未拥有且是充值货"的情况下才拦 —— 已拥有的照旧可以装备 / 佩戴。
   */
  if (cashPriceOf(target)) {
    return { ok: false, error: `${target.name}是充值商品，需要 ¥${cashPriceOf(target)}`, needCash: cashPriceOf(target) };
  }
  if (ownsKind(save, kind, target.id)) return { ok: false, error: `已经拥有这个${KIND_LABEL[kind] || '装扮'}了` };
  if (economy.beans < target.price) {
    return { ok: false, error: `开心豆不足，需要 💰${target.price.toLocaleString()}` };
  }
  economy.addBeans(-target.price, 'cosmetic');
  grantKind(save, kind, target.id);
  return { ok: true, kind, name: target.name, id: target.id };
}

/**
 * ★ 充值买装扮（用户拍板：霓虹脉冲 ¥18 / 霓虹夜 ¥188 / 斗地主之王 ¥128）
 * ------------------------------------------------------------------
 * 和商城买开心豆**共用同一套模拟收银台**：页面弹 `runMockPayment()`，
 * 玩家确认订单 → 选支付方式 → 处理中 → 这一步真的发货。
 * 不接真实支付（`recordPayment` 只记一笔订单，顺带计入累计充值）。
 *
 * @param {object} save
 * @param {{kind:'frame'|'theme'|'title', id:string, name?:string, price:number}} what
 * @returns {{ok:boolean, error?:string, order?:object, name?:string, kind?:string}}
 */
export function buyCosmeticWithCash(save, what = {}) {
  ensureCosmetics(save);
  const kind = what.kind;
  const price = Number(what.price) || 0;
  if (price <= 0) return { ok: false, error: '这一款不是充值商品' };

  // 称号走 store/titles.js 的解锁列表：这里只认"充值称号"，避免越权
  if (kind === 'title') {
    const id = what.id;
    const t = titleById(id);
    if (!t) return { ok: false, error: '称号不存在' };
    if (cashPriceOf(t) !== price) return { ok: false, error: '价格对不上，请刷新后重试' };
    const st = ensureTitleState(save);
    if (st.unlocked.includes(id)) return { ok: false, error: '已经拥有这个称号了' };
    const order = recordPayment(save, { price, label: `称号 · ${t.name}`, kind: 'title' });
    st.unlocked.push(id);
    return { ok: true, order, name: t.name, kind: 'title' };
  }

  const target = saleTarget(kind, what.id);
  if (!target) return { ok: false, error: '这个装扮不在售' };
  if (cashPriceOf(target) !== price) return { ok: false, error: '价格对不上，请刷新后重试' };
  if (ownsKind(save, kind, target.id)) return { ok: false, error: `已经拥有这个${KIND_LABEL[kind] || '装扮'}了` };
  const order = recordPayment(save, {
    price, label: `${KIND_LABEL[kind] || '装扮'} · ${target.name}`, kind: kind || 'cosmetic',
  });
  grantKind(save, kind, target.id);
  return { ok: true, order, name: target.name, kind };
}

/** 装扮面板用列表（分"已拥有/未拥有"，并标价） */
export function cosmeticList(save) {
  ensureCosmetics(save);
  const decorate = (item) => ({
    ...item,
    cashPrice: cashPriceOf(item),
    isCash: cashPriceOf(item) > 0,
  });
  return {
    frames: FRAMES.map((f) => decorate({
      ...f,
      owned: ownsFrame(save, f.id),
      equipped: equippedFrame(save) === f.id,
      forSale: f.price > 0 || cashPriceOf(f) > 0,
      affordable: save.beans >= f.price,
    })),
    cardBacks: CARD_BACKS.map((b) => decorate({
      ...b,
      owned: ownsCardBack(save, b.id),
      forSale: b.price > 0,
      inUse: save.settings && save.settings.cardBack === b.id,
      affordable: save.beans >= b.price,
    })),
    themes: THEMES.map((t) => decorate({
      ...t,
      owned: ownsTheme(save, t.id),
      equipped: equippedTheme(save) === t.id,
      forSale: t.price > 0 || cashPriceOf(t) > 0,
      affordable: save.beans >= t.price,
    })),
    renameCards: renameCardCount(save),
    renamePrice: RENAME_CARD.price,
  };
}
