/**
 * 活动中心数据（PRD §2.16）
 *
 * 零依赖、纯数据 + 纯函数：日期键、每日随机挑选、倒计时文案、奖励文案
 * 都放在这里，界面只负责画，测试可以直接调。
 *
 * 所有"充值"都是**模拟支付**（和商城买豆子同一套仪式），不接真实支付。
 */
import { ITEMS } from '../config.js';
import { FRAMES_FOR_SALE, FRAMES, CARD_BACKS, RENAME_CARD } from './cosmetics.js';
import { titleById } from './titles.js';

/* ===================================================================== */
/*                              免费礼包                                 */
/* ===================================================================== */
export const FREE_DAILY = {
  id: 'daily',
  name: '每日免费礼包',
  sub: '每天都能领一次，过了零点刷新',
  emoji: '🎁',
  tone: 'neon',
  rewards: [{ kind: 'beans', amount: 2000 }, { kind: 'item', id: 'flower', n: 1 }],
};

export const FREE_WEEKLY = {
  id: 'weekly',
  name: '每周免费礼包',
  sub: '每周一刷新，一周一次，比每日厚',
  emoji: '🧧',
  tone: 'neon',
  rewards: [{ kind: 'beans', amount: 15000 }, { kind: 'item', id: 'cappuccino', n: 2 }],
};

/* ===================================================================== */
/*                              首充礼包                                 */
/* ===================================================================== */
export const FIRST_PAY = {
  id: 'firstpay',
  name: '首充礼包',
  sub: '任意金额充值即可领取，一辈子只有一次',
  emoji: '👑',
  tone: 'gold',
  limit: '仅此一次',
  /** 首充的奖励走邮箱发放（真游戏都这样，仪式感在"收到邮件"那一刻） */
  byMail: true,
  rewards: [
    { kind: 'frame', id: 'f_gold' },
    { kind: 'title', id: 't_first' },
    { kind: 'beans', amount: 100000 },
    { kind: 'item', id: 'flower', n: 5 },
    { kind: 'renameCard', n: 1 },
  ],
};

/* ===================================================================== */
/*                        每日限时礼包（每天随机一款）                    */
/* ===================================================================== */
export const DAILY_PACKS = [
  {
    id: 'pack_s',
    name: '小试牛刀礼包',
    price: 6,
    emoji: '🎁',
    tone: 'fire',
    rewards: [{ kind: 'beans', amount: 6000 }, { kind: 'item', id: 'tomato', n: 3 }],
  },
  {
    id: 'pack_m',
    name: '渐入佳境礼包',
    price: 30,
    emoji: '🎊',
    tone: 'fire',
    rewards: [{ kind: 'beans', amount: 30000 }, { kind: 'item', id: 'egg', n: 5 }, { kind: 'renameCard', n: 1 }],
  },
  {
    id: 'pack_l',
    name: '豪气冲天礼包',
    price: 128,
    emoji: '💎',
    tone: 'fire',
    rewards: [
      { kind: 'beans', amount: 128000 },
      { kind: 'cardBack', id: 'back_02' },
      { kind: 'item', id: 'cappuccino', n: 3 },
    ],
  },
  {
    id: 'pack_xl',
    name: '一掷千金礼包',
    price: 648,
    emoji: '👑',
    tone: 'fire',
    rewards: [{ kind: 'beans', amount: 648000 }, { kind: 'frame', id: 'f_neon' }, { kind: 'item', id: 'flower', n: 10 }],
  },
];

/**
 * 今日限时礼包：每天**两款**，档位必须不同（价格不一样才算"不同档位"）
 *   · 第一款 = `dailyPackOf(key)`，用的还是老 salt，所以老存档"今天已经买过"的那款对得上
 *   · 第二款从**剩下三档**里按日期稳定地挑，所以同一天刷新页面结果不变
 */
export function dailyPacksOf(key) {
  if (!Array.isArray(DAILY_PACKS) || !DAILY_PACKS.length) return [];
  const first = dailyPackOf(key);
  if (!first) return [];
  const rest = DAILY_PACKS.filter((p) => p.id !== first.id); // 天然是"别的档位"
  const second = pickOfDay(rest, key, 'pack2');
  return [first, second].filter(Boolean);
}

