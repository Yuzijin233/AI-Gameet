/**
 * AI 身家 / 道具 / 好友上限测试（node tools/test-aiEcon.mjs）
 * 覆盖 PRD §2.14：
 *   初始身家（幂律偏小）、参战结算、其他 AI 每局浮动、低保、
 *   按门槛抽对手、极端兜底输血、房间补足、按身家戴称号，
 *   以及商城的道具库存与好友上限 10。
 */
import { AI_ECON, CONFIG, ITEMS, ROOMS } from '../src/config.js';
import { PERSONAS } from '../src/data/personas.js';
import { defaultSave } from '../src/store/storage.js';
import { Economy } from '../src/store/economy.js';
import { TITLES } from '../src/data/titles.js';
import { addFriend, listFriends } from '../src/store/friends.js';
import {
  ensureAiEcon, aiBeansOf, setAiBeans, aiTitleOf, skewedRandom, uniformRandom,
  eligiblePersonas, rescueAiIfNeeded, pickEligiblePersonas, topUpForRoom,
  applyAiSettlement, pulseIdleAi, grantAiRelief, aiEconSummary,
  isShopTitlePersona, shopTitleOf, SHOP_TITLES, SHOP_TITLE_EVERY,
} from '../src/store/aiBeans.js';
import {
  ensureItems, itemCount, addItems, toolLeft, consumeItem, buyItem, stockTotal,
} from '../src/store/items.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };

/** 确定性伪随机（LCG），让统计类断言可复现 */
function makeRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const roomOf = (id) => ROOMS.find((r) => r.id === id);
const mid = roomOf('mid');
const high = roomOf('high');
const low = roomOf('low');

/* ================================================================= */
console.log('-- 初始身家（幂律偏小）');
{
  const save = defaultSave();
  const { created } = ensureAiEcon(save, makeRng(7));
  ok(created.length === PERSONAS.length, `每个 AI 都分到初始身家（${created.length}/${PERSONAS.length}）`);

  const values = PERSONAS.map((p) => aiBeansOf(save, p.id));
  ok(values.every((v) => v >= AI_ECON.minStart && v <= AI_ECON.maxStart),
    `初始身家都在 ${AI_ECON.minStart}~${AI_ECON.maxStart} 之间`);
  for (const p of PERSONAS) ok(typeof aiBeansOf(save, p.id) === 'number', `「${p.name}」有身家`);

  // 幂律：统计 2000 次抽样，中位数应远低于区间中点，且小值占多数
  const rng = makeRng(99);
  const samples = Array.from({ length: 2000 }, () => skewedRandom(AI_ECON.minStart, AI_ECON.maxStart, AI_ECON.startSkew, rng));
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const midPoint = (AI_ECON.minStart + AI_ECON.maxStart) / 2;
  ok(median < midPoint * 0.35, `中位数明显偏小（中位数 ${Math.round(median)} < 中点 ${Math.round(midPoint)} 的 35%）`);
  const small = samples.filter((v) => v < AI_ECON.maxStart * 0.1).length;
  ok(small > samples.length * 0.4, `大部分 AI 是小身家（${small}/2000 低于上限的 10%）`);
  ok(Math.min(...samples) >= AI_ECON.minStart && Math.max(...samples) <= AI_ECON.maxStart, '抽样不越界');

  ok(uniformRandom(10, 20) >= 10 && uniformRandom(10, 20) <= 20, '均匀抽样在区间内');

  // 重复调用不会重新分配
  const before = aiBeansOf(save, PERSONAS[0].id);
  ensureAiEcon(save);
  ok(aiBeansOf(save, PERSONAS[0].id) === before, '已有身家不会被重新随机');
}

