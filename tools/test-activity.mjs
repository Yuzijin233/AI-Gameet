/**
 * 活动中心 / 大转盘 / 邮箱 / 排行榜 / 装扮 测试（node tools/test-activity.mjs）
 *
 * 重点盯三件事：
 *  1. **大转盘的数学期望必须是负的**（用户明确要求），且 100 万大奖概率极小
 *  2. 每个活动的"什么时候能领"边界：每日跨天、每周跨周、首充一次、累计档位一次
 *  3. 奖励发放口径统一：礼包类走邮箱，免费类直接到账，领取后状态正确
 */
import { defaultSave } from '../src/store/storage.js';
import { ensureItems, itemCount } from '../src/store/items.js';
import { ensureTitleState, isTitleUnlocked } from '../src/store/titles.js';
import {
  WHEEL, wheelEV, wheelHouseEdge, wheelWeightTotal, jackpotChance, spinPrize,
  dayKey, weekKey, msUntilTomorrow, msUntilNextWeek, formatLeft, hashKey, pickOfDay,
  dailyPackOf, dailyPacksOf, discountOf, discountPrice, discountMaxBuys, rewardLabel, DISCOUNT_RATE,
  DISCOUNT_ITEM_BUYS,
  wheelSeg, wheelTargetAngle, wheelIndexAt,
  FREE_DAILY, FREE_WEEKLY, FIRST_PAY, PAY_TIERS, DAILY_PACKS,
} from '../src/data/activities.js';
import {
  FRAMES, CARD_BACKS, RENAME_CARD, FRAMES_FOR_SALE, THEMES, THEMES_FOR_SALE, FREE_THEME, themeById,
} from '../src/data/cosmetics.js';
import {
  ensureActivity, recordPayment, totalPaidYuan, hasPaid,
  freeGiftState, claimFreeGift, firstPayState, claimFirstPay,
  dailyPackState, buyDailyPack, payTierState, claimPayTier,
  discountState, buyDiscount, wheelState, spinWheel, activityOverview,
} from '../src/store/activity.js';
import {
  pushMail, claimMail, claimAllMail, claimableMailCount, unreadMailCount,
  markMailRead, markAllMailRead, isMailExpired, listMailWithState, MAIL_TTL_MS, ensureMail,
} from '../src/store/rewards.js';
import {
  ensureCosmetics, ownedFrames, ownsFrame, ownFrame, equipFrame, equippedFrame, frameClassOf,
  ownedCardBacks, ownsCardBack, ownCardBack, renameCardCount, addRenameCard, useRenameCard,
  buyCosmetic, cosmeticList,
  ownedThemes, ownsTheme, ownTheme, equipTheme, equippedTheme, themeNameOf,
} from '../src/store/cosmetics.js';
import { wealthRanking, medalOf, beanText, RANK_SIZE } from '../src/store/rank.js';
import { ensureAiEcon, setAiBeans } from '../src/store/aiBeans.js';
import { PERSONAS, SCENES, genderOf, genderSign, genderPromptLine, ageOf, agePromptLine } from '../src/data/personas.js';
import { SIGNATURES } from '../src/data/signatures.js';
import { PLAY_STYLE_BY_PERSONA } from '../src/ai/playBrain.js';
import { periodOf, clockText, dateText, timeContextLine, gapText, lastChatGapLine, stampText } from '../src/data/clock.js';
import { historyLines } from '../src/ai/friend.js';
import { personaReactionLine } from '../src/data/style.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };

function newSave() {
  const s = defaultSave();
  ensureItems(s);
  ensureActivity(s);
  ensureCosmetics(s);
  ensureTitleState(s);
  ensureMail(s);
  return s;
}
function eco(save) {
  return {
    save,
    get beans() { return save.beans; },
    addBeans(n) { save.beans = Math.max(0, Math.round(save.beans + n)); },
  };
}
/** 造一个"用固定序列抽奖"的随机源 */
const seq = (vals) => { let i = 0; return () => vals[(i++) % vals.length]; };

/* ===================================================================== */
console.log('-- 大转盘：期望必须是负的');
{
  const total = wheelWeightTotal();
  ok(total === 1000, `权重总和正好 1000（实际 ${total}）`);
  ok(WHEEL.prizes.length === 12, `12 格，正好铺满一圈（实际 ${WHEEL.prizes.length}）`);
  ok(WHEEL.prizes.every((p) => p.weight > 0 && Number.isInteger(p.weight)), '每格权重都是正整数');
  ok(new Set(WHEEL.prizes.map((p) => p.id)).size === WHEEL.prizes.length, '每格 id 唯一');
  ok(WHEEL.prizes.every((p) => !!p.short), '每格都有转盘上的短标签（不然一圈写不下）');

  const ev = wheelEV();
  const edge = wheelHouseEdge();
  console.log(`  成本 💰${WHEEL.cost.toLocaleString()} / 一次，期望回报 💰${ev.toFixed(1)}，庄家优势 ${(edge * 100).toFixed(1)}%`);
  ok(ev < WHEEL.cost, `**数学期望必须是负的**：期望 ${ev.toFixed(1)} < 成本 ${WHEEL.cost}`);
  ok(edge > 0.05, `庄家优势要明显（>5%，实际 ${(edge * 100).toFixed(1)}%）`);
  ok(edge < 0.35, `也不能黑到离谱（<35%，实际 ${(edge * 100).toFixed(1)}%）`);

  // 大奖
  const jack = WHEEL.prizes.find((p) => p.jackpot);
  ok(!!jack && jack.amount === 1000000, '有 1,000,000 豆的头奖格');
  const jc = jackpotChance();
  console.log(`  头奖 1,000,000 豆的概率：${(jc * 100).toFixed(2)}%（约 ${Math.round(1 / jc)} 次中一次）`);
  ok(jc > 0 && jc <= 0.002, `头奖概率极小（≤0.2%，实际 ${(jc * 100).toFixed(2)}%）`);
  ok(jc >= 0.0005, '也不能小到几乎不可能（≥0.05%）');

  // 限定装扮不计入期望（等于白送），所以真实期望只会更差
  ok(WHEEL.prizes.filter((p) => p.limited).every((p) => p.value === 0), '限定装扮不计入期望（保守口径）');
  ok(WHEEL.prizes.some((p) => p.kind === 'frame' && p.id === 'f_star'), '转盘能出限定头像框·星轨');
  ok(WHEEL.prizes.some((p) => p.kind === 'title' && p.id === 't_lucky_star'), '转盘能出限定称号·欧皇');
  ok(WHEEL.duplicateBeans > 0 && WHEEL.duplicateBeans < 100000, '重复的限定装扮折算成豆子（不是空奖）');
}

/* ===================================================================== */
console.log('-- 大转盘：按权重开奖');
{
  // 边界：rnd=0 出第一格；rnd 接近 1 出最后一格（头奖）
  ok(spinPrize(() => 0) === WHEEL.prizes[0], 'rnd=0 落在第一格');
  ok(spinPrize(() => 0.999999) === WHEEL.prizes[WHEEL.prizes.length - 1], 'rnd→1 落在最后一格（头奖）');  // 单调：rnd 越大，落到的格越靠后
  let last = -1;
  let mono = true;
  for (let i = 0; i <= 100; i += 1) {
    const idx = WHEEL.prizes.indexOf(spinPrize(() => i / 100.5));
    if (idx < last) mono = false;
    last = idx;
  }
  ok(mono, 'rnd 递增时中奖格单调向后（权重映射没写错）');

  // 蒙特卡洛：出现频率要接近权重，且头奖几乎不出
  const N = 200000;
  const hit = {};
  let jackpot = 0;
  let rnd = 123456789;
  const next = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
  for (let i = 0; i < N; i += 1) {
    const p = spinPrize(next);
    hit[p.id] = (hit[p.id] || 0) + 1;
    if (p.jackpot) jackpot += 1;
  }
  const worst = WHEEL.prizes.reduce((w, p) => {
    const got = (hit[p.id] || 0) / N;
    const want = p.weight / 1000;
    return Math.max(w, Math.abs(got - want));
  }, 0);
  ok(worst < 0.01, `20 万次抽奖的频率与权重吻合（最大偏差 ${(worst * 100).toFixed(2)}%）`);
  console.log(`  实测头奖命中 ${jackpot} 次 / ${N}（约 ${(jackpot / N * 100).toFixed(3)}%）`);
  ok(jackpot / N < 0.004, '实测头奖频率依然极小');
}

