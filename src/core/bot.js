/**
 * 机器人出牌 AI（PRD §2.5.1 / §2.6）
 * ------------------------------------------------------------------
 * ★ 出牌 100% 走**规则引擎**，不再经过大模型（大模型只负责说话，见 ai/chat.js）。
 *   一次决策三步：
 *     ① 枚举合法牌型：core/rules.js 的 `findPlays(hand, last)` —— 候选**只可能**来自这里；
 *     ② 打分排序：能一把走完优先 / 用刚好压住的最小牌 / 不拆炸弹不拆结构 / 农民配合 /
 *        对手报单报双时压死 / 残局算"还要几手" / 记牌推理"这手是不是死牌"；
 *     ③ 按人设的**牌技档位**（data/ddzLevels.js：新手 / 熟练 / 高手 / 大师）决定
 *        "从前几名里挑、犯不犯懒、算不算牌" —— 同一手牌，四档打出来的强度明显不同。
 *
 * 硬约束：本文件的每一条返回路径都**只返回 findPlays 结果里的对象**（或 null = 不出），
 *         所以出的牌一定是合法牌型、且一定压得住上一手，engine 的校验永远不会被撞破。
 *         另外"能一把走完"是无条件优先的（四档一致）—— 绝不允许"明明能赢却不出"。
 */
import { TYPE, findPlays, analyze, canBeat } from './rules.js';
import { LEVEL_PARAMS, levelOfPersona, levelParamsOf, DEFAULT_LEVEL } from '../data/ddzLevels.js';

const SUIT_LOW = { J: 0, S: 0, H: 1, C: 2, D: 3 };

/** 假装思考的时长硬边界（用户拍板：1~5 秒之间；四档只是在这个区间里微调） */
export const THINK_MIN_MS = 1000;
export const THINK_MAX_MS = 5000;

/** 残局精算：每多花一手要扣多少分（够盖过几个点数的差距） */
const TRICK_VALUE = 55;
const SHAPE_VALUE = 12;
/** Hard limits for the bounded残局 search (also useful for regression tests). */
export const FINISH_SEARCH_LIMITS = Object.freeze({ depth: 8, beam: 14, plays: 12, expansions: 96 });
/** 残局精算的候选池：先粗排取前几，再把"还要几手"算进去 */
const REFINE_POOL = 12;

/* ------------------------------------------------------------------ */
/*                        牌力评分（叫地主用）                          */
/* ------------------------------------------------------------------ */

/** 手牌强度评分（用于叫地主 / 抢地主） */
export function handStrength(hand) {
  let score = 0;
  const m = new Map();
  for (const c of hand) m.set(c.rank, (m.get(c.rank) || 0) + 1);
  for (const [rank, n] of m) {
    if (rank === 17) score += 4.5;
    else if (rank === 16) score += 3.5;
    else if (rank === 15) score += 2 * n;
    else if (rank === 14) score += 1 * n;
    if (n === 4) score += 6;
  }
  if (m.get(16) && m.get(17)) score += 3;
  // 顺子潜力：小牌多加分
  const smalls = hand.filter((c) => c.rank <= 11).length;
  score += Math.max(0, smalls - 8) * 0.3;
  return score;
}

/** 叫地主 / 抢地主决策 */
export function wantLandlord(hand, persona) {
  const s = handStrength(hand);
  const style = persona?.style || 'balanced';
  const thresholds = { aggressive: 6.5, balanced: 8, cautious: 10 };
  const base = thresholds[style] ?? 8;
  return s + (Math.random() - 0.5) * 2.5 >= base;
}

/* ------------------------------------------------------------------ */
/*                          打分用的小工具                              */
/* ------------------------------------------------------------------ */

/** 跟牌时的“拆牌代价”：越小越好，0 = 不拆任何结构 */
function breakCost(hand, play) {
  const counts = new Map();
  for (const c of hand) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
  const used = new Map();
  for (const c of play.cards) used.set(c.rank, (used.get(c.rank) || 0) + 1);
  let cost = 0;
  for (const [rank, n] of used) {
    const total = counts.get(rank) || 0;
    if (total === 4 && n < 4) cost += 6; // 拆炸弹（把 4 张拆开用；整炸打出去不算拆）
    else if (total === 3 && n < 3) cost += 3; // 拆三张
    else if (total === 2 && n < 2) cost += 2; // 拆对子
    if (rank >= 16) cost += 4; // 单出大小王
    else if (rank === 15) cost += 2;
    else if (rank === 14) cost += 1;
  }
  return cost;
}