/* ================================================================= */
console.log('-- AI 按身家戴称号');
{
  const save = defaultSave();
  ensureAiEcon(save, makeRng(3));
  /**
   * ★ 行为变了（用户拍板）：**一部分 AI 戴的是商城买的称号**，不再跟身家档走。
   *   所以"身家档 → 称号"这条老断言必须挑一位**不是商城称号党**的人设来验，
   *   否则会被商城称号挡住（那不是 bug，是新规则）。
   *   商城称号的规则单独在下面一节验（确定性 + 覆盖比例 + 和身家无关）。
   */
  const beansGuy = PERSONAS.find((p) => !isShopTitlePersona(p.id));
  ok(!!beansGuy, '能挑出一位"按身家戴称号"的 AI（不是商城称号党）');
  const id = beansGuy.id;
  const beanTitles = TITLES.filter((t) => t.kind === 'beans');
  setAiBeans(save, id, 0);
  ok(aiTitleOf(save, id).id === 't_poor', `0 豆的「${beansGuy.name}」戴「穷光蛋」`);
  setAiBeans(save, id, 15000);
  ok(aiTitleOf(save, id).id === 't_lucky', `1.5 万豆的「${beansGuy.name}」戴「手气不错」`);
  setAiBeans(save, id, 20000000);
  ok(aiTitleOf(save, id).id === beanTitles[beanTitles.length - 1].id,
    `两千万豆的「${beansGuy.name}」戴最高身家档称号`);
  const summary = aiEconSummary(save);
  ok(summary.rows.length === PERSONAS.length, '摘要包含全部 AI');
  ok(summary.max.beans >= summary.min.beans, '摘要能给出最富/最穷');
}

/* ================================================================= */
console.log('-- ★ 商城称号：一部分 AI 像真人那样"买了就戴"（确定性）');
{
  ok(SHOP_TITLES.length > 0, `称号表里有商城称号（${SHOP_TITLES.length} 个）`);
  ok(SHOP_TITLES.every((t) => t.kind === 'shop'), 'SHOP_TITLES 只含 kind=shop 的称号');

  const save = defaultSave();
  ensureAiEcon(save, makeRng(13));

  // ① 覆盖比例：一部分（不是全部、也不是没有）
  const holders = PERSONAS.filter((p) => isShopTitlePersona(p.id));
  ok(holders.length > 0, `有 AI 戴商城称号（${holders.length}/${PERSONAS.length}）`);
  ok(holders.length < PERSONAS.length, '不是所有 AI 都戴商城称号（身家档仍然有人走）');
  ok(Math.abs(holders.length / PERSONAS.length - 1 / SHOP_TITLE_EVERY) <= 0.15,
    `比例接近 1/${SHOP_TITLE_EVERY}（实际 ${holders.length}/${PERSONAS.length}）`);

  // ② 确定性：同一个 AI 每次都一样（刷新一次变一个就崩了）
  for (const p of PERSONAS) {
    const a = aiTitleOf(save, p.id);
    const b = aiTitleOf(save, p.id);
    ok(a && b && a.id === b.id, `「${p.name}」的称号是确定的（${a && a.name}）`);
  }
  const fresh = defaultSave(); // 换个全新存档（身家重新随机）
  ensureAiEcon(fresh, makeRng(999));
  /**
   * ★ 用户拍板：一部分 AI 戴的是**商城称号**，这批人完全由 personaId 决定
   *   （换存档 / 换设备 / 身家重随机都不变）；其余人仍然按身家档走 ——
   *   身家重随机后档位本来就可能不同，那是老行为，不在这里要求一致。
   */
  const shopIds = PERSONAS.filter((p) => isShopTitlePersona(p.id)).map((p) => p.id);
  ok(shopIds.length > 0 && shopIds.length < PERSONAS.length,
    `★ 一部分 AI 戴商城称号（${shopIds.length}/${PERSONAS.length}）`);
  ok(shopIds.every((id) => {
    const a = aiTitleOf(save, id);
    const b = aiTitleOf(fresh, id);
    return a && b && a.id === b.id && a.kind === 'shop';
  }), '★ 商城称号党：只看 personaId（换存档 / 换设备也是同一个）');
  ok(PERSONAS.filter((p) => !shopIds.includes(p.id)).every((p) => {
    const t = aiTitleOf(save, p.id);
    return t && t.kind === 'beans';
  }), '其余人还是按身家档（老行为不变）');

  // ③ 商城称号党：与身家无关（穷也戴、富也戴），而且戴的确实是商城那一个
  const holder = holders[0];
  for (const beans of [0, 999, 50000, 20000000]) {
    setAiBeans(save, holder.id, beans);
    const t = aiTitleOf(save, holder.id);
    ok(t && t.kind === 'shop' && t.id === shopTitleOf(holder.id).id,
      `「${holder.name}」身家 ${beans} 时仍然戴商城称号「${t && t.name}」`);
  }
  ok(shopTitleOf(holder.id) !== null && !isShopTitlePersona('') && shopTitleOf('') === null,
    'shopTitleOf 对空 id / 非党成员返回 null（调用方不用额外判空）');

  // ④ 不是党的人：称号就是身家档（老行为，一点没动）
  const plain = PERSONAS.find((p) => !isShopTitlePersona(p.id));
  setAiBeans(save, plain.id, 15000);
  ok(aiTitleOf(save, plain.id).kind === 'beans', `「${plain.name}」按身家档（kind=${aiTitleOf(save, plain.id).kind}）`);
  ok(shopTitleOf(plain.id) === null, '非党成员没有商城称号');

  // ⑤ 返回值结构不能变（调用方很多：好友列表 / 房间座位 / 排行榜 / 提示词）
  for (const p of PERSONAS) {
    const t = aiTitleOf(save, p.id);
    ok(t && typeof t.id === 'string' && typeof t.name === 'string',
      `「${p.name}」的称号仍然是 { id, name, ... }`);
  }
}

