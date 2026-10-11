/**
 * 对局状态机（PRD §2.4 / §5-Q1 / §5-Q4 / §5-Q6）
 * 座位：0 = 玩家（底部）｜1 = 下家（右上）｜2 = 上家（左上），逆时针出牌 0→1→2→0
 * 流程：发牌 → 叫地主 → 抢地主/反抢 → 出牌 → 结算
 */
import { createDeck, shuffle, cutDeck, sortDesc, handToString } from '../core/cards.js';
import { analyze, canBeat, countBombs, findPlays } from '../core/rules.js';
import { computeMultiplier, settleGame, detectSpring } from '../core/settle.js';
import { choosePlay, wantLandlord } from '../core/bot.js';
import { CONFIG } from '../config.js';

export const PHASE = {
  IDLE: 'idle',
  BID: 'bid',
  ROB: 'rob',
  PLAY: 'play',
  OVER: 'over',
};

export const SEAT_NAME = ['你', '下家', '上家'];

const nextSeat = (s) => (s + 1) % 3;

export class Game {
  /**
   * @param {object} opts
   *  room: ROOMS 中的一项
   *  personas: [null, personaA, personaB]（AI 模式）或 [null, null, null]（机器模式）
   *  names / avatars: 各座位显示信息
   *  beans: 开局前的豆子快照
   *  onEvent: (type, payload) => void
   */
  constructor({ room, personas, names, avatars, beans, mode = 'ai', shuffleOn = true, onEvent }) {
    this.room = room;
    this.personas = personas || [null, null, null];
    this.names = names || ['你', '下家', '上家'];
    this.avatars = avatars || ['avatar_01', 'avatar_02', 'avatar_03'];
    this.beans = beans.slice();
    this.mode = mode;
    this.shuffleOn = shuffleOn !== false;
    this.onEvent = onEvent || (() => {});
    this.round = 0;
    this.stats = { wins: 0, losses: 0 };
    this.startNewHand();
  }

  emit(type, payload) {
    this.onEvent(type, payload);
  }

  /* ------------------------------------------------------------------ */
  /*                              发牌                                   */
  /* ------------------------------------------------------------------ */
  startNewHand() {
    /*
     * 发牌方式：
     *  - 洗牌（默认）：每局把 54 张充分打乱
     *  - 不洗牌：用**原序的新牌只做 1~3 次切牌**（切开换个位置，不改变牌与牌的相邻关系）
     *    → 同一花色与连续点数扎堆，玩家更容易摸到顺子/连对/对子，牌型连、节奏快
     *      （注意：不是沿用上一局的牌序，只是没有彻底洗乱）
     */
    const deck = this.shuffleOn
      ? shuffle(createDeck())
      : cutDeck(createDeck(), 1 + Math.floor(Math.random() * 3));
    this.hands = [sortDesc(deck.slice(0, 17)), sortDesc(deck.slice(17, 34)), sortDesc(deck.slice(34, 51))];
    this.bottom = sortDesc(deck.slice(51, 54));
    this.phase = PHASE.BID;
    this.round += 1;
    this.landlordSeat = null;
    this.callerSeat = null;
    this.robCount = 0;
    this.robs = 0;
    this.bombs = 0;
    this.rockets = 0;
    this.playCounts = [0, 0, 0];
    this.lastPlay = null; // { seat, play }
    this.passCount = 0;
    this.history = []; // { seat, play|null }
    this.result = null;
    this.turnSeat = 0;
    this.deadline = 0;
    // 首位叫地主者随机（PRD §8-7）
    const starter = Math.floor(Math.random() * 3);
    this.bidQueue = [starter, nextSeat(starter), nextSeat(nextSeat(starter))];
    this.bidIndex = 0;
    this.robQueue = [];
    this.robIndex = 0;
    this.emit('hand:start', { round: this.round });
    this.emit('phase', { phase: this.phase, seat: this.bidQueue[0] });
  }

  /* ------------------------------------------------------------------ */
  /*                          叫地主 / 抢地主                            */
  /* ------------------------------------------------------------------ */
  get currentBidder() {
    if (this.phase === PHASE.BID) return this.bidQueue[this.bidIndex] ?? null;
    if (this.phase === PHASE.ROB) return this.robQueue[this.robIndex] ?? null;
    return null;
  }

  /** 叫地主：true = 叫 */
  applyBid(seat, call) {
    if (this.phase !== PHASE.BID || seat !== this.currentBidder) return { ok: false, error: '还没轮到你' };
    this.emit('bid', { seat, call });
    if (call && this.callerSeat === null) {
      this.callerSeat = seat;
      this.landlordSeat = seat;
    }
    // 规则：第一轮叫地主，第一个叫的人成为临时地主；其余人可在抢地主阶段抢
    if (this.callerSeat !== null) {
      const others = [nextSeat(this.callerSeat), nextSeat(nextSeat(this.callerSeat))];
      this.robQueue = others.slice();
      this.robIndex = 0;
      this.robbedByAnyone = false;
      this.phase = PHASE.ROB;
      this.emit('phase', { phase: this.phase, seat: this.robQueue[0] });
      return { ok: true };
    }
    this.bidIndex += 1;
    if (this.bidIndex >= this.bidQueue.length) {
      // 三家都不叫 → 流局重发（PRD Q1）
      this.emit('redeal', {});
      this.startNewHand();
      return { ok: true, redeal: true };
    }
    this.emit('phase', { phase: this.phase, seat: this.bidQueue[this.bidIndex] });
    return { ok: true };
  }

