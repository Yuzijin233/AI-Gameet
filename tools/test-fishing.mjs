/**
 * 小猫钓鱼逻辑测试（node tools/test-fishing.mjs）
 */
import { FishingGame, MAX_MOVES, settleFishing } from '../src/games/fishing.js';
import { fishingView } from '../src/ai/fishingView.js';
import { TITLES, titleById, titleGradient } from '../src/data/titles.js';
import { syncBeanTitles, buyTitle, equipTitle, equippedTitle, titleList, ensureTitleState, isTitleUnlocked } from '../src/store/titles.js';
import { Economy, todayStr } from '../src/store/economy.js';
import { defaultSave } from '../src/store/storage.js';
import { CONFIG, FISHING, FISHING_ROOMS } from '../src/config.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };

/* ---------------- 小猫钓鱼 ---------------- */
console.log('── 小猫钓鱼（计分版 + 可选择钓不钓）');
const GAMES = 800;
let ended = 0;
let wins = [0, 0, 0];
let totalMoves = 0;
let maxMoves = 0;
let minMoves = 1e9;
let totalCaught = 0;
let totalDelta = 0;
let declined = 0;
let collected = 0;
for (let g = 0; g < GAMES; g += 1) {
  const game = new FishingGame();
  ok(game.piles[0].length === 26 && game.piles[1].length === 26, '应当各发 26 张');
  const ids = new Set([...game.piles[0], ...game.piles[1]].map((c) => c.id));
  ok(ids.size === 52, '发牌应当是 52 张不重复的牌');
  let guard = 0;
  while (!game.over && guard < MAX_MOVES + 200) {
    guard += 1;
    if (game.awaiting) {
      // 模拟决策：够大就收，小的一半概率先攒着
      const a = game.awaiting;
      const collect = a.count >= 5 ? true : Math.random() < 0.5;
      const dec = game.resolveCatch(collect);
      if (dec.type === 'collect') collected += 1; else declined += 1;
    } else {
      game.play();
    }
    ok(game.totalCards === 52, '每一步牌总数应当守恒（手牌+中央+鱼篓 = 52）');
    ok(game.bucket[0].length === game.score[0] && game.bucket[1].length === game.score[1], '鱼篓里的牌数与计分一致');
    ok(game.table.length >= 0 && game.piles[0].length >= 0 && game.piles[1].length >= 0, '数量不应为负');
  }
  if (game.over) {
    ended += 1;
    wins[game.winner === -1 ? 2 : game.winner] += 1;
    totalMoves += game.moves;
    totalCaught += game.score[0] + game.score[1];
    totalDelta += settleFishing(game.score[0], game.score[1]).delta;
    maxMoves = Math.max(maxMoves, game.moves);
    minMoves = Math.min(minMoves, game.moves);
    ok(game.piles[0].length === 0 && game.piles[1].length === 0, '结束时双方手牌都应当出完');
    ok(game.awaiting === null, '结束时不应还挂着未决定的机会');
    if (game.winner >= 0) {
      ok(game.score[game.winner] > game.score[1 - game.winner], '胜者的鱼篓应当更多');
    } else {
      ok(game.score[0] === game.score[1], '平局时双方鱼篓相同');
    }
  }
}
console.log(`  完成 ${ended}/${GAMES} 局；先手胜 ${wins[0]}、后手胜 ${wins[1]}、平局 ${wins[2]}`);
console.log(`  翻牌步数：平均 ${(totalMoves / Math.max(1, ended)).toFixed(0)}（最少 ${minMoves}，最多 ${maxMoves}）`);
console.log(`  平均每局钓到的牌：${(totalCaught / Math.max(1, ended)).toFixed(1)} 张`);
console.log(`  「收下」${collected} 次 vs 「先不收」${declined} 次`);
console.log(`  原始采样期望 ${(totalDelta / Math.max(1, ended)).toFixed(1)} 豆/局（单局波动上千，采样噪声很大，仅供参考）`);
ok(ended === GAMES, '所有对局都应正常结束');
ok(totalMoves / ended <= 60, `一局应当在 60 次翻牌内结束（实际 ${(totalMoves / ended).toFixed(0)}）`);
ok(declined > 0, '应当出现「先不收」的选择');
ok(collected > 0, '应当出现「收下」的选择');