/* ===================================================================== */
console.log('-- 转盘角度：指针必须停在中奖那一格');
{
  // 每一格都验一遍：算出来的角度，反推回去必须还是那一格
  for (let i = 0; i < WHEEL.prizes.length; i += 1) {
    const a = wheelTargetAngle(i, 0, 5);
    ok(wheelIndexAt(a) === i, `第 ${i} 格（${WHEEL.prizes[i].short}）停位正确（角度 ${a}）`);
  }
  // 连续转多次：角度只增不减（视觉上一直往前转，不会倒着甩回去）
  let prev = 0;
  let mono = true;
  let allOk = true;
  for (let k = 0; k < 30; k += 1) {
    const idx = (k * 7) % WHEEL.prizes.length;
    const next = wheelTargetAngle(idx, prev, 5);
    if (next <= prev) mono = false;
    if (wheelIndexAt(next) !== idx) allOk = false;
    prev = next;
  }
  ok(mono, '连续转 30 次角度单调递增（不会倒转）');
  ok(allOk, '连续转 30 次每次都停在正确的格子上');
  ok(wheelTargetAngle(0, 0, 5) > 360 * 5 - 360, '至少转满 5 圈，有"转起来"的观感');
  ok(wheelSeg() * WHEEL.prizes.length === 360, '12 格正好 360°');
  // 边界：角度 0 时指针正好压在 0° 这条分界线上（按"分界线属于它开始的那一格"处理）。
  // 真实抽奖永远不会停在分界线上 —— wheelTargetAngle 加的是半格偏移。
  ok(wheelIndexAt(0) === 0, '角度 0 落在分界线上，按"属于起始格"处理');
  ok(WHEEL.prizes.every((_, i) => wheelIndexAt(wheelTargetAngle(i, 0, 5)) === i),
    '真实抽奖的角度都停在格子正中，不会踩到分界线');
}

/* ===================================================================== */
console.log('-- 转一次：扣豆 / 到账 / 计数');
{
  const s = newSave();
  const e = eco(s);
  s.beans = 100000;
  const res = spinWheel(e, () => 0.5);
  ok(res.ok, '豆子够就能转');
  ok(s.beans === 100000 - WHEEL.cost + (res.reward.kind === 'beans' ? res.reward.amount : 0),
    `扣了成本并发了奖（余额 ${s.beans}）`);
  ok(s.activity.spins === 1, '转了 1 次');
  ok(res.index >= 0 && res.index < WHEEL.prizes.length, '返回中奖格的下标（转盘要用它算角度）');

  // 豆子不够
  const poor = newSave(); poor.beans = 100;
  const bad = spinWheel(eco(poor), () => 0.5);
  ok(!bad.ok && /不足/.test(bad.error), '豆子不够时拒绝并给出原因');
  ok(poor.beans === 100 && poor.activity.spins === 0, '失败的转不扣豆、不计数');

  // 限定装扮重复抽到 → 折算豆子，不做空奖
  const dup = newSave();
  const de = eco(dup);
  dup.beans = 1000000;
  ownFrame(dup, 'f_star');
  const idxFrame = WHEEL.prizes.findIndex((p) => p.kind === 'frame');
  ok(idxFrame >= 0, '转盘里有头像框那一格');
  const span = WHEEL.prizes.slice(0, idxFrame).reduce((a, p) => a + p.weight, 0) / 1000;
  const dupRes = spinWheel(de, () => span + 0.0005); // 落在星轨那一格
  ok(dupRes.prize.kind === 'frame', `这次抽到的是限定框（实际 ${dupRes.prize.id}）`);
  ok(dupRes.duplicate === true, '已拥有 → 标记为重复');
  ok(dupRes.reward.kind === 'beans' && dupRes.reward.amount === WHEEL.duplicateBeans,
    `重复的限定框折算成 ${WHEEL.duplicateBeans} 豆`);
  ok(dup.activity.bestWin === WHEEL.duplicateBeans, '最高中奖记录跟着更新');

  // 头奖会记进 bestWin
  const jp = newSave();
  const je = eco(jp);
  jp.beans = 100000;
  const jres = spinWheel(je, () => 0.999999);
  ok(jres.prize.jackpot === true && jp.activity.bestWin === 1000000, '抽到头奖：bestWin 记 1,000,000');
}

/* ===================================================================== */
console.log('-- 日期键 / 倒计时 / 每日随机');
{
  const t = new Date(2026, 2, 5, 14, 32, 0); // 2026-03-05 周四
  ok(dayKey(t) === '2026-03-05', `日期键（${dayKey(t)}）`);
  ok(weekKey(t) === weekKey(new Date(2026, 2, 2, 9, 0, 0)), '同周内周键相同（周一与周四同键）');
  ok(weekKey(t) !== weekKey(new Date(2026, 2, 9, 9, 0, 0)), '跨周后周键不同');
  ok(/^\d{4}-W\d{2}$/.test(weekKey(t)), `周键格式正确（${weekKey(t)}）`);

  const ms = msUntilTomorrow(t);
  ok(ms === (9 * 60 + 28) * 60 * 1000, `到明天 0 点的毫秒数正确（${ms / 3600000} 小时）`);
  const wk = msUntilNextWeek(t); // 周四 14:32 → 下周一 0 点
  ok(wk === (3 * 86400000) + (9 * 60 + 28) * 60 * 1000, '到下周一 0 点的毫秒数正确');
  ok(msUntilTomorrow(new Date(2026, 2, 5, 23, 59, 59)) === 1000, '23:59:59 时只剩 1 秒');

  ok(formatLeft(0) === '00:00:00', '倒计时 0');
  ok(formatLeft(3661000) === '01:01:01', `一小时零一分零一秒（${formatLeft(3661000)}）`);
  ok(formatLeft(90061000) === '1 天 01:01:01', `超过一天带天数（${formatLeft(90061000)}）`);
  ok(formatLeft(-5) === '00:00:00', '负数当 0 处理');

  // 同一天抽到的是同一款（刷新页面不变），换一天基本会变
  ok(dailyPackOf('2026-03-05').id === dailyPackOf('2026-03-05').id, '同一天限时礼包固定');
  ok(discountOf('2026-03-05').id === discountOf('2026-03-05').id, '同一天折扣商品固定');
  const packIds = new Set(Array.from({ length: 14 }, (_, i) => dailyPackOf(`2026-03-${String(i + 1).padStart(2, '0')}`).id));
  ok(packIds.size >= 2, `14 天里会换到不同的礼包（出现 ${packIds.size} 款）`);
  const discIds = new Set(Array.from({ length: 14 }, (_, i) => discountOf(`2026-03-${String(i + 1).padStart(2, '0')}`).id));
  ok(discIds.size >= 2, `14 天里会换到不同的折扣商品（出现 ${discIds.size} 款）`);
  ok(pickOfDay([], 'x') === null, '空列表安全返回 null');
  ok(typeof hashKey('2026-03-05') === 'number', '哈希返回数字');

  // 折扣
  const dp = discountPrice(5000);
  ok(dp === 2500, `5 折（5000 → ${dp}）`);
  ok(discountPrice(300) <= 300 && discountPrice(300) >= 100, `小额也打折且向上取到百位（300 → ${discountPrice(300)}）`);
  ok(DISCOUNT_RATE === 0.5, '折扣率就是 5 折');
  ok(discountPrice(200000) === 100000, '大额折扣正确');
}