  /** 抢地主 / 反抢：true = 抢 */
  applyRob(seat, rob) {
    if (this.phase !== PHASE.ROB || seat !== this.seatToAsk) return { ok: false, error: '还没轮到你' };
    this.emit('rob', { seat, rob });
    if (rob && this.robs < CONFIG.maxRob) {
      this.robs += 1;
      this.robCount = this.robs;
      this.landlordSeat = seat;
      this.robbedByAnyone = true;
      this.emit('multiplier', { robCount: this.robs });
    }
    this.robIndex += 1;
    if (this.robIndex >= this.robQueue.length) {
      const alreadyAskedRecall = this.robQueue.includes('recall');
      const canRecall = this.robbedByAnyone && !alreadyAskedRecall && this.robs < CONFIG.maxRob;
      if (canRecall) {
        this.robQueue.push('recall'); // 原叫者获得一次反抢机会
      } else {
        this.beginPlay();
        return { ok: true };
      }
    }
    const entry = this.robQueue[this.robIndex];
    this.emit('phase', { phase: this.phase, seat: entry === 'recall' ? this.callerSeat : entry });
    return { ok: true };
  }

  /** 需要反抢时，当前该谁表态 */
  get seatToAsk() {
    if (this.phase !== PHASE.ROB) return null;
    const entry = this.robQueue[this.robIndex];
    if (entry === undefined) return null;
    return entry === 'recall' ? this.callerSeat : entry;
  }

  beginPlay() {
    this.phase = PHASE.PLAY;
    this.hands[this.landlordSeat] = sortDesc([...this.hands[this.landlordSeat], ...this.bottom]);
    this.emit('landlord', { seat: this.landlordSeat, bottom: this.bottom, robCount: this.robs });
    this.turnSeat = this.landlordSeat;
    this.lastPlay = null;
    this.passCount = 0;
    this.emit('phase', { phase: this.phase, seat: this.turnSeat });
  }

  /* ------------------------------------------------------------------ */
  /*                              出牌                                   */
  /* ------------------------------------------------------------------ */
  canPlayAt(seat) {
    return this.phase === PHASE.PLAY && this.turnSeat === seat;
  }

  /** 当前是否必须出牌（首出不能过牌） */
  mustPlay() {
    return !this.lastPlay;
  }

  applyPlay(seat, cards) {
    if (!this.canPlayAt(seat)) return { ok: false, error: '还没轮到你' };
    const isPass = !cards || cards.length === 0;
    if (isPass) {
      if (this.mustPlay()) return { ok: false, error: '该你首出，不能过牌' };
      this.passCount += 1;
      this.history.push({ seat, play: null });
      this.emit('play', { seat, play: null });
      if (this.passCount >= 2) {
        this.lastPlay = null;
        this.passCount = 0;
      }
      this.advance();
      return { ok: true, pass: true };
    }
    const play = analyze(cards);
    if (!play) return { ok: false, error: '不是合法牌型' };
    if (!canBeat(play, this.lastPlay ? this.lastPlay.play : null)) {
      return { ok: false, error: this.lastPlay ? '管不上上家的牌' : '不能这样出牌' };
    }
    const ids = new Set(cards.map((c) => c.id));
    if (cards.some((c) => !this.hands[seat].some((h) => h.id === c.id))) {
      return { ok: false, error: '牌不在手中' };
    }
    const remaining = this.hands[seat].filter((c) => !ids.has(c.id));
    this.hands[seat] = remaining;
    this.playCounts[seat] += 1;
    const { bombs, rockets } = countBombs(play);
    this.bombs += bombs;
    this.rockets += rockets;
    this.lastPlay = { seat, play };
    this.passCount = 0;
    this.history.push({ seat, play });
    this.emit('play', { seat, play });
    if (bombs || rockets) this.emit('multiplier', { bombs: this.bombs, rockets: this.rockets });
    if (remaining.length === 0) {
      this.finish(seat);
      return { ok: true, win: true };
    }
    this.advance();
    return { ok: true };
  }

  advance() {
    this.turnSeat = nextSeat(this.turnSeat);
    this.emit('phase', { phase: this.phase, seat: this.turnSeat });
  }