/* ---------------- 攒大鱼：先不收之后能钓到更多 ---------------- */
console.log('── 攒大鱼（用户举的例子：7 3 2 7）');
{
  const C = (rank, suit, id) => ({ id, rank, suit });
  const game = new FishingGame();
  game.piles = [[C(7, 'S', 900), C(7, 'C', 905), C(8, 'H', 901)], [C(9, 'C', 902), C(4, 'D', 903)]];
  game.table = [C(7, 'H', 1), C(3, 'S', 2), C(2, 'C', 3), C(7, 'D', 4)];
  game.bucket = [[], []];
  game.score = [0, 0];
  game.turn = 0;
  game.awaiting = null;
  game.winner = null;

  const r1 = game.play(); // 我翻出 7
  ok(!!r1.pending, '出现同点数时应当先询问，而不是强制收走');
  ok(r1.pending.count === 2, `现在收只能拿到 2 张（实际 ${r1.pending.count}）`);
  ok(game.turn === 0, '等待决定时不换手');
  const d1 = game.resolveCatch(false); // 先不收
  ok(d1.type === 'decline', '可以「先不收」');
  ok(game.table.length === 5, `先不收时牌留在中央（7 3 2 7 7，实际 ${game.table.length} 张）`);
  ok(game.score[0] === 0, '先不收不加分');
  ok(game.turn === 1, '决定之后才换手');

  game.play(); // 对手翻 9（不匹配）
  const r3 = game.play(); // 我再翻 7 —— 这次能收更多
  ok(!!r3.pending, '再次钓到时仍会出现选择');
  ok(r3.pending.count > 2, `攒过之后能钓到更多（现在 ${r3.pending.count} 张 > 之前 2 张）`);
  const d3 = game.resolveCatch(true);
  ok(d3.type === 'collect', '可以「收下」');
  ok(game.score[0] === r3.pending.count, '收下后计入鱼篓');
  ok(game.bucket[0].length === game.score[0], '鱼篓里确实有这些牌');
}

/* ---------------- 小猫钓鱼的发言触发（每次收牌都要说） ---------------- */
console.log('── 小猫钓鱼发言触发');
{
  const GAP_SELF = CONFIG.ai.fishMinGap; // 小猫钓鱼用的最小间隔
  let totalLines = 0;
  let collectLines = 0;
  let totalCollects = 0;
  let bigSelf = 0;
  let bigOther = 0;
  let smallTalk = 0;
  const RUNS = 200;
  for (let g = 0; g < RUNS; g += 1) {
    const game = new FishingGame();
    let clock = 0;
    let lastSpoke = -1e9;
    const trySpeak = () => {
      if (clock - lastSpoke < GAP_SELF) return false;
      lastSpoke = clock;
      return true;
    };
    let guard = 0;
    while (!game.over && guard < MAX_MOVES + 200) {
      guard += 1;
      if (game.awaiting) {
        const a = game.awaiting;
        const collect = a.count >= 5 ? true : Math.random() < 0.5;
        const dec = game.resolveCatch(collect);
        clock += 500;
        if (dec.type === 'collect') {
          totalCollects += 1;
          // 与 app.fishSayCatch 相同：收牌就说（priority 绕过全局间隔）
          if (trySpeak()) {
            totalLines += 1;
            collectLines += 1;
            const big = dec.count >= FISHING.bigCatchMin;
            if (dec.seat === 1) { if (big) bigSelf += 1; else smallTalk += 1; } else if (big) bigOther += 1; else smallTalk += 1;
          }
        } else if (Math.random() < 0.3 && trySpeak()) {
          totalLines += 1;
        }
      } else {
        game.play();
        clock += 1200;
      }
    }
  }
  const perGame = totalLines / RUNS;
  const cover = collectLines / totalCollects;
  console.log(`  ${RUNS} 局：收牌 ${totalCollects} 次，对手发言 ${totalLines} 句（每局 ${perGame.toFixed(1)} 句）`);
  console.log(`  收牌覆盖率 ${(cover * 100).toFixed(0)}%（差额只来自同一 AI 的 ${GAP_SELF / 1000} 秒最小间隔）`);
  console.log(`  大丰收：自己 ${bigSelf} / 玩家 ${bigOther}；小丰收也说话 ${smallTalk} 次`);
  ok(cover >= 0.98, `每一次收牌都应当说上话（覆盖率 ${(cover * 100).toFixed(0)}%）`);
  ok(smallTalk > 0, '小鱼小虾也要有台词，不能只有大丰收才开口');
  ok(bigSelf > 0, '对手自己钓到大鱼时会说话');
  ok(bigOther > 0, '玩家钓到大鱼时对手会说话');
  // 不设产品意义上的发言上限（每次收牌都说）；200 句只是防跑飞的兜底
  ok(perGame <= 200, `发言量兜底检查：不应失控（实际 ${perGame.toFixed(1)} 句/局）`);
}