/* ===================================================================== */
/*                          累计充值礼包                                 */
/* ===================================================================== */
/** 解锁门槛：30 / 128 / 648 / 2560 元（越往上给得越狠） */
export const PAY_TIERS = [
  { yuan: 30, rewards: [{ kind: 'beans', amount: 60000 }, { kind: 'renameCard', n: 1 }] },
  { yuan: 128, rewards: [{ kind: 'beans', amount: 300000 }, { kind: 'cardBack', id: 'back_03' }, { kind: 'item', id: 'flower', n: 5 }] },
  { yuan: 648, rewards: [{ kind: 'beans', amount: 1600000 }, { kind: 'frame', id: 'f_sakura' }, { kind: 'item', id: 'cappuccino', n: 5 }] },
  { yuan: 2560, rewards: [{ kind: 'beans', amount: 6000000 }, { kind: 'frame', id: 'f_flame' }, { kind: 'renameCard', n: 3 }] },
];

/* ===================================================================== */
/*                          今日限时折扣                                 */
/* ===================================================================== */
export const DISCOUNT_RATE = 0.5;

/**
 * 今日折扣能买几次：
 *   · **道具类（番茄、鲜花、鸡蛋、卡布奇诺）可以买 5 次** —— 道具是消耗品，一次一个不够用
 *   · 装扮类（头像框 / 牌背）只给 1 次，不然折扣就变成"批发"了
 */
export const DISCOUNT_ITEM_BUYS = 5;

/** 这件折扣商品今天最多能买几次 */
export function discountMaxBuys(item) {
  return item && item.kind === 'item' ? DISCOUNT_ITEM_BUYS : 1;
}

/**
 * 打折池：牌桌道具 + 要买的牌背 + 要买的头像框
 * ★ 只用开心豆结算的才算折扣（折扣本身是"花开心豆"的活动）——
 *   充值货（霓虹脉冲 ¥18）价格是人民币，打折池里必须排掉，否则会算出"¥18 的 5 折 = 若干豆"这种四不像。
 */
export function discountPool() {
  return [
    ...ITEMS.map((i) => ({ kind: 'item', id: i.id, name: i.name, emoji: i.emoji, price: i.price })),
    ...CARD_BACKS.filter((b) => b.price > 0).map((b) => ({ kind: 'cardBack', id: b.id, name: `${b.name}牌背`, emoji: '🂠', price: b.price })),
    ...FRAMES_FOR_SALE.filter((f) => f.price > 0 && !(Number(f.cashPrice) > 0))
      .map((f) => ({ kind: 'frame', id: f.id, name: f.name, emoji: '🖼️', price: f.price })),
  ];
}

/** 折扣价（向上取整到百位，看起来像"标价"而不是算出来的） */
export function discountPrice(price) {
  const raw = Math.max(1, Math.round(price * DISCOUNT_RATE));
  return Math.ceil(raw / 100) * 100;
}

/* ===================================================================== */
/*                            大转盘（抽奖）                              */
/* ===================================================================== */
/**
 * 花开心豆抽奖，**整体数学期望是负的**（庄家优势 ≈ 10.5%，见 `wheelHouseEdge()`）：
 * 抽得到更多豆子、道具，也有极小概率（0.1%）抽到 **1,000,000 豆**的大奖，
 * 以及只能在这里拿到的**星轨头像框 / 欧皇称号**。
 * 权重是千分比，加起来正好 1000（12 格 × 30°，正好铺满一圈）。
 *
 * 价值口径（`value`）只算"有明确豆子价格"的东西（豆子本身 + 道具按商城售价折），
 * 那两件装扮**不计入期望**（等于白送），所以真实期望只会比算出来的更不划算 —— 保守。
 */
