/**
 * 礼物系统测试（node tools/test-gifts.mjs）
 *
 * 用户拍板的五条里，前三条在这里：
 *   1) 商城多一类「礼物」+ 好友界面赠送：每日每人 3 次、好感度按档位加、
 *      送完发一条赠礼消息、好友据此回应、并写一条"礼物"记忆
 *   2) 审查 AI 多审一层"要不要送礼"（受财力与关系约束，不可能强送最贵的）
 *   3) 第一次成为恋人 → 称号「神仙眷侣」
 */
import { readFileSync } from 'node:fs';
import { GIFTS, GIFT, FRIEND } from '../src/config.js';
import { defaultSave } from '../src/store/storage.js';
import { Economy } from '../src/store/economy.js';
import { addFriend, findFriend, listGiftMemory } from '../src/store/friends.js';
import { itemCount, ensureItems, buyItem } from '../src/store/items.js';
import {
  sendGiftToFriend, sendGiftToPlayer, giftsSentToday, giftsLeftFor,
  aiGiftsToday, aiGiftsLeft, giftOptionsForAi, ensureGiftLedger,
} from '../src/store/gifts.js';
import { setAiBeans, aiBeansOf } from '../src/store/aiBeans.js';
import { buildAnalyzeMessages, parseAnalysis, pickAllowedGift } from '../src/ai/friend.js';
import { awardTitle, isTitleUnlocked } from '../src/store/titles.js';
import { TITLES, titleById } from '../src/data/titles.js';
import { playerGiftLine, aiGiftLine } from '../src/data/giftLines.js';
import { PERSONAS } from '../src/data/personas.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function newSave() {
  const s = defaultSave();
  s.nickname = '小徐';
  ensureItems(s);
  return s;
}
const P = PERSONAS[0];

/* ===================================================================== */
console.log('-- 礼物数据与商城');
{
  ok(GIFTS.length === 4, `礼物 4 档（实际 ${GIFTS.length}）`);
  const byId = Object.fromEntries(GIFTS.map((g) => [g.id, g]));
  ok(byId.g_rose.price === 1000 && byId.g_rose.affinity === 1, '🌹 玫瑰花 1000 豆 / 好感 +1');
  ok(byId.g_box.price === 9999 && byId.g_box.affinity === 3, '🎁 礼盒 9999 豆 / 好感 +3');
  ok(byId.g_diamond.price === 88888 && byId.g_diamond.affinity === 10, '💎 钻石 88888 豆 / 好感 +10');
  ok(byId.g_ring.price === 520000 && byId.g_ring.affinity === 30, '💍 戒指 520000 豆 / 好感 +30');
  ok(GIFT.dailyPerFriend === 3 && GIFT.aiDailyMax === 3, '★ 每天每人最多 3 次（两个方向都是 3）');

  // 商城里能买，买完进库存
  const s = newSave();
  s.beans = 200000;
  const eco = new Economy(s, () => {});
  ok(itemCount(s, 'g_rose') === 0, '初始没有礼物');
  const buy = buyItem(eco, 'g_rose');
  ok(buy.ok && itemCount(s, 'g_rose') === 1, '商城买玫瑰花 → 库存 1');
  ok(s.beans === 200000 - 1000, '买礼物扣开心豆');

  // 商城面板里确实有「礼物」这一栏，而且用的是 GIFTS
  const shop = read('../src/ui/panels.js');
  ok(/data-tab="gifts"/.test(shop), '★ 商城多了「礼物」分类');
  ok(/GIFTS\.map/.test(shop) && /renderGifts/.test(shop), '礼物栏是独立渲染的（和牌桌道具分开）');
  const items = read('../src/store/items.js');
  ok(/\[\.\.\.ITEMS, \.\.\.GIFTS\]/.test(items), '库存初始化把道具与礼物都算上');
}

