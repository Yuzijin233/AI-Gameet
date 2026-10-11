/**
 * 大模型出牌测试（node tools/test-play.mjs）
 * 覆盖：解析模型输出、合法性校验、提示词内容与信息边界、打法风格、超时/失败兜底
 * （不联网：只测离线可验证的部分）
 */
import { CONFIG } from '../src/config.js';
import { PERSONAS } from '../src/data/personas.js';
import { createDeck } from '../src/core/cards.js';
import { analyze } from '../src/core/rules.js';
import {
  parseRankTokens, parsePlayReply, buildPlayMessages, playStyleOf, PLAY_STYLES, PLAY_STYLE_BY_PERSONA,
  decidePlayWithLLM, handText,
} from '../src/ai/playBrain.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };

const deck = createDeck();
const card = (rank, i = 0) => deck.filter((c) => c.rank === rank)[i];
const single = (rank) => analyze([card(rank)]);

/* ---------------- 解析模型输出 ---------------- */
console.log('-- 解析模型输出');
{
  ok(parseRankTokens('pass').pass === true, 'pass = 不出');
  ok(parseRankTokens('不出').pass === true, '"不出" = 不出');
  ok(parseRankTokens('过').pass === true, '"过" = 不出');
  ok(JSON.stringify(parseRankTokens('5 5').ranks) === '[5,5]', '"5 5" → 两张 5');
  ok(JSON.stringify(parseRankTokens('10 J Q K A').ranks) === '[10,11,12,13,14]', '顺子写法可解析');
  ok(JSON.stringify(parseRankTokens('小王 大王').ranks) === '[16,17]', '王可解析');
  ok(JSON.stringify(parseRankTokens('♠9').ranks) === '[9]', '带花色也能解析出点数');
  ok(JSON.stringify(parseRankTokens('对三').ranks) === '[3]', '"对三"这种写法也能兜住');
  ok(parseRankTokens('').error !== undefined, '空回复报错');
  ok(parseRankTokens('好的没问题').error !== undefined, '纯废话报错（会被重试）');
}

/* ---------------- 合法性校验 ---------------- */
console.log('-- 出牌合法性');
{
  const hand = [card(3, 0), card(3, 1), card(9)];
  const last = single(5); // parsePlayReply 收的是"牌型对象"（和 decidePlayWithLLM 一致）

  const r1 = parsePlayReply('9', hand, last);
  ok(r1.ok && r1.play.type === 'single' && r1.play.rank === 9, '出 9 压单 5：合法');

  const r2 = parsePlayReply('3', hand, last);
  ok(!r2.ok && r2.error.includes('管不上'), `出 3 压单 5：正确拒绝（${r2.error}）`);

  const r3 = parsePlayReply('3 3', hand, last);
  ok(!r3.ok, '拿对子去压单张：正确拒绝');

  const r4 = parsePlayReply('K', hand, last);
  ok(!r4.ok && r4.error.includes('没有'), `出手里没有的牌：正确拒绝（${r4.error}）`);

  const r5 = parsePlayReply('pass', hand, null, { mustPlay: true });
  ok(!r5.ok && r5.error.includes('首出'), '首出不能 pass：正确拒绝');

  const r6 = parsePlayReply('pass', hand, last);
  ok(r6.ok && r6.play === null, '跟牌时 pass 合法');

  const r7 = parsePlayReply('9 9', hand, last);
  ok(!r7.ok, '手里只有一张 9，出两张要拒绝');
}