/* ---------------- 按差距结算 ---------------- */
console.log('── 小猫钓鱼结算（按鱼篓差距给豆）');
{
  ok(settleFishing(20, 20).delta === 0, '五五开双方都是 0');
  ok(settleFishing(20, 20).kind === 'draw', '五五开判为平局');
  ok(settleFishing(0, 0).delta === 0, '0:0 也是 0');
  const w1 = settleFishing(21, 20);
  const w5 = settleFishing(30, 20);
  const l1 = settleFishing(20, 21);
  const l5 = settleFishing(20, 30);
  ok(w1.delta > 0, '赢加豆');
  ok(l1.delta < 0, '输扣豆');
  ok(w5.delta > w1.delta, '差距越大赢的越多');
  ok(l5.delta < l1.delta, '差距越大扣的越多');
  ok(w5.delta > Math.abs(l5.delta), '同样差距下赢得比输得多（期望偏正）');
  ok(settleFishing(52, 0).delta > 0 && settleFishing(0, 52).delta < 0, '极端差距也能正常结算');

  // 曲线要越悬殊越陡峭：增量必须单调递增（凸函数）
  let nonConvex = 0;
  let prevInc = -1;
  for (let d = 1; d <= 26; d += 1) {
    const inc = settleFishing(26 + d, 26).base - settleFishing(26 + d - 1, 26).base;
    if (prevInc >= 0 && inc <= prevInc) nonConvex += 1;
    prevInc = inc;
  }
  ok(nonConvex === 0, `曲线应当是越悬殊越陡峭的凸函数（异常 ${nonConvex} 处）`);
  ok(settleFishing(26 + 20, 26).base > settleFishing(26 + 10, 26).base * 2, '差 20 张的基数应当远超差 10 张的两倍');
  ok(settleFishing(52, 26).delta > 2000, `悬殊时能博一大把（差 26 张赢 ${settleFishing(52, 26).delta}）`);
  ok(settleFishing(52, 0).delta > 8000, `理论上限很可观（26:0 通吃赢 ${settleFishing(52, 0).delta}）`);

  let bad = 0;
  for (let d = -52; d <= 52; d += 1) {
    const r = settleFishing(26 + d, 26);
    if ((d === 0) !== (r.delta === 0)) bad += 1;
    if (d !== 0 && Math.sign(r.delta) !== Math.sign(d)) bad += 1;
  }
  ok(bad === 0, `所有差距档位判定正确（错误 ${bad} 处）`);
  const ev = totalDelta / Math.max(1, ended);
  // 单局波动远大于期望，采样符号不可靠；这里只做量级提示，严格结论放在场次一节
  ok(Number.isFinite(ev), '采样期望应当是有限数');
  const show = (d) => `差${d}:赢${settleFishing(26 + d, 26).delta}/输${Math.abs(settleFishing(26 - d, 26).delta)}`;
  console.log(`  档位｜${[1, 3, 5, 10, 15, 20].map(show).join('  ')}`);
}

