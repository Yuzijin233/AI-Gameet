/**
 * 装扮（头像框 / 牌背 / 整体风格）数据（PRD §2.17）
 *
 * 头像框**不需要任何图片素材**：一个框 = 头像外圈的描边 + 发光（CSS 类 `frame-xxx`）。
 * 这样换皮时只要改这里的 color 就能出新框，也不会有"贴图没对齐"的问题。
 * 风格（主题）同理：不改一张图，只换 CSS 令牌，见 styles/theme-light.css。
 */

/** 头像框：`price` 是开心豆价；`price === 0` 表示只在活动里送，商城不卖 */
export const FRAMES = [
  { id: 'f_gold', name: '鎏金环', price: 0, color: '#ffd166', desc: '首充礼包里的', only: 'gift' },
  { id: 'f_neon', name: '霓虹脉冲', price: 60000, color: '#6FD6FF', desc: '会呼吸的蓝光' },
  { id: 'f_sakura', name: '樱吹雪', price: 120000, color: '#FF9EC4', desc: '春日元气' },
  { id: 'f_flame', name: '烈焰之环', price: 300000, color: '#FF6B35', desc: '上桌就带火' },
  { id: 'f_frost', name: '霜之哀伤', price: 500000, color: '#A8E6FF', desc: '冷静得让人发冷' },
  // 只有大转盘能抽到，商城买不到
  { id: 'f_star', name: '星轨', price: 0, color: '#C8B6FF', desc: '大转盘的彩头', only: 'wheel' },
];

export const frameById = (id) => FRAMES.find((f) => f.id === id) || null;

/** 商城在售的头像框（排除只送不卖的） */
export const FRAMES_FOR_SALE = FRAMES.filter((f) => f.price > 0);

/** 牌背：第 1 款免费，另外两款要买 */
export const CARD_BACKS = [
  { id: 'back_01', name: '经典红', price: 0, desc: '默认牌背，一直免费用' },
  { id: 'back_02', name: '青花瓷', price: 50000, desc: '蓝白釉色' },
  { id: 'back_03', name: '暗夜鎏金', price: 200000, desc: '黑金配色，最贵的一款' },
];

export const cardBackById = (id) => CARD_BACKS.find((b) => b.id === id) || null;

/** 改名卡（消耗品：改一次昵称扣一张） */
export const RENAME_CARD = {
  id: 'renameCard',
  name: '改名卡',
  emoji: '🪪',
  price: 20000,
  desc: '用一张改一次昵称（没卡就改不了名）',
};

export const FREE_CARD_BACK = 'back_01';

/* ===================================================================== */
/*                              整体风格                                  */
/* ===================================================================== */
/**
 * 风格 = 整体配色（深色 / 浅色）。实现方式是**只换设计令牌**：
 * 佩戴后往 <html> 上挂一个 `data-theme`，styles/theme-light.css 里那套就生效。
 *
 * ★ 默认仍然是**深色**（用户拍板）；浅色 «奶油晴空» 去商城 · 装扮买，
 *   这一版它被重做过：灰白底 + 细线 + 扁平气泡，照着真的聊天软件排。
 *
 * 注意：**牌桌与钓鱼桌永远保持暗色**（毛毡、卡牌都是照着暗底画的），
 * 所以浅色风格会让"界面"变亮，牌桌那一屏还是深色 —— 这是有意的。
 */
export const THEMES = [
  {
    id: 'th_dark',
    name: '霓虹夜',
    price: 0,
    tone: 'dark',
    desc: '默认风格：紫黑霓虹，夜里看着最舒服',
  },
  {
    id: 'th_light',
    name: '奶油晴空',
    price: 88000,
    tone: 'light',
    desc: '浅色风：灰白底 + 细线 + 扁平气泡，像真的聊天软件；牌桌依旧是深色',
  },
];

export const FREE_THEME = 'th_dark';
export const themeById = (id) => THEMES.find((t) => t.id === id) || null;

/** 商城在售的风格（排除免费那款） */
export const THEMES_FOR_SALE = THEMES.filter((t) => t.price > 0);
