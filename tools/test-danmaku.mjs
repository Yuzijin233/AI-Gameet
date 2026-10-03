/**
 * 房间弹幕测试（node tools/test-danmaku.mjs）
 * 覆盖：只在房间界面出现、轨道分配、颜色区分、长度裁剪、说话人选择（1 个 AI 不主动发）、
 *      提示词是否带上"谁说的"
 */
import { readFileSync } from 'node:fs';
import { DANMAKU } from '../src/config.js';
import { pickLane, colorOfSeat, clipDanmaku, DanmakuLayer, DANMAKU_COLORS } from '../src/ui/danmaku.js';
import { buildDanmakuMessages, localDanmaku, pickSpeaker, danmakuReplyDelay, danmakuSituationText } from '../src/ai/danmaku.js';
import { PERSONAS } from '../src/data/personas.js';
import { defaultSave } from '../src/store/storage.js';
import {
  addFriend, findFriend, adjustAffinity, addMemory, setSelfMemory, friendContextLines,
} from '../src/store/friends.js';
import { buildMessages } from '../src/ai/chat.js';
import { fishingView } from '../src/ai/fishingView.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };

/* ---------------- 节奏参数 ---------------- */
console.log('── 弹幕节奏');
ok(DANMAKU.minGap === 3000, `最短间隔 3s（实际 ${DANMAKU.minGap}）`);
ok(DANMAKU.maxGap === 5000, `最长间隔 5s（实际 ${DANMAKU.maxGap}）`);
ok(DANMAKU.kickoffGap === 5000, `进房 5s 玩家不说话就由 AI 开场（实际 ${DANMAKU.kickoffGap}）`);
ok(DANMAKU.maxChars <= 24, `单条不能太长（${DANMAKU.maxChars} 字）`);
ok(DANMAKU.lanes >= 3, '至少有 3 条轨道');

/* ---------------- 玩家发言后的"打字"延迟 ---------------- */
console.log('── AI 回复延迟（模拟真人打字）');
{
  ok(DANMAKU.replyMin === 3000 && DANMAKU.replyMax === 5000, '回复延迟区间是 3~5 秒');
  ok(danmakuReplyDelay(() => 0) === 3000, '最快也要 3 秒');
  ok(danmakuReplyDelay(() => 1) === 5000, '最慢 5 秒');
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 500; i += 1) {
    const d = danmakuReplyDelay();
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  ok(min >= 3000 && max <= 5000, `随机延迟都落在 3~5 秒（${min}~${max}）`);
  ok(Number.isInteger(danmakuReplyDelay(() => 0.5)), '延迟是整数毫秒');
}

/* ---------------- 轨道分配 ---------------- */
console.log('── 轨道分配');
{
  const now = 1000;
  let r = pickLane([0, 0, 0, 0], now);
  ok(r.lane === 0, '有空闲轨道时用第一条');
  ok(r.freeAt <= now, '空闲轨道立即可用');

  r = pickLane([now + 500, now + 100, now + 900], now);
  ok(r.lane === 1, `都占着时选最早空出来的（实际 ${r.lane}）`);

  r = pickLane([now - 500, now - 100], now);
  ok(r.lane === 0 && r.freeAt <= now, '已过期视为空闲');
}

/* ---------------- 颜色区分 ---------------- */
console.log('── 不同角色不同颜色');
{
  const c0 = colorOfSeat(0);
  const c1 = colorOfSeat(1);
  const c2 = colorOfSeat(2);
  ok(c0 !== c1 && c1 !== c2 && c0 !== c2, `三个座位颜色互不相同（${c0} / ${c1} / ${c2}）`);
  ok(c0 === DANMAKU_COLORS[0], '玩家用自己的颜色');
  ok(colorOfSeat(99) === '#FFFFFF', '未知座位有兜底色');
}

/* ---------------- 长度裁剪 ---------------- */
console.log('── 长度与格式');
{
  const long = '这是一条特别特别特别特别特别特别长的弹幕内容需要被裁掉';
  const r = clipDanmaku(long, '不吃香菜');
  ok(r.body.length <= DANMAKU.maxChars, `超长会被裁到 ${DANMAKU.maxChars} 字（实际 ${r.body.length}）`);
  ok(!r.body.includes('\n'), '换行被去掉');
  const r2 = clipDanmaku('  换行\n测试  ', 'x');
  ok(!r2.body.includes('\n'), '多行会折成一行');
  ok(clipDanmaku('', 'x').body === '', '空内容返回空');
  ok(clipDanmaku('你好', '名字特别特别特别长的家伙').name.length <= 8, '名字也会裁剪');
}