/* ===================================================================== */
console.log('-- 每日 / 每周免费礼包');
{
  const s = newSave();
  const d1 = new Date(2026, 2, 5, 10, 0, 0);
  const d2 = new Date(2026, 2, 6, 10, 0, 0);
  ok(freeGiftState(s, 'daily', d1).canClaim, '第一天可以领每日礼包');
  const r = claimFreeGift(s, 'daily', d1);
  ok(r.ok && r.got.length === FREE_DAILY.rewards.length, '领到每日礼包（直接到账）');
  ok(itemCount(s, 'flower') === 4, '鲜花 +1（新手本来 3 个）');
  ok(!freeGiftState(s, 'daily', d1).canClaim, '同一天不能再领');
  ok(!claimFreeGift(s, 'daily', d1).ok, '重复领取被拒');
  ok(freeGiftState(s, 'daily', d2).canClaim, '第二天又能领');
  ok(claimFreeGift(s, 'daily', d2).ok, '第二天领取成功');

  const w1 = new Date(2026, 2, 5);
  const w2 = new Date(2026, 2, 9); // 下周一
  ok(freeGiftState(s, 'weekly', w1).canClaim, '本周可以领每周礼包');
  ok(claimFreeGift(s, 'weekly', w1).ok, '领到每周礼包');
  ok(!claimFreeGift(s, 'weekly', w1).ok, '同一周不能重复领');
  ok(freeGiftState(s, 'weekly', w2).canClaim, '下一周又能领');
  ok(FREE_WEEKLY.rewards.some((x) => x.amount > FREE_DAILY.rewards[0].amount), '每周礼包比每日厚');
}

/* ===================================================================== */
console.log('-- 首充礼包（奖励走邮箱）');
{
  const s = newSave();
  ok(!firstPayState(s).canClaim, '没充值不能领首充');
  ok(!claimFirstPay(s).ok, '没充值领取被拒');
  ok(!hasPaid(s), '还没充过');

  recordPayment(s, { price: 6, label: '开心豆 · 小袋' });
  ok(totalPaidYuan(s) === 6 && hasPaid(s), '记了一笔 ¥6 充值');
  ok(firstPayState(s).canClaim, '充值后可以领首充');

  const mailsBefore = s.mail.length;
  const res = claimFirstPay(s);
  ok(res.ok && s.mail.length === mailsBefore + 1, '首充奖励进了邮箱（不是直接到账）');
  ok(s.mail[0].rewards.length === FIRST_PAY.rewards.length, '邮件里带着全部首充奖励');
  ok(s.beans === defaultSave().beans, '领首充本身不加豆（要等邮件领取）');
  ok(!firstPayState(s).canClaim && !claimFirstPay(s).ok, '首充只能领一次');

  // 从邮箱领出来 → 东西真的到手
  const claim = claimMail(s, s.mail[0].id);
  ok(claim.ok, '邮箱里能领取');
  ok(ownsFrame(s, 'f_gold'), '拿到了鎏金环头像框');
  ok(isTitleUnlocked(s, 't_first'), '拿到了「初见」称号');
  ok(renameCardCount(s) === 1, '拿到了 1 张改名卡');
  ok(s.beans === defaultSave().beans + 100000, '豆子到账 100,000');
  ok(!claimMail(s, s.mail[0].id).ok, '同一封邮件不能领两次');
}

/* ===================================================================== */
console.log('-- 每日限时礼包（每天两款，档位不同）');
{
  const s = newSave();
  const d1 = new Date(2026, 2, 5, 10, 0);
  const d2 = new Date(2026, 2, 6, 10, 0);
  const st = dailyPackState(s, d1);
  ok(st.packs.length === 2, `今天给两款礼包（实际 ${st.packs.length} 款）`);
  ok(st.packs.every((p) => DAILY_PACKS.some((x) => x.id === p.id)), '两款都来自预设池');
  ok(st.packs[0].id !== st.packs[1].id, '两款不是同一个');
  ok(st.packs[0].price !== st.packs[1].price,
    `两款是不同档位（¥${st.packs[0].price} / ¥${st.packs[1].price}）`);
  ok(dailyPacksOf('2026-03-05').map((p) => p.id).join(',') === dailyPacksOf('2026-03-05').map((p) => p.id).join(','),
    '同一天固定是这两款（刷新页面不变）');
  ok(dailyPacksOf('2026-03-05')[0].id === dailyPackOf('2026-03-05').id, '第一款仍然是老算法那款（老存档才对得上）');

  ok(st.canBuy && st.boughtCount === 0, '今天还没买');
  const first = st.packs[0];
  const res = buyDailyPack(s, first.id, d1);
  ok(res.ok, '买第一款成功');
  ok(totalPaidYuan(s) === first.price, `模拟充值累加了 ¥${first.price}（累计 ¥${totalPaidYuan(s)}）`);
  ok(s.mail.length === 0, '限时礼包**直接到账**（只有首充走邮箱）');
  ok(res.got.length === first.rewards.length, '奖励当场就发了');

  const after = dailyPackState(s, d1);
  ok(after.packs[0].bought && !after.packs[1].bought, '只有买过的那款变成"已买"');
  ok(after.canBuy, '另一款今天还能买');
  ok(!buyDailyPack(s, first.id, d1).ok, '同一款不能重复买');
  const res2 = buyDailyPack(s, st.packs[1].id, d1);
  ok(res2.ok, '第二款也能买');
  ok(dailyPackState(s, d1).allBought && !dailyPackState(s, d1).canBuy, '两款都买完就不能再买了');
  ok(!buyDailyPack(s, d1).ok, '都买过之后（不指定 id）也被拒');
  ok(totalPaidYuan(s) === first.price + st.packs[1].price, '两次购买都计入了累计充值');
  ok(dailyPackState(s, d2).packs.every((p) => !p.bought), '第二天两款都刷新');
  // 老存档：旧字段 packBought=true 表示"当年那唯一一款已买"
  const old = newSave();
  old.activity.packDate = '2026-03-05';
  old.activity.packBought = true;
  old.activity.packsBought = [];
  const oldSt = dailyPackState(old, new Date(2026, 2, 5, 12, 0));
  ok(oldSt.packs[0].bought && !oldSt.packs[1].bought, '老存档的"已买"折算成今天第一款已买');
}

/* ===================================================================== */
console.log('-- 累计充值礼包（30 / 128 / 648 / 2560 元解锁）');
{
  const s = newSave();
  ok(PAY_TIERS.map((t) => t.yuan).join(',') === '30,128,648,2560',
    `解锁门槛就是 30/128/648/2560（实际 ${PAY_TIERS.map((t) => t.yuan).join('/')}）`);
  ok(PAY_TIERS.every((t, i, a) => i === 0 || t.yuan > a[i - 1].yuan), '门槛递增');
  ok(PAY_TIERS.every((t, i, a) => i === 0 || t.rewards[0].amount > a[i - 1].rewards[0].amount), '越往上豆子给得越多');

  const st0 = payTierState(s);
  ok(st0.total === 0 && st0.tiers.every((t) => !t.reached), '没充值时所有档位都未达成');
  ok(!claimPayTier(s, PAY_TIERS[0].yuan).ok, '未达成不能领');

  recordPayment(s, { price: 30, label: 'a' });
  const st1 = payTierState(s);
  ok(st1.tiers[0].reached && st1.tiers[0].canClaim, '¥30 达成第一档');
  ok(!st1.tiers[1].reached, '¥128 还没达成');
  const res = claimPayTier(s, 30);
  ok(res.ok && res.got.length === PAY_TIERS[0].rewards.length, '领取 → **直接到账**（不经过邮箱）');
  ok(s.mail.length === 0, '累充奖励也直接到手，邮箱里没有东西');
  ok(!payTierState(s).tiers[0].canClaim, '同一档不能重复领');
  ok(!claimPayTier(s, 30).ok, '重复领取被拒');

  recordPayment(s, { price: 100, label: 'b' });
  ok(totalPaidYuan(s) === 130, '累计到 ¥130');
  const st2 = payTierState(s);
  ok(st2.tiers[0].reached && st2.tiers[1].reached && !st2.tiers[2].reached, '¥30 / ¥128 达成，¥648 未达成');
  ok(claimPayTier(s, 128).ok, '领第二档');
  // 一次性拉满（买一袋至尊袋就够了）
  recordPayment(s, { price: 2560, label: 'c' });
  const st3 = payTierState(s);
  ok(st3.tiers.every((t) => t.reached), '充多了所有档位都达成');
  ok(st3.tiers.filter((t) => t.canClaim).length === 2, '还剩两档没领');
  ok(claimPayTier(s, 648).ok && claimPayTier(s, 2560).ok, '剩下两档都能领');
  ok(!claimPayTier(s, 999).ok, '不存在的档位被拒');

  // 累计充值看的是"充值"，不是身家
  const poor = newSave();
  poor.beans = 0;
  recordPayment(poor, { price: 30, label: 'x' });
  ok(payTierState(poor).tiers[0].reached, '身家为 0 也不影响累计充值档位');
}

