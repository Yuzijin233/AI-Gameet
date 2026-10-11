/**
 * 发言频率与局势贴合度测试（node tools/test-chat.mjs）
 * 用虚拟时钟跑完整对局，统计 AI 每局会说多少句、其中多少句是"跟着局势走"的
 */
import { Game, PHASE } from '../src/game/engine.js';
import { PERSONAS } from '../src/data/personas.js';
import { ROOMS, CONFIG } from '../src/config.js';
import { buildSituation, pickScene } from '../src/ai/scene.js';
import { SITUATION_LINES } from '../src/ai/lines.js';
import {
  isLongCombo, relationOf, bombPlan, bombBrief, springPlan, springBrief,
  greetingPlan, metFriendBrief, metAgainBrief, LONG_COMBO_MIN,
} from '../src/ai/events.js';
import { buildMessages, isHandReport, pickLocal as pickLocalLine } from '../src/ai/chat.js';
import { decorateLine, joinChatty } from '../src/data/style.js';

const NAMES = ['你', '下家', '上家'];
const room = ROOMS[1];
const HANDS = 200;

let totalLines = 0;
let totalEvents = 0;
let totalPlayEvents = 0;
let totalPlayLines = 0;
let bidEvents = 0;
let bidLines = 0;
let situationLines = 0;
let urgentMoments = 0;
let bombEvents = 0;
let perHand = [];
let maxPerHand = 0;
let minPerHand = 999;
const sceneCount = {};
const keyCount = {};
/** 出牌按"牌型档位"分开统计：炸弹 / 长牌型 必说，普通牌 50% */
const PLAY_CLASS = {
  bomb: { n: 0, said: 0 },
  long: { n: 0, said: 0 },
  normal: { n: 0, said: 0 },
};
const playClassOf = (detail) => {
  if (detail.bomb) return 'bomb';
  if (isLongCombo(detail.type, detail.size)) return 'long';
  return 'normal';
};