/* ---------------- 谁该说话 ---------------- */
console.log('── 谁该主动发');
{
  ok(pickSpeaker([1], null) === null, '单人房里 pickSpeaker 不选人（开场第一句由 app 层单独放行）');
  ok(pickSpeaker([], null) === null, '没有 AI 时不发');
  const two = [1, 2];
  let same = 0;
  for (let i = 0; i < 200; i += 1) if (pickSpeaker(two, 1) === 1) same += 1;
  ok(same === 0, '两个 AI 时不会连续同一个人说');
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(pickSpeaker(two, null));
  ok(seen.size === 2, '两个 AI 都会轮到');
}

/* ---------------- 提示词 ---------------- */
console.log('── 弹幕提示词（要能分辨谁说的）');
{
  const p1 = PERSONAS[0];
  const p2 = PERSONAS[1];
  const recent = [
    { name: p1.name, text: '这把我要赢了' },
    { name: '玩家', text: '别急' },
    { name: p2.name, text: '你确定？' },
  ];
  const msgs = buildDanmakuMessages({
    persona: p2,
    friend: { affinity: 70, memory: ['称呼：阿伟', '偏好：喝奶茶'] },
    situation: '斗地主中级场；你剩 8 张，地主剩 5 张',
    recent,
    target: '你们俩别吵了',
  });
  const all = msgs.map((m) => m.content).join('\n');
  ok(all.includes(p2.name), '提示词里有自己的人设');
  ok(all.includes(p1.name), '提示词里带了其他说话人的名字');
  ok(all.includes(p1.name + '：这把我要赢了'), '弹幕历史里保留了"谁说的 + 说了什么"');
  ok(all.includes('玩家'), '玩家的弹幕也在历史里');
  ok(all.includes('称呼：阿伟'), '注入了好友 memory');
  ok(all.includes('70/100'), '注入了好感度');
  ok(all.includes('地主剩 5 张'), '注入了当前牌局');
  ok(all.includes('你们俩别吵了'), '注入了玩家刚发的弹幕，可以针对回应');
  ok(all.includes(String(DANMAKU.maxChars)), '提示词里写明了长度上限');
  ok(all.includes('谁说的') || all.includes('分辨'), '提示词要求分辨说话人');

  // 名字与称号都只是背景知识：不能围着称号聊
  const withTitle = buildDanmakuMessages({
    persona: p1, playerTitle: '富可敌国', playerName: '老王', situation: '房间里等人',
  }).map((m) => m.content).join('\n');
  ok(withTitle.includes('富可敌国'), '提示词里带上了玩家佩戴的称号');
  ok(withTitle.includes('老王'), '提示词里带上了玩家昵称');
  ok(withTitle.includes('背景知识'), '名字/称号标注为背景知识');
  ok(/不用拿它当话题|不是话题|顺口带一句/.test(withTitle), '明确要求不要把称号当话题');
  ok(withTitle.includes('人') && withTitle.includes('游戏'), '要求话题围绕"人和游戏"');
  const noTitle = buildDanmakuMessages({ persona: p1, playerTitle: '', situation: '房间里等人' })
    .map((m) => m.content).join('\n');
  ok(!noTitle.includes('称号是'), '没戴称号时不注入空称号');

  // 开场第一句：房间里冷场，AI 先开口
  const openerMsgs = buildDanmakuMessages({ persona: p1, situation: '房间里等人', opener: true })
    .map((m) => m.content).join('\n');
  ok(openerMsgs.includes('冷场') || openerMsgs.includes('先开个口'), '开场提示词要求 AI 主动起话头');
  const noOpener = buildDanmakuMessages({ persona: p1, situation: '房间里等人' })
    .map((m) => m.content).join('\n');
  ok(!noOpener.includes('冷场'), '普通轮次不会写成"冷场开场"');

  // 房间人数：两个人在等人的时候要能说出"二缺一"
  const twoOfThree = danmakuSituationText({ seated: 1, needFriends: 2, game: 'ddz' });
  ok(twoOfThree.includes('2 个人') && twoOfThree.includes('3 个人'), '提示词里写清了"现在几个人 / 需要几个人"');
  ok(twoOfThree.includes('二缺一'), '斗地主两人在房时说得出"二缺一"');
  const full = danmakuSituationText({ seated: 2, needFriends: 2, game: 'ddz' });
  ok(full.includes('齐了'), '人齐了会说"随时可以开局"');
  ok(!full.includes('二缺一'), '人齐了就不再喊缺人');
  const fish = danmakuSituationText({ seated: 1, needFriends: 1, game: 'fishing' });
  ok(fish.includes('小猫钓鱼'), '场景文案跟着玩法变');
}