/* ===================================================================== */
console.log('-- 今日限时折扣（道具类能买 5 次 / 装扮类 1 次）');
{
  /** 找一个"当天折扣正好是道具 / 正好是装扮"的日期，保证两条分支都被真跑一遍 */
  const findDay = (wantItem) => {
    for (let i = 1; i <= 60; i += 1) {
      const d = new Date(2026, 2, i, 10, 0);
      const it = discountOf(dayKey(d));
      if (it && (it.kind === 'item') === wantItem) return d;
    }
    return null;
  };
  const itemDay = findDay(true);
  const lookDay = findDay(false);
  ok(!!itemDay && !!lookDay, '60 天里道具类和装扮类都出现过（两条分支都能测）');

  // ---- 道具类：可以买 5 次 ----
  const s = newSave();
  const e = eco(s);
  s.beans = 200000;
  const st = discountState(s, itemDay);
  ok(st.item.kind === 'item', `这天折扣的是道具（${st.item.name}）`);
  ok(st.maxBuys === DISCOUNT_ITEM_BUYS && DISCOUNT_ITEM_BUYS === 5, '道具类今天能买 5 次');
  ok(st.left === 5, '一次没买时还剩 5 次');
  ok(st.price < st.item.price, `折扣价低于原价（${st.item.price} → ${st.price}）`);
  ok(st.off === st.item.price - st.price, '省了多少算得对');

  const before = s.beans;
  const res = buyDiscount(e, itemDay);
  ok(res.ok, '折扣购买成功');
  ok(s.beans === before - st.price, `只扣了折扣价 ${st.price}`);
  ok(discountState(s, itemDay).boughtCount === 1, '记账：今天买过 1 次');
  ok(discountState(s, itemDay).canBuy && discountState(s, itemDay).left === 4, '还能接着买（剩 4 次）');
  ok(itemCount(s, st.item.id) >= 1, '道具真的进了库存');
  for (let i = 2; i <= 5; i += 1) {
    const more = buyDiscount(e, itemDay);
    ok(more.ok, `第 ${i} 次也能买`);
    if (more.ok && i < 5) ok(more.left === 5 - i, `第 ${i} 次之后还剩 ${5 - i} 次`);
  }
  ok(itemCount(s, st.item.id) >= 5, '买 5 次就拿到 5 个道具');
  ok(!discountState(s, itemDay).canBuy && discountState(s, itemDay).left === 0, '买满 5 次后关门');
  ok(!buyDiscount(e, itemDay).ok, '买满后再买被拒');
  ok(/买满/.test(buyDiscount(e, itemDay).error), '拒绝理由说清楚是"买满 5 次"');
  ok(discountState(s, new Date(2026, 2, 6, 10, 0)).canBuy
    || discountState(s, new Date(2026, 2, 6, 10, 0)).item.id !== st.item.id, '换一天就是新的折扣');
  ok(totalPaidYuan(s) === 0, '折扣是花豆子，不算充值');

  // ---- 装扮类：只能买 1 次 ----
  const s2 = newSave();
  s2.beans = 200000;
  const lk = discountState(s2, lookDay);
  ok(lk.item.kind !== 'item', `这天折扣的是装扮（${lk.item.name}）`);
  ok(lk.maxBuys === 1, '装扮类今天只能买 1 次');
  ok(buyDiscount(eco(s2), lookDay).ok, '买一次成功');
  ok(!discountState(s2, lookDay).canBuy, '同一天不能买第二次');
  ok(!buyDiscount(eco(s2), lookDay).ok, '重复购买被拒');

  // 老存档：布尔字段 discountBought=true 折算成"今天已经买过 1 次"
  const old = newSave();
  old.beans = 200000;
  old.activity.discountDate = dayKey(itemDay);
  old.activity.discountBought = true;
  old.activity.discountCount = 0;
  ok(discountState(old, itemDay).boughtCount === 1, '老存档的"已买过"折算成 1 次');
  ok(discountState(old, itemDay).canBuy, '道具类还能再买 4 次（没有被老字段锁死）');

  // 豆子不够
  const poor = newSave();
  poor.beans = 0;
  const bad = buyDiscount(eco(poor), itemDay);
  ok(!bad.ok && /不足/.test(bad.error), '豆子不足时拒绝');
}

/* ===================================================================== */
console.log('-- 邮箱');
{
  const s = newSave();
  ok(claimableMailCount(s) === 0 && unreadMailCount(s) === 0, '空邮箱：没有可领也没有未读');
  const m = pushMail(s, { from: '活动中心', title: '测试奖励', body: '正文', rewards: [{ kind: 'beans', amount: 777 }] });
  ok(s.mail.length === 1 && s.mail[0].id === m.id, '邮件进箱');
  ok(claimableMailCount(s) === 1, '有 1 封可领');
  ok(unreadMailCount(s) === 1, '有 1 封未读');
  ok(m.expireAt - m.at === MAIL_TTL_MS, `${MAIL_TTL_MS / 86400000} 天后过期`);

  const before = s.beans;
  const res = claimMail(s, m.id);
  ok(res.ok && res.got.length === 1, '领取成功');
  ok(s.beans === before + 777, '豆子到账');
  ok(claimableMailCount(s) === 0 && unreadMailCount(s) === 0, '领完既不可领也已读');
  ok(!claimMail(s, m.id).ok, '已领取的不能再领');
  ok(!claimMail(s, 'nope').ok, '不存在的邮件报错');

  // 过期
  const old = pushMail(s, { title: '过期邮件', rewards: [{ kind: 'beans', amount: 1 }] });
  old.expireAt = Date.now() - 1000;
  ok(isMailExpired(old), '过期判定正确');
  const expRes = claimMail(s, old.id);
  ok(!expRes.ok && /过期/.test(expRes.error), '过期邮件不能领');
  const list = listMailWithState(s);
  ok(list.some((x) => x.id === old.id && x.expired), '列表里标出已过期');

  // 一键领取
  const s2 = newSave();
  pushMail(s2, { title: 'a', rewards: [{ kind: 'beans', amount: 100 }] });
  pushMail(s2, { title: 'b', rewards: [{ kind: 'beans', amount: 200 }] });
  pushMail(s2, { title: 'c', rewards: [{ kind: 'item', id: 'egg', n: 2 }] });
  const b0 = s2.beans;
  const all = claimAllMail(s2);
  ok(all.ok && all.count === 3, `一键领取 3 封（实际 ${all.count}）`);
  ok(s2.beans === b0 + 300, '豆子汇总正确');
  ok(itemCount(s2, 'egg') === 5, '道具也汇总（新手 3 + 奖励 2）');
  ok(!claimAllMail(s2).ok, '没有可领时一键领取返回 false');

  // 已读
  const s3 = newSave();
  const m3 = pushMail(s3, { title: 'x', rewards: [] });
  markMailRead(s3, m3.id);
  ok(unreadMailCount(s3) === 0, '单封标记已读');
  pushMail(s3, { title: 'y', rewards: [] });
  markAllMailRead(s3);
  ok(unreadMailCount(s3) === 0, '全部标记已读');

  // 上限：不会无限膨胀
  const s4 = newSave();
  for (let i = 0; i < 80; i += 1) pushMail(s4, { title: `m${i}`, rewards: [] });
  ok(s4.mail.length <= 50, `邮件数量有上限（实际 ${s4.mail.length}）`);
}