for (let g = 0; g < HANDS; g += 1) {
  const game = new Game({
    room,
    personas: [null, PERSONAS[g % PERSONAS.length], PERSONAS[(g + 7) % PERSONAS.length]],
    names: NAMES,
    avatars: ['a', 'b', 'c'],
    beans: [100000, 100000, 100000],
  });

  const lastSpoke = [0, 0, 0];
  let lastAny = -1e9;
  let clock = 0;
  let lines = 0;
  let events = 0;
  let playEvents = 0;
  let playLines = 0;
  const urgentSaid = new Set();

  const trySpeak = (seat, priority, minGap) => {
    if (clock - lastSpoke[seat] < (minGap || CONFIG.ai.minGap)) return false;
    if (!priority && clock - lastAny < CONFIG.ai.globalGap) return false;
    lastSpoke[seat] = clock;
    lastAny = clock;
    return true;
  };

  const react = (seat, kind, detail, dt) => {
    clock += dt;
    if (seat === 0) return;
    events += 1;
    // 出牌 / 叫地主 / 不叫 都必须表态（PRD §2.8）；
    // 但"必说"只覆盖 叫抢地主 + 炸弹 + 长牌型，普通牌是脚本掷 50%
    const mustSpeak = kind === 'play' || kind === 'bid' || kind === 'rob';
    const isBid = kind === 'bid' || kind === 'rob';
    const cls = kind === 'play' ? playClassOf(detail) : null;
    if (kind === 'play') { playEvents += 1; PLAY_CLASS[cls].n += 1; }
    if (isBid) bidEvents += 1;
    const sit = buildSituation(game, seat, NAMES);
    if (sit.urgent) urgentMoments += 1;
    const ukey = `${seat}:${sit.key}`;
    const firstTime = sit.urgent && !urgentSaid.has(ukey);
    if (sit.urgent) urgentSaid.add(ukey);
    const scene = pickScene(kind, detail, { ...sit, urgent: firstTime }, CONFIG.ai.chance);
    if (!scene) return;
    // 与 app.aiReact 一致：必说的场景绕过全局间隔，用很短的间隔
    if (!trySpeak(seat, mustSpeak || firstTime, mustSpeak ? CONFIG.ai.playMinGap : CONFIG.ai.minGap)) return;
    lines += 1;
    if (kind === 'play') { playLines += 1; PLAY_CLASS[cls].said += 1; }
    if (isBid) bidLines += 1;
    sceneCount[scene] = (sceneCount[scene] || 0) + 1;
    const hasKey = sit.key && sit.key !== 'normal';
    const forceSituation = !!hasKey && (firstTime || Math.random() < 0.5);
    const sitKey = (scene === 'bomb' ? 'bombed' : null)
      || (forceSituation ? sit.key : null)
      || (scene === 'suppressed' ? 'pressured' : null);
    const useSituation = !!sitKey && (forceSituation || (!!firstTime && ['playBig', 'playSmall', 'suppress', 'suppressed', 'idle', 'passBid', 'bid', 'rob', 'bomb'].includes(scene)) || sitKey === 'pressured');
    if (useSituation && SITUATION_LINES[sitKey]) {
      situationLines += 1;
      keyCount[sitKey] = (keyCount[sitKey] || 0) + 1;
    }
  };

  // 开局问候
  react(1 + (g % 2), 'greeting', {}, 700);

  let guard = 0;
  while (game.phase !== PHASE.OVER && guard < 4000) {
    guard += 1;
    if (game.phase === PHASE.BID) {
      const seat = game.currentBidder;
      if (seat == null) break;
      if (seat === 0) { clock += 3500; game.applyBid(0, game.decideBid(0, false)); }
      else {
        const want = game.decideBid(seat, false);
        react(seat, 'bid', { call: want }, 1400);
        game.applyBid(seat, want);
      }
    } else if (game.phase === PHASE.ROB) {
      const seat = game.seatToAsk;
      if (seat == null) break;
      if (seat === 0) { clock += 3000; game.applyRob(0, game.decideBid(0, true)); }
      else {
        const want = game.decideBid(seat, true);
        react(seat, 'rob', { call: want }, 1400);
        game.applyRob(seat, want);
      }
    } else if (game.phase === PHASE.PLAY) {
      const seat = game.turnSeat;
      if (seat === 0) {
        clock += 4000; // 玩家思考
        const play = game.decidePlay(0);
        const res = play ? game.applyPlay(0, play.cards) : game.applyPlay(0, []);
        if (!res.ok) game.applyPlay(0, []);
        // 玩家出牌后，其他 AI 的反应（与 app.aiReactToHuman 同逻辑）
        if (play) {
          const isBomb = play.type === 'bomb' || play.type === 'rocket';
          const big = play.rank >= 15;
          const goodCombo = isBomb || play.size >= 5
            || ['straight', 'straightPair', 'plane', 'plane1', 'plane2', 'four2single', 'four2pair', 'trio2'].includes(play.type);
          if (isBomb) {
            // 炸弹走 aiEventSpeak：桌上每个 AI 各说一句（这里只统计事件本身）
            bombEvents += 1;
            clock += 500;
          } else {
            const humanIsLandlord = game.landlordSeat === 0;
            const farmers = [1, 2];
            const cands = humanIsLandlord ? farmers : [game.landlordSeat, farmers.find((s) => s !== game.landlordSeat)];
            const rseat = Math.random() < (humanIsLandlord ? 0.5 : 0.75) ? cands[0] : cands[1];
            const chance = big ? 0.7 : goodCombo ? 0.45 : CONFIG.ai.chance.reactHuman;
            if (Math.random() <= chance) {
              clock += 500;
              events += 1;
              if (trySpeak(rseat, big)) {
                lines += 1;
                sceneCount.reactToHuman = (sceneCount.reactToHuman || 0) + 1;
                const key = goodCombo || big ? 'humanBig' : null;
                if (key && SITUATION_LINES[key]) { situationLines += 1; keyCount[key] = (keyCount[key] || 0) + 1; }
              }
            }
          }
        }
      } else {
        const play = game.decidePlay(seat);
        if (play) {
          const bomb = play.type === 'bomb' || play.type === 'rocket';
          game.applyPlay(seat, play.cards);
          if (bomb) bombEvents += 1;
          react(seat, 'play', {
            bomb, big: play.rank >= 15, type: play.type, size: play.size,
          }, 1400);
        } else {
          game.applyPlay(seat, []);
          react(seat, 'pass', {}, 1400);
        }
      }
    } else break;
  }

  // 结算感言（固定 2 句）
  lines += 2;
  totalLines += lines;
  totalEvents += events;
  totalPlayEvents += playEvents;
  totalPlayLines += playLines;
  perHand.push(lines);
  maxPerHand = Math.max(maxPerHand, lines);
  minPerHand = Math.min(minPerHand, lines);
}