/** 已经打出去的牌（公开信息）→ 每个点数出了几张 */
function playedByRank(history) {
  const m = new Map();
  for (const h of history || []) {
    if (!h || !h.play || !h.play.cards) continue;
    for (const c of h.play.cards) m.set(c.rank, (m.get(c.rank) || 0) + 1);
  }
  return m;
}

/**
 * 记牌：每个点数还有几张**没露面**（= 一副牌的总张数 − 我手里的 − 已经打出去的）
 * 只用来推理"这一手对手管不管得上"，和合法性无关。
 * 一副牌：3~2 每个点数 4 张，大小王各 1 张（两副牌按 decks 翻倍）。
 */
function unseenCounts(hand, history, decks = 1) {
  const played = playedByRank(history);
  const mine = new Map();
  for (const c of hand) mine.set(c.rank, (mine.get(c.rank) || 0) + 1);
  const m = new Map();
  for (let r = 3; r <= 17; r += 1) {
    const total = (r >= 16 ? 1 : 4) * decks;
    m.set(r, Math.max(0, total - (played.get(r) || 0) - (mine.get(r) || 0)));
  }
  return m;
}

const unseenHas = (unseen, rank, n) => (unseen.get(rank) || 0) >= n;

/** 对手手里还可能凑出炸弹 / 王炸吗（记牌档位用；宁可保守） */
function oppMayHaveBomb(unseen, maxOpp) {
  if (!unseen) return false;
  if (maxOpp >= 2 && unseenHas(unseen, 16, 1) && unseenHas(unseen, 17, 1)) return true;
  if (maxOpp >= 4) {
    for (let r = 3; r <= 15; r += 1) if (unseenHas(unseen, r, 4)) return true;
  }
  return false;
}

/**
 * 记牌推理：这一手打出去，对手**按正常牌型**基本管不上吗？
 * 说明：这里只算"同型更大的牌"，炸弹/王炸单独用 oppMayHaveBomb 判断；
 *      长牌型的翅膀（三带一、飞机的带牌）没细算 —— 是启发式，不追求精确。
 */
function looksUnbeatable(play, unseen, maxOpp) {
  if (!unseen) return false;
  if (play.type === TYPE.ROCKET) return true;
  if (play.type === TYPE.BOMB) {
    if (maxOpp >= play.size) {
      for (let r = 3; r <= 15; r += 1) {
        if (r !== play.rank && unseenHas(unseen, r, play.size)) return false;
      }
    }
    return !(maxOpp >= 2 && unseenHas(unseen, 16, 1) && unseenHas(unseen, 17, 1));
  }
  const need = {
    [TYPE.SINGLE]: 1, [TYPE.PAIR]: 2, [TYPE.TRIO]: 3, [TYPE.TRIO1]: 3, [TYPE.TRIO2]: 3,
  }[play.type];
  if (need) {
    if (maxOpp < need) return true; // 对手手里张数都不够，压不了
    const top = need === 1 ? 17 : 15;
    for (let r = play.rank + 1; r <= top; r += 1) if (unseenHas(unseen, r, need)) return false;
    return true;
  }
  // 顺子 / 连对 / 飞机：还有更高的一段、同长度、张数够组得出来 → 就还算不上"管不上"
  const per = play.type === TYPE.STRAIGHT ? 1
    : play.type === TYPE.STRAIGHT_PAIR ? 2
      : (play.type === TYPE.PLANE || play.type === TYPE.PLANE1 || play.type === TYPE.PLANE2) ? 3 : 0;
  if (!per) return false; // 四带二之类不细算 → 当作"压得住"，不给奖励
  const len = play.type === TYPE.STRAIGHT ? play.size
    : play.type === TYPE.STRAIGHT_PAIR ? play.size / 2
      : play.size / (play.type === TYPE.PLANE ? 3 : play.type === TYPE.PLANE1 ? 4 : 5);
  if (!Number.isInteger(len) || len < 2) return false;
  if (maxOpp < len * per) return true;
  for (let top = play.rank + 1; top <= 14; top += 1) {
    const start = top - len + 1;
    if (start < 3) continue;
    let ok = true;
    for (let r = start; r <= top; r += 1) {
      if (!unseenHas(unseen, r, per)) { ok = false; break; }
    }
    if (ok) return false;
  }
  return true;
}