/* ===================================================================== */
console.log('-- 奖励发放口径');
{
  const s = newSave();
  const before = {
    beans: s.beans, flower: itemCount(s, 'flower'),
  };
  pushMail(s, {
    title: '全类型奖励',
    rewards: [
      { kind: 'beans', amount: 5000 },
      { kind: 'item', id: 'tomato', n: 2 },
      { kind: 'frame', id: 'f_neon' },
      { kind: 'cardBack', id: 'back_02' },
      { kind: 'title', id: 't_general' },
      { kind: 'renameCard', n: 2 },
    ],
  });
  const res = claimMail(s, s.mail[0].id);
  ok(res.ok && res.got.length === 6, '六种奖励都能发');
  ok(s.beans === before.beans + 5000, '豆子');
  ok(itemCount(s, 'tomato') === 5, '道具（新手 3 + 2）');
  ok(ownsFrame(s, 'f_neon'), '头像框进"已拥有"');
  ok(ownsCardBack(s, 'back_02'), '牌背进"已拥有"');
  ok(isTitleUnlocked(s, 't_general'), '称号直接解锁');
  ok(renameCardCount(s) === 2, '改名卡 ×2');
  ok(!equippedFrame(s), '拿到的头像框不会自动佩戴');

  // 文案口径统一
  const label = rewardLabel({ kind: 'beans', amount: 12345 });
  ok(label.text.includes('12,345'), `奖励文案带千分位（${label.text}）`);
  ok(rewardLabel({ kind: 'renameCard', n: 3 }).text.includes('改名卡'), '改名卡文案');
  ok(rewardLabel({ kind: 'frame', id: 'f_star' }).text.includes('星轨'), '头像框文案');
  ok(rewardLabel({ kind: 'title', id: 't_lucky_star' }).text.includes('欧皇'), '称号文案');
  ok(rewardLabel(null).emoji === '❔', '非法奖励有兜底文案');
  ok(Object.keys({}).length === 0, '（占位）');
  // 每个活动定义的奖励都能生成文案（不会出现"神秘奖励"）
  const allRewards = [
    ...FREE_DAILY.rewards, ...FREE_WEEKLY.rewards, ...FIRST_PAY.rewards,
    ...DAILY_PACKS.flatMap((p) => p.rewards), ...PAY_TIERS.flatMap((t) => t.rewards),
    ...WHEEL.prizes.filter((p) => p.kind !== 'beans').map((p) => ({
      kind: p.kind, id: p.id, n: p.n, amount: p.amount,
    })),
  ];
  const unknown = allRewards.filter((r) => rewardLabel(r).text === '神秘奖励');
  ok(unknown.length === 0, `所有活动奖励都有像样的文案（异常 ${unknown.length} 条）`);
}

/* ===================================================================== */
console.log('-- 装扮：头像框 / 牌背 / 改名卡');
{
  const s = newSave();
  const e = eco(s);
  s.beans = 1000000;
  ok(ownedCardBacks(s).includes('back_01'), '免费牌背默认拥有');
  ok(!ownsCardBack(s, 'back_02'), '付费牌背默认没有');
  ok(ownedFrames(s).length === 0, '默认没有头像框');
  ok(equippedFrame(s) === '' && frameClassOf(s) === '', '默认不戴框，类名为空');

  ownFrame(s, 'f_neon');
  ok(ownsFrame(s, 'f_neon') && ownedFrames(s).length === 1, '拥有一个框');
  ok(ownFrame(s, 'f_neon') === false, '重复拥有返回 false');
  ok(equippedFrame(s) === '', '拥有 ≠ 自动佩戴');
  const eq = equipFrame(s, 'f_neon');
  ok(eq.ok && equippedFrame(s) === 'f_neon', '佩戴成功');
  ok(frameClassOf(s) === 'frame-neon', `类名正确（${frameClassOf(s)}）`);
  ok(equipFrame(s, '').ok && frameClassOf(s) === '', '可以卸下');
  ok(!equipFrame(s, 'f_frost').ok, '没拥有的框不能戴');
  ok(!ownsFrame(s, 'f_gold') && !ownFrame(s, 'f_not_exist'), '不存在的框戴不上');

  const rename0 = renameCardCount(s);
  addRenameCard(s, 2);
  ok(renameCardCount(s) === rename0 + 2, '加改名卡');
  ok(useRenameCard(s) === true && renameCardCount(s) === rename0 + 1, '用掉一张');
  useRenameCard(s);
  ok(useRenameCard(s) === false, '没卡了用不了');

  // 商城购买
  const b0 = s.beans;
  const buyFrame = buyCosmetic(e, { kind: 'frame', id: 'f_sakura' });
  ok(buyFrame.ok && s.beans === b0 - 120000, '买头像框扣豆');
  ok(ownsFrame(s, 'f_sakura'), '买到就拥有');
  ok(!buyCosmetic(e, { kind: 'frame', id: 'f_sakura' }).ok, '不能重复买同一个框');
  ok(!buyCosmetic(e, { kind: 'frame', id: 'f_gold' }).ok, '限定框（首充送）不在售');
  ok(!buyCosmetic(e, { kind: 'frame', id: 'f_star' }).ok, '转盘限定框不在售');
  ok(buyCosmetic(e, { kind: 'cardBack', id: 'back_03' }).ok, '买牌背成功');
  ok(ownsCardBack(s, 'back_03'), '牌背进已拥有');
  const bc = buyCosmetic(e, { kind: 'renameCard' });
  ok(bc.ok && bc.count === rename0 + 1, '买改名卡（进数量）');

  const poor = newSave();
  poor.beans = 10;
  ok(!buyCosmetic(eco(poor), { kind: 'cardBack', id: 'back_02' }).ok, '豆子不够买不了');

  const list = cosmeticList(s);
  ok(list.frames.length === FRAMES.length, '装扮列表列出所有头像框');
  ok(list.frames.filter((f) => f.forSale).length === FRAMES_FOR_SALE.length, '在售的只有可买的那些');
  ok(list.cardBacks.length === CARD_BACKS.length, '列出所有牌背');
  ok(list.themes.length === THEMES.length, '★ 列出所有风格（深色主题在商城售卖）');
  ok(list.renamePrice === RENAME_CARD.price, '改名卡价格一致');
}

/* ===================================================================== */
console.log('-- 风格（深色 / 浅色主题）：拥有、佩戴、切换');
{
  const s = newSave();
  const e = eco(s);
  s.beans = 500000;

  ok(THEMES.length >= 2, '至少有深色和浅色两套风格');
  ok(FREE_THEME === 'th_dark', '★ 默认（免费）的是深色');
  ok(THEMES_FOR_SALE.length === THEMES.filter((t) => t.price > 0).length, '在售 = 有价格的那些');
  ok(THEMES_FOR_SALE.some((t) => t.tone === 'light'), '★ 浅色风格在售卖列表里');
  ok(THEMES.every((t) => t.name && typeof t.tone === 'string'), '每套风格都有名字和 tone（决定挂哪个 data-theme）');
  ok(themeById('th_light') && themeById('th_light').tone === 'light', '浅色风格 id 与 tone 对得上');

  // 免费那款永远算拥有，否则老存档一进来就没有主题
  ok(ownsTheme(s, FREE_THEME) && ownedThemes(s).includes(FREE_THEME), '免费风格默认拥有');
  ok(equippedTheme(s) === '' && themeNameOf(s) === '', '默认不佩戴 → data-theme 为空（就是深色）');
  ownTheme(s, 'th_light');
  ok(ownsTheme(s, 'th_light') && ownTheme(s, 'th_light') === false, '拥有浅色风格（重复拥有返回 false）');
  ok(!equipTheme(s, 'th_nope').ok, '没拥有的风格不能佩戴');
  const eq = equipTheme(s, 'th_light');
  ok(eq.ok && equippedTheme(s) === 'th_light', '佩戴浅色成功');
  ok(themeNameOf(s) === 'light', '★ 浅色风格 → <html data-theme="light">');
  ok(equipTheme(s, '').ok && themeNameOf(s) === '', '可以切回默认（空 data-theme = 深色）');
  equipTheme(s, 'th_light');

  // 商城购买
  const s2 = newSave();
  s2.beans = 500000;
  const b0 = s2.beans;
  const light = THEMES_FOR_SALE.find((t) => t.tone === 'light');
  const buy = buyCosmetic(eco(s2), { kind: 'theme', id: light.id });
  ok(buy.ok && s2.beans === b0 - light.price, `买风格扣豆（💰${light.price.toLocaleString()}）`);
  ok(ownsTheme(s2, light.id), '买到就拥有');
  ok(!buyCosmetic(eco(s2), { kind: 'theme', id: light.id }).ok, '不能重复买同一套风格');
  ok(!buyCosmetic(eco(s2), { kind: 'theme', id: FREE_THEME }).ok, '免费那套不在售（不用买）');
  const poor = newSave();
  poor.beans = 10;
  ok(!buyCosmetic(eco(poor), { kind: 'theme', id: light.id }).ok, '豆子不够买不了');
  ok(cosmeticList(s2).themes.find((t) => t.id === light.id).owned, '装扮列表里标成已拥有');
}