const avg = (totalLines / HANDS).toFixed(1);
const avgEvents = (totalEvents / HANDS).toFixed(1);
const sitRate = ((situationLines / Math.max(1, totalLines)) * 100).toFixed(0);

console.log('── AI 发言频率与局势贴合度');
console.log(`  样本：${HANDS} 局完整对局`);
console.log(`  每局 AI 动作事件：${avgEvents} 次`);
console.log(`  每局 AI 发言：平均 ${avg} 句（最少 ${minPerHand}，最多 ${maxPerHand}）`);
console.log(`  AI 出牌发言覆盖率：${(totalPlayLines / Math.max(1, totalPlayEvents) * 100).toFixed(0)}%（${totalPlayLines}/${totalPlayEvents}）`);
console.log('    分档：'
  + Object.entries(PLAY_CLASS).map(([k, v]) => `${k} ${v.said}/${v.n}（${((v.said / Math.max(1, v.n)) * 100).toFixed(0)}%）`).join('  '));
console.log(`  炸弹/王炸出现：${bombEvents} 次（每次桌上两个 AI 都要各说一句）`);
console.log(`  叫抢地主发言覆盖率：${(bidLines / Math.max(1, bidEvents) * 100).toFixed(0)}%（${bidLines}/${bidEvents}）`);
console.log(`  其中"跟着局势说"的台词：${situationLines} 句（占 ${sitRate}%，约 ${(situationLines / HANDS).toFixed(1)} 句/局）`);
console.log(`  关键局势出现次数：${urgentMoments}（${(urgentMoments / HANDS).toFixed(1)} 次/局）`);
console.log(`  场景分布：${Object.entries(sceneCount).map(([k, v]) => `${k}×${v}`).join('  ')}`);
console.log(`  局势台词分布：${Object.entries(keyCount).map(([k, v]) => `${k}×${v}`).join('  ')}`);

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };
const pct = (a, b) => `${((a / Math.max(1, b)) * 100).toFixed(0)}%`;
console.log('');
// 普通牌是脚本掷 50%，所以整体覆盖率必然明显低于 100% —— 这正是要盯住的点
ok(totalPlayLines / Math.max(1, totalPlayEvents) >= 0.4 && totalPlayLines / Math.max(1, totalPlayEvents) <= 0.8,
  `出牌整体开口率应落在 40%~80%（实际 ${pct(totalPlayLines, totalPlayEvents)}，普通牌 50% + 必说档拉高）`);
ok(PLAY_CLASS.normal.n > 500, `样本里有足够的普通牌（${PLAY_CLASS.normal.n} 手）`);
ok(PLAY_CLASS.normal.said / Math.max(1, PLAY_CLASS.normal.n) >= 0.4
  && PLAY_CLASS.normal.said / Math.max(1, PLAY_CLASS.normal.n) <= 0.6,
  `普通牌（单张/对子/三带一…）约 50% 才开口（实际 ${pct(PLAY_CLASS.normal.said, PLAY_CLASS.normal.n)}）`);
ok(PLAY_CLASS.long.n > 30, `样本里有长牌型（${PLAY_CLASS.long.n} 手）`);
ok(PLAY_CLASS.long.said === PLAY_CLASS.long.n,
  `长牌型（连对/长顺子/飞机/四带二）必须每手都开口（${PLAY_CLASS.long.said}/${PLAY_CLASS.long.n}）`);