/* ---------------- 本地兜底 ---------------- */
console.log('── 本地兜底与对象');
{
  let bad = 0;
  for (const p of PERSONAS) {
    const l = localDanmaku(p);
    if (!l || l.length > 30) bad += 1;
  }
  ok(bad === 0, `所有 ${PERSONAS.length} 套人设都有可用的兜底弹幕`);
  ok(localDanmaku({ lines: {} }).length > 0, '没有语料时也能兜底');
  ok(localDanmaku(PERSONAS[0], '玩家刚说话').length > 0, '针对玩家发言的兜底可用');

  // 兜底语料里不能出现没替换的模板占位符，也要有"还差人"的房间话题
  let placeholder = 0;
  const roomPool = [];
  for (const p of PERSONAS) {
    for (let i = 0; i < 5; i += 1) {
      const l = localDanmaku(p);
      if (l.includes('{') || l.includes('}')) placeholder += 1;
      roomPool.push(l);
    }
  }
  ok(placeholder === 0, '兜底台词里没有未替换的模板占位符');
  ok(roomPool.some((l) => l.includes('二缺一') || l.includes('还差') || l.includes('人齐')),
    '房间兜底语料里有人数/等人的话题');
  ok(roomPool.every((l) => l.length <= 30), '兜底台词长度都在限制内');

  const layer = new DanmakuLayer();
  ok(layer.recentLines().length === 0, '未挂载时历史为空');
  ok(layer.push({ seat: 1, name: 'x', text: 'y' }) === null, '未挂载时 push 安全返回 null');
  layer.recent = [{ name: 'a', text: 'b', seat: 1 }];
  ok(layer.recentLines()[0].name === 'a', 'recentLines 带上了说话人');
}

/* ---------------- 只在房间界面出现 ---------------- */
console.log('── 弹幕只在"房间/等人"界面');
{
  const html = read('index.html');
  ok(!html.includes('danmaku-table'), '牌桌界面没有弹幕层');
  ok(!html.includes('danmaku-fishing'), '小猫钓鱼界面没有弹幕层');

  const ui = read('src/ui/friends.js');
  ok(ui.includes('id="danmaku-room"'), '房间面板里有弹幕层');
  ok(ui.includes("app.startDanmaku('danmaku-room')"), '打开房间时启动弹幕');
  ok(ui.includes('onClose: () => app.stopDanmaku()'), '关掉房间时停止弹幕');
  ok(ui.includes('app.refreshDanmakuTimer()'), '房间人数变化时重排定时器');
  ok(ui.includes('app.roomDanmakuSeats = seats.slice()'), '说话人取自已邀请的好友');

  const appjs = read('src/ui/app.js');
  ok(!appjs.includes("startDanmaku('danmaku-table')"), '开局时不再启动牌桌弹幕');
  ok(!appjs.includes("startDanmaku('danmaku-fishing')"), '钓鱼时不再启动牌桌弹幕');
  ok(appjs.includes('this.showBubble(seat, text);'), 'AI 在牌桌上说话回到气泡');
  ok(appjs.includes('sendRoomDanmaku'), '房间里有玩家发弹幕的入口');
  ok(!appjs.includes('aiSeats()'), '不再按"这局的 AI 座位"决定说话人');
  ok(appjs.includes('armDanmakuKickoff'), '有"进房 5s 玩家不说话就由 AI 开场"的兜底');
  ok(appjs.includes('scheduleDanmakuReply'), '玩家发弹幕后走 3~5 秒的"打字"延迟');
  ok(appjs.includes('opener: true'), '开场调用会标记 opener');
  ok(appjs.includes('danmakuReplyDelay'), '延迟用的是可测试的纯函数');
}