console.log('-- 玩家赠礼：扣库存 / 加好感 / 每日 3 次 / 写礼物记忆');
{
  const s = newSave();
  s.beans = 500000;
  const eco = new Economy(s, () => {});
  addFriend(s, P);
  buyItem(eco, 'g_rose');
  buyItem(eco, 'g_rose');
  buyItem(eco, 'g_rose'); // 多买一支：这样才能把"每日 3 次"这条规矩单独测出来
  buyItem(eco, 'g_box');
  const before = findFriend(s, P.id).affinity;

  const r1 = sendGiftToFriend(s, eco, P.id, 'g_rose', { today: '2026-09-22' });
  ok(r1.ok && r1.affinity === 1 && r1.left === 2, '送出玫瑰：好感 +1，今天还能送 2 次');
  ok(itemCount(s, 'g_rose') === 2, '库存扣掉一支');
  ok(findFriend(s, P.id).affinity === before + 1, '好感度真的加上了');

  const r2 = sendGiftToFriend(s, eco, P.id, 'g_rose', { today: '2026-09-22' });
  ok(r2.ok, '再送一支也成功');
  const mem = listGiftMemory(findFriend(s, P.id));
  ok(mem.length === 1 && /礼物：玩家送过我/.test(mem[0]), '★ 写了一条「礼物」记忆（玩家送过我…）');
  ok(mem[0].includes('🌹玫瑰花×2'), `★ 同类累加件数（实际：${mem[0]}）`);

  const r3 = sendGiftToFriend(s, eco, P.id, 'g_box', { today: '2026-09-22' });
  ok(r3.ok && r3.left === 0, '第 3 次成功（礼盒 +3）');
  ok(giftsLeftFor(s, P.id, '2026-09-22') === 0, '今天额度用完');
  ok(mem[0].includes('🌹玫瑰花×2') && /🎁礼盒/.test(listGiftMemory(findFriend(s, P.id))[0]),
    '两个方向/两种礼物都在记忆里');

  const r4 = sendGiftToFriend(s, eco, P.id, 'g_rose', { today: '2026-09-22' });
  ok(!r4.ok && /今天/.test(r4.error), `★ 第 4 次被每日 3 次限制挡住（${r4.error}）`);

  // 换一天自动重置
  ok(giftsLeftFor(s, P.id, '2026-09-23') === 3, '★ 换一天额度重置为 3');
  const r5 = sendGiftToFriend(s, eco, P.id, 'g_rose', { today: '2026-09-23' });
  ok(r5.ok, '第二天又能送了');

  // 没有库存 / 不是好友
  const s2 = newSave();
  addFriend(s2, P);
  const noStock = sendGiftToFriend(s2, null, P.id, 'g_rose');
  ok(!noStock.ok && /商城/.test(noStock.error), '没有库存时给出"去商城买"的提示');
  const notFriend = sendGiftToFriend(s, eco, PERSONAS[9].id, 'g_rose');
  ok(!notFriend.ok, '不是好友送不了');
}

console.log('-- AI 回赠：财力 + 关系约束');
{
  const s = newSave();
  addFriend(s, P);
  const friend = findFriend(s, P.id);

  // 关系很低 → 只可能送得起最便宜的那档（门槛：礼盒要 20，钻石 60，戒指 80）
  friend.affinity = 0;
  setAiBeans(s, P.id, 2000000);
  let opts = giftOptionsForAi(s, P.id);
  ok(opts.length === 1 && opts[0].id === 'g_rose', `★ 关系不到位时只送得起玫瑰（实际 ${opts.map((o) => o.id).join('/')}）`);

  // 关系拉满 + 身家很大 → 四档都买得起（戒指 52 万，预算 = min(身家-5000, 身家×25%)）
  friend.affinity = 90;
  setAiBeans(s, P.id, 3000000);
  opts = giftOptionsForAi(s, P.id);
  ok(opts.length === 4, `好关系 + 富 → 四档都能送（实际 ${opts.length}）`);

  // 身家很穷 → 贵的一律不出现在清单里（不可能强送最贵的）
  setAiBeans(s, P.id, 12000);
  opts = giftOptionsForAi(s, P.id);
  ok(!opts.some((o) => o.id === 'g_ring') && !opts.some((o) => o.id === 'g_diamond'),
    '★ 穷的时候不会去送钻石/戒指（财力约束）');

  // 送礼真的扣它自己的身家、并把东西送进玩家库存
  friend.affinity = 90;
  setAiBeans(s, P.id, 500000);
  const beforeBeans = aiBeansOf(s, P.id);
  const beforeStock = itemCount(s, 'g_diamond');
  const sent = sendGiftToPlayer(s, P.id, 'g_diamond', { today: '2026-09-22' });
  ok(sent.ok, 'AI 送出一颗钻石');
  ok(aiBeansOf(s, P.id) === beforeBeans - 88888, '★ 送礼花的是它自己的身家');
  ok(itemCount(s, 'g_diamond') === beforeStock + 1, '★ 礼物进了玩家的道具库存');
  const mem = listGiftMemory(findFriend(s, P.id)).join('\n');
  ok(/礼物：我送过玩家/.test(mem) && /💎钻石/.test(mem), '★ 写了一条"我送过玩家…"的记忆');
  ok(aiGiftsToday(s, P.id, '2026-09-22') === 1 && aiGiftsLeft(s, P.id, '2026-09-22') === 2, 'AI 每天也是 3 次');

  // 三次上限
  sendGiftToPlayer(s, P.id, 'g_rose', { today: '2026-09-22' });
  sendGiftToPlayer(s, P.id, 'g_rose', { today: '2026-09-22' });
  const fourth = sendGiftToPlayer(s, P.id, 'g_rose', { today: '2026-09-22' });
  ok(!fourth.ok, '★ AI 第 4 次被挡住');

  // 穷到送不起
  setAiBeans(s, P.id, 1000);
  const poor = sendGiftToPlayer(s, P.id, 'g_ring', { today: '2026-09-24' });
  ok(!poor.ok, '身家不够时送不了戒指');
}