ok(PLAY_CLASS.bomb.n > 3, `样本里有炸弹（${PLAY_CLASS.bomb.n} 手）`);
ok(PLAY_CLASS.bomb.said === PLAY_CLASS.bomb.n,
  `炸弹/王炸必须开口（${PLAY_CLASS.bomb.said}/${PLAY_CLASS.bomb.n}）`);
// 不设产品意义上的发言上限；200 句只是防跑飞的兜底
ok(totalLines / HANDS <= 200, `发言量兜底检查：不应失控（实际 ${avg} 句/局）`);
ok(totalLines / HANDS >= 4, `也不能太安静（实际 ${avg}）`);
ok(situationLines > 0, '应当出现跟着局势走的台词');
ok(situationLines / HANDS >= 3, `局势台词每局都应当出现若干次（实际 ${(situationLines / HANDS).toFixed(1)} 句/局）`);
ok(Number(sitRate) >= 15, `局势台词占比不应被通用台词淹没（实际 ${sitRate}%）`);

/* ---------------- 叫地主 / 不叫 都要说话 ---------------- */
console.log('');
console.log('── 叫地主与不叫都要表态');
ok(bidEvents > 0, `样本里有叫抢地主事件（${bidEvents} 次）`);
ok(bidLines / Math.max(1, bidEvents) >= 0.99,
  `每次叫/不叫地主都必须说一句（覆盖 ${(bidLines / Math.max(1, bidEvents) * 100).toFixed(0)}%）`);
ok((sceneCount.bid || 0) + (sceneCount.rob || 0) > 0, '叫/抢 有专门的说法');
ok((sceneCount.passBid || 0) > 0, '不叫/不抢 也有专门的说法');

/* ---------------- 不报牌 / 就牌论牌 ---------------- */
console.log('');
console.log('── 不报牌：只就牌论牌');
{
  // 用户点名的反例必须被拦住
  const bad = [
    '4个2在手，不慌',
    '我手里还有王炸',
    '我手里有对A，稳了',
    '我剩一张2了',
    '我这把牌还有个炸弹',
  ];
  for (const t of bad) ok(isHandReport(t), `应当判定为报牌：「${t}」`);

  // 正确示范不能误伤
  const good = [
    '对2，你还能打过我？',
    '这手我接不住，过',
    '管上了，你还有牌吗',
    '倍数都翻到 8 倍了，稳一点',
    '你这手出得挺凶啊',
    '我就剩 3 张了，快跑',
  ];
  for (const t of good) ok(!isHandReport(t), `不该误判成报牌：「${t}」`);

  // 提示词里不再出现自己的具体手牌
  const persona = PERSONAS[0];
  const view = {
    isLandlord: true,
    handReportLine: '你的手牌：8 张（具体是什么牌只有你知道，**不要念出来**）',
    countsText: '玩家 8 张，下家 12 张，上家 5 张',
    multiplier: 4,
    bombs: 1,
    lastText: '你 出了 对2',
    situationText: '你是地主；你的手牌 8 张',
    historyText: '玩家 对3；你 对2',
    playerText: '',
  };
  const msgs = buildMessages({ persona, scene: 'playBig', view });
  const all = msgs.map((m) => m.content).join('\n');
  ok(!/♠|♥|♣|♦/.test(all), '提示词里不再塞入具体手牌（没有花色字符）');
  ok(all.includes('不要报牌'), '提示词里明令"不要报牌"');
  ok(all.includes('就牌论牌'), '提示词里要求"就牌论牌"');
  ok(all.includes('对2'), '提示词里带上了刚打出的那一手，供就牌论牌');
  ok(all.includes('上一手出牌'), '上一手出牌被单独提出来放在显眼位置');
}