/* ---------------- ★ 弹幕与私聊共享同一份记忆 / 好感度 ---------------- */
console.log('── 弹幕与私聊共享记忆与好感度');
{
  const save = defaultSave();
  const p = PERSONAS[2];
  addFriend(save, p);
  const f = findFriend(save, p.id);
  adjustAffinity(save, p.id, 80); // 默认 0 → 好感度 80（挚友档）
  addMemory(save, p.id, '称呼：阿伟');
  addMemory(save, p.id, '偏好：爱喝奶茶');
  setSelfMemory(save, p.id, '老家', '杭州');

  const all = buildDanmakuMessages({
    persona: p,
    friend: f,
    situation: danmakuSituationText({ seated: 2, needFriends: 2 }),
    recent: [
      { name: '玩家', text: '今晚谁有空' },
      { name: PERSONAS[3].name, text: '我我我' },
      { name: p.name, text: '来了' },
    ],
    target: '你今晚打不打',
    playerName: '我',
  }).map((m) => m.content).join('\n');

  ok(/好感度 80\/100/.test(all), `★ 弹幕提示词里带上好感度（${(all.match(/好感度 \d+\/100/) || [])[0]}）`);
  ok(/你和玩家的关系：\S+/.test(all), '★ 带上关系档位');
  ok(all.includes('阿伟'), '★ 带上"平时怎么称呼他"');
  ok(all.includes('偏好：爱喝奶茶'), '★ 带上私聊里记下的事');
  ok(all.includes('自设：老家=杭州'), '★ 带上 AI 自己的设定（与私聊同一份）');
  ok(!/你记得玩家的事：[^；]*自设：/.test(all), '自设没有混进"记得玩家的事"里');

  // 前几条弹幕：带说话人、有先后顺序
  ok(/前面几条弹幕（从早到晚，共 3 条/.test(all), '★ 明确给出"前面几条弹幕"并标了条数');
  const i1 = all.indexOf('玩家：今晚谁有空');
  const i2 = all.indexOf(`${PERSONAS[3].name}：我我我`);
  const i3 = all.indexOf(`${p.name}：来了`);
  ok(i1 > 0 && i2 > i1 && i3 > i2, '★ 前几条弹幕按从早到晚排列，且都带说话人');
  ok(/最后一条如果就是你自己的/.test(all), '提醒它"刚才那条是自己说的"');
  ok(all.includes('玩家刚发的弹幕：你今晚打不打'), '玩家的这一条单独点出来');

  const empty = buildDanmakuMessages({ persona: p, friend: f, recent: [] }).map((m) => m.content).join('\n');
  ok(/前面还没有人发过弹幕/.test(empty), '没有历史时明说"这是第一条"');

  const loverAll = buildDanmakuMessages({ persona: p, friend: f, recent: [], lover: true })
    .map((m) => m.content).join('\n');
  ok(/关系：恋人/.test(loverAll), '★ 房间里也知道是恋人');
  ok(/你和玩家已经是恋人了/.test(loverAll), '恋人的口吻要求也在');

  const cold = defaultSave();
  addFriend(cold, p);
  // 默认就是 0 好感度（陌生档），不用再往下扣
  const coldAll = buildDanmakuMessages({
    persona: p, friend: findFriend(cold, p.id), recent: [],
  }).map((m) => m.content).join('\n');
  ok(/关系：陌生/.test(coldAll), '好感度 0 → 关系是「陌生」');
}

