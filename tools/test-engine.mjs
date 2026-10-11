/**
 * 对局状态机压力测试（node tools/test-engine.mjs）
 * 让 3 个机器人自动打完整局，校验不变量：能结束、豆子守恒、永不为负、倍数封顶生效
 */
import fs from 'node:fs';
import { Game, PHASE } from '../src/game/engine.js';
import { PERSONAS } from '../src/data/personas.js';
import { ROOMS } from '../src/config.js';
import { createDeck, shuffle, cutDeck } from '../src/core/cards.js';
import { LEVELS, LEVEL_BY_PERSONA, LEVEL_PARAMS, levelOf, levelParamsOf, levelCounts } from '../src/data/ddzLevels.js';
import { choosePlay, thinkDelay, THINK_MIN_MS, THINK_MAX_MS } from '../src/core/bot.js';

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); }
};

function drive(game) {
  let guard = 0;
  while (game.phase !== PHASE.OVER && guard < 5000) {
    guard += 1;
    if (game.phase === PHASE.BID) {
      const s = game.currentBidder;
      if (s == null) break;
      game.applyBid(s, game.decideBid(s, false));
    } else if (game.phase === PHASE.ROB) {
      const s = game.seatToAsk;
      if (s == null) break;
      game.applyRob(s, game.decideBid(s, true));
    } else if (game.phase === PHASE.PLAY) {
      const s = game.turnSeat;
      const play = game.decidePlay(s);
      const res = play ? game.applyPlay(s, play.cards) : game.applyPlay(s, []);
      ok(res.ok, `出牌应当合法：${JSON.stringify(res)}`);
      if (!res.ok) break;
    } else {
      break;
    }
  }
  return guard;
}

const ROUNDS = 300;
let finished = 0;
let springCount = 0;
let antiCount = 0;
let maxMult = 0;
let maxDelta = 0;
let totalRobs = 0;
const room = ROOMS[1]; // 中级场：底分 100 / 封顶 8192

for (let i = 0; i < ROUNDS; i += 1) {
  const beans = [100000, 100000, 100000];
  const personas = [null, PERSONAS[i % PERSONAS.length], PERSONAS[(i + 7) % PERSONAS.length]];
  const game = new Game({
    room,
    personas,
    names: ['你', '下家', '上家'],
    avatars: ['a', 'b', 'c'],
    beans,
    mode: 'ai',
  });
  const guard = drive(game);
  if (guard >= 5000) { console.log('  ✗ 出现无法结束的对局（死循环保护触发）'); fail += 1; break; }
  if (game.phase !== PHASE.OVER) continue;
  finished += 1;
  const r = game.result;
  if (r.spring) springCount += 1;
  if (r.antiSpring) antiCount += 1;
  maxMult = Math.max(maxMult, r.multiplier);
  totalRobs += r.robs;

  const before = r.beansBefore.reduce((a, b) => a + b, 0);
  const after = r.beansAfter.reduce((a, b) => a + b, 0);
  ok(before === after, `第 ${i + 1} 局豆子总量守恒（${before} → ${after}）`);
  ok(r.beansAfter.every((b) => b >= 0), `第 ${i + 1} 局不出现负数豆：${JSON.stringify(r.beansAfter)}`);
  ok(r.deltas.reduce((a, b) => a + b, 0) === 0, `第 ${i + 1} 局 delta 之和为 0`);
  ok(r.multiplier >= 1, '倍数至少为 1');
  ok(r.landlordSeat !== null, '地主已产生');
  const per = r.perHand;
  for (const f of [0, 1, 2].filter((s) => s !== r.landlordSeat)) {
    ok(Math.abs(r.deltas[f]) <= Math.min(per, room.cap) + 1e-6, `农民赔付不超过封顶：${r.deltas[f]}`);
    maxDelta = Math.max(maxDelta, Math.abs(r.deltas[f]));
  }
}