/* ---------------- 三个场次 ---------------- */
console.log('── 小猫钓鱼场次（低 / 中 / 高）');
{
  ok(FISHING_ROOMS.length === 3, '应当有三个场次');
  const [low, mid, high] = FISHING_ROOMS;
  ok(low.id === 'low' && mid.id === 'mid' && high.id === 'high', '场次 id 正确');
  ok(FISHING_ROOMS.every((r) => r.minBeans > 0), '每个场次都要有入场门槛');
  ok(low.minBeans < mid.minBeans && mid.minBeans < high.minBeans, '门槛应当递增');

  // 低级场 = 原来的手感
  ok(low.cube === 0, '低级场是二次曲线');
  ok(settleFishing(36, 26, low).base === 420, `低级场差 10 张基数应为 420（实际 ${settleFishing(36, 26, low).base}）`);

  // 中级场 = 低级场 ×10
  let ratioBad = 0;
  for (let d = 1; d <= 26; d += 1) {
    const a = settleFishing(26 + d, 26, low).base;
    const b = settleFishing(26 + d, 26, mid).base;
    if (b !== a * 10) ratioBad += 1;
  }
  ok(ratioBad === 0, `中级场应当恰好是低级场的 10 倍（异常 ${ratioBad} 处）`);
  ok(mid.cube === 0, '中级场仍是二次曲线');

  // 高级场 = 低级场 ×15 且升到三次方
  ok(high.cube > 0, '高级场应当是三次曲线');
  const highRatio = settleFishing(36, 26, high).perCard !== undefined ? null : null;
  void highRatio;
  ok(settleFishing(26 + 10, 26, high).base > settleFishing(26 + 10, 26, mid).base, '高级场差 10 张应当高于中级场');
  ok(settleFishing(26 + 20, 26, high).base > settleFishing(26 + 20, 26, mid).base * 3, '差距拉大后高级场应当甩开中级场');
  // 三次曲线：二阶差分（增量）本身还在变大
  let notCubic = 0;
  let prevInc2 = -1;
  for (let d = 1; d <= 26; d += 1) {
    const inc = settleFishing(26 + d, 26, high).base - settleFishing(26 + d - 1, 26, high).base;
    const inc2 = prevInc2 < 0 ? -1 : inc - prevInc2;
    if (prevInc2 >= 0 && inc2 <= 0) notCubic += 1;
    prevInc2 = inc;
  }
  ok(notCubic === 0, `高级场应当是三次曲线（增量本身递增，异常 ${notCubic} 处）`);

  // 期望：单局波动远大于期望，采样符号不可靠。
  // 严格结论来自「结构性检验」：只要每个差距档位赢得都比输得多，
  // 在胜负近似对称的对局分布下，长期期望必然 > 0。
  const gaps = [];
  let multiGames = 0;
  let maxMult = 1;
  for (let g = 0; g < 300; g += 1) {
    const game = new FishingGame();
    let guard = 0;
    while (!game.over && guard < MAX_MOVES + 200) {
      guard += 1;
      if (game.awaiting) {
        const a = game.awaiting;
        game.resolveCatch(a.count >= 5 ? true : Math.random() < 0.5);
      } else game.play();
    }
    gaps.push({ gap: game.score[0] - game.score[1], mult: game.multiplier });
    if (game.multiplier > 1) multiGames += 1;
    maxMult = Math.max(maxMult, game.multiplier);
  }
  const winRate = gaps.filter((r) => r.gap > 0).length / gaps.length;
  ok(Math.abs(winRate - 0.5) < 0.12, `对局胜负应当接近五五开（实测胜率 ${(winRate * 100).toFixed(0)}%）`);

  const baseOf = (room, d) => Math.round(room.perCard * d + room.quad * d * d + (room.cube || 0) * d * d * d);
  // 对称分布下的解析期望：每局贡献 (赢赔付 − 输赔付)/2（含本局倍数）
  const symEv = (room) => {
    let sum = 0;
    for (const { gap, mult } of gaps) {
      if (gap === 0) continue;
      const base = baseOf(room, Math.abs(gap)) * mult;
      sum += (base * FISHING.winFactor - base * FISHING.loseFactor) / 2;
    }
    return sum / gaps.length;
  };
  const meanAbs = (room) => {
    let sum = 0;
    for (const { gap, mult } of gaps) {
      if (gap !== 0) sum += baseOf(room, Math.abs(gap)) * mult * (FISHING.winFactor + FISHING.loseFactor) / 2;
    }
    return sum / gaps.length;
  };

  const evs = FISHING_ROOMS.map(symEv);
  ok(evs.every((v) => v > 0), `三场期望都应当大于 0（${evs.map((v) => v.toFixed(1)).join(' / ')}）`);
  ok(FISHING_ROOMS.every((r, i) => evs[i] / meanAbs(r) < 0.06), '期望应当只是单局波动的一小部分（“略微”）');
  ok(evs[1] > evs[0] * 9.9 && evs[1] < evs[0] * 10.1, `中级场期望应当是低级场的 10 倍（${(evs[1] / evs[0]).toFixed(2)}×）`);
  ok(evs[2] > evs[1], '高级场期望应当高于中级场');
  const lv = (r, d) => Math.abs(settleFishing(26 + d, 26, r).delta).toLocaleString();
  console.log(`  门槛：${FISHING_ROOMS.map((r) => `${r.name} 💰${r.minBeans}`).join(' / ')}`);
  console.log(`  差 10 张：低级 ±${lv(low, 10)}　中级 ±${lv(mid, 10)}　高级 ±${lv(high, 10)}`);
  console.log(`  差 20 张：低级 ±${lv(low, 20)}　中级 ±${lv(mid, 20)}　高级 ±${lv(high, 20)}`);
  console.log(`  对称期望：${evs.map((v, i) => `${FISHING_ROOMS[i].name} +${v.toFixed(1)}`).join(' / ')} 豆/局（占单局波动 ${(evs[0] / meanAbs(low) * 100).toFixed(1)}%）`);
  const dist = {};
  for (const { mult } of gaps) dist[mult] = (dist[mult] || 0) + 1;
  console.log(`  倍数分布：${Object.entries(dist).map(([k, v]) => `×${k}:${v}局`).join('  ')}`);
  ok(maxMult >= 2, '实战中应当出现过倍数（说明触发条件可达）');
  ok(maxMult <= FISHING.maxMultiplier, `倍数不得超过上限 ×${FISHING.maxMultiplier}（实际最高 ×${maxMult}）`);
  ok(dist[1] > 0, '应当有没吃到倍数的对局');
}