/**
 * 粗略估算"这手牌还要几手才能走完"（残局排序用，不要求精确）。
 * 做法：对候选拆分做有限宽度搜索，炸弹计为一手，估计后续手数。
 * 只在评分前几名调用，并限制搜索深度/宽度，避免影响对局响应。
 */
function shapeCost(cards) {
  const counts = new Map();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
  let singles = 0;
  let lowSingles = 0;
  for (const [rank, n] of counts) {
    if (n === 1) {
      singles += 1;
      if (rank <= 10) lowSingles += 1;
    }
  }
  // A low singleton is much harder to dispose of than a pair/trio.  This is
  // deliberately only a tie-breaker: a genuine one-turn finish still wins.
  return singles * 2 + lowSingles;
}

/**
 * Estimate the best remaining plan with a small beam search.  Unlike the old
 * greedy "take the longest play" rule, this keeps several decompositions, so
 * using one card from a pair for a long straight is not automatically treated
 * as progress.  It only uses our hand and public rules; no opponent cards are
 * inspected here.
 */
function rankMultisetKey(cards) {
  const counts = new Map();
  for (const c of cards) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
  return [...counts].sort((a, b) => a[0] - b[0]).map(([rank, n]) => `${rank}:${n}`).join('|');
}

function rankGroupTurns(cards) {
  const ranks = new Set(cards.map((c) => c.rank));
  // 每个同点数组可单独出；大小王组合可以作为王炸出掉。
  return ranks.size - (ranks.has(16) && ranks.has(17) ? 1 : 0);
}

function tricksToFinish(cards, search) {
  if (!cards.length) return 0;
  const key = rankMultisetKey(cards);
  if (search.memo.has(key)) return search.memo.get(key);
  let beam = [{ rest: cards.slice(), turns: 0 }];
  let best = rankGroupTurns(cards);
  for (let depth = 0; depth < FINISH_SEARCH_LIMITS.depth && beam.length; depth += 1) {
    const next = [];
    for (const state of beam) {
      if (!state.rest.length) {
        best = Math.min(best, state.turns);
        continue;
      }
      if (search.expansions >= search.limit) break;
      search.expansions += 1;
      const plays = findPlays(state.rest, null)
        .sort((a, b) => (b.size - a.size) || (a.rank - b.rank))
        .slice(0, FINISH_SEARCH_LIMITS.plays);
      for (const p of plays) {
        const used = new Set(p.cards.map((c) => c.id));
        const rest = state.rest.filter((c) => !used.has(c.id));
        const turns = state.turns + 1;
        best = Math.min(best, turns + rankGroupTurns(rest));
        if (!rest.length) best = Math.min(best, turns);
        else next.push({ rest, turns });
      }
    }
    next.sort((a, b) => {
      // Lower turn count and fewer remaining cards are better.  The previous
      // `-rest.length` accidentally preferred states with more cards left.
      const ca = a.turns * 100 + shapeCost(a.rest) * 5 + a.rest.length;
      const cb = b.turns * 100 + shapeCost(b.rest) * 5 + b.rest.length;
      return ca - cb;
    });
    const unique = new Map();
    for (const state of next) {
      const stateKey = rankMultisetKey(state.rest);
      const previous = unique.get(stateKey);
      if (!previous || state.turns < previous.turns) unique.set(stateKey, state);
    }
    beam = [...unique.values()].slice(0, FINISH_SEARCH_LIMITS.beam);
  }
  search.memo.set(key, best);
  return best;
}

/** 残局精算：把"出完这一手还要几手"算进分数（只精算前几名，够用且快） */
function refineByTricks(scored, hand, poolSize) {
  const top = scored.slice(0, Math.max(1, poolSize));
  const memo = new Map();
  // 公平分配预算：不能让排在前面的候选用光搜索，后面的候选被迫按逐张出牌计分。
  const limit = Math.max(1, Math.floor(FINISH_SEARCH_LIMITS.expansions / top.length));
  for (const item of top) {
    const used = new Set(item.p.cards.map((c) => c.id));
    const rest = hand.filter((c) => !used.has(c.id));
    item.score -= tricksToFinish(rest, { memo, expansions: 0, limit }) * TRICK_VALUE;
    item.score -= shapeCost(rest) * SHAPE_VALUE;
  }
  top.sort((a, b) => b.score - a.score);
  for (let i = 0; i < top.length; i += 1) scored[i] = top[i];
}

