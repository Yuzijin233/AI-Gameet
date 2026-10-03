/**
 * 规则引擎（PRD §5-Q5）
 * 牌型识别 / 大小比较 / 可压牌枚举（提示与机器人共用）
 */
import { groupByRank } from './cards.js';

export const TYPE = {
  SINGLE: 'single',
  PAIR: 'pair',
  TRIO: 'trio',
  TRIO1: 'trio1',
  TRIO2: 'trio2',
  STRAIGHT: 'straight',
  STRAIGHT_PAIR: 'straightPair',
  PLANE: 'plane',
  PLANE1: 'plane1',
  PLANE2: 'plane2',
  FOUR2: 'four2single',
  FOUR2P: 'four2pair',
  BOMB: 'bomb',
  ROCKET: 'rocket',
};

export const TYPE_LABEL = {
  [TYPE.SINGLE]: '单张',
  [TYPE.PAIR]: '对子',
  [TYPE.TRIO]: '三张',
  [TYPE.TRIO1]: '三带一',
  [TYPE.TRIO2]: '三带二',
  [TYPE.STRAIGHT]: '顺子',
  [TYPE.STRAIGHT_PAIR]: '连对',
  [TYPE.PLANE]: '飞机',
  [TYPE.PLANE1]: '飞机带单',
  [TYPE.PLANE2]: '飞机带对',
  [TYPE.FOUR2]: '四带二',
  [TYPE.FOUR2P]: '四带两对',
  [TYPE.BOMB]: '炸弹',
  [TYPE.ROCKET]: '王炸',
};

const ROCKET_RANK = 100;
const MAX_STRAIGHT_RANK = 14; // 顺子/连对/飞机 最大到 A，不含 2 与大小王

function make(type, cards, rank, size) {
  return {
    type,
    rank,
    size: size ?? cards.length,
    cards: cards.slice(),
    isBomb: type === TYPE.BOMB || type === TYPE.ROCKET,
  };
}

function countMap(cards) {
  const m = new Map();
  for (const c of cards) m.set(c.rank, (m.get(c.rank) || 0) + 1);
  return m;
}

function isConsecutive(ranks) {
  for (let i = 1; i < ranks.length; i += 1) if (ranks[i] !== ranks[i - 1] + 1) return false;
  return true;
}

function detectPlane(cards, m, n) {
  const trioRanks = [...m.keys()].filter((r) => r <= MAX_STRAIGHT_RANK && m.get(r) >= 3).sort((a, b) => a - b);
  if (trioRanks.length < 2) return null;
  const runs = [];
  let i = 0;
  while (i < trioRanks.length) {
    let j = i;
    while (j + 1 < trioRanks.length && trioRanks[j + 1] === trioRanks[j] + 1) j += 1;
    for (let a = i; a <= j; a += 1) {
      for (let b = a + 1; b <= j; b += 1) runs.push(trioRanks.slice(a, b + 1));
    }
    i = j + 1;
  }
  runs.sort((a, b) => b.length - a.length);
  for (const run of runs) {
    const k = run.length;
    const rest = new Map(m);
    for (const r of run) rest.set(r, rest.get(r) - 3);
    const restRanks = [...rest.keys()].filter((r) => rest.get(r) > 0);
    if (restRanks.some((r) => run.includes(r))) continue; // 翅膀不能带本体
    const restCards = n - 3 * k;
    if (restCards === 0) return make(TYPE.PLANE, cards, run[k - 1], n);
    if (restCards === k) return make(TYPE.PLANE1, cards, run[k - 1], n);
    if (restCards === 2 * k && restRanks.length === k && restRanks.every((r) => rest.get(r) === 2)) {
      return make(TYPE.PLANE2, cards, run[k - 1], n);
    }
  }
  return null;
}

