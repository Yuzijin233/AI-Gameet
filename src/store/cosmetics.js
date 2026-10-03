/**
 * 装扮拥有状态：头像框 / 牌背 / 整体风格 / 改名卡（PRD §2.17）
 *
 * 边界：装扮只影响"看起来"，**绝不影响出牌与结算**（和道具一样是纯表达）。
 * 头像框不需要图片素材，佩戴后就是给头像加一个 CSS 类（描边 + 发光）。
 * 风格也不需要图片素材：只换 CSS 令牌（见 styles/theme-light.css）。
 */
import {
  FRAMES, FRAMES_FOR_SALE, CARD_BACKS, FREE_CARD_BACK, RENAME_CARD, THEMES, THEMES_FOR_SALE, FREE_THEME,
  frameById, cardBackById, themeById,
} from '../data/cosmetics.js';

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
  // 免费风格（深色霓虹夜）永远算拥有，否则老存档一进来就没有主题可用
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

/** 当前佩戴的风格 id（没戴过就是空串 = 用默认的深色） */
export function equippedTheme(save) {
  const c = ensureCosmetics(save);
  return c.theme && c.themes.includes(c.theme) ? c.theme : '';
}

/** 佩戴 / 还原默认（传空字符串或免费款 = 回到默认深色） */
export function equipTheme(save, id) {
  const c = ensureCosmetics(save);
  if (id && !c.themes.includes(id)) return { ok: false, error: '还没有这个风格' };
  c.theme = id && id !== FREE_THEME ? id : '';
  return { ok: true, theme: c.theme };
}

/**
 * 给 <html> 用的 data-theme 值：'light' 或 ''（空 = 默认深色）。
 * 只有浅色需要打标记，深色就是不加 data-theme（见 styles/theme-light.css）
 */
export function themeNameOf(save) {
  const t = themeById(equippedTheme(save));
  return t && t.tone === 'light' ? 'light' : '';
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
  const item = kind === 'frame' ? FRAMES_FOR_SALE.find((f) => f.id === what.id) : null;
  const back = kind === 'cardBack' ? CARD_BACKS.find((b) => b.id === what.id && b.price > 0) : null;
  const theme = kind === 'theme' ? THEMES_FOR_SALE.find((t) => t.id === what.id) : null;
  const target = item || back || theme;
  if (!target) return { ok: false, error: '这个装扮不在售' };
  if (kind === 'frame' && ownsFrame(save, target.id)) return { ok: false, error: '已经拥有这个头像框了' };
  if (kind === 'cardBack' && ownsCardBack(save, target.id)) return { ok: false, error: '已经拥有这个牌背了' };
  if (kind === 'theme' && ownsTheme(save, target.id)) return { ok: false, error: '已经拥有这个风格了' };
  if (economy.beans < target.price) {
    return { ok: false, error: `开心豆不足，需要 💰${target.price.toLocaleString()}` };
  }
  economy.addBeans(-target.price, 'cosmetic');
  if (kind === 'frame') ownFrame(save, target.id);
  else if (kind === 'theme') ownTheme(save, target.id);
  else ownCardBack(save, target.id);
  return { ok: true, kind, name: target.name, id: target.id };
}

/** 装扮面板用列表（分"已拥有/未拥有"，并标价） */
export function cosmeticList(save) {
  ensureCosmetics(save);
  return {
    frames: FRAMES.map((f) => ({
      ...f,
      owned: ownsFrame(save, f.id),
      equipped: equippedFrame(save) === f.id,
      forSale: f.price > 0,
      affordable: save.beans >= f.price,
    })),
    cardBacks: CARD_BACKS.map((b) => ({
      ...b,
      owned: ownsCardBack(save, b.id),
      forSale: b.price > 0,
      inUse: save.settings && save.settings.cardBack === b.id,
      affordable: save.beans >= b.price,
    })),
    themes: THEMES.map((t) => ({
      ...t,
      owned: ownsTheme(save, t.id),
      equipped: equippedTheme(save) === t.id || (!equippedTheme(save) && t.id === FREE_THEME),
      forSale: t.price > 0,
      affordable: save.beans >= t.price,
    })),
    renameCards: renameCardCount(save),
    renamePrice: RENAME_CARD.price,
  };
}