/* ---------------- 倍数：一次钓够 bigCatchMin 张就翻倍 ---------------- */
console.log(`── 倍数（一次钓 ${FISHING.bigCatchMin} 张以上翻倍，上限 ×${FISHING.maxMultiplier}）`);
{
  const C = (rank, suit, id) => ({ id, rank, suit });
  /** 造一个局面：中央第 0 张与本方要翻的牌同点数（填充牌里不能再出现 7），翻完正好能收 n 张 */
  const FILL = [3, 4, 5, 6, 8, 9, 10, 11, 12, 13];
  const mk = (n, idBase = 100) => {
    const g = new FishingGame();
    const tableRanks = [7];
    for (let i = 1; i < n - 1; i += 1) tableRanks.push(FILL[i % FILL.length]);
    g.piles = [[C(7, 'S', 900), C(8, 'H', 901)], [C(9, 'C', 902)]];
    g.table = tableRanks.map((r, i) => C(r, 'D', idBase + i));
    g.bucket = [[], []];
    g.score = [0, 0];
    g.turn = 0;
    g.awaiting = null;
    g.winner = null;
    g.multiplier = 1;
    g.bigCatches = 0;
    return g;
  };
  const MIN = FISHING.bigCatchMin;

  // 差一张（MIN-1）：不翻倍
  let g = mk(MIN - 1);
  g.play();
  ok(g.awaiting && g.awaiting.count === MIN - 1, `应当能收 ${MIN - 1} 张（实际 ${g.awaiting && g.awaiting.count}）`);
  g.resolveCatch(true);
  ok(g.multiplier === 1, `收 ${MIN - 1} 张不翻倍（实际 ×${g.multiplier}）`);

  // 刚好 MIN 张：翻倍
  g = mk(MIN);
  g.play();
  ok(g.awaiting && g.awaiting.count === MIN, `应当能收 ${MIN} 张（实际 ${g.awaiting && g.awaiting.count}）`);
  const dec = g.resolveCatch(true);
  ok(dec.type === 'collect', '收下');
  ok(g.multiplier === 2, `收 ${MIN} 张应当把倍数翻倍（实际 ×${g.multiplier}）`);
  ok(g.lastCatch.doubled === true, '这次应当标记为“翻倍了”');

  // 连续两次大丰收：×4
  g.table = mk(MIN).table.slice();
  g.piles = [[C(7, 'S', 900)], [C(6, 'H', 300)]];
  g.turn = 0;
  g.play();
  g.resolveCatch(true);
  ok(g.multiplier === 4, `两次大丰收应当 ×4（实际 ×${g.multiplier}）`);
  ok(g.bigCatches === 2, '大丰收计数应当为 2');
  ok(g.bucket[0].length === g.score[0], '鱼篓里的牌数与计分一致');

  // 结算是倍数的线性放大（注意最终才取整，允许 1~2 豆的取整误差）
  const [lowRoom] = FISHING_ROOMS;
  const m1 = settleFishing(36, 26, lowRoom, undefined, 1).delta;
  const m2 = settleFishing(36, 26, lowRoom, undefined, 2).delta;
  const m4 = settleFishing(36, 26, lowRoom, undefined, 4).delta;
  ok(Math.abs(m2 - m1 * 2) <= 1 && Math.abs(m4 - m1 * 4) <= 2, `赢的结算按倍数线性放大（${m1} / ${m2} / ${m4}）`);
  const base = settleFishing(36, 26, lowRoom).base;
  const loss4 = settleFishing(26, 36, lowRoom, undefined, 4).delta;
  ok(Math.abs(loss4 + Math.round(base * FISHING.loseFactor * 4)) <= 2, `输的结算也按倍数放大（${loss4}）`);
  ok(settleFishing(26, 26, lowRoom, undefined, 8).delta === 0, '平局时无论倍数都是 0');

  // 倍数上限：连吃多次大鱼也不会超过上限
  const g2 = mk(MIN);
  for (let i = 0; i < 6; i += 1) {
    g2.table = mk(MIN, 300 + i * 20).table.slice();
    g2.piles = [[C(7, 'S', 900 + i)], [C(6, 'H', 950 + i)]];
    g2.turn = 0;
    g2.play();
    g2.resolveCatch(true);
  }
  ok(g2.multiplier === FISHING.maxMultiplier, `连吃 6 次大鱼后倍数应封顶在 ×${FISHING.maxMultiplier}（实际 ×${g2.multiplier}）`);
  ok(g2.bigCatches === 6, '大丰收次数照常累计');
  ok(g2.lastCatch.doubled === false, '已经封顶后不应再标记“翻倍了”（避免误导玩家）');
}