export const WHEEL = {
  cost: 5000, // 一次 5000 开心豆
  /** 重复抽到已经有的装扮时，折算成豆子（不做"空奖"） */
  duplicateBeans: 20000,
  prizes: [
    { id: 'w_1k', label: '1,000 豆', short: '1千', emoji: '💰', weight: 20, kind: 'beans', amount: 1000, value: 1000 },
    { id: 'w_flower', label: '鲜花 ×1', short: '鲜花', emoji: '🌸', weight: 140, kind: 'item', itemId: 'flower', n: 1, value: 500 },
    { id: 'w_2k', label: '2,000 豆', short: '2千', emoji: '💰', weight: 340, kind: 'beans', amount: 2000, value: 2000 },
    { id: 'w_tomato', label: '番茄 ×1', short: '番茄', emoji: '🍅', weight: 110, kind: 'item', itemId: 'tomato', n: 1, value: 500 },
    { id: 'w_5k', label: '5,000 豆', short: '5千', emoji: '💰', weight: 200, kind: 'beans', amount: 5000, value: 5000 },
    { id: 'w_capp', label: '卡布奇诺 ×1', short: '咖啡', emoji: '☕', weight: 80, kind: 'item', itemId: 'cappuccino', n: 1, value: 2000 },
    { id: 'w_10k', label: '10,000 豆', short: '1万', emoji: '💰', weight: 70, kind: 'beans', amount: 10000, value: 10000 },
    { id: 'w_rename', label: '改名卡 ×1', short: '改名卡', emoji: '🪪', weight: 29, kind: 'renameCard', n: 1, value: 20000 },
    { id: 'w_30k', label: '30,000 豆', short: '3万', emoji: '💰', weight: 7, kind: 'beans', amount: 30000, value: 30000 },
    { id: 'w_frame', label: '星轨头像框', short: '星轨框', emoji: '🖼️', weight: 2, kind: 'frame', id: 'f_star', limited: true, value: 0 },
    { id: 'w_title', label: '欧皇称号', short: '欧皇', emoji: '🏅', weight: 1, kind: 'title', id: 't_lucky_star', limited: true, value: 0 },
    // 大奖：千分之一。单独放在最后一格，画成金色压轴格
    {
      id: 'w_jackpot', label: '1,000,000 豆', short: '100万', emoji: '💎', weight: 1, kind: 'beans', amount: 1000000, value: 1000000, jackpot: true,
    },
  ],
};

/** 大奖（jackpot）被抽中的概率 */
export function jackpotChance() {
  const p = WHEEL.prizes.find((x) => x.jackpot);
  if (!p) return 0;
  const total = wheelWeightTotal() || 1;
  return p.weight / total;
}

/** 权重总和（必须是 1000，测试里锁住） */
export function wheelWeightTotal() {
  return WHEEL.prizes.reduce((s, p) => s + p.weight, 0);
}

/** 一次抽奖的豆子等价期望（不含那两件装扮） */
export function wheelEV() {
  const total = wheelWeightTotal() || 1;
  return WHEEL.prizes.reduce((s, p) => s + (p.weight / total) * (p.value || 0), 0);
}

/** 庄家优势：(成本 - 期望) / 成本 */
export function wheelHouseEdge() {
  return (WHEEL.cost - wheelEV()) / WHEEL.cost;
}

/** 按权重抽一个（rnd ∈ [0,1)，方便测试注入） */
export function spinPrize(rnd = Math.random) {
  const total = wheelWeightTotal();
  let roll = rnd() * total;
  for (const p of WHEEL.prizes) {
    roll -= p.weight;
    if (roll < 0) return p;
  }
  return WHEEL.prizes[WHEEL.prizes.length - 1];
}

/** 一格多少度 */
export const wheelSeg = () => 360 / WHEEL.prizes.length;

/**
 * 让第 index 格正好停在正上方指针处所需的总旋转角
 * 只往一个方向累加（每次都多转几圈），所以视觉上永远是"继续往前转"
 */
export function wheelTargetAngle(index, prevRotation = 0, turns = 5) {
  const seg = wheelSeg();
  const base = Math.ceil(prevRotation / 360) * 360;
  return base + 360 * turns - (index * seg + seg / 2);
}

/**
 * 反过来验算：转到 rotation 度时，指针指的是第几格
 * 指针固定在正上方（屏幕 0°），盘面角度 b 转 R 后出现在 (b+R) 处，所以指针处 b = (-R) mod 360
 */
export function wheelIndexAt(rotation) {
  const seg = wheelSeg();
  const n = WHEEL.prizes.length;
  const b = ((-rotation % 360) + 360) % 360;
  return Math.floor(b / seg) % n;
}

/* ===================================================================== */
/*                          日期键与每日随机                              */
/* ===================================================================== */

/** 本地日期键 YYYY-MM-DD */
export function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 周一为起点的周键 YYYY-Www（跨年时按 ISO 周号近似：用该周的周四所在年） */
export function weekKey(d = new Date()) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (t.getDay() + 6) % 7; // 周一 = 0
  t.setDate(t.getDate() - dow + 3); // 挪到本周四
  const year = t.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const jan4Dow = (jan4.getDay() + 6) % 7;
  const firstThursday = new Date(year, 0, 4 - jan4Dow + 3);
  const week = 1 + Math.round((t - firstThursday) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 距离本地明天 0 点还有多少毫秒 */
export function msUntilTomorrow(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next - now);
}