/** 识别牌型，非法返回 null */
export function analyze(cards) {
  const n = cards.length;
  if (!n) return null;
  const m = countMap(cards);
  const ranks = [...m.keys()].sort((a, b) => a - b);
  const maxCount = Math.max(...ranks.map((r) => m.get(r)));

  if (n === 2 && m.get(16) === 1 && m.get(17) === 1) return make(TYPE.ROCKET, cards, ROCKET_RANK, 2);
  // 两副牌：2 张王（1 小 1 大）或 4 张王（2 小 2 大）都算王炸，4 张的更大
  // 注意 (m.get(16) || 0) > 0：两张 undefined 相等，不加判断会把"3334"错判成王炸
  if (n % 2 === 0 && n >= 2 && n <= 4 && ranks.length === 2
    && (m.get(16) || 0) > 0 && m.get(16) === m.get(17)) {
    return make(TYPE.ROCKET, cards, ROCKET_RANK + n / 2 - 1, n);
  }
  if (n === 1) return make(TYPE.SINGLE, cards, cards[0].rank, 1);
  if (n === 2 && maxCount === 2) return make(TYPE.PAIR, cards, ranks[0], 2);
  if (n === 3 && maxCount === 3) return make(TYPE.TRIO, cards, ranks[0], 3);
  // 炸弹：4~8 张同点数（两副牌里 5、6、7、8 张也算炸弹，张数越多越大）
  if (n >= 4 && maxCount === n && ranks.length === 1) return make(TYPE.BOMB, cards, ranks[0], n);
  if (n === 4 && maxCount === 4) return make(TYPE.BOMB, cards, ranks[0], 4);
  if (n === 4 && maxCount === 3) return make(TYPE.TRIO1, cards, ranks.find((r) => m.get(r) === 3), 4);
  if (n === 5 && maxCount === 3) {
    const trio = ranks.find((r) => m.get(r) === 3);
    const other = ranks.find((r) => r !== trio);
    if (trio !== undefined && other !== undefined && m.get(other) === 2) return make(TYPE.TRIO2, cards, trio, 5);
  }
  if (n >= 5 && ranks.every((r) => m.get(r) === 1) && ranks[ranks.length - 1] <= MAX_STRAIGHT_RANK && isConsecutive(ranks)) {
    return make(TYPE.STRAIGHT, cards, ranks[ranks.length - 1], n);
  }
  if (n >= 6 && n % 2 === 0 && ranks.length >= 3 && ranks.every((r) => m.get(r) === 2)
    && ranks[ranks.length - 1] <= MAX_STRAIGHT_RANK && isConsecutive(ranks)) {
    return make(TYPE.STRAIGHT_PAIR, cards, ranks[ranks.length - 1], n);
  }
  if (n === 6) {
    const four = ranks.find((r) => m.get(r) === 4);
    if (four !== undefined) return make(TYPE.FOUR2, cards, four, 6);
  }
  if (n === 8) {
    const four = ranks.find((r) => m.get(r) === 4);
    if (four !== undefined) {
      const others = ranks.filter((r) => r !== four);
      if (others.length === 2 && others.every((r) => m.get(r) === 2)) return make(TYPE.FOUR2P, cards, four, 8);
    }
  }
  const plane = detectPlane(cards, m, n);
  if (plane) return plane;

  // 三带一/三带二 的宽松兜底（如 3334 之外的多余组合）
  return null;
}

/** a 能否压过 b（b 为 null 表示首出） */
export function canBeat(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.type === TYPE.ROCKET) return b.type !== TYPE.ROCKET || a.rank > b.rank; // 4 张王 > 2 张王
  if (b.type === TYPE.ROCKET) return false;
  if (a.type === TYPE.BOMB && b.type === TYPE.BOMB) {
    // 两副牌里炸弹张数不同：张数多的大；张数相同比点数
    if (a.size !== b.size) return a.size > b.size;
    return a.rank > b.rank;
  }
  if (a.type === TYPE.BOMB) return true;
  if (b.type === TYPE.BOMB) return false;
  if (a.type !== b.type) return false;
  if (a.size !== b.size) return false;
  return a.rank > b.rank;
}

export function isValidPlay(cards) {
  return analyze(cards) !== null;
}

export function describePlay(play) {
  if (!play) return '';
  const label = TYPE_LABEL[play.type] || play.type;
  if (play.type === TYPE.SINGLE || play.type === TYPE.PAIR) return label;
  return label;
}

/* ------------------------------------------------------------------ */
/*                        可压牌枚举（提示 / AI）                       */
/* ------------------------------------------------------------------ */

function combinations(arr, k, limit = 40) {
  const out = [];
  const buf = [];
  const walk = (start) => {
    if (out.length >= limit) return;
    if (buf.length === k) {
      out.push(buf.slice());
      return;
    }
    for (let i = start; i < arr.length; i += 1) {
      buf.push(arr[i]);
      walk(i + 1);
      buf.pop();
      if (out.length >= limit) return;
    }
  };
  walk(0);
  return out;
}

function signature(play) {
  return `${play.type}|${play.cards.map((c) => c.id).sort((a, b) => a - b).join(',')}`;
}

/**
 * 枚举手中所有合法出牌；last 为 null 时返回所有牌型
 * 结果按「非炸弹优先 → 点数小优先 → 张数少优先」排序
 */