/* ---------------- 人设的表达风格（表情 / 颜文字 / 话痨） ---------------- */
console.log('');
console.log('── 人设表达风格');
{
  const emoji = PERSONAS.filter((p) => p.emoji && p.emoji.length);
  const kao = PERSONAS.filter((p) => p.kaomoji && p.kaomoji.length);
  const talky = PERSONAS.filter((p) => p.talky);
  const quiet = PERSONAS.filter((p) => p.quiet);
  ok(emoji.length >= 3, `至少 3 个人设爱发表情（${emoji.length} 个：${emoji.map((p) => p.name).join('、')}）`);
  ok(kao.length >= 3, `至少 3 个人设爱用颜文字（${kao.length} 个：${kao.map((p) => p.name).join('、')}）`);
  ok(talky.length >= 2, `至少 2 个话痨（${talky.length} 个：${talky.map((p) => p.name).join('、')}）`);
  ok(quiet.length >= 2, '也有惜字如金的人设，风格要拉开差距');
  ok(emoji.every((p) => p.emoji.every((e) => typeof e === 'string' && e.length <= 4)), '表情池内容合法');

  // 提示词要按人设注入风格，且长度上限跟着人设走
  const view = {
    isLandlord: true,
    handReportLine: '你的手牌：8 张',
    countsText: '你 8 张',
    multiplier: 2,
    bombs: 0,
    lastText: '你 出了 对2',
    situationText: '',
    historyText: '',
    playerText: '',
  };
  const chatty = talky[0];
  const chattyText = buildMessages({ persona: chatty, scene: 'playSmall', view }).map((m) => m.content).join('\n');
  ok(chattyText.includes('话痨'), `话痨「${chatty.name}」的提示词里写了"话痨"`);
  ok(chattyText.includes(`${chatty.maxChars} 个字以内`), `话痨的长度上限放宽到 ${chatty.maxChars}（默认 ${CONFIG.ai.maxChars}）`);

  const emojiP = emoji[0];
  const emojiText = buildMessages({ persona: emojiP, scene: 'playSmall', view }).map((m) => m.content).join('\n');
  ok(emojiText.includes('emoji'), `爱发表情的「${emojiP.name}」提示词里允许 emoji`);

  const kaoP = kao[0];
  const kaoText = buildMessages({ persona: kaoP, scene: 'playSmall', view }).map((m) => m.content).join('\n');
  ok(kaoText.includes('颜文字'), `爱用颜文字的「${kaoP.name}」提示词里允许颜文字`);
  ok(!kaoText.includes('话痨'), '没打"话痨"标签的人不会被要求说很多');

  // 本地语料也要有区分度
  let withEmoji = 0;
  for (let i = 0; i < 200; i += 1) {
    const l = pickLocalLine(emojiP, 'playSmall');
    if (new RegExp(`[${emojiP.emoji.join('')}]`).test(l)) withEmoji += 1;
  }
  ok(withEmoji > 40, `爱发表情的人设本地台词会带 emoji（${withEmoji}/200）`);

  // 话痨的平均台词要明显长于惜字如金的人
  let talkyLen = 0;
  let quietLen = 0;
  let joinedLines = 0;
  for (let i = 0; i < 300; i += 1) {
    const l = pickLocalLine(chatty, 'playSmall');
    talkyLen += l.length;
    if ((l.match(/[，。]/g) || []).length >= 2) joinedLines += 1;
    quietLen += pickLocalLine(quiet[0], 'playSmall').length;
  }
  ok(talkyLen / 300 > quietLen / 300 + 1.5,
    `话痨平均台词更长（${(talkyLen / 300).toFixed(1)} 字 vs ${(quietLen / 300).toFixed(1)} 字）`);
  ok(joinedLines > 30, `话痨会把两句接起来说（${joinedLines}/300）`);

  const line = decorateLine('管上。', emojiP, () => 0.1);
  ok(line.length > 3, `装饰函数会给台词加尾巴（${line}）`);
  const joined = joinChatty('先走单张。', '你慢慢想。');
  ok(joined === '先走单张，你慢慢想。', `话痨拼接正确（${joined}）`);
}