  /* ------------------------------------------------------------------ */
  /*                              结算                                   */
  /* ------------------------------------------------------------------ */
  finish(winnerSeat) {
    this.phase = PHASE.OVER;
    const landlordWin = winnerSeat === this.landlordSeat;
    const { spring, antiSpring } = detectSpring({
      landlordSeat: this.landlordSeat,
      landlordWin,
      playCounts: this.playCounts,
    });
    const { mult, factors } = computeMultiplier({
      robs: this.robs,
      bombs: this.bombs,
      rockets: this.rockets,
      spring,
      antiSpring,
    });
    const settle = settleGame({
      landlordSeat: this.landlordSeat,
      landlordWin,
      multiplier: mult,
      base: this.room.base,
      cap: this.room.cap,
      beans: this.beans,
    });
    const deltas = settle.deltas;
    const beansAfter = this.beans.map((b, i) => b + deltas[i]);
    this.result = {
      winnerSeat,
      landlordSeat: this.landlordSeat,
      landlordWin,
      multiplier: mult,
      factors,
      spring,
      antiSpring,
      deltas,
      beansBefore: this.beans.slice(),
      beansAfter,
      bombs: this.bombs,
      rockets: this.rockets,
      robs: this.robs,
      perHand: settle.perHand,
      detail: settle.detail,
    };
    const humanWin = (this.landlordSeat === 0) === landlordWin;
    if (humanWin) this.stats.wins += 1;
    else this.stats.losses += 1;
    this.beans = beansAfter;
    this.emit('over', this.result);
  }

  /* ------------------------------------------------------------------ */
  /*                          AI 决策辅助                                */
  /* ------------------------------------------------------------------ */
  publicInfo(seat) {
    return {
      seat,
      seatName: SEAT_NAME[seat],
      isLandlord: seat === this.landlordSeat,
      landlordSeat: this.landlordSeat,
      counts: this.hands.map((h) => h.length),
      handCount: this.hands[seat].length,
      lastPlay: this.lastPlay ? { seat: this.lastPlay.seat, text: handToString(this.lastPlay.play.cards), type: this.lastPlay.play.type } : null,
      bombs: this.bombs,
      rockets: this.rockets,
      robs: this.robs,
      history: this.history.slice(-12).map((h) => ({
        seat: h.seat,
        pass: !h.play,
        text: h.play ? handToString(h.play.cards) : null,
      })),
      base: this.room.base,
      cap: this.room.cap,
    };
  }

  /** AI 视角：自己的手牌 + 公开信息（PRD Q17：绝不包含他人手牌） */
  aiContext(seat) {
    return {
      hand: this.hands[seat].slice(),
      handText: handToString(this.hands[seat]),
      // 注意：这里要带上 seat —— bot 的"农民配合"判断用的是 last.seat，
      // 以前只传了牌型对象，导致那句判断永远不成立（AI 会去打自己队友的牌）
      last: this.lastPlay ? { ...this.lastPlay.play, seat: this.lastPlay.seat } : null,
      lastSeat: this.lastPlay ? this.lastPlay.seat : null,
      seat,
      landlordSeat: this.landlordSeat,
      counts: this.hands.map((h) => h.length),
      persona: this.personas[seat],
      isLandlord: seat === this.landlordSeat,
    };
  }

  /** 机器人：叫地主 / 抢地主 决策 */
  decideBid(seat, rob = false) {
    const persona = this.personas[seat];
    const want = wantLandlord(this.hands[seat], persona);
    if (!rob) return want;
    // 抢地主：手牌越强越敢抢；已经是地主候选时不抢自己
    if (seat === this.landlordSeat) return want && Math.random() < 0.45;
    return want;
  }

  /** 机器人：出牌决策（★ 纯规则引擎：core/bot.js 的 choosePlay，按人设的牌技档位打） */
  decidePlay(seat) {
    const ctx = this.aiContext(seat);
    return choosePlay({
      hand: ctx.hand,
      last: ctx.last,
      seat,
      landlordSeat: this.landlordSeat,
      counts: ctx.counts,
      persona: this.personas[seat],
      // 记牌用（公开信息）：高手 / 大师档位会拿它推算"这一手对手管不管得上"
      history: this.history,
    });
  }

  /** 玩家超时：能过则过，首出则自动打出最小合法牌（PRD Q4） */
  autoPlay(seat) {
    if (this.mustPlay()) {
      const plays = findPlays(this.hands[seat], null);
      if (plays.length) return this.applyPlay(seat, plays[0].cards);
    }
    return this.applyPlay(seat, []);
  }

  snapshot() {
    return {
      phase: this.phase,
      round: this.round,
      turnSeat: this.turnSeat,
      landlordSeat: this.landlordSeat,
      robs: this.robs,
      bombs: this.bombs,
      rockets: this.rockets,
      hands: this.hands.map((h) => h.slice()),
      bottom: this.bottom.slice(),
      lastPlay: this.lastPlay,
      passCount: this.passCount,
      beans: this.beans.slice(),
      result: this.result,
    };
  }
}