/* ================================================================= */
console.log('-- 参战 AI 结算');
{
  const save = defaultSave();
  ensureAiEcon(save, makeRng(11));
  const a = PERSONAS[0].id;
  const b = PERSONAS[1].id;
  setAiBeans(save, a, 10000);
  setAiBeans(save, b, 10000);
  const changes = applyAiSettlement(save, [null, a, b], [500, -200, -300]);
  ok(changes.length === 2, '只结算参战的两个 AI');
  ok(aiBeansOf(save, a) === 9800, `地主输豆（10000-200=9800，实际 ${aiBeansOf(save, a)}）`);
  ok(aiBeansOf(save, b) === 9700, `农民输豆（10000-300=9700，实际 ${aiBeansOf(save, b)}）`);
  ok(changes.every((c) => c.after >= 0), '身家不会变成负数');

  // 输光也不会为负
  setAiBeans(save, a, 100);
  applyAiSettlement(save, [null, a, null], [0, -5000, 0]);
  ok(aiBeansOf(save, a) === 0, '输光即止，不会为负');
}

/* ================================================================= */
console.log('-- 其他 AI 每局浮动（+0~20% / -0~10%）');
{
  const save = defaultSave();
  ensureAiEcon(save, makeRng(5));
  const a = PERSONAS[0].id;
  const b = PERSONAS[1].id;
  for (const p of PERSONAS) setAiBeans(save, p.id, 100000);

  const changes = pulseIdleAi(save, [a, b], makeRng(21));
  ok(!changes.some((c) => c.id === a || c.id === b), '参战的两个 AI 不参与浮动');
  ok(changes.length === PERSONAS.length - 2, `其他 ${PERSONAS.length - 2} 个 AI 都动了一次`);
  ok(changes.every((c) => c.up ? c.delta <= 100000 * AI_ECON.idleGainRate : c.delta >= -100000 * AI_ECON.idleLoseRate),
    '涨幅不超过 20%、跌幅不超过 10%');
  ok(changes.some((c) => c.up) && changes.some((c) => !c.up), '有涨有跌');

  // 涨跌方向由随机数决定
  const up = pulseIdleAi(save, [], () => 0.1); // 0.1 < 0.5 → 涨
  ok(up.every((c) => c.delta >= 0), '随机数偏小时全部是涨');
  const down = pulseIdleAi(save, [], () => 0.9);
  ok(down.every((c) => c.delta <= 0), '随机数偏大时全部是跌');

  // 0 豆的 AI 不产生变化，也不会变负
  setAiBeans(save, PERSONAS[3].id, 0);
  const again = pulseIdleAi(save, [], makeRng(77));
  ok(!again.some((c) => c.id === PERSONAS[3].id), '身家为 0 的 AI 不参与浮动');
  ok(PERSONAS.every((p) => aiBeansOf(save, p.id) >= 0), '浮动后没有负身家');
}