/* ===================================================================== */
console.log('-- 排行榜：玩家与 AI 平等');
{
  const s = newSave();
  ensureAiEcon(s);
  s.nickname = '我';
  s.beans = 5000;

  const data = wealthRanking(s);
  ok(data.top.length === RANK_SIZE, `只排前 ${RANK_SIZE} 名（实际 ${data.top.length}）`);
  ok(data.total === PERSONAS.length + 1, `总参与人数 = 玩家 + 24 个 AI（实际 ${data.total}）`);
  ok(data.top.every((e, i, arr) => i === 0 || arr[i - 1].beans >= e.beans), '按身家降序');
  ok(data.top.every((e, i) => e.rank === i + 1), '名次连续');
  ok(data.top.some((e) => e.kind === 'me') === data.inTop, 'inTop 与榜上有没有自己一致');
  ok(data.inTop ? data.me === null : !!data.me, '进了前十就不再单独给"我"那一行');

  // 玩家与 AI 的字段结构完全一致（界面才能用同一套渲染）
  const meFields = ['key', 'kind', 'id', 'name', 'avatar', 'beans', 'title', 'titleId', 'rank'].sort();
  const aiEntry = data.top.find((e) => e.kind === 'ai') || wealthRanking(s).top[0];
  ok(JSON.stringify(Object.keys(aiEntry).sort()) === JSON.stringify(meFields), '玩家与 AI 的字段完全一样');

  // 身家最高 → 玩家第一
  s.beans = 999999999;
  const rich = wealthRanking(s);
  ok(rich.inTop && rich.top[0].kind === 'me' && rich.top[0].rank === 1, '身家最高时自己是第一（就是普通的第一名）');
  ok(rich.me === null, '第一名不额外给自己开小灶');

  // 身家最低 → 未上榜，且名次是真实名次
  s.beans = 0;
  const poor = wealthRanking(s);
  const minAi = Math.min(...PERSONAS.map((p) => aiBeansOfSafe(s, p.id)));
  if (minAi > 0) {
    ok(!poor.inTop, '身家 0 时应该上不了榜');
    ok(!!poor.me && poor.me.kind === 'me', '未上榜时单独给出自己那一行');
    ok(poor.me.rank === poor.total, `名次排最后（第 ${poor.me.rank}/${poor.total} 名）`);
    ok(!poor.top.some((e) => e.kind === 'me'), '前十名里确实没有自己');
  }
  ok(medalOf(1).emoji === '🥇' && medalOf(2).emoji === '🥈' && medalOf(3).emoji === '🥉', '前三名有奖牌');
  ok(medalOf(4).emoji === '', '第四名没有奖牌');
  // ★ 排行榜称号看不清的 bug：徽章的文字是深紫色，所以界面必须自己画底色（或用 titleId 取渐变）
  ok(data.top.every((e) => typeof e.titleId === 'string'), '★ 每行都带 titleId（给界面取称号渐变色用）');
  ok(data.top.some((e) => e.title && e.titleId) || data.top.every((e) => !e.title),
    '有称号的行同时有 titleId（有名字却取不到颜色，就是那个"深色看不清"的 bug）');
  ok(beanText(12345) === '1.23万', `大数压缩（${beanText(12345)}）`);
  ok(beanText(999) === '999', '小数原样');
  ok(beanText(250000000) === '2.5亿', `亿级压缩（${beanText(250000000)}）`);
}

function aiBeansOfSafe(save, id) {
  // 只为上面那条断言服务的小工具
  const v = save.aiEcon && save.aiEcon.beans ? save.aiEcon.beans[id] : 0;
  return Number.isFinite(v) ? v : 0;
}

/* ===================================================================== */
console.log('-- 活动总览一次取全（面板用）');
{
  const s = newSave();
  const o = activityOverview(s);
  for (const k of ['daily', 'weekly', 'first', 'pack', 'tiers', 'discount', 'wheel']) {
    ok(!!o[k], `总览里有 ${k}`);
  }
  ok(o.daily.canClaim && o.weekly.canClaim && !o.first.canClaim, '新号：免费礼包可领、首充不可领');
  ok(typeof o.discount.price === 'number' && o.discount.price > 0, '今日折扣有价格');
  ok(o.wheel.spins === 0 && o.wheel.cost === WHEEL.cost, '转盘状态正确');
}

/* ===================================================================== */
console.log('-- 老存档兼容');
{
  // 模拟没有 activity / cosmetics / wallet / mail 字段的旧存档
  const old = { version: 1, nickname: '老玩家', beans: 5000, signIn: { lastDate: '', streak: 0 }, items: {} };
  ensureActivity(old);
  ensureCosmetics(old);
  ensureMail(old);
  ensureTitleState(old);
  ok(!!old.activity && !!old.wallet && Array.isArray(old.mail), '缺字段时自动补齐');
  ok(old.wallet.totalYuan === 0, '钱包从 0 开始');
  ok(ownedCardBacks(old).includes('back_01'), '老存档也有免费牌背');
  const o = activityOverview(old);
  ok(o.daily.canClaim, '老存档也能领今日礼包');
  ok(!o.first.canClaim, '老存档不算已充值');
  const r = wealthRanking(old);
  ok(r.top.length === RANK_SIZE, '老存档也能排榜');
}