/** 距离下周一 0 点还有多少毫秒 */
export function msUntilNextWeek(now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (t.getDay() + 6) % 7; // 周一 = 0
  const next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + (7 - dow), 0, 0, 0, 0);
  return Math.max(0, next - now);
}

/** 倒计时文案：`02:14:33`（一天内）/ `1 天 04:12:33` */
export function formatLeft(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = String(Math.floor((total % 86400) / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return d > 0 ? `${d} 天 ${h}:${m}:${s}` : `${h}:${m}:${s}`;
}

/** FNV-1a：把日期键搅成一个稳定的数，保证"同一天抽到的是同一款" */
export function hashKey(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 按日期稳定地抽一款（同一天刷新页面结果不变） */
export function pickOfDay(list, key, salt = '') {
  if (!Array.isArray(list) || !list.length) return null;
  return list[hashKey(`${key}|${salt}`) % list.length];
}

/** 今天轮到哪款限时礼包 */
export const dailyPackOf = (key) => pickOfDay(DAILY_PACKS, key, 'pack');

/** 今天打哪个折 */
export const discountOf = (key) => pickOfDay(discountPool(), key, 'discount');

/* ===================================================================== */
/*                            奖励文案                                   */
/* ===================================================================== */
const ITEM_BY_ID = new Map(ITEMS.map((i) => [i.id, i]));
const FRAME_BY_ID = new Map(FRAMES.map((f) => [f.id, f]));
const BACK_BY_ID = new Map(CARD_BACKS.map((b) => [b.id, b]));

/**
 * 豆子用的**独立图**（商城里的开心豆标志）：`assets/ui/bean-social.svg`
 * —— 它不是一个 `<symbol>`，是单独一张图，所以 `rewardArtId` 用这个哨兵值告诉 UI 换 img。
 */
export const BEAN_ART = 'bean';

/**
 * ★ 奖励 → 商城那套图标（用户拍板：活动中心里"改名卡"那些占位贴图全部换成商城的图标，
 *   开心豆也换成商城里的那个标志）。
 *   道具 / 礼物 / 改名卡 / 牌背 / 头像框 / 称号 都在 `assets/ui/item-art.svg` 里有 `<symbol id="art-xxx">`，
 *   这里只返回那串 id 的后半段；豆子返回 `BEAN_ART`。
 *   返回空串表示"这件东西没有对应图"，调用方退回 emoji（见 ui/activity.js 的 rewardIcon）。
 */
export function rewardArtId(r) {
  if (!r || !r.kind) return '';
  switch (r.kind) {
    case 'beans':
      return BEAN_ART;
    case 'item':
      return r.id || '';
    case 'renameCard':
      return RENAME_CARD.id;
    case 'cardBack':
      return r.id || '';
    case 'frame':
      return r.id || '';
    case 'title':
      return 't_' + String(r.id || r.titleId || '').replace(/^t_/, '');
    default:
      return '';
  }
}

/** 奖励 → { emoji, text }（列表和邮箱都用这一份，保证口径一致） */
export function rewardLabel(r) {
  if (!r || !r.kind) return { emoji: '❔', text: '神秘奖励' };
  switch (r.kind) {
    case 'beans':
      return { emoji: '💰', text: `${Number(r.amount || 0).toLocaleString()} 开心豆` };
    case 'item': {
      const it = ITEM_BY_ID.get(r.id);
      return { emoji: it ? it.emoji : '🎁', text: `${it ? it.name : r.id} ×${r.n || 1}` };
    }
    case 'frame': {
      const f = FRAME_BY_ID.get(r.id);
      return { emoji: '🖼️', text: `${f ? f.name : r.id} 头像框` };
    }
    case 'cardBack': {
      const b = BACK_BY_ID.get(r.id);
      return { emoji: '🂠', text: `${b ? b.name : r.id} 牌背` };
    }
    case 'title':
      return { emoji: '🏅', text: `${titleById(r.id || r.titleId)?.name || '称号'}` };
    case 'renameCard':
      return { emoji: RENAME_CARD.emoji, text: `${RENAME_CARD.name} ×${r.n || 1}` };
    default:
      return { emoji: '🎁', text: '奖励' };
  }
}