/* ---------------- 提示词：给全自己、不给别人 ---------------- */
console.log('-- 出牌提示词与信息边界');
{
  const hand = [card(3, 0), card(3, 1), card(11, 0), card(16)];
  const msgs = buildPlayMessages({
    persona: PERSONAS[0],
    style: playStyleOf(PERSONAS[0]),
    hand,
    last: { seat: 2, play: single(5) },
    counts: [12, hand.length, 9],
    names: ['你', '下家', '上家'],
    seat: 1,
    landlordSeat: 0,
    mustPlay: false,
    multiplier: 4,
    history: ['玩家出 5'],
  });
  const all = msgs.map((m) => m.content).join('\n');
  ok(all.includes('你手里的牌'), '提示词给出了自己的手牌');
  ok(all.includes('J') && all.includes('小王'), '手牌点数写全了（J / 小王）');
  ok(all.includes('你 12 张') && all.includes('上家 9 张'), '给出了各家剩余张数');
  ok(all.includes('×4'), '给出了当前倍数');
  ok(all.includes('5'), '给出了上一手');
  ok(all.includes('pass'), '写明了不出要输出 pass');
  ok(all.includes('只输出') && all.includes('点数'), '写明了输出格式');
  // 信息边界：只给别家的张数，不给别家的牌
  const othersBlock = all.split('其他两家：')[1].split('\n')[0];
  ok(/^\D*\d+ 张/.test(othersBlock) && !/[♠♥♣♦]/.test(othersBlock), `别家只有张数没有牌（${othersBlock}）`);
  ok(playStyleOf(PERSONAS[0]).key === PLAY_STYLE_BY_PERSONA[PERSONAS[0].id], '提示词里带上了这个人设的打法风格');
  ok(all.includes(PLAY_STYLES[playStyleOf(PERSONAS[0]).key].name), '风格名称出现在提示词里');

  // 首出时必须出牌
  const first = buildPlayMessages({ persona: PERSONAS[1], style: playStyleOf(PERSONAS[1]), hand, last: null, counts: [3, 3, 3], names: ['你', '下家', '上家'], seat: 1, landlordSeat: 0, mustPlay: true });
  ok(first.map((m) => m.content).join('\n').includes('必须出牌'), '首出时提示词说"必须出牌"');
}

/* ---------------- 打法风格 ---------------- */
console.log('-- 打法风格');
{
  const keys = Object.keys(PLAY_STYLES);
  ok(keys.length >= 5, `预设了 ${keys.length} 套打法风格`);
  ok(PERSONAS.every((p) => keys.includes(playStyleOf(p).key)), '24 个人设都能映射到一套风格');
  const used = new Set(PERSONAS.map((p) => playStyleOf(p).key));
  ok(used.size >= 4, `风格分布不能太单一（用了 ${used.size} 种）`);
  ok(PERSONAS.every((p) => PLAY_STYLES[playStyleOf(p).key].prompt.length > 10), '每套风格都有可读的提示词');
  // 激进的人设不该是"惜牌"
  const aggressive = PERSONAS.filter((p) => p.style === 'aggressive');
  ok(aggressive.filter((p) => playStyleOf(p).key === 'holder').length === 0, '激进人设不会配"惜牌留大"');
}

/* ---------------- 超时 / 失败兜底 ---------------- */
console.log('-- 兜底策略');
{
  ok(CONFIG.ai.playTimeout === 15000, `出牌预算 15 秒（实际 ${CONFIG.ai.playTimeout}）`);
  ok(CONFIG.ai.playRetry === 1, '失败重试 1 次（共 2 次调用）');

  // 预算极小 → 直接判定兜底，不该发起任何请求
  const t0 = Date.now();
  const out = await decidePlayWithLLM({
    persona: PERSONAS[0], style: playStyleOf(PERSONAS[0]),
    hand: [card(3), card(4)], last: single(5), counts: [2, 2, 2], names: ['你', 'a', 'b'],
    seat: 1, landlordSeat: 0, mustPlay: false, timeoutMs: 1,
  });
  ok(out.source === 'fallback', `预算用尽 → 交给脚本兜底（${out.source}）`);
  ok(out.play === null, '兜底时不返回牌（由调用方走脚本机器人）');
  ok(Date.now() - t0 < 500, '预算用尽时立刻返回，不会卡住');
}

/* ---------------- 手牌文本 ---------------- */
console.log('-- 手牌文本');
{
  const t = handText([card(3, 0), card(16), card(11, 0)]);
  ok(t.split(' ').length === 3, '手牌文本张数正确');
  ok(t.includes('小王'), '王显示为"小王"');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '大模型出牌测试全部通过'}`);
process.exit(fail ? 1 : 0);
