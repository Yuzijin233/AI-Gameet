/**
 * 倍数与结算（PRD §2.4.2 / §2.4.3）
 * 三重截断：min(底分 × 倍数, 场次封顶豆, 付款方身家) —— 永不出现负数豆
 */

/** 倍数 = 2^(抢地主+反抢 + 炸弹 + 王炸) × 春天系数 */
export function computeMultiplier({ robs = 0, bombs = 0, rockets = 0, spring = false, antiSpring = false } = {}) {
  const factors = [];
  const robTotal = robs;
  if (robTotal) factors.push({ label: `抢地主 ×${2 ** robTotal}`, value: 2 ** robTotal });
  if (bombs) factors.push({ label: `炸弹 ×${2 ** bombs}`, value: 2 ** bombs });
  if (rockets) factors.push({ label: `王炸 ×${2 ** rockets}`, value: 2 ** rockets });
  if (spring) factors.push({ label: '春天 ×2', value: 2 });
  if (antiSpring) factors.push({ label: '反春 ×2', value: 2 });
  const mult = 2 ** (robTotal + bombs + rockets) * (spring || antiSpring ? 2 : 1);
  return { mult, factors };
}

/**
 * 结算
 * @returns {{ deltas:number[], detail:Array, multiplier:number, perHand:number }}
 *   deltas 按座位索引，正数为赢豆，负数为输豆；总和恒为 0
 */
export function settleGame({
  landlordSeat,
  landlordWin,
  multiplier,
  base,
  cap,
  beans, // 各座位结算前身家
}) {
  const deltas = [0, 0, 0];
  const detail = [];
  const farmers = [0, 1, 2].filter((s) => s !== landlordSeat);
  const perHand = base * multiplier;

  if (landlordWin) {
    let total = 0;
    for (const f of farmers) {
      const want = Math.min(perHand, cap);
      const pay = Math.max(0, Math.min(want, beans[f]));
      deltas[f] -= pay;
      total += pay;
      detail.push({ seat: f, amount: -pay, capped: pay < perHand });
    }
    deltas[landlordSeat] += total;
    detail.push({ seat: landlordSeat, amount: total });
  } else {
    // 地主向每位农民各赔一笔，受封顶与地主身家总量双重限制
    let budget = beans[landlordSeat];
    let paid = 0;
    for (const f of farmers) {
      const want = Math.min(perHand, cap);
      const pay = Math.max(0, Math.min(want, budget));
      budget -= pay;
      paid += pay;
      deltas[f] += pay;
      detail.push({ seat: f, amount: pay, capped: pay < perHand });
    }
    deltas[landlordSeat] -= paid;
    detail.push({ seat: landlordSeat, amount: -paid });
  }

  return { deltas, detail, multiplier, perHand };
}

/** 春天 / 反春判定（PRD §2.4.2） */
export function detectSpring({ landlordSeat, landlordWin, playCounts }) {
  const farmers = [0, 1, 2].filter((s) => s !== landlordSeat);
  if (landlordWin) {
    const spring = farmers.every((f) => (playCounts[f] || 0) === 0);
    return { spring, antiSpring: false };
  }
  const antiSpring = (playCounts[landlordSeat] || 0) <= 1;
  return { spring: false, antiSpring };
}

export function formatBeans(n) {
  const v = Math.round(n);
  if (Math.abs(v) >= 100000000) return `${(v / 100000000).toFixed(2)}亿`;
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(2).replace(/\.00$/, '')}万`;
  return String(v);
}

/** 带 💰 图标的豆子文案（全场统一用这个） */
export function beanLabel(n) {
  return `💰 ${formatBeans(n)}`;
}

export function beanLabelFull(n) {
  return `💰 ${Math.round(n).toLocaleString()}`;
}