/* ================================================================= */
console.log('-- 低保（每个 AI 每日一次）');
{
  const save = defaultSave();
  ensureAiEcon(save, makeRng(31));
  const poor = PERSONAS[0].id;
  const rich = PERSONAS[1].id;
  setAiBeans(save, poor, 200);
  setAiBeans(save, rich, 500000);

  const day1 = grantAiRelief(save, '2025-01-01');
  ok(day1.length === 1 && day1[0].id === poor, '只有低于低保线的 AI 领低保');
  ok(aiBeansOf(save, poor) === 200 + AI_ECON.reliefBeans, `身家补到 ${200 + AI_ECON.reliefBeans}`);
  ok(grantAiRelief(save, '2025-01-01').length === 0, '同一天不重复领');

  setAiBeans(save, poor, 100);
  ok(grantAiRelief(save, '2025-01-01').length === 0, '当天再次变穷也不补');
  const day2 = grantAiRelief(save, '2025-01-02');
  ok(day2.length === 1, '第二天可以再领');
  ok(aiBeansOf(save, rich) === 500000, '身家充足的不领低保');
}

/* ================================================================= */
console.log('-- 按场次门槛抽对手');
{
  const save = defaultSave();
  ensureAiEcon(save, makeRng(13));
  for (const p of PERSONAS) setAiBeans(save, p.id, 1500); // 够低级场、不够中级场
  const rich3 = [PERSONAS[0].id, PERSONAS[1].id, PERSONAS[2].id];
  for (const id of rich3) setAiBeans(save, id, 20000);

  const eligibleMid = eligiblePersonas(save, mid);
  ok(eligibleMid.length === 3, `中级场只有 3 个 AI 达标（实际 ${eligibleMid.length}）`);
  ok(eligiblePersonas(save, high).length === 0, '高级场一个都不达标');

  const { picks, rescued } = pickEligiblePersonas(save, mid, 2, makeRng(17));
  ok(!rescued, '中级场有能打的 AI 时不触发兜底');
  ok(picks.length === 2 && picks[0].id !== picks[1].id, '抽出两个不同的 AI');
  ok(picks.every((p) => aiBeansOf(save, p.id) >= mid.minBeans), '抽到的 AI 身家都达到门槛');

  // 低级场：全都能玩
  ok(eligiblePersonas(save, low).length === PERSONAS.length, '低级场门槛低，所有 AI 都能玩');
}