/* ===================================================================== */
console.log('-- 人设：性别 / 年龄 / 时间背景知识');
{
  // 性别
  ok(PERSONAS.length >= 29, `人设数量（实际 ${PERSONAS.length}）：p01~p28 + 后来加的 p29 何知非`);
  ok(PERSONAS.every((p) => p.gender === 'm' || p.gender === 'f'), '每个都标了性别');
  ok(PERSONAS.every((p) => genderOf(p) === p.gender), 'genderOf 读得对');
  ok(PERSONAS.every((p) => ['♂', '♀'].includes(genderSign(p))), '♂ / ♀ 符号正确');
  const females = PERSONAS.filter((p) => p.gender === 'f');
  const males = PERSONAS.filter((p) => p.gender === 'm');
  ok(females.length >= 12 && males.length >= 10, `男女都有（♀${females.length} / ♂${males.length}）`);
  ok(genderOf(null) === 'm' && genderOf({}) === 'm', '缺字段时按男兜底，不炸');
  const gline = genderPromptLine(PERSONAS[0]);
  ok(/你的性别/.test(gline) && /别每句都提性别/.test(gline), '性别提示词写清楚了"是背景知识、别每句提"');

  // 年龄：覆盖 18~55，且整体偏年轻
  ok(PERSONAS.every((p) => Number.isFinite(p.age)), '每个都有年龄');
  const ages = PERSONAS.map((p) => p.age);
  ok(Math.min(...ages) >= 18, `最小的也满 18 岁（最小 ${Math.min(...ages)}）`);
  ok(Math.min(...ages) === 18 && Math.max(...ages) === 55,
    `年龄覆盖 18~55（实际 ${Math.min(...ages)}~${Math.max(...ages)}）`);
  const sorted = [...ages].sort((a, b) => a - b);
  const median = (sorted[11] + sorted[12]) / 2;
  ok(median <= 27, `中位数偏年轻（${median} 岁）`);
  ok(ages.filter((a) => a <= 25).length >= 10, `25 岁及以下有 ${ages.filter((a) => a <= 25).length} 人（年轻的多）`);
  ok(ageOf(null) === 25 && ageOf({}) === 25, '缺年龄时兜底 25');
  const aline = agePromptLine(PERSONAS[0]);
  ok(/你的年龄/.test(aline) && /绝对不要主动提年龄/.test(aline), '年龄进提示词，且明确"不许主动提"');
  ok(!/多大/.test(aline.replace('不说自己多大', '')), '提示词不会诱导它自己报年龄');

  // 早先新增的 4 位女性：二次元 / 傲娇 / 阿姨 / 萝莉（按 id 挑，别用下标——后面还会加人）
  const added = ['p25', 'p26', 'p27', 'p28'].map((id) => PERSONAS.find((p) => p.id === id)).filter(Boolean);
  ok(added.length === 4 && added.every((p) => p.gender === 'f'), '新增的 4 位都是女性');
  ok(added.some((p) => /二次元/.test(p.tags.join(''))), '有一个二次元');
  ok(added.some((p) => /傲娇/.test(p.tags.join(''))), '有一个傲娇');
  ok(added.some((p) => /阿姨/.test(p.tags.join(''))), '有一个阿姨');
  ok(added.some((p) => /萝莉/.test(p.tags.join(''))), '有一个萝莉');
  // ★ p29 何知非：用户后来加的阳光文科生
  {
    const p = PERSONAS.find((x) => x.id === 'p29');
    ok(!!p, '★ 有 p29 何知非');
    ok(p.name === '何知非' && p.avatar === 'avatar_29', `名字/头像对得上（${p.name} / ${p.avatar}）`);
    ok(p.age === 21, '21 岁');
    ok(p.tags.join('').includes('阳光') && p.tags.join('').includes('文科') && p.tags.join('').includes('学霸'),
      `标签是 阳光/文科/学霸（${p.tags.join('/')}）`);
    ok(Object.keys(p.lines).length === 15 && Object.values(p.lines).every((l) => l.length === 3),
      '15 个场景、每个 3 条台词（和别的人设一样）');
  }
  // ★ p30 说的道理（爱玩抽象、攻击性强、现实社恐）
  {
    const p = PERSONAS.find((x) => x.id === 'p30');
    ok(!!p, '★ 有 p30 说的道理');
    ok(p.name === '说的道理' && p.avatar === 'avatar_30', `名字/头像对得上（${p.name} / ${p.avatar}）`);
    ok(p.gender === 'm' && p.age === 24, '24 岁男生');
    ok(p.tags.join('').includes('抽象') && p.tags.join('').includes('社恐'),
      `标签是 抽象/嘴臭/社恐（${p.tags.join('/')}）`);
    ok(Object.keys(p.lines).length === 15 && Object.values(p.lines).every((l) => l.length === 3),
      '15 个场景、每个 3 条台词');
    // 用户拍板：高强度冲浪的钢铁直男，**不用颜文字**（原来那池子已清空）
    ok(Array.isArray(p.kaomoji) && p.kaomoji.length === 0, '★ 完全不用颜文字');
    ok(/从不用颜文字/.test(p.prompt), '提示词里也写明了不用颜文字');
    // 那批梗要在人设里点名
    for (const word of ['典', '孝', '急', '乐', '绷', '麻', '幽默', '乐子']) {
      ok(p.prompt.includes(word), `口头禅里有「${word}」`);
    }
    for (const meme of ['疑似有点', '你这种', '那没事了', 'chovy', '这辈子有了']) {
      ok(p.prompt.includes(meme), `梗里有「${meme}」`);
    }
    ok(!JSON.stringify(p.emoji).includes('💀'), '★ 不用 💀 这个表情');
    ok(p.emoji.includes('😅') && p.emoji.includes('🤡'), '表情池是 😅 / 🤡');
    ok(/钢铁直男/.test(p.prompt) && /社恐宅男/.test(p.prompt), '人设是"网上钢铁直男 / 现实社恐宅男"');
    ok(p.reactions && p.reactions.softenForWomen === true, '★ 挂了"对女生会收着火"的设定');
  }
  // ★ 看人下菜那一行：男生一直开火；女生随好感度降攻击性
  {
    const p30 = PERSONAS.find((x) => x.id === 'p30');
    const male = personaReactionLine(p30, { playerGender: 'male', affinity: 90 });
    ok(/玩家是男生/.test(male) && /一直/.test(male) && /不用收敛/.test(male),
      '★ 玩家是男生 → 一直那副冲浪样，好感度再高也不收敛');
    const cold = personaReactionLine(p30, { playerGender: 'female', affinity: 10 });
    const warm = personaReactionLine(p30, { playerGender: 'female', affinity: 60 });
    const close = personaReactionLine(p30, { playerGender: 'female', affinity: 90 });
    ok(/火力收着点/.test(cold), '★ 女生 + 还不熟：火力收着点');
    ok(/明显没那么冲/.test(warm), '★ 女生 + 聊得来：明显没那么冲');
    ok(/基本收起来/.test(close) && /不要\*\*再冲她甩/.test(close),
      '★ 女生 + 好感度高：攻击性基本收起来、不知所措');
    ok(cold !== warm && warm !== close, '三档说法各不相同（好感度真的起作用）');
    ok(/基本收起来/.test(personaReactionLine(p30, { playerGender: 'female', affinity: 20, lover: true })),
      '成了恋人直接按最高档走');
    ok(personaReactionLine(p30, { playerGender: '玩家是女生（称呼别叫错性别，可以用「姐妹 / 小姐姐」这类说法）', affinity: 90 }).includes('基本收起来'),
      '★ 直接把 playerGenderLine() 那句话传进来也认得（不用各处再算一次 id）');
    ok(personaReactionLine(PERSONAS.find((x) => x.id === 'p02'), { playerGender: 'female', affinity: 90 }) === '',
      '没这条设定的人设不注入（不占提示词）');
    ok(personaReactionLine(p30, {}) .includes('玩家是男生'), '性别未知时按默认（男）走');
  }
  // ★ 另外两种"看人下菜"：口癖浓度 / 三次元话题
  {
    const p01 = PERSONAS.find((x) => x.id === 'p01');
    const p25 = PERSONAS.find((x) => x.id === 'p25');
    ok(p01.reactions && p01.reactions.toneDownSlang === true, '★ p01 不吃香菜挂了"好感越高口癖越少"');
    ok(/小红书/.test(p01.tags.join('')) || /小红书/.test(p01.prompt), 'p01 改成了小红书重度用户');
    for (const tic of ['啊啊啊啊', '家人们', '绝绝子', '一整个大']) {
      ok(p01.prompt.includes(tic), `口癖里有「${tic}」`);
    }
    const coldSlang = personaReactionLine(p01, { affinity: 10 });
    const midSlang = personaReactionLine(p01, { affinity: 50 });
    const warmSlang = personaReactionLine(p01, { affinity: 90 });
    ok(/口癖密度高/.test(coldSlang), '★ 陌生时口癖密度高');
    ok(/比刚认识时少一些/.test(midSlang), '★ 熟了以后口癖变少');
    ok(/明显退潮/.test(warmSlang), '★ 很熟以后口癖明显退潮（但不全戒）');
    ok(coldSlang !== midSlang && midSlang !== warmSlang, '三档各不相同');

    ok(p25.reactions && p25.reactions.easeIntoReality === true, '★ p25 挂了"好感越高越聊三次元"');
    ok(['2333', 'orz', 'QAQ', 'ovo'].every((k) => p25.kaomoji.includes(k)),
      `颜文字池里有 2333/orz/QAQ/ovo（${p25.kaomoji.join(' ')}）`);
    const coldReal = personaReactionLine(p25, { affinity: 10 });
    const midReal = personaReactionLine(p25, { affinity: 50 });
    const warmReal = personaReactionLine(p25, { affinity: 90 });
    ok(/很少主动说/.test(coldReal), '★ 不熟时基本只聊二次元');
    ok(/偶尔会漏出一点现实日常/.test(midReal), '★ 熟一点会漏一点现实日常');
    ok(/主动聊一点三次元/.test(warmReal), '★ 很熟会主动聊三次元');
    // 一个人设可以同时挂多条（拼成多行）
    ok(personaReactionLine({ id: 'x', reactions: { toneDownSlang: true, easeIntoReality: true } }, { affinity: 90 }).split('\n').length === 2,
      '多条 reaction 拼成多行');
  }
  // ★ 冷面棋手 → 小柳先生（古风小生）
  {
    const p = PERSONAS.find((x) => x.id === 'p02');
    ok(p.name === '小柳先生', `★ p02 改名为小柳先生（${p.name}）`);
    ok(p.age === 21 && p.tags.join('').includes('古风'), `21 岁、古风标签（${p.tags.join('/')}）`);
    ok(/文绉绉|在下|承让/.test(p.prompt), '人设是文绉绉的古风小生');
    ok(!PERSONAS.some((x) => x.name === '冷面棋手'), '★ 旧名字「冷面棋手」已经不在了');
  }
  ok(added.every((p) => p.tags.length >= 2 && p.prompt.length > 40), '4 位的新人设都写完整了');
  ok(added.every((p) => SCENES.every((s) => Array.isArray(p.lines[s]) && p.lines[s].length >= 3)),
    '4 位的 15 个场景都有 3 条台词');
  ok(added.every((p) => SCENES.every((s) => p.lines[s].every((l) => l.length <= 18))),
    '4 位的台词都不超过 18 个字');
  ok(added.every((p) => !!SIGNATURES[p.id]), '4 位都有好友列表个性签名');
  ok(added.every((p) => !!PLAY_STYLE_BY_PERSONA[p.id]), '4 位都有打法风格');
  // 萝莉那条人设：设定是成年人，台词不涉及暧昧
  const loli = added.find((p) => /萝莉/.test(p.tags.join('')));
  ok(loli.age >= 18, `萝莉人设也是成年人（${loli.age} 岁）`);
  ok(/成年人/.test(loli.prompt), '提示词里写明"你是成年人"，划清边界');
}