export function findPlays(hand, last = null, opts = {}) {
  const limitWings = opts.limitWings ?? 6;
  const out = [];
  const seen = new Set();
  const push = (cards) => {
    if (!cards || !cards.length) return;
    const play = analyze(cards);
    if (!play || !canBeat(play, last)) return;
    const sig = signature(play);
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push(play);
  };

  const byRank = groupByRank(hand); // rank -> cards（已按花色排序）
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const countOf = (r) => (byRank.get(r) || []).length;
  const take = (r, n) => (byRank.get(r) || []).slice(0, n);

  // 基础牌型
  for (const r of ranks) {
    push(take(r, 1));
    if (countOf(r) >= 2) push(take(r, 2));
    if (countOf(r) >= 3) push(take(r, 3));
    if (countOf(r) === 4) push(take(r, 4));
  }
  if (countOf(16) && countOf(17)) push([...take(16, 1), ...take(17, 1)]);

  // 三带一 / 三带二
  for (const r of ranks) {
    if (countOf(r) < 3) continue;
    const trio = take(r, 3);
    const singlePool = ranks.filter((x) => x !== r).flatMap((x) => byRank.get(x));
    const pairRanks = ranks.filter((x) => x !== r && countOf(x) >= 2);
    for (const wing of combinations(singlePool.slice(0, limitWings + 1), 1, limitWings)) push([...trio, ...wing]);
    for (const pr of pairRanks.slice(0, limitWings)) push([...trio, ...take(pr, 2)]);
  }

  // 四带二
  for (const r of ranks) {
    if (countOf(r) !== 4) continue;
    const four = take(r, 4);
    const singlePool = ranks.filter((x) => x !== r).flatMap((x) => byRank.get(x));
    const pairRanks = ranks.filter((x) => x !== r && countOf(x) >= 2);
    for (const wings of combinations(singlePool.slice(0, limitWings), 2, limitWings)) push([...four, ...wings]);
    for (let i = 0; i < pairRanks.length && i < 3; i += 1) {
      for (let j = i + 1; j < pairRanks.length && j < 4; j += 1) {
        push([...four, ...take(pairRanks[i], 2), ...take(pairRanks[j], 2)]);
      }
    }
  }

  // 顺子
  for (let start = 3; start <= MAX_STRAIGHT_RANK - 4; start += 1) {
    for (let len = 5; start + len - 1 <= MAX_STRAIGHT_RANK; len += 1) {
      const seq = [];
      for (let r = start; r < start + len; r += 1) seq.push(take(r, 1)[0]);
      if (seq.some((c) => !c)) break;
      push(seq);
    }
  }

  // 连对
  for (let start = 3; start <= MAX_STRAIGHT_RANK - 2; start += 1) {
    for (let len = 3; start + len - 1 <= MAX_STRAIGHT_RANK; len += 1) {
      const seq = [];
      for (let r = start; r < start + len; r += 1) {
        if (countOf(r) < 2) { seq.length = 0; break; }
        seq.push(...take(r, 2));
      }
      if (!seq.length) break;
      push(seq);
    }
  }

  // 飞机（含带单 / 带对）
  const trioRanks = ranks.filter((r) => r <= MAX_STRAIGHT_RANK && countOf(r) >= 3);
  for (let start = 0; start < trioRanks.length; start += 1) {
    for (let end = start + 1; end < trioRanks.length; end += 1) {
      if (trioRanks[end] !== trioRanks[end - 1] + 1) break;
      const run = trioRanks.slice(start, end + 1);
      const k = run.length;
      const main = [];
      for (const r of run) main.push(...take(r, 3));
      push(main);
      const usedRanks = new Set(run);
      const singlePool = ranks.filter((x) => !usedRanks.has(x)).flatMap((x) => byRank.get(x));
      for (const wings of combinations(singlePool.slice(0, k + 3), k, limitWings)) push([...main, ...wings]);
      const pairRanks = ranks.filter((x) => !usedRanks.has(x) && countOf(x) >= 2);
      for (const wings of combinations(pairRanks.slice(0, k + 2), k, limitWings)) {
        push([...main, ...wings.flatMap((r) => take(r, 2))]);
      }
    }
  }

  out.sort((a, b) => {
    const ab = a.isBomb ? 1 : 0;
    const bb = b.isBomb ? 1 : 0;
    if (ab !== bb) return ab - bb;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.size - b.size;
  });
  return out;
}

/** 提示：给玩家用的排序（首出时优先小牌，跟牌时优先最小可压） */
export function hintPlays(hand, last) {
  return findPlays(hand, last);
}

/** 炸弹/王炸数量（用于倍数与统计） */
export function countBombs(play) {
  if (!play) return { bombs: 0, rockets: 0 };
  if (play.type === TYPE.ROCKET) return { bombs: 0, rockets: 1 };
  if (play.type === TYPE.BOMB) return { bombs: 1, rockets: 0 };
  return { bombs: 0, rockets: 0 };
}