/** 按档位从"评分前 N 名"里挑（topN = 1 → 每次都选最优） */
function pickByLevel(scored, params, rnd) {
  const n = Math.max(1, Math.min(params.topN, scored.length));
  const item = scored[Math.floor(rnd() * n) % n] || scored[0];
  return item.p;
}

/* ------------------------------------------------------------------ */
/*                            出牌决策                                  */
/* ------------------------------------------------------------------ */
/**
 * 选择出牌（**纯规则引擎**：不调大模型，候选全部来自 findPlays）
 * @param {object} ctx
 *  hand        自己的手牌
 *  last        上一手牌型对象（带 seat）或 null（本轮首出）
 *  seat        自己座位；landlordSeat 地主座位
 *  counts      各家剩余张数（公开信息）
 *  persona     人设（决定牌技档位）
 *  history     最近的对局历史 [{ seat, play }]（记牌用，可省）
 *  level       可选：直接指定档位（测试/调试用，优先于 persona）
 *  rnd         可选：随机源（默认 Math.random）
 *  decks       可选：几副牌（默认 1）
 * @returns {object|null} 要出的牌（一定是 findPlays 里的合法牌型），或 null = 不出
 */
export function choosePlay({
  hand, last, seat, landlordSeat, counts, persona, history, level, rnd = Math.random, decks = 1,
}) {
  const plays = findPlays(hand, last);
  if (!plays.length) return null; // 没牌可出 → 不出（跟牌时合法；首出绝不会走到这里）

  const params = levelParamsOf(level || persona);
  const skillLevel = level || levelOfPersona(persona);
  // 熟练保留有限残局判断，但新手仍保留其原本的“犯懒”差异。
  const finishEnabled = params.finishAware || skillLevel === '熟练';
  const isLandlord = seat === landlordSeat;
  const teammateSeat = isLandlord ? -1 : [0, 1, 2].find((s) => s !== landlordSeat && s !== seat);
  const oppSeats = [0, 1, 2].filter((s) => s !== seat && s !== teammateSeat);
  const oppLeft = oppSeats.map((s) => counts?.[s] ?? 99);
  const maxOpp = oppLeft.length ? Math.max(...oppLeft) : 0;
  const minOpp = oppLeft.length ? Math.min(...oppLeft) : 99;
  const unseen = params.countCards ? unseenCounts(hand, history, decks) : null;
  /** 这一手是不是"对手基本管不上"（不记牌的档位只认大王） */
  const softPlay = (p) => (unseen ? looksUnbeatable(p, unseen, maxOpp) : p.rank >= 17);

  /* ---------- ① 能一把走完 → 无条件走完（四档一致，绝不允许"能赢不出"） ---------- */
  const finisher = plays.find((p) => p.size === hand.length);
  if (finisher) return finisher;

  /* ---------- ② 跟队友的牌：农民配合（必须先于犯懒） ---------- */
  if (last && teammateSeat >= 0 && last.seat === teammateSeat) {
    const mateLeft = counts?.[teammateSeat] ?? 99;
    if (mateLeft <= 2) return null; // 队友报单/报双：让队友走（四档一致）
    if (params.teamwork) return null; // 认队友：别抢自己人的牌
    if (rnd() < 0.7) return null; // 不认队友的新手，也大多不拦自己人
    return plays.find((p) => !p.isBomb) || null; // 偶尔手贱压一下队友（也只用小牌）
  }

  /* ---------- ③ 犯懒：直接丢手里最小的一手（新手专属的低级失误） ---------- */
  if (params.blunder > 0 && rnd() < params.blunder) return plays[0];

  /* ---------- ④ 跟对手的牌 ---------- */
  if (last) {
    const danger = params.pressDanger && minOpp <= 2; // 有对手报单/报双 → 必须压死
    const holdBomb = rnd() < params.bombSave; // 不是非压不可时，舍不舍得动炸弹
    const mayBomb = oppMayHaveBomb(unseen, maxOpp);

    // 只能靠炸弹才压得住：对手没报单、我手牌还多 → 干脆不出（留着炸弹）
    if (!danger && hand.length > 5 && holdBomb && !plays.some((p) => !p.isBomb)) return null;

    const scored = plays.map((p) => {
      if (danger) {
        // 对手要走了：优先"他管不上"的一手（炸弹 / 记牌算出来的死牌），否则拿最大的牌去压
        let score;
        if (p.isBomb) score = 930 - p.size * 4;
        else if (softPlay(p)) score = (mayBomb ? 850 : 1000) - p.rank;
        else score = 800 + p.rank * 3;
        return { p, score };
      }
      // 平常跟牌：用**刚好压住的最小牌**，不拆结构、不轻易动炸弹
      let score = 300 - p.rank * 10 - breakCost(hand, p) * params.breakWeight - p.size * 3;
      if (p.isBomb) score -= holdBomb ? 400 : 900;
      else if (softPlay(p) && !mayBomb) score += 10; // 记牌：这一手基本没人管得上
      if (!p.isBomb && hand.length <= 6) score += p.size * 2; // 手牌少了，尽量一次多走
      return { p, score };
    });
    scored.sort((a, b) => b.score - a.score);
    // 残局精算（高手 / 大师）：出完这一手还剩几手
    if (finishEnabled && !danger && hand.length <= 20) {
      refineByTricks(scored, hand, Math.max(params.topN, REFINE_POOL));
    }
    if (danger && minOpp === 1 && last.type === TYPE.SINGLE) {
      // Do not answer the last opponent card with a cheap card that leaves
      // another cheap singleton to feed them on the next lead.
      for (const item of scored) {
        if (item.p.type === TYPE.SINGLE) item.score += item.p.rank * 5;
      }
      scored.sort((a, b) => b.score - a.score);
    }
    return pickByLevel(scored, params, rnd);
  }

  /* ---------- ⑤ 首出 ---------- */
  {
    const threat = params.pressDanger && minOpp <= 2; // 有对手报单/报双
    const shortHand = hand.length <= 6;
    const scored = plays.map((p) => {
      // 长牌型优先（一次走很多张）、小牌优先、别拆结构
      // 长牌仍有基础奖励，但熟练及以上会让残局结构参与同一轮排序，
      // 避免“多出一张”粗暴覆盖少一手的真实收益。
      let score = p.size * 8 - p.rank * 3 - breakCost(hand, p) * params.breakWeight;
      if (p.isBomb && !shortHand) score -= 150; // 炸弹留到关键回合（手牌少了才主动放）
      if (hand.length > 6 && p.rank >= 15) score -= p.size === 1 ? 60 : 45; // 别一上来就丢 2 / 王
      if (threat) {
        // 对手报单报双：尽量出"他一手接不了"的牌型，别送他一张一张走
        if (p.size === 1) score -= 80;
        if (softPlay(p)) score += 90;
        if (minOpp === 1 && p.size === 1) score += p.rank * 5; // 只能出单张时，出最大的那张
      }
      return { p, score };
    });
    scored.sort((a, b) => b.score - a.score);
    if (finishEnabled && hand.length <= 20) {
      refineByTricks(scored, hand, Math.max(params.topN, REFINE_POOL));
    }
    return pickByLevel(scored, params, rnd);
  }
}