/* ---------------- ★ 牌桌 / 小猫钓鱼也要知道关系与称呼 ---------------- */
console.log('── 牌桌与钓鱼台上的关系背景');
{
  const save = defaultSave();
  const p = PERSONAS[1];
  addFriend(save, p);
  adjustAffinity(save, p.id, 95); // 默认 0 → 好感度 95（挚友档）
  addMemory(save, p.id, '称呼：明哥');
  addMemory(save, p.id, '身份：大学生');
  setSelfMemory(save, p.id, '职业', '大学生');

  const lines = friendContextLines(save, findFriend(save, p.id), { table: true });
  const text = lines.join('\n');
  ok(/好感度 95\/100/.test(text), '★ 牌桌背景里有好感度');
  ok(/挚友/.test(text), '★ 有具体关系（挚友）');
  ok(text.includes('明哥'), '★ 有"平时怎么称呼他"');
  ok(text.includes('身份：大学生'), '有玩家信息');
  ok(text.includes('自设：职业=大学生'), '有 AI 自己的设定');
  ok(/不要报好感度/.test(text), '牌桌版明确"别报好感度、别聊关系来历"');

  const chatText = friendContextLines(save, findFriend(save, p.id)).join('\n');
  ok(/挚友/.test(chatText) && /说话随便些/.test(chatText), '挚友 → 允许随便/损他');
  ok(/不要报出数值/.test(chatText), '聊天版明确"不要报数值"');

  // 中间几档也要有各自的口吻（避免只有两端对、中间串档）
  const toneOf = (v) => {
    const s2 = defaultSave();
    addFriend(s2, p);
    adjustAffinity(s2, p.id, v);
    return friendContextLines(s2, findFriend(s2, p.id)).join('\n');
  };
  ok(/密友/.test(toneOf(70)) && /关系很好/.test(toneOf(70)), '60~80 → 密友口吻');
  ok(/朋友/.test(toneOf(50)) && /聊得来/.test(toneOf(50)), '40~60 → 朋友口吻');
  ok(/点头之交/.test(toneOf(30)) && /别自来熟/.test(toneOf(30)), '20~40 → 点头之交口吻');
  ok(/陌生/.test(toneOf(10)) && /客气一点/.test(toneOf(10)), '0~20 → 陌生口吻');

  const coldText = toneOf(0);
  ok(/陌生/.test(coldText) && /客气/.test(coldText), '关系差 → 要求客气、别套近乎');

  ok(friendContextLines(save, null).length === 0, '不是好友就没有这些行');
  ok(friendContextLines(save, findFriend(save, 'nope')).length === 0, '传不存在的记录也安全');

  // 真的进了牌桌提示词
  const msgs = buildMessages({
    persona: p,
    scene: 'playSmall',
    view: {
      isLandlord: false,
      handReportLine: '你的手牌：8 张',
      countsText: '你 8 张',
      multiplier: 2,
      bombs: 0,
      lastText: '',
      situationText: '',
      historyText: '',
      playerText: '',
      friendLines: lines,
    },
  }).map((m) => m.content).join('\n');
  ok(msgs.includes('明哥'), '★ 牌桌台词的提示词里真的带上了称呼');
  ok(/好感度 95\/100/.test(msgs), '★ 牌桌台词的提示词里真的带上了好感度');
  ok(/挚友/.test(msgs), '★ 也带上了关系');

  const fv = fishingView({
    game: {
      score: [3, 5], piles: [[6], [4]], table: [], multiplier: 2, recentLog: () => [],
    },
    seat: 1,
    extra: { friendLines: lines },
  });
  ok(Array.isArray(fv.friendLines) && fv.friendLines.length > 0, '★ 小猫钓鱼视图里也带上了关系背景');
  ok(fv.friendLines.join('\n').includes('明哥'), '钓鱼台也知道怎么称呼玩家');
}

/* ---------------- ★ 共享是"同一份数据"，而且是**只读不写** ---------------- */
console.log('── 弹幕只读不写（读得到记忆与好感度，但不写记忆、不动好感度）');
{
  const appjs = read('src/ui/app.js');
  const frijs = read('src/ui/friends.js');
  const code = appjs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  // 私聊：一处实现，负责"写"
  ok(/async settleFriendChat\(personaId/.test(code), '沉淀逻辑只有一处实现（app.settleFriendChat）');
  ok(/await app\.settleFriendChat\(personaId/.test(frijs), '★ 只有私聊调用它（写记忆 / 动好感度）');

  // 弹幕：只读
  const fn = (code.match(/async emitAiDanmaku\([\s\S]*?\n  \}/) || [''])[0];
  ok(fn.length > 0, '取得到 emitAiDanmaku');
  ok(!/settleFriendChat/.test(fn), '★ 房间弹幕不调用沉淀逻辑');
  ok(!/analyzeMessage|addMemory|adjustAffinity|setSelfMemories|setLover|breakUp/.test(fn),
    '★ 房间弹幕里没有任何写操作');
  ok(/friend,/.test(fn), '★ 但把 friend 传给了提示词（读得到记忆与好感度）');
  ok(/isLover\(this\.save, persona\.id\)/.test(fn), '★ 也读得到恋人关系');
  ok(/recent: this\.danmaku\.recentLines\(\)/.test(fn), '★ 还读得到前面几条弹幕');

  // 牌桌 / 钓鱼：也是只读
  ok(/friendLinesFor\(/.test(code) && /friendContextLines\(this\.save/.test(code),
    '牌桌 / 钓鱼共用 friendLinesFor（只读关系背景）');
  ok(/friendLines: this\.friendLinesFor\(g\.personas\[seat\], \{ table: true \}\)/.test(code),
    '牌桌每个座位的台词都带上关系背景');
  ok(/friendLines: this\.friendLinesFor\(this\.fishing\.persona\)/.test(code),
    '小猫钓鱼的对手也带上关系背景');
  ok(/view\.friendLines/.test(read('src/ai/chat.js')), '牌桌台词提示词会把这些行放进 system');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '弹幕测试全部通过'}`);
process.exit(fail ? 1 : 0);