/* ---------------- 大事件编排：炸弹 / 春天 / 被反杀 ---------------- */
console.log('');
console.log('── 大事件：桌上每个 AI 都要开口');
{
  // 长牌型的判定边界：单张/对子/三带一都不算长，连对 3 对起、顺子 5 张起
  ok(isLongCombo('straight', 5) && !isLongCombo('straight', 4), '顺子 5 张起才算长牌型');
  ok(isLongCombo('straightPair', 6) && !isLongCombo('straightPair', 4), '连对 3 对起才算长牌型');
  ok(isLongCombo('plane', 6) && isLongCombo('plane2', 10) && !isLongCombo('plane', 3), '飞机按张数分档');
  ok(isLongCombo('four2single', 6) && isLongCombo('four2pair', 8), '四带二 / 四带两对算长牌型');
  for (const t of ['single', 'pair', 'trio', 'trio1', 'trio2', 'bomb', 'rocket']) {
    ok(!isLongCombo(t, 6), `${t} 不算长牌型（走 50% 那条路，炸弹另走大事件）`);
  }
  ok(Object.keys(LONG_COMBO_MIN).length >= 7, '长牌型档位覆盖顺子/连对/飞机/四带二');

  // 阵营关系：出炸者本人 = self，同为农民 = mate，敌对 = foe
  ok(relationOf(1, 1, 0) === 'self', '出牌的人自己是 self');
  ok(relationOf(2, 1, 0) === 'mate', '玩家是地主时，两个 AI 互为同伙（mate）');
  ok(relationOf(1, 0, 0) === 'foe', '玩家是地主时，AI 是对手（foe）');
  ok(relationOf(0, 1, 1) === 'foe', 'AI 是地主时，玩家是对手（foe）');
  ok(relationOf(2, 1, 1) === 'foe', '地主出炸时，另一个农民是对手');
  ok(relationOf(1, 2, 2) === 'foe', '地主（seat2）出炸时，农民（seat1）是对手');

  // 炸弹：**两个 AI 都要有话说**，而且口吻按关系分
  for (const actor of [0, 1, 2]) {
    for (const landlordSeat of [0, 1, 2]) {
      if (actor === 0 && landlordSeat === 0) continue;
      const plans = [1, 2].map((seat) => bombPlan(seat, actor, landlordSeat));
      ok(plans.every((p) => !!p.scene && !!p.situationKey), `炸弹事件每个 AI 都有场景（actor=${actor} 地主=${landlordSeat}）`);
      ok(plans.every((p) => SITUATION_LINES[p.situationKey]),
        `炸弹事件的局势台词都有本地兜底（${plans.map((p) => p.situationKey).join('/')}）`);
      if (actor !== 0) {
        const selfPlan = plans[actor - 1];
        ok(selfPlan.relation === 'self' && selfPlan.scene === 'bomb', `出炸的 AI 自己是 bomb 场景（actor=${actor}）`);
      }
      // 场上两个 AI 不可能同时是"出炸者"
      ok(plans.filter((p) => p.relation === 'self').length <= 1, '最多一个 AI 是出炸者本人');
    }
  }
  const matePlan = bombPlan(2, 1, 0); // 玩家地主，seat1 出炸 → seat2 是同伙
  ok(matePlan.relation === 'mate' && matePlan.situationKey === 'bombMate', '同伙出炸 → 我夸他（bombMate）');
  const foePlan = bombPlan(1, 0, 0); // 玩家地主出炸 → seat1 是对手
  ok(foePlan.relation === 'foe' && foePlan.situationKey === 'bombFoe', '对手出炸 → 我惊讶（bombFoe）');
  ok(/搭档/.test(bombBrief({ relation: 'mate', actorName: '下家', isRocket: false })), '提示词里说明了"这是你的搭档，要夸"');
  ok(/对手/.test(bombBrief({ relation: 'foe', actorName: '你', isRocket: true })), '提示词里说明了"这是对手，要惊讶"');
  ok(/王炸/.test(bombBrief({ relation: 'self', actorName: '下家', isRocket: true })), '王炸与炸弹在提示词里区分开');

  // 春天 / 被反杀：每个 AI 都要有话说，赢的那侧欢呼、输的那侧懵
  for (const landlordSeat of [0, 1, 2]) {
    for (const landlordWin of [true, false]) {
      for (const seat of [1, 2]) {
        const plan = springPlan(seat, landlordSeat, landlordWin);
        ok(!!plan.situationKey && !!SITUATION_LINES[plan.situationKey],
          `春天/被反杀有本地兜底（seat=${seat} 地主=${landlordSeat} 地主赢=${landlordWin}）`);
        const brief = springBrief({ spring: true, antiSpring: false, won: plan.won });
        ok(brief.length > 6, '春天事件有背景说明');
      }
    }
  }
  ok(springPlan(0, 0, true).situationKey === 'spring', '地主春天 → 赢家台词');
  ok(springPlan(1, 0, true).situationKey === 'antiSpring', '地主春天 → 农民是"被反杀"');
  ok(springPlan(1, 0, false).situationKey === 'spring', '农民反春 → 农民欢呼');
  ok(springPlan(0, 0, false).situationKey === 'antiSpring', '农民反春 → 地主是"被反杀"');
  ok(/反杀/.test(springBrief({ spring: false, antiSpring: true, won: false })), '"被反杀"在提示词里说清楚了');

  // 开局问候：好友 / 上一局对手，两种说法
  ok(greetingPlan({ isFriend: true, metLastHand: true }).situationKey === 'metFriend', '好友优先按"遇到好友"打招呼');
  ok(greetingPlan({ isFriend: false, metLastHand: true }).situationKey === 'metAgain', '只碰到上局对手 → 提上一局');
  ok(greetingPlan({ isFriend: false, metLastHand: false }).situationKey === null, '都不是 → 普通开场白');
  ok(/好友/.test(metFriendBrief('冷面棋手')), '遇到好友的说明里点明了关系');
  ok(/上一局/.test(metAgainBrief('冷面棋手', '你上把输了 800 豆')), '遇到上局对手的说明里带上上一局');
  ok(/上一局/.test(metAgainBrief('冷面棋手', '')), '没有概括时也能只说"上一局刚打过"');

  // 所有大事件场景都要有提示词说明，否则模型不知道用什么态度
  for (const scene of ['bombMate', 'bombFoe', 'longCombo']) {
    const msgs = buildMessages({ persona: PERSONAS[0], scene, view: { isLandlord: true, handReportLine: 'X', countsText: 'X', multiplier: 2, bombs: 0, lastText: '', situationText: '', historyText: '', playerText: '', eventText: '' } });
    const all = msgs.map((m) => m.content).join('\n');
    ok(!all.includes('轮到你说话'), `场景 ${scene} 有专门的提示词说明`);
  }
  // 大事件的背景说明会真的进提示词
  const withEvent = buildMessages({
    persona: PERSONAS[0],
    scene: 'bombFoe',
    view: {
      isLandlord: true, handReportLine: 'X', countsText: 'X', multiplier: 4, bombs: 1,
      lastText: '', situationText: '', historyText: '', playerText: '',
      eventText: bombBrief({ relation: 'foe', actorName: '你', isRocket: false }),
    },
  }).map((m) => m.content).join('\n');
  ok(withEvent.includes('刚刚发生'), '大事件说明会被写进提示词');
  ok(withEvent.includes('对手'), '大事件说明里的态度要求进了提示词');
}

/* ---------------- 本地兜底语料：关键局势都要有 ----------------
 * 大模型不可用时全靠这些台词撑住，缺一个 key 就会出现"哑巴 AI" */
console.log('');
console.log('── 本地兜底语料覆盖');
{
  // 注意：叫/不叫地主的台词在 persona.lines 里（走 pickLocal），不在这张局势表里
  const need = [
    'bombed', 'bombMate', 'bombFoe', 'longCombo',
    'spring', 'antiSpring', 'metFriend', 'metAgain',
  ];
  for (const key of need) {
    const bucket = SITUATION_LINES[key];
    ok(!!bucket, `局势台词有 ${key}`);
    if (!bucket) continue;
    for (const style of ['aggressive', 'balanced', 'cautious']) {
      const list = bucket[style] || [];
      ok(list.length >= 3, `${key}.${style} 至少 3 条（实际 ${list.length}）`);
      ok(list.every((l) => typeof l === 'string' && l.length > 0 && l.length <= 18),
        `${key}.${style} 每条都是短句（≤18 字）`);
      ok(new Set(list).size === list.length, `${key}.${style} 内部不重复`);
    }
  }
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '发言频率与局势贴合度检查通过'}`);
process.exit(fail ? 1 : 0);