/* ---------------- 称号 ---------------- */
console.log('── 称号系统');
{
  const save = defaultSave();
  save.beans = 0;
  ensureTitleState(save);
  let got = syncBeanTitles(save);
  ok(got.some((t) => t.id === 't_poor'), '0 豆应当解锁「穷光蛋」');
  ok(equippedTitle(save)?.id === 't_poor', '没有佩戴时自动戴上已解锁的最高档');

  save.beans = 50000;
  got = syncBeanTitles(save);
  ok(got.some((t) => t.id === 't_lucky'), '5 万豆应当解锁「手气不错」');
  ok(!got.some((t) => t.id === 't_rich'), '还不该解锁十万档');
  ok(equippedTitle(save)?.id === 't_lucky', '未手动选择时自动升到最高档');

  save.beans = 100000;
  syncBeanTitles(save);
  ok(equippedTitle(save)?.id === 't_rich', '自动佩戴应当升到「豆子大户」');

  // 购买
  const eco = new Economy(save, () => {});
  eco.save.beans = 1000;
  let buy = buyTitle(eco, 't_rookie');
  ok(!buy.ok, '豆子不足时不能购买称号');
  eco.save.beans = 20000;
  buy = buyTitle(eco, 't_rookie');
  ok(buy.ok, '豆子足够时可以购买称号');
  ok(eco.beans === 15000, `购买应当扣豆（20000-5000=15000，实际 ${eco.beans}）`);
  ok(buyTitle(eco, 't_rookie').ok === false, '不能重复购买');
  ok(buyTitle(eco, 't_poor').ok === false, '按身家解锁的称号不能购买');
  ok(equipTitle(save, 't_rookie').ok, '可以佩戴已拥有的称号');
  ok(equippedTitle(save)?.id === 't_rookie', '佩戴生效');
  ok(equipTitle(save, 't_legend').ok === false, '不能佩戴未拥有的称号');
  ok(equipTitle(save, '').ok, '可以卸下称号');
  ok(equippedTitle(save) === null, '卸下后没有佩戴称号');
  save.beans = 20000000;
  syncBeanTitles(save);
  ok(equippedTitle(save) === null, '手动卸下后不再自动佩戴');

  const list = titleList(save);
  ok(list.length === TITLES.length, '列表应当包含全部称号');
  ok(list.every((t) => typeof t.unlocked === 'boolean' && typeof t.equipped === 'boolean'), '列表项状态字段完整');
  ok(titleGradient(titleById('t_legend')).startsWith('linear-gradient'), '渐变生成正常');

  /* 连续签到 8 天赠送「劳模」 */
  const labor = titleById('t_labor');
  ok(!!labor && labor.kind === 'signin' && labor.days === 8, '「劳模」是"连续签到 8 天"赠送的称号');

  const s7 = defaultSave();
  ensureTitleState(s7);
  s7.signIn = { lastDate: '2024-01-07', streak: 7 };
  ok(!syncBeanTitles(s7).some((t) => t.id === 't_labor'), '连续 7 天还不给「劳模」');
  ok(!isTitleUnlocked(s7, 't_labor'), '连续 7 天时「劳模」未解锁');
  ok(titleList(s7).find((t) => t.id === 't_labor').progress === 7, '面板显示签到进度 7/8');

  s7.signIn = { lastDate: '2024-01-08', streak: 8 };
  ok(syncBeanTitles(s7).some((t) => t.id === 't_labor'), '连续 8 天赠送「劳模」');
  ok(isTitleUnlocked(s7, 't_labor'), '「劳模」进入已解锁列表');
  s7.signIn = { lastDate: '2024-02-01', streak: 1 };
  syncBeanTitles(s7);
  ok(isTitleUnlocked(s7, 't_labor'), '断签后已拿到的「劳模」不会被收回');

  // 真实签到流程：连续第 8 天签到时当场拿到
  const s8 = defaultSave();
  ensureTitleState(s8);
  s8.signIn = { lastDate: todayStr(new Date(Date.now() - 86400000)), streak: 7 };
  const eco8 = new Economy(s8, () => {});
  const r8 = eco8.signIn();
  ok(r8.ok && r8.streak === 8, `连续签到第 8 天（实际 streak=${r8.streak}）`);
  ok(syncBeanTitles(s8).some((t) => t.id === 't_labor'), '第 8 天签到当场赠送「劳模」');
  ok(equipTitle(s8, 't_labor').ok, '「劳模」可以佩戴');
  ok(equippedTitle(s8)?.id === 't_labor', '佩戴「劳模」生效');
}

