/**
 * 牌模型（PRD §2.4.1 / §5-Q5）
 * rank: 3..10 = 3..10, J=11, Q=12, K=13, A=14, 2=15, 小王=16, 大王=17
 * suit: 'S' 黑桃 | 'H' 红心 | 'C' 梅花 | 'D' 方块 | 'J' 王
 */

export const SUITS = ['S', 'H', 'C', 'D'];
// 花色统一用 emoji 呈现（带 VS16 变体选择符，浏览器会渲染成彩色 emoji）
export const SUIT_GLYPH = { S: '♠️', H: '♥️', C: '♣️', D: '♦️', J: '🤡' };
export const SUIT_NAME = { S: '黑桃', H: '红心', C: '梅花', D: '方块', J: '王' };

export const RANK_LABEL = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王',
};

export const RANK_ORDER = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

export function rankLabel(rank) {
  return RANK_LABEL[rank] ?? String(rank);
}

export function isJoker(card) {
  return card.rank >= 16;
}

export function isRed(card) {
  return card.suit === 'H' || card.suit === 'D' || card.rank === 17;
}

/**
 * 牌堆：decks = 1 → 54 张（3 人斗地主）；decks = 2 → 108 张（4 人两副牌）
 * 每张牌的 id 全局唯一（多副牌时同点数同花色会出现多张，靠 id 区分）
 */
export function createDeck(decks = 1) {
  const deck = [];
  let id = 0;
  for (let d = 0; d < decks; d += 1) {
    for (const suit of SUITS) {
      for (let rank = 3; rank <= 15; rank += 1) {
        deck.push({ id: id++, rank, suit, deck: d });
      }
    }
    deck.push({ id: id++, rank: 16, suit: 'J', deck: d });
    deck.push({ id: id++, rank: 17, suit: 'J', deck: d });
  }
  return deck;
}

/**
 * 座位/牌数规则（PRD §2.4.1）
 * 3 人：54 张，每人 17，底牌 3（地主 20）
 * 4 人：两副 108 张，每人 25，底牌 8（地主 33）
 */
export const SEAT_RULES = {
  3: { decks: 1, perHand: 17, bottom: 3, label: '三人斗地主' },
  4: { decks: 2, perHand: 25, bottom: 8, label: '四人斗地主（两副牌）' },
};

export function ruleOf(seatCount) {
  return SEAT_RULES[seatCount] || SEAT_RULES[3];
}

/** Fisher-Yates */
export function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 切牌（不洗牌模式用）：把牌堆分成两摞、原样交换位置
 * 关键点：**不改变牌与牌的相邻关系**（只在切口处断开），
 * 所以发出来的牌保留原来的顺序结构 —— 点数连、同花色扎堆，
 * 玩家更容易摸到顺子/连对/对子，牌型连、节奏快。
 * 切多次 = 仍然等价于切一次（旋转的复合还是旋转）。
 */
export function cutDeck(deck, times = 1, rnd = Math.random) {
  let a = deck.slice();
  for (let t = 0; t < times; t += 1) {
    if (a.length < 2) break;
    const at = 1 + Math.floor(rnd() * (a.length - 1));
    a = [...a.slice(at), ...a.slice(0, at)];
  }
  return a;
}

/** 统计牌堆里"相邻两张点数连着或相同"的对数（衡量牌型保留度） */
export function adjacentConnected(deck) {
  let n = 0;
  for (let i = 1; i < deck.length; i += 1) {
    const d = Math.abs(deck[i].rank - deck[i - 1].rank);
    if (d === 0 || d === 1) n += 1;
  }
  return n;
}

/** 从大到小排序（同点数按 黑桃>红心>梅花>方块） */
export function sortDesc(cards) {
  const suitOrder = { S: 0, H: 1, C: 2, D: 3, J: 0 };
  return cards.slice().sort((a, b) => (b.rank - a.rank) || (suitOrder[a.suit] - suitOrder[b.suit]));
}

export function groupByRank(cards) {
  const map = new Map();
  for (const card of sortDesc(cards)) {
    if (!map.has(card.rank)) map.set(card.rank, []);
    map.get(card.rank).push(card);
  }
  return map;
}

/** 贴图文件名（不带扩展名），如 S_A / H_10 / joker_b */
export function cardFile(card) {
  if (card.rank === 16) return 'joker_s';
  if (card.rank === 17) return 'joker_b';
  return `${card.suit}_${rankLabel(card.rank)}`;
}

export function cardTexture(card) {
  return `assets/cards/front/${cardFile(card)}.png`;
}

export function cardName(card) {
  if (card.rank >= 16) return rankLabel(card.rank);
  return `${SUIT_GLYPH[card.suit]}${rankLabel(card.rank)}`;
}

export function handToString(cards) {
  return sortDesc(cards).map(cardName).join(' ');
}

export function sameCardSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = a.map((c) => c.id).sort((x, y) => x - y).join(',');
  const sb = b.map((c) => c.id).sort((x, y) => x - y).join(',');
  return sa === sb;
}
