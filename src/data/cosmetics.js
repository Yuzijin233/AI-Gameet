/**
 * 装扮（头像框 / 牌背 / 整体风格）数据（PRD §2.17）
 *
 * 头像框**不需要任何图片素材**：一个框 = 头像外圈的描边 + 发光（CSS 类 `frame-xxx`）。
 * 这样换皮时只要改这里的 color 就能出新框，也不会有"贴图没对齐"的问题。
 * 风格（主题）同理：不改一张图，只换 CSS 令牌，见 styles/theme-light.css。
 */

/**
 * 头像框
 *   `price`     = 开心豆价（0 = 商城不卖，走活动）
 *   `cashPrice` = **人民币价**（元）：有它就说明这一款改成"充值购买"，
 *                 走和买开心豆**同一套模拟收银台**（不接真实支付），见 store/cosmetics.js 的 buyCosmeticWithCash。
 *                 用户拍板：霓虹脉冲 = ¥18。
 *   `only`      = 只送不卖（'gift' 首充礼包 / 'wheel' 大转盘）
 */
export const FRAMES = [
  { id: 'f_gold', name: '鎏金环', price: 0, color: '#ffd166', desc: '首充礼包里的', only: 'gift' },
  // ★ 充值购买（用户拍板 ¥18）；不要再给它 price，否则会被当成豆子货
  { id: 'f_neon', name: '霓虹脉冲', price: 0, cashPrice: 18, color: '#6FD6FF', desc: '会呼吸的蓝光' },
  { id: 'f_sakura', name: '樱吹雪', price: 120000, color: '#FF9EC4', desc: '春日元气' },
  { id: 'f_flame', name: '烈焰之环', price: 300000, color: '#FF6B35', desc: '上桌就带火' },
  { id: 'f_frost', name: '霜之哀伤', price: 500000, color: '#A8E6FF', desc: '冷静得让人发冷' },
  // 只有大转盘能抽到，商城买不到
  { id: 'f_star', name: '星轨', price: 0, color: '#C8B6FF', desc: '大转盘的彩头', only: 'wheel' },
];

export const frameById = (id) => FRAMES.find((f) => f.id === id) || null;

/** 商城在售的头像框（豆子货 + 充值货；排除只送不卖的） */
export const FRAMES_FOR_SALE = FRAMES.filter((f) => f.price > 0 || f.cashPrice > 0);

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
 * 风格 = 整体配色（午后会客厅 / 鎏金 / 霓虹夜 / 奶油晴空）。
 * 实现方式是**只换设计令牌**：佩戴后往 <html> 上挂一个 `data-theme`，
 * 对应的 `styles/theme-*.css` 那套就生效。
 *
 * ★ 用户拍板（本轮改版）：
 *   · 免费默认只有**「午后会客厅」**（新建号 / 老存档都会回到它）
 *   · 「霓虹夜」不再默认解锁，充值 **¥188**（和买开心豆同一套模拟收银台）
 *   · **「鎏金」不在商城卖**：它是**里程碑 200 分**的奖励
 *     （用户拍板：里程碑那一档不再给霓虹夜，改成新风格「鎏金」）
 *   · 「奶油晴空」继续花开心豆买（88,000 豆）
 */
export const THEMES = [
  {
    id: 'th_social',
    name: '午后会客厅',
    price: 0,
    tone: 'social',
    desc: '全新默认：暖灰与松绿，聊得自在，玩得尽兴',
  },
  {
    id: 'th_gilded',
    name: '鎏金',
    // ★ 不出售：`price: 0` + `only: 'milestone'` 表示"只能靠里程碑拿"
    price: 0,
    tone: 'gilded',
    only: 'milestone',
    desc: '里程碑专属：午后会客厅的金色版本，暖金与米黄',
  },
  {
    id: 'th_dark',
    name: '霓虹夜',
    // ★ 不再免费：充值 ¥188 购买（price 是等值豆子展示价，真正的收款入口是 cashPrice）
    price: 188 * 1000,
    cashPrice: 188,
    tone: 'dark',
    desc: '经典风格：紫黑霓虹，原版界面完整保留',
  },
  {
    id: 'th_light',
    name: '奶油晴空',
    price: 88000,
    tone: 'light',
    desc: '浅色风：灰白底 + 细线 + 扁平气泡，像真的聊天软件；牌桌依旧是深色',
  },
];

/** 唯一免费、且永远算拥有的风格（新建号 / 老存档都回落到它） */
export const FREE_THEME = 'th_social';
/** 新账号默认佩戴的风格 */
export const DEFAULT_THEME = 'th_social';
/**
 * ★ 曾经免费、现在改成收费的那款（用户拍板霓虹夜 ¥188）：
 *   老存档里如果白拿过它，要**收回一次**（不回滚资金，因为它本来就是免费的）。
 *   这就是"不默认解锁"的含义 —— 想要就买。
 */
export const NO_LONGER_FREE_THEMES = ['th_dark'];

export const themeById = (id) => THEMES.find((t) => t.id === id) || null;

/**
 * 商城在售的风格（豆子货 + 充值货）。
 * ★ 排除 `only: 'milestone'` 的「鎏金」—— 它只在里程碑里发放，商城买不到。
 */
export const THEMES_FOR_SALE = THEMES.filter((t) => (t.price > 0 || t.cashPrice > 0) && !t.only);
