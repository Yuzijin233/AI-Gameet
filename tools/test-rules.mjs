/**
 * 规则引擎与结算单测（node tools/test-rules.mjs）
 * 覆盖 PRD §5-Q5 牌型表、§2.4.2 倍数、§2.4.3 三重截断结算
 */
import { analyze, canBeat, findPlays, TYPE, countBombs } from '../src/core/rules.js';
import { computeMultiplier, settleGame, detectSpring } from '../src/core/settle.js';

let uid = 0;
const R = { 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14, 2: 15, w: 16, W: 17 };
const C = (suit, label) => ({ id: uid++, rank: R[label], suit });
const H = (str) => str.split(/\s+/).filter(Boolean).map((t) => {
  const [s, l] = t.split(':');
  return C(s, l);
});

let pass = 0;
let fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  ✓ ${msg}`); } else { fail += 1; console.log(`  ✗ ${msg}\n      期望 ${e}\n      实际 ${a}`); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }
function section(title) { console.log(`\n── ${title}`); }

/* ---------------- 牌型识别 ---------------- */
section('牌型识别');
eq(analyze(H('S:3')).type, TYPE.SINGLE, '单张');
eq(analyze(H('S:3 H:3')).type, TYPE.PAIR, '对子');
eq(analyze(H('S:3 H:3 C:3')).type, TYPE.TRIO, '三张');
eq(analyze(H('S:3 H:3 C:3 D:4')).type, TYPE.TRIO1, '三带一');
eq(analyze(H('S:3 H:3 C:3 D:4 S:4')).type, TYPE.TRIO2, '三带二');
eq(analyze(H('S:3 H:3 C:3 D:3')).type, TYPE.BOMB, '炸弹');
eq(analyze(H('S:w S:W')).type, TYPE.ROCKET, '王炸');
eq(analyze(H('S:3 H:4 C:5 D:6 S:7')).type, TYPE.STRAIGHT, '顺子 34567');
eq(analyze(H('S:10 H:J C:Q D:K S:A')).type, TYPE.STRAIGHT, '顺子 10JQKA（含 A）');
eq(analyze(H('S:J H:Q C:K D:A S:2')), null, '顺子不能含 2');
eq(analyze(H('S:A H:2 C:3 D:4 S:5')), null, '顺子不能 A2345 绕圈');
eq(analyze(H('S:w H:W C:3 D:4 S:5')), null, '顺子不能含王');
eq(analyze(H('S:3 H:3 C:4 D:4 S:5 C:5')).type, TYPE.STRAIGHT_PAIR, '连对 334455');
eq(analyze(H('S:Q H:Q C:K D:K S:A C:A')).type, TYPE.STRAIGHT_PAIR, '连对 QQKKAA（含 A）');
eq(analyze(H('S:K H:K C:A D:A S:2 C:2')), null, '连对不能含 2');
eq(analyze(H('S:3 H:3 C:3 D:4 S:4 C:4')).type, TYPE.PLANE, '飞机 333444');
eq(analyze(H('S:3 H:3 C:3 D:4 S:4 C:4 D:5 S:9')).type, TYPE.PLANE1, '飞机带单（2 个三带 2 张）');
eq(analyze(H('S:3 H:3 C:3 D:4 S:4 C:4 D:8 S:8 D:9 S:9')).type, TYPE.PLANE2, '飞机带对（2 个三带 2 对）');
eq(analyze(H('S:3 H:3 C:3 D:4 S:4 C:4 D:9 S:9')).type, TYPE.PLANE1, '两个三张 + 一对 → 判为飞机带单');
eq(analyze(H('S:3 H:3 C:3 D:3 S:5 H:6')).type, TYPE.FOUR2, '四带二（两单）');
eq(analyze(H('S:3 H:3 C:3 D:3 S:5 H:5')).type, TYPE.FOUR2, '四带二（一对当两单）');
eq(analyze(H('S:3 H:3 C:3 D:3 S:5 H:5 C:6 D:6')).type, TYPE.FOUR2P, '四带两对');
eq(analyze(H('S:K H:K C:K D:A S:A C:A')).type, TYPE.PLANE, 'KKK+AAA 是飞机（最大到 A）');
eq(analyze(H('S:A H:A C:A D:2 S:2 C:2')), null, 'AAA+222 不是飞机（2 不能进飞机）');
eq(analyze(H('S:3 H:4 C:5 D:6')), null, '4 张顺子非法');
eq(analyze(H('S:3 H:4 C:5 D:6 S:8')), null, '断顺非法');

/* ---------------- 大小比较 ---------------- */
section('大小比较');
const pair8 = analyze(H('S:8 H:8'));
const pair9 = analyze(H('S:9 H:9'));
ok(canBeat(pair9, pair8), '对 9 压对 8');
ok(!canBeat(pair8, pair9), '对 8 压不过对 9');
ok(canBeat(analyze(H('S:3 H:3 C:3 D:3')), pair9), '炸弹压对子');
ok(canBeat(analyze(H('S:w H:W')), analyze(H('S:3 H:3 C:3 D:3'))), '王炸压炸弹');
ok(!canBeat(analyze(H('S:3 H:3 C:3 D:3')), analyze(H('S:w H:W'))), '炸弹压不过王炸');
ok(canBeat(analyze(H('S:4 H:5 C:6 D:7 S:8')), analyze(H('S:3 H:4 C:5 D:6 S:7'))), '45678 压 34567');
ok(!canBeat(analyze(H('S:3 H:4 C:5 D:6 S:7')), analyze(H('S:4 H:5 C:6 D:7 S:8'))), '小顺压不过大顺');
ok(!canBeat(analyze(H('S:3 H:4 C:5 D:6 S:7')), analyze(H('S:3 H:4 C:5 D:6 S:7'))), '同牌不可压');
ok(canBeat(pair8, null), '首出任意合法牌型');
eq(canBeat(analyze(H('S:3 H:3 C:3 D:3 S:5 H:6')), pair9), false, '四带二不是炸弹，压不住对子');
eq(countBombs(analyze(H('S:3 H:3 C:3 D:3'))).bombs, 1, '炸弹计数');
eq(countBombs(analyze(H('S:w H:W'))).rockets, 1, '王炸计数');
eq(countBombs(analyze(H('S:3 H:3 C:3 D:3 S:5 H:6'))).bombs, 0, '四带二不计入炸弹倍数');

/* ---------------- 提示枚举 ---------------- */
section('提示枚举');
const hand20 = H('S:3 H:4 C:5 D:6 S:7 S:9 H:9 S:K H:K S:A H:A C:2 D:2 S:w H:W S:8 H:8 C:3 D:3 S:4');
const allPlays = findPlays(hand20, null);
ok(allPlays.length > 10, `首出可枚举出多种牌型（${allPlays.length} 种）`);
ok(allPlays.every((p) => analyze(p.cards)), '枚举出的每一手都是合法牌型');
const beats = findPlays(hand20, analyze(H('S:5 H:5')));
ok(beats.length > 0, '能找出压对 5 的牌');
ok(beats.every((p) => canBeat(p, analyze(H('S:5 H:5')))), '找出的牌全部能压过对 5');
ok(beats.some((p) => p.isBomb), '包含炸弹方案');
eq(findPlays(H('S:3 H:4 C:5'), analyze(H('S:K H:K'))).length, 0, '小牌无法压对 K 时返回空');

/* ---------------- 倍数与春天 ---------------- */
section('倍数与春天');
eq(computeMultiplier({}).mult, 1, '基础倍数 1');
eq(computeMultiplier({ robs: 3 }).mult, 8, '抢地主 3 次 = 8 倍');
eq(computeMultiplier({ bombs: 2 }).mult, 4, '2 个炸弹 = 4 倍');
eq(computeMultiplier({ robs: 1, bombs: 1, rockets: 1, spring: true }).mult, 16, '抢1+炸1+王炸1+春天 = 16 倍');
eq(detectSpring({ landlordSeat: 0, landlordWin: true, playCounts: { 0: 5, 1: 0, 2: 0 } }).spring, true, '农民一张未出 → 春天');
eq(detectSpring({ landlordSeat: 0, landlordWin: true, playCounts: { 0: 5, 1: 1, 2: 0 } }).spring, false, '农民出过牌 → 无春天');
eq(detectSpring({ landlordSeat: 0, landlordWin: false, playCounts: { 0: 1, 1: 4, 2: 3 } }).antiSpring, true, '地主只出一手 → 反春');

/* ---------------- 结算（三重截断） ---------------- */
section('结算：三重截断，永不出现负数豆');
let res = settleGame({ landlordSeat: 0, landlordWin: true, multiplier: 4, base: 100, cap: 8192, beans: [10000, 10000, 10000] });
eq(res.deltas, [800, -400, -400], '地主赢：每位农民赔 底分×倍数');
eq(res.deltas.reduce((a, b) => a + b, 0), 0, '豆子总和守恒');
res = settleGame({ landlordSeat: 0, landlordWin: true, multiplier: 60, base: 100, cap: 8192, beans: [10000, 10000, 10000] });
eq(res.deltas[1], -6000, '未超封顶时按 底分×倍数 结算（6000）');
res = settleGame({ landlordSeat: 0, landlordWin: true, multiplier: 200, base: 100, cap: 8192, beans: [10000, 10000, 10000] });
eq(res.deltas[1], -8192, '超过封顶时按封顶豆截断');
res = settleGame({ landlordSeat: 0, landlordWin: true, multiplier: 200, base: 100, cap: 8192, beans: [10000, 500, 10000] });
eq(res.deltas[1], -500, '农民身家不足时按身家截断');
eq(res.deltas[0], 8192 + 500, '地主所得 = 两位农民实际赔付之和');
res = settleGame({ landlordSeat: 0, landlordWin: false, multiplier: 200, base: 100, cap: 8192, beans: [3000, 10000, 10000] });
eq(res.deltas[0], -3000, '地主输光即止，不会变负');
eq(res.deltas[1] + res.deltas[2], 3000, '地主赔付总量 = 实付之和');
ok(res.deltas.every((d) => Number.isFinite(d)), '结算结果均为有限数');
res = settleGame({ landlordSeat: 0, landlordWin: false, multiplier: 200, base: 100, cap: 8192, beans: [9000, 10000, 10000] });
eq(res.deltas[0], -9000, '地主身家不足以支付两笔时的截断');
eq(res.deltas.reduce((a, b) => a + b, 0), 0, '截断后依然守恒');

console.log(`\n────────────────────────────\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
