/**
 * 小猫钓鱼（休闲模式，不计豆子）
 *
 * 规则（计分版 + 可选择钓不钓）：
 *  1. 52 张牌（无大小王）平分，双方各 26 张；
 *  2. 轮流把自己牌堆最上面一张翻到中央；
 *  3. 翻出的牌若与中央已有的牌点数相同，就出现一次「钓」的机会：
 *     - 收下：把「最后一个同点数的牌 → 刚翻的这张」之间的牌收进自己的鱼篓（计分）；
 *     - 先不收：牌留在中央，可以继续往上攒，之后再翻到同点数就能一次收走一大串
 *       —— 但对手也可能先把这堆牌钓走，所以是一次风险选择；
 *  4. 双方手牌都出完即结束，鱼篓里牌多的一方获胜，相同为平局（固定每人 26 次翻牌）。
 *
 * 为什么不按「出完牌的人输」的原始规则：那是 26 张牌上的随机游走，
 * 实测平均要 407 步（200+ 次点击）才能分出胜负，做成电子游戏体验极差。
 */
import { createDeck, shuffle } from '../core/cards.js';
import { FISHING, FISHING_ROOMS } from '../config.js';

export const MAX_MOVES = 80;

/**
 * 小猫钓鱼结算：按双方鱼篓差结算豆子
 *  - 一样多（五五开）→ 双方都是 0
 *  - 曲线是 perCard×d + quad×d² + cube×d³：差距越大涨得越猛，场次越高倍率越大
 *  - 赢的系数 > 输的系数 ⇒ 长期期望略微大于 0
 * @param {number} myScore 我的鱼篓
 * @param {number} aiScore 对手鱼篓
 * @param {object} room FISHING_ROOMS 里的一项（决定倍率与曲线）
 * @returns {{ diff:number, base:number, delta:number, kind:'win'|'lose'|'draw' }}
 */
export function settleFishing(myScore, aiScore, room = FISHING_ROOMS[0], rates = FISHING, multiplier = 1) {
  const diff = myScore - aiScore;
  if (diff === 0) return { diff: 0, base: 0, delta: 0, kind: 'draw', multiplier };
  const d = Math.abs(diff);
  const base = Math.round(room.perCard * d + room.quad * d * d + (room.cube || 0) * d * d * d);
  const delta = diff > 0
    ? Math.round(base * rates.winFactor * multiplier)
    : -Math.round(base * rates.loseFactor * multiplier);
  return { diff, base, delta, kind: diff > 0 ? 'win' : 'lose', multiplier };
}

export class FishingGame {
  constructor(rnd = Math.random) {
    const deck = shuffle(createDeck().filter((c) => c.rank <= 15), rnd); // 52 张，不含大小王
    this.piles = [deck.slice(0, 26), deck.slice(26)];
    this.table = [];
    this.score = [0, 0]; // 鱼篓（钓到的牌数）
    this.bucket = [[], []]; // 鱼篓里的真实牌（用于界面展示）
    this.turn = 0;
    this.winner = null; // 0 | 1 | -1(平局)
    this.moves = 0;
    this.lastCatch = null; // { seat, count, rank }
    this.awaiting = null; // 待决定：{ seat, idx, count, rank }
    this.multiplier = 1; // 本局倍数
    this.bigCatches = 0; // 一次钓 6 张以上的次数
    this.log = []; // 最近几步操作（给 AI 提示词用）：{ seat, type, card, count, rank }
  }

  /** 记一步操作（只留最近 12 步） */
  note(entry) {
    this.log.push(entry);
    if (this.log.length > 12) this.log.shift();
  }

  /** 最近 n 步（从早到晚），给提示词用 */
  recentLog(n = 5) {
    return this.log.slice(-n);
  }