/**
 * 供 UI 显示“AI 思考中”的拟人化时长
 * ------------------------------------------------------------------
 * ★ 用户拍板：规则引擎是瞬间出牌的，所以要**故意延迟 1~5 秒假装在思考**。
 *   四档在这个区间里微调（新手手快、大师想得久），但绝不会低于 1 秒（不再"秒出"）。
 * @param {string|object} levelOrPersona 档位名（'新手'…）或人设对象 / personaId，可省
 */
export function thinkDelay(levelOrPersona) {
  const lv = (typeof levelOrPersona === 'string' && LEVEL_PARAMS[levelOrPersona])
    ? levelOrPersona
    : levelOfPersona(levelOrPersona);
  const band = (LEVEL_PARAMS[lv] || LEVEL_PARAMS[DEFAULT_LEVEL]).think;
  const lo = Math.max(THINK_MIN_MS, band[0]);
  const hi = Math.min(THINK_MAX_MS, Math.max(lo, band[1]));
  return Math.floor(lo + Math.random() * (hi - lo));
}

/** 校验一组牌是否可出（UI 用） */
export function validate(cards, last) {
  const play = analyze(cards);
  if (!play) return { ok: false, reason: '不是合法牌型' };
  if (!canBeat(play, last)) {
    return { ok: false, reason: last ? '管不上上一手牌' : '不能这样出牌' };
  }
  return { ok: true, play };
}

export { SUIT_LOW };