/* ================================================================= */
console.log('-- 极端兜底：没人能打时输血');
{
  const save = defaultSave();
  ensureAiEcon(save, makeRng(41));
  for (const p of PERSONAS) setAiBeans(save, p.id, 100);
  // 先塞满 10 个好友，验证"玩家好友以外"
  const friendIds = PERSONAS.slice(0, 10).map((p) => p.id);
  for (const p of PERSONAS.slice(0, 10)) addFriend(save, p);

  const res = rescueAiIfNeeded(save, high, makeRng(43));
  ok(res.rescued, '高级场没人能打时触发兜底');
  ok(res.mid.length === AI_ECON.rescueMidCount, `输血 ${AI_ECON.rescueMidCount} 个到中级档`);
  ok(res.high.length === AI_ECON.rescueHighCount, `输血 ${AI_ECON.rescueHighCount} 个到高级档`);
  const touched = [...res.mid, ...res.high].map((p) => p.id);
  ok(touched.every((id) => !friendIds.includes(id)), '被输血的都不是玩家好友');
  ok(new Set(touched).size === touched.length, '同一个 AI 不会被输两次血');
  for (const p of res.mid) {
    const b = aiBeansOf(save, p.id);
    ok(b >= AI_ECON.rescueMidMin && b <= AI_ECON.rescueMidMax, `中级档输血落在 ${AI_ECON.rescueMidMin}~${AI_ECON.rescueMidMax}（实际 ${b}）`);
    ok(b >= mid.minBeans, '输血后能进中级场');
  }
  for (const p of res.high) {
    const b = aiBeansOf(save, p.id);
    ok(b >= AI_ECON.rescueHighMin && b <= AI_ECON.rescueHighMax, `高级档输血落在 ${AI_ECON.rescueHighMin}~${AI_ECON.rescueHighMax}（实际 ${b}）`);
    ok(b >= high.minBeans, '输血后能进高级场');
  }
  ok(eligiblePersonas(save, high).length >= AI_ECON.rescueHighCount, '兜底后高级场有人能打');
  const after = pickEligiblePersonas(save, high, 2, makeRng(51));
  ok(after.picks.length === 2 && !after.rescued, '兜底后能正常抽出高级场对手');

  // 已经有人能打时不输血
  const save2 = defaultSave();
  ensureAiEcon(save2, makeRng(61));
  setAiBeans(save2, PERSONAS[0].id, 500000);
  const noRescue = rescueAiIfNeeded(save2, high, makeRng(63));
  ok(!noRescue.rescued, '已经有人能打时不触发兜底');
}

/* ================================================================= */
console.log('-- 房间模式手动邀请：身家不足补到门槛');
{
  const save = defaultSave();
  ensureAiEcon(save, makeRng(71));
  const id = PERSONAS[0].id;
  setAiBeans(save, id, 300);
  const r1 = topUpForRoom(save, id, high);
  ok(r1.topped && aiBeansOf(save, id) === high.minBeans, `身家补到门槛 ${high.minBeans}`);
  const r2 = topUpForRoom(save, id, low);
  ok(!r2.topped, '已经够门槛就不再补');
  setAiBeans(save, id, 4000000);
  ok(!topUpForRoom(save, id, high).topped, '身家充裕时不动它');
}

/* ================================================================= */
console.log('-- 好友上限 10');
{
  const save = defaultSave();
  const got = [];
  for (const p of PERSONAS) {
    const r = addFriend(save, p);
    if (r.ok) got.push(r.friend);
  }
  ok(got.length === 10, `最多只能加 10 个好友（实际 ${got.length}）`);
  ok(listFriends(save).length === 10, '好友列表长度也是 10');
  const extra = addFriend(save, PERSONAS[10]);
  ok(!extra.ok, '第 11 个加不进去');
  ok(String(extra.error).includes('10'), `错误提示说明了上限（${extra.error}）`);
  const dup = addFriend(save, PERSONAS[0]);
  ok(!dup.ok && dup.error.includes('已经是好友'), '重复加好友仍然被拦住');
}

/* ================================================================= */
console.log('-- 道具库存（商城第三类）');
{
  const save = defaultSave();
  ensureItems(save);
  ok(ITEMS.length >= 4, `道具至少 4 种（实际 ${ITEMS.length}）`);
  ok(ITEMS.some((i) => i.id === 'tomato') && ITEMS.some((i) => i.id === 'cappuccino'), '包含番茄与卡布奇诺');
  ok(ITEMS.some((i) => i.id === 'egg' && i.emoji === '🥚'), '鸡蛋用 emoji');

  const id = ITEMS[0].id;
  ok(itemCount(save, id) === save.items[id], '库存读取正确');
  ok(toolLeft(save, id, 0) === Math.min(itemCount(save, id), CONFIG.toolPerHand), '本局可用次数受库存与上限双重限制');
  ok(toolLeft(save, id, CONFIG.toolPerHand) === 0, '本局次数用完后不可用');
  addItems(save, id, 10);
  ok(toolLeft(save, id, 0) === CONFIG.toolPerHand, '库存再多也受每局上限限制');

  const before = itemCount(save, id);
  ok(consumeItem(save, id) === true && itemCount(save, id) === before - 1, '使用道具会扣库存');
  save.items[id] = 0;
  ok(consumeItem(save, id) === false, '库存为 0 时不能使用');

  // 商城购买
  const eco = new Economy(save, () => {});
  eco.save.beans = 100;
  const poor = buyItem(eco, 'flower');
  ok(!poor.ok, '豆子不足时买不了道具');
  eco.save.beans = 10000;
  const buy = buyItem(eco, 'flower');
  ok(buy.ok, '豆子足够时可以买道具');
  ok(eco.beans === 10000 - 500, `买道具扣的是开心豆（10000-500=${eco.beans}）`);
  ok(itemCount(save, 'flower') === 1, '买到的道具进库存');
  ok(stockTotal(save) >= 1, '库存总量可统计');

  // 非法库存会被修正
  save.items.flower = -5;
  ensureItems(save);
  ok(save.items.flower === 0, '非法库存（负数）会被修正为 0');
}