console.log('\n── 对局状态机（3 机器人自动对局）');
console.log(`  完成对局：${finished} / ${ROUNDS}`);
console.log(`  春天局数：${springCount}｜反春局数：${antiCount}`);
console.log(`  最大倍数：${maxMult}｜单笔最大输赢：${maxDelta} 豆（封顶 ${room.cap}）`);
console.log(`  平均每局抢地主次数：${(totalRobs / Math.max(1, finished)).toFixed(2)}`);
ok(finished === ROUNDS, `应当全部完成：${finished}/${ROUNDS}`);
ok(maxDelta <= room.cap, `单笔输赢不得超过封顶豆 ${room.cap}`);
ok(springCount >= 0 && antiCount >= 0, '春天统计正常');

/* ---------------- 不洗牌模式：只切牌，不彻底洗乱 ---------------- */
console.log('\n── 不洗牌（只切牌）：牌型保留度');
{
  // 1) 切牌只是"旋转"：牌张集合不变，且相邻关系只被切开一处
  const full = createDeck();
  const cut = cutDeck(full, 1, () => 0.37);
  ok(cut.length === full.length, `切牌不丢牌（${cut.length} 张）`);
  ok(new Set(cut.map((c) => c.id)).size === full.length, '切牌后每张牌都还在，且不重复');
  const cutOnce = full.slice(Math.floor(0.37 * 53) + 1);
  ok(cut[0].id === cutOnce[0].id, '切牌位置符合预期（可复现）');

  // 2) 不洗牌发出的牌，相邻点数"连着或相同"的对数明显更多（= 更容易成顺子/连对/对子）
  const conn = (deck) => {
    let n = 0;
    for (let i = 1; i < deck.length; i += 1) {
      const d = Math.abs(deck[i].rank - deck[i - 1].rank);
      if (d === 0 || d === 1) n += 1;
    }
    return n;
  };
  const cutDeckOnce = cutDeck(createDeck(), 1, () => 0.5);
  ok(conn(cutDeckOnce) >= conn(full) - 2,
    `只切牌几乎不损失相邻结构（切牌后 ${conn(cutDeckOnce)} vs 原序 ${conn(full)}）`);

  let cutSum = 0;
  let shuffleSum = 0;
  for (let i = 0; i < 200; i += 1) {
    cutSum += conn(cutDeck(createDeck(), 1 + (i % 3)));
    shuffleSum += conn(shuffle(createDeck()));
  }
  ok(cutSum / 200 > shuffleSum / 200 * 3,
    `不洗牌的牌型保留度远高于洗牌（${(cutSum / 200).toFixed(1)} vs ${(shuffleSum / 200).toFixed(1)} 对相邻）`);

  // 3) 真发一局：不洗牌模式下能正常开局、正常打完，且手牌里"连着的牌"更多
  const makeGame = (shuffleOn) => new Game({
    room,
    personas: [null, PERSONAS[0], PERSONAS[1]],
    names: ['你', '下家', '上家'],
    avatars: ['a', 'b', 'c'],
    beans: [100000, 100000, 100000],
    mode: 'ai',
    shuffleOn,
  });
  const gCut = makeGame(false);
  const gShuf = makeGame(true);
  const handConn = (g) => g.hands.reduce((sum, h) => {
    const sorted = h.map((c) => c.rank).sort((a, b) => a - b);
    let n = 0;
    for (let i = 1; i < sorted.length; i += 1) if (sorted[i] - sorted[i - 1] <= 1) n += 1;
    return sum + n;
  }, 0);
  ok(handConn(gCut) > handConn(gShuf), `不洗牌的手牌更容易连（${handConn(gCut)} vs ${handConn(gShuf)} 处相邻）`);
  const guard = drive(gCut);
  ok(guard < 5000 && gCut.phase === PHASE.OVER, '不洗牌模式下能正常打完一局');
}