console.log('-- 审查层：多审一层"要不要送礼"');
{
  const friend = { affinity: 70, memory: [], name: '不吃香菜' };
  const opts = [
    { id: 'g_rose', name: '玫瑰花', emoji: '🌹', price: 1000, affinity: 1 },
    { id: 'g_box', name: '礼盒', emoji: '🎁', price: 9999, affinity: 3 },
  ];
  const msgs = buildAnalyzeMessages({
    persona: P, friend, text: '送你个礼物', reply: '谢谢呀', giftOptions: opts, giftLeft: 2, myBeans: 30000,
  });
  const sys = msgs[0].content;
  ok(/gift/.test(sys), '★ 审查 JSON 里多了 gift 字段');
  ok(/要不要送玩家一件礼物/.test(sys), '★ 提示词里明确问"要不要送礼"');
  ok(sys.includes('g_rose') && sys.includes('g_box'), '清单里列了它现在能送的礼物');
  ok(/身家/.test(sys), '提示词里给了它的身家作为财力参考');
  ok(/大多数时候应该填 ""/.test(sys), '★ 明确要求"大多数时候不送"（不是每句都送）');
  ok(!/g_ring/.test(sys), '不在清单里的（戒指）提示词里根本不提');

  // 没给清单时不出现这一段（没条件送就不问）
  const plain = buildAnalyzeMessages({ persona: P, friend, text: '你好', reply: '嗨' })[0].content;
  ok(!/要不要送玩家一件礼物/.test(plain), '不能送的时候不打扰模型');

  // JSON 解析 + 硬校验
  ok(parseAnalysis('{"gift":"g_ring"}').gift === 'g_ring', 'gift 字段能被解析');
  ok(pickAllowedGift('g_rose', opts, 2) === 'g_rose', '清单内的礼物放行');
  ok(pickAllowedGift('g_ring', opts, 2) === '', '★ 清单外的一律作废（不可能强送最贵的）');
  ok(pickAllowedGift('g_rose', opts, 0) === '', '今天没次数了就不送');
  ok(pickAllowedGift('', opts, 2) === '', '模型不送就空着');
}

console.log('-- 赠礼消息与台词');
{
  const rose = GIFTS[0];
  const line = playerGiftLine(rose);
  ok(line.includes('🌹'), `赠礼消息里带礼物（${line}）`);
  const ai = aiGiftLine(P, rose);
  ok(ai.length > 0, `AI 回赠也有一句话（${ai}）`);

  // 好友界面：赠送礼物按钮在"删除好友"左边（用户要求）
  const ui = read('../src/ui/friends.js');
  const head = ui.slice(ui.indexOf('id="btn-gift-friend"'), ui.indexOf('id="btn-drop-friend"'));
  ok(/btn-gift-friend/.test(ui) && head.length > 0 && !/btn-drop-friend/.test(head),
    '★ 「🎁 赠送礼物」按钮排在「删除好友」左侧');
  ok(/sendGiftToFriend\(app\.save/.test(ui), '赠送真的走 store（不是只改 UI）');
  ok(/giftNote/.test(ui) && /gift: res\.gift/.test(ui), '★ 赠礼消息带上"刚收到礼物"的提示，好友据此回应');
  ok(/chat-gift/.test(ui), '聊天里把赠礼渲染成礼物卡');
  const css = read('../styles/friends.css');
  ok(/\.chat-msg\.is-gift/.test(css) && /\.gift-opt/.test(css), '礼物卡与礼物面板都有样式');
}

console.log('-- 需求 3：第一次成为恋人 → 称号「神仙眷侣」');
{
  const t = titleById('t_lovers');
  ok(!!t && t.name === '神仙眷侣' && t.kind === 'lover', '称号表里有「神仙眷侣」');
  ok(TITLES.some((x) => x.id === 't_lovers'), '在 TITLES 里（面板能显示）');
  const s = newSave();
  ok(!isTitleUnlocked(s, 't_lovers'), '一开始没有');
  const a1 = awardTitle(s, 't_lovers');
  ok(a1.ok && a1.isNew, '★ 第一次成为恋人 → 授予（isNew=true）');
  const a2 = awardTitle(s, 't_lovers');
  ok(a2.ok && !a2.isNew, '第二次不会重复弹提示');
  const app = read('../src/ui/app.js');
  ok(/awardTitle\(this\.save, 't_lovers'\)/.test(app), '★ 表白成功那条链路里会授予它');
  ok(/kind !== 'beans' && t\.kind !== 'signin'/.test(read('../src/store/titles.js')),
    '自动解锁只处理豆子档与签到档，不会把恋人称号刷给所有人');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '礼物 / 审查送礼 / 恋人称号检查通过'}`);
process.exit(fail ? 1 : 0);