/* ===================================================================== */
console.log('-- 时间背景知识（防止 AI 时间错位）');
{
  const mk = (h, mi) => new Date(2026, 2, 5, h, mi || 0);
  // 时段映射（顺序写错会让"凌晨"永远命中，这里逐个卡边界）
  const cases = [[0, '凌晨'], [4, '凌晨'], [5, '清晨'], [8, '早上'], [11, '上午'],
    [12, '中午'], [14, '下午'], [17, '傍晚'], [19, '晚上'], [23, '深夜']];
  for (const [h, want] of cases) ok(periodOf(mk(h)) === want, `${String(h).padStart(2, '0')}:00 是「${want}」（实际 ${periodOf(mk(h))}）`);

  ok(clockText(mk(23, 4)) === '23:04', `时间补零（${clockText(mk(23, 4))}）`);
  ok(/2026年3月5日 周四/.test(dateText(mk(9))), `日期带星期（${dateText(mk(9))}）`);

  const night = timeContextLine(mk(23, 41));
  ok(/现在的时间/.test(night) && /深夜/.test(night), '时间行写明了日期与时段');
  ok(/别祝人"早安"/.test(night), '深夜会明确提醒"别祝人早安"');
  ok(/不要主动报时间/.test(night), '同时要求"别主动报时间"');
  const morning = timeContextLine(mk(6));
  ok(/别问人"怎么还不睡"/.test(morning), '清晨会提醒"别问人怎么还不睡"');
  ok(/适合"早啊"/.test(timeContextLine(mk(9))), '早上会建议"早啊"这类打招呼');
  ok(/别主动报时间/.test(timeContextLine(mk(9), { short: true })), '牌桌用的短版本也在');
  ok(timeContextLine(mk(9)).length < 200, '这行不会太长（不然每次调用都白烧 token）');

  // 距上次聊天多久
  ok(gapText(30 * 1000) === '刚刚', '半分钟 = 刚刚');
  ok(gapText(12 * 60000) === '12 分钟前', '分钟级');
  ok(gapText(3 * 3600000) === '3 小时前', '小时级');
  ok(gapText(26 * 3600000) === '昨天', '跨天 = 昨天');
  ok(gapText(4 * 86400000) === '4 天前', '多天');
  ok(gapText(400 * 86400000) === '很久以前', '太久远');
  ok(gapText(-100) === '刚刚', '负数当刚刚');

  const now = mk(20, 0).getTime();
  ok(lastChatGapLine([], now) === '', '没有聊天记录就不加这一行');
  const near = lastChatGapLine([{ role: 'ai', at: now - 2 * 60000 }], now);
  ok(/2 分钟前/.test(near) && /别说"好久不见"/.test(near), '刚聊过 → 明确禁止说"好久不见"');
  const far = lastChatGapLine([{ role: 'ai', at: now - 5 * 86400000 }], now);
  ok(/5 天前/.test(far), '隔了很久会如实说 5 天前');
  ok(lastChatGapLine(null, now) === '', '传 null 不炸');
}

/* ===================================================================== */
console.log('-- ★ 时间锚点：AI 不只要知道"几点"，还要知道"哪一天"');
{
  /* 用户报的问题：昨晚 23 点聊完，今天 11 点再来，她还问"怎么还没睡"。
     原因是提示词里只有"现在几点"，没有"上次那句话是哪天的"。 */
  const today = new Date(2026, 8, 24, 11, 5); // 2026-09-24 11:05
  const lastNight = new Date(2026, 8, 23, 23, 10).getTime();
  const line = lastChatGapLine([{ role: 'ai', at: lastNight }], today.getTime());

  ok(stampText(lastNight, today) === '9月23日 23:10', 'stampText：同年不写年份（9月23日 23:10）');
  ok(stampText(new Date(2025, 0, 2, 9, 8).getTime(), today) === '2025年1月2日 09:08', 'stampText：跨年才写年份');
  ok(stampText(0, today) === '' && stampText(undefined, today) === '', '没有时间就不写（不冒出 NaN）');

  ok(/9月23日 23:10/.test(line), '★ 上次说话带上**月日**（不是只有"12 小时前"）');
  ok(/另一天/.test(line) && /9月24日 11:05/.test(line), '★ 跨天时明说"那是另一天"，并给出当前的月日时刻');
  ok(/怎么还没睡/.test(line), '★ 明确禁止把昨晚的场景搬到今天白天（"怎么还没睡"）');
  ok(/早啊/.test(line), '跨天时给个改口的示范（"早啊"）');

  const sameDay = lastChatGapLine([{ role: 'ai', at: today.getTime() - 5 * 60000 }], today.getTime());
  ok(!/另一天/.test(sameDay), '同一天不啰嗦"另一天"');

  const ctx = timeContextLine(today);
  ok(/2026年9月24日 周四/.test(ctx), '★ 时间行里写全 年月日 + 星期');
  ok(/先看清今天是几月几号/.test(ctx), '并且点名"先看清今天是几月几号"');
  ok(/9月24日/.test(dateText(today)), 'dateText 本身就带月日');

  // 历史里的日期小标：第一天的那条挂上时间戳，同一天内不重复挂
  const hist = historyLines([
    { role: 'ai', text: '早点睡', at: lastNight },
    { role: 'me', text: '好', at: lastNight + 60000 },
    { role: 'me', text: '在吗', at: today.getTime() - 120000 },
  ], today);
  ok(hist.length === 3, '历史三条都在');
  ok(/^（9月23日 23:10）你：早点睡$/.test(hist[0]), '★ 跨天那条历史前面挂上时间戳');
  ok(!/（/.test(hist[1]), '同一天内的第二条不再挂');
  ok(/^（今天）朋友：在吗$/.test(hist[2]), '回到今天那一条挂"（今天）"');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '活动 / 转盘 / 邮箱 / 排行榜检查通过'}`);
process.exit(fail ? 1 : 0);