/* ===================================================================== */
console.log('-- ★ 斗地主出牌：纯规则引擎 + 人设牌技档位（用户拍板：模型只说话）');
{
  ok(LEVELS.length === 4, `四档牌技（${LEVELS.join(' / ')}）`);
  ok(Object.keys(LEVEL_BY_PERSONA).length === PERSONAS.length,
    `★ 每个 AI 都有档位（${Object.keys(LEVEL_BY_PERSONA).length}/${PERSONAS.length}）`);
  const missing = PERSONAS.filter((p) => !LEVEL_BY_PERSONA[p.id]).map((p) => p.id);
  ok(missing.length === 0, '没有漏掉的人设', missing.join(','));
  ok(levelOf('不存在的人') === '熟练', '认不出来就按"熟练"兜底');
  const counts = levelCounts();
  ok(Object.values(counts).reduce((a, b) => a + b, 0) === PERSONAS.length, '各档人数加起来等于总人数');
  ok(['新手', '熟练', '高手', '大师'].every((lv) => LEVEL_PARAMS[lv]), '四档都有可读参数表');

  // "能一把走完"必须无条件走完（任何档位、任何随机源）—— 这是"最差也得勉强能玩"的底线
  const oneShot = [
    ['单张', [3]],
    ['对子', [3, 3]],
    ['三张', [3, 3, 3]],
    ['炸弹', [3, 3, 3, 3]],
    ['顺子', [3, 4, 5, 6, 7]],
    ['王炸', [16, 17]],
  ];
  for (const [label, ranks] of oneShot) {
    const hand = ranks.map((rank, i) => ({ rank, suit: rank >= 16 ? 'J' : 'SHDC'[i % 4] }));
    for (const lv of LEVELS) {
      for (const rnd of [() => 0, () => 0.5, () => 0.999]) {
        const out = choosePlay({ hand, last: null, seat: 1, landlordSeat: 1, level: lv, rnd });
        ok(out && out.cards && out.cards.length === hand.length,
          `★ ${lv} 手里能一把走完就走完（${label}）`);
      }
    }
  }
  // 不管怎么随机，选出来的牌都必须来自手里（合法性底线）
  const hand2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((rank, i) => ({ rank, suit: rank >= 16 ? 'J' : 'SHDC'[i % 4] }));
  for (const lv of LEVELS) {
    for (let i = 0; i < 60; i += 1) {
      const out = choosePlay({ hand: hand2.slice(), last: null, seat: 1, landlordSeat: 1, level: lv });
      if (!out) continue;
      const owned = new Set(hand2.map((c) => `${c.rank}-${c.suit}`));
      ok(out.cards.every((c) => owned.has(`${c.rank}-${c.suit}`)), `${lv} 出的牌都在手里`);
    }
  }
  // 思考延迟：用户拍板 1~5 秒，绝不能秒出
  ok(THINK_MIN_MS === 1000 && THINK_MAX_MS === 5000, '思考区间就是 1~5 秒');
  for (const lv of LEVELS) {
    for (let i = 0; i < 40; i += 1) {
      const d = thinkDelay(lv);
      ok(d >= 1000 && d <= 5000, `${lv} 的思考时长落在 1~5 秒（${d}ms）`);
    }
  }

  // 入口必须走引擎（不再问模型）
  const app = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const fn = (app.match(/async decideAiPlay\(seat\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/g\.decidePlay\(seat\)/.test(fn), '★ decideAiPlay 直接问规则引擎');
  ok(!/decidePlayWithLLM/.test(fn), '★ 出牌不再经过大模型');
  ok(!/import[^\n]*playBrain/.test(app), 'app.js 里已经不再 import 出牌的模型那条线（注释里提一句不算）');
  ok(/llmPlays: false/.test(fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')),
    '配置里也标明"出牌不走模型了"');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : `全部通过（${ROUNDS} 局自动对局无异常）`}`);
process.exit(fail ? 1 : 0);