/* ================================================================= */
console.log('-- 存档兼容');
{
  const legacy = { beans: 100, signIn: { streak: 1 } }; // 老存档没有 aiEcon / items
  const save = { ...defaultSave(), ...legacy };
  ok(!!save.aiEcon && !!save.items, '默认存档带有 AI 身家与道具字段');
  ensureAiEcon(save, makeRng(5));
  ensureItems(save);
  ok(PERSONAS.every((p) => aiBeansOf(save, p.id) >= AI_ECON.minStart), '老存档能补齐 24 个 AI 的身家');
  ok(ITEMS.every((it) => itemCount(save, it.id) >= 0), '老存档能补齐道具字段');
}

/* ================================================================= */
console.log('-- 端到端：打完一整局后 AI 身家的变化');
{
  // 用真实状态机跑 60 局，把 result.deltas 喂给 AI 身家系统，校验不变量
  const { Game, PHASE } = await import('../src/game/engine.js');
  const save = defaultSave();
  ensureAiEcon(save, makeRng(1234));
  const rng = makeRng(4321);

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
        game.applyPlay(s, play ? play.cards : []);
      } else break;
    }
    return guard;
  }

  let games = 0;
  let negatives = 0;
  let mismatch = 0;
  for (let i = 0; i < 60; i += 1) {
    // 每局都从"够门槛的 AI"里抽两个当对手
    const { picks } = pickEligiblePersonas(save, roomOf('low'), 2, rng);
    if (picks.length < 2) break;
    const seatIds = picks.map((p) => p.id);
    const game = new Game({
      room: roomOf('low'),
      personas: [null, ...picks],
      names: ['你', '下家', '上家'],
      avatars: ['a', 'b', 'c'],
      beans: [50000, aiBeansOf(save, seatIds[0]), aiBeansOf(save, seatIds[1])],
      mode: 'ai',
    });
    drive(game);
    if (game.phase !== PHASE.OVER) break;
    const result = game.result;
    const before = seatIds.map((id) => aiBeansOf(save, id));
    applyAiSettlement(save, [null, ...seatIds], result.deltas);
    const want = before.map((b, k) => Math.max(0, b + result.deltas[k + 1]));
    const got = seatIds.map((id) => aiBeansOf(save, id));
    if (want.some((w, k) => w !== got[k])) mismatch += 1;
    pulseIdleAi(save, seatIds, rng);
    grantAiRelief(save, `2025-06-${String((i % 27) + 1).padStart(2, '0')}`);
    if (PERSONAS.some((p) => aiBeansOf(save, p.id) < 0)) negatives += 1;
    games += 1;
  }
  ok(games >= 50, `跑完整局数足够（${games} 局）`);
  ok(mismatch === 0, '参战 AI 的身家变化与本局结算完全一致');
  ok(negatives === 0, '60 局之后没有任何 AI 的身家变成负数');
  const summary = aiEconSummary(save);
  ok(summary.total > 0, '整轮跑完总身家仍然为正');
  ok(summary.rows.every((r) => r.title), '每个 AI 都能按身家拿到一个称号');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : 'AI 身家 / 道具 / 好友上限测试全部通过'}`);
process.exit(fail ? 1 : 0);