/* ---------------- AI 视图：不能把"我的牌"和"你的牌"搞反 ---------------- */
console.log('── AI 钓鱼视图（座位不能写反）');
{
  const mkCards = (n) => Array.from({ length: n }, (_, i) => ({ id: i, rank: 3 + (i % 9), suit: 'S' }));
  const game = {
    piles: [mkCards(12), mkCards(7)], // 0 = 玩家手上 12 张，1 = AI 手上 7 张
    score: [7, 3], // 0 = 玩家鱼篓 7 张（领先），1 = AI 鱼篓 3 张
    bucket: [[], []],
    table: mkCards(5),
    multiplier: 2,
    lastCatch: { seat: 1, count: 4, rank: 9 },
    recentLog: () => ([
      { seat: 0, type: 'collect', count: 3, rank: 5, total: 7 },
      { seat: 1, type: 'play', card: { rank: 9 }, rank: 9, hit: true, count: 0 },
      { seat: 1, type: 'collect', count: 4, rank: 9, total: 3 },
      { seat: 0, type: 'decline', count: 2, rank: 5 },
    ]),
  };
  const v = fishingView({ game, seat: 1 });

  ok(v.handReportLine.includes('你的鱼篓 3 张'), `AI 视角的鱼篓取 score[1]（实际：${v.handReportLine}）`);
  ok(v.countsText.includes('你（AI）手上还剩 7 张、鱼篓 3 张'),
    `AI 自己的牌数取 piles[1]/score[1]（实际：${v.countsText}）`);
  ok(v.countsText.includes('对手（玩家）手上还剩 12 张、鱼篓 7 张'),
    '玩家的牌数取 piles[0]/score[0]，不能和 AI 的搞反');
  ok(v.countsText.includes('中央牌堆 5 张'), '中央牌堆张数也在提示词里');
  ok(v.lastText.includes('你刚一次钓走 4 张'), `lastCatch.seat=1 时是"你"（实际：${v.lastText}）`);
  ok(v.historyText.includes('对手收了 3 张'), '日志里 seat=0 显示为"对手"');
  ok(v.historyText.includes('你收了 4 张'), '日志里 seat=1 显示为"你"');
  ok(v.historyText.includes('对手先不收'), '日志里"先不收"也要能看懂');
  ok(v.historyLabel.includes('操作'), '钓鱼用的是"操作"而不是"出牌"');

  // 反过来：seat=0 时同一份数据要翻转过来（证明映射是通用的，不是写死的）
  const v0 = fishingView({ game, seat: 0 });
  ok(v0.countsText.includes('你（AI）手上还剩 12 张、鱼篓 7 张'), 'seat=0 时视图跟着翻转');
}