  /**
   * 记牌器：每个点数在**牌堆里还剩几张**（双方手上没翻的牌）
   * 52 张（3~2 各 4 张，无大小王）；已翻出来的牌要么在鱼篓、要么在中央牌堆，都不算"牌堆里"。
   * @returns {Array<{rank:number, left:number}>} 按点数从 3 到 2
   */
  remainingByRank() {
    const left = new Map();
    for (let r = 3; r <= 15; r += 1) left.set(r, 0);
    for (const pile of this.piles) {
      for (const c of pile) left.set(c.rank, (left.get(c.rank) || 0) + 1);
    }
    return [...left.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rank, n]) => ({ rank, left: n }));
  }

  /** 已经翻出来（鱼篓 + 中央）的牌数，用来核对牌数守恒 */
  revealedCount() {
    return this.bucket[0].length + this.bucket[1].length + this.table.length;
  }

  get counts() { return [this.piles[0].length, this.piles[1].length]; }

  get over() { return this.winner !== null; }

  get topCard() { return this.table[this.table.length - 1] || null; }

  get totalCards() {
    return this.piles[0].length + this.piles[1].length + this.table.length + this.score[0] + this.score[1];
  }

  /** 该点数在中央已有几张（不含刚翻的那张） */
  sameRankOnTable(rank) {
    let n = 0;
    for (let i = 0; i < this.table.length - 1; i += 1) if (this.table[i].rank === rank) n += 1;
    return n;
  }

  /**
   * 翻一张牌。
   * 若出现同点数，会返回 pending（等待 收 / 先不收 的决定），此时不会换手；
   * 否则自动换手。
   */
  play() {
    if (this.over || this.awaiting) return null;
    const seat = this.turn;
    if (!this.piles[seat].length) {
      this.nextTurn(seat);
      if (this.piles[seat].length) return { type: 'skip', seat };
      this.finish();
      return { type: 'skip', seat };
    }
    const card = this.piles[seat].shift();
    this.table.push(card);
    this.moves += 1;

    // 找中央牌堆里最后一张同点数的牌
    let idx = -1;
    for (let i = this.table.length - 2; i >= 0; i -= 1) {
      if (this.table[i].rank === card.rank) { idx = i; break; }
    }

    if (idx >= 0) {
      this.awaiting = { seat, idx, count: this.table.length - idx, rank: card.rank };
      this.note({ seat, type: 'play', card, rank: card.rank, count: 0, hit: true });
      return { type: 'play', seat, card, pending: this.awaiting, caught: 0 };
    }

    this.lastCatch = null;
    this.note({ seat, type: 'play', card, rank: card.rank, count: 0, hit: false });
    if (!this.piles[0].length && !this.piles[1].length) this.finish();
    else this.nextTurn(seat);
    return { type: 'play', seat, card, caught: 0 };
  }

  /**
   * 决定这次钓不钓
   * @param {boolean} collect true = 收下；false = 先不收，继续攒
   */
  resolveCatch(collect) {
    if (!this.awaiting || this.over) return null;
    const { seat, idx, count, rank } = this.awaiting;
    this.awaiting = null;
    if (collect) {
      const taken = this.table.splice(idx);
      this.bucket[seat].push(...taken);
      this.score[seat] += taken.length;
      this.lastCatch = { seat, count: count, rank, doubled: false };
      // 一次钓到 5 张以上（不含 5）→ 本局倍数翻倍，越大越刺激（有上限，避免失控）
      if (taken.length >= FISHING.bigCatchMin) {
        this.bigCatches += 1;
        const before = this.multiplier;
        this.multiplier = Math.min(2 ** this.bigCatches, FISHING.maxMultiplier);
        this.lastCatch.doubled = this.multiplier > before;
      }
      this.note({ seat, type: 'collect', count, rank, total: this.score[seat] });
    } else {
      this.lastCatch = null;
      this.note({ seat, type: 'decline', count, rank });
    }
    if (!this.piles[0].length && !this.piles[1].length) this.finish();
    else this.nextTurn(seat);
    return { type: collect ? 'collect' : 'decline', seat, count, rank };
  }

  nextTurn(from) {
    const other = 1 - from;
    if (this.piles[other].length) this.turn = other;
    else if (this.piles[from].length) this.turn = from;
  }

  finish() {
    const [a, b] = this.score;
    this.winner = a === b ? -1 : (a > b ? 0 : 1);
  }
}