/* ---------------- 记牌器：牌堆里每个点数还剩几张 ---------------- */
console.log('── 记牌器（牌堆剩余）');
{
  const g = new FishingGame();
  const rows = g.remainingByRank();
  ok(rows.length === 13, `3~2 共 13 个点数（实际 ${rows.length}）`);
  ok(rows.reduce((s, r) => s + r.left, 0) === 52, '开局牌堆里正好 52 张');
  ok(rows.every((r) => r.left === 4), '开局每个点数都是 4 张');
  ok(rows[0].rank === 3 && rows[rows.length - 1].rank === 15, '按 3 → 2 排序');

  // 翻几张牌之后：牌堆减少的总数 = 已翻出来的张数
  let moves = 0;
  while (moves < 14 && !g.over) {
    const r = g.play();
    moves += 1;
    if (g.awaiting) g.resolveCatch(Math.random() < 0.5);
    if (!r) break;
  }
  const left = g.remainingByRank().reduce((s, x) => s + x.left, 0);
  ok(left + g.revealedCount() === 52, `牌堆 ${left} + 已翻 ${g.revealedCount()} = 52（守恒）`);
  ok(left < 52, '翻过牌之后牌堆少了');
  ok(g.remainingByRank().every((r) => r.left >= 0 && r.left <= 4), '每个点数剩余都在 0~4 之间');

  // 跑到结束：牌堆应该清空
  let guard = 0;
  while (!g.over && guard < MAX_MOVES + 20) {
    guard += 1;
    g.play();
    if (g.awaiting) g.resolveCatch(true);
  }
  ok(g.over, '对局能正常结束');
  ok(g.remainingByRank().every((r) => r.left === 0), '结束时牌堆里一张不剩（记牌器全为 0）');
  ok(g.revealedCount() === 52, '52 张全部翻出来过');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '小猫钓鱼与称号系统测试全部通过'}`);
process.exit(fail ? 1 : 0);
