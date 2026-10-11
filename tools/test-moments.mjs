/**
 * 友圈（node tools/test-moments.mjs）
 *
 * 用户拍板的规则，一条一条盯：
 *   · 面板叫**社交**，里面有好友 / 群聊 / **友圈** 三个标签
 *   · 只有玩家能发说说；AI 只点赞 + 评论
 *   · 评论**只显示名称、不显示头像**（`某某：XXXXXXXX`）
 *   · 发完说说：审查 AI 挑人 → 第一条 10~30s，之后每条 2~30s
 *   · 明确 @ 谁 → 谁一定来；好友 < 3 位 → 全来；否则随机 2~4 位
 *   · 玩家回复某位 AI 的评论 → 那位 AI 接着回
 */
import { readFileSync } from 'node:fs';
import { defaultSave } from '../src/store/storage.js';
import { addFriend, removeFriend, setLover, isLover, findFriend, listMomentMemory, addMomentMemory, addMemory, setSelfMemory } from '../src/store/friends.js';
import { PERSONAS } from '../src/data/personas.js';
import { MOMENTS, ONLINE_MOMENT } from '../src/config.js';
import {
  ensureMoments, listMoments, findMoment, addMoment, addMomentComment, toggleMomentLike, hasLiked,
  momentStats, recentMomentComments, momentUnreadTotal, markMomentsSeen, removeMoment, addMomentLike,
} from '../src/store/moments.js';
import {
  localChooseCommenters, parseChooseCommenters, buildChooseCommentersMessages,
  buildMomentCommentMessages, cleanMomentComment, localMomentComment,
  firstCommentDelayMs, nextCommentDelayMs, commentSchedule, replyDelayMs,
  buildMomentPostMessages, localMomentPost, pickMomentScene, localAiMomentComment,
} from '../src/ai/moments.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function newSave(friends = 4) {
  const s = defaultSave();
  s.nickname = '小徐';
  for (const p of PERSONAS.slice(0, friends)) addFriend(s, p);
  return s;
}
/** app 挑人时传的是"好友记录 + persona"（见 app.scheduleMomentCommenters） */
const withPersona = (s) => s.friends.filter((f) => !f.removed).map((f) => ({
  ...f, persona: PERSONAS.find((p) => p.id === f.personaId) || null,
}));

/* ===================================================================== */
console.log('-- 数据层：发说说 / 点赞 / 评论');
{
  const s = newSave();
  ok(Array.isArray(s.moments), '存档里有 moments 字段（默认空数组）');

  const bad = addMoment(s, '   ');
  ok(!bad.ok, '★ 空说说发不出去');

  const { ok: created, moment } = addMoment(s, '今天天气真好，出来晒太阳');
  ok(created && moment, '能发一条说说');
  ok(listMoments(s).length === 1, '存档里出现了这条说说');
  ok(listMoments(s)[0].id === moment.id, '★ 最新的说说排在最前面');
  ok(momentStats(moment).likes === 0 && momentStats(moment).comments === 0, '新说说没有赞也没有评论');

  const long = addMoment(s, '啊'.repeat(MOMENTS.maxChars + 50));
  ok(long.moment.text.length === MOMENTS.maxChars, `★ 说说超长会被截到 ${MOMENTS.maxChars} 字`);

  // 点赞 / 取消
  ok(!hasLiked(s, moment.id, 'me'), '一开始没点过赞');
  toggleMomentLike(s, moment.id, 'me');
  ok(hasLiked(s, moment.id, 'me') && momentStats(moment).likes === 1, '点赞 +1');
  toggleMomentLike(s, moment.id, 'me');
  ok(!hasLiked(s, moment.id, 'me') && momentStats(moment).likes === 0, '再点一下 = 取消赞');
  const dupLike = toggleMomentLike(s, moment.id, PERSONAS[0].id);
  toggleMomentLike(s, moment.id, PERSONAS[0].id);
  ok(dupLike.ok && !hasLiked(s, moment.id, PERSONAS[0].id), 'AI 的赞也能取消，不会重复堆数量');

  // 评论
  const c1 = addMomentComment(s, moment.id, { by: 'me', text: '  ' });
  ok(!c1.ok, '空评论发不出去');
  addMomentComment(s, moment.id, { by: 'me', text: '自己顶一下' });
  addMomentComment(s, moment.id, { by: PERSONAS[0].id, text: '好看！' });
  ok(momentStats(moment).comments === 2, '两条评论都进去了');
  ok(moment.comments[1].by === PERSONAS[0].id, '评论记下了是谁说的');
  ok(recentMomentComments(moment).length === 2, 'recentMomentComments 能给提示词喂上下文');

  // 回复某条评论
  const reply = addMomentComment(s, moment.id, {
    by: 'me', text: '谢谢～', replyTo: moment.comments[1].id,
  });
  ok(reply.ok && reply.comment.replyTo === moment.comments[1].id, '★ 评论可以挂在"回复谁"下面');

  // 找不到的说说
  ok(!addMomentComment(s, 'nope', { by: 'me', text: 'x' }).ok, '给不存在的说说评论 → 失败');
  ok(toggleMomentLike(s, 'nope', 'me').ok === false, '给不存在的说说点赞 → 失败');

  /* ★ 删除一条说说：只删它自己（连带它的赞和评论），别的一概不动 */
  {
    const s2 = newSave();
    const a = addMoment(s2, '第一条').moment;
    const b = addMoment(s2, '第二条').moment;
    addMomentComment(s2, a.id, { by: PERSONAS[0].id, text: '好看' });
    toggleMomentLike(s2, a.id, 'me');
    const friendBefore = JSON.stringify(s2.friends[0]);
    const del = removeMoment(s2, a.id);
    ok(del.ok && del.moment.id === a.id, '★ 能删掉指定的那条说说');
    ok(listMoments(s2).length === 1 && listMoments(s2)[0].id === b.id, '★ 只删这一条，别的说说还在');
    ok(!findMoment(s2, a.id), '删掉之后查不到它了');
    ok(findMoment(s2, b.id).comments.length === 0, '另一条说说的评论没有被牵连');
    ok(JSON.stringify(s2.friends[0]) === friendBefore, '★ 删说说不动好友（好感度 / 记忆都不受影响）');
    ok(removeMoment(s2, a.id).ok === false, '再删一次 → 返回失败（不炸）');
    ok(removeMoment(s2, 'nope').ok === false, '删不存在的说说 → 失败');
  }

  // 老存档 / 脏数据兜底
  const dirty = { moments: [{ id: 'm1', text: 'x', likes: null, comments: [{ text: 'a' }] }, null, { }] };
  ensureMoments(dirty);
  ok(dirty.moments.length === 1, '脏数据会被清掉（没有 id 的丢掉）');
  ok(Array.isArray(dirty.moments[0].likes) && Array.isArray(dirty.moments[0].comments), '字段缺了会补齐');
  ok(typeof dirty.moments[0].comments[0].id === 'string' && dirty.moments[0].comments[0].id, '评论没有 id 会补一个');
  ok(dirty.moments[0].comments[0].by === 'me', '评论没有 by 默认算玩家的');

  // 上限
  const many = newSave();
  for (let i = 0; i < MOMENTS.maxPosts + 5; i += 1) addMoment(many, `第 ${i} 条`);
  ok(listMoments(many).length === MOMENTS.maxPosts, `★ 最多留 ${MOMENTS.maxPosts} 条说说`);
  ok(listMoments(many)[0].text === `第 ${MOMENTS.maxPosts + 4} 条`, '超上限时砍掉最老的');
}

/* ===================================================================== */
console.log('-- 小红点：好友来评论之后才亮，看过就灭');
{
  const s = newSave(3);
  const { moment } = addMoment(s, '今天出门散步');
  ok(momentUnreadTotal(s) === 0, '刚发完说说没有未读');

  addMomentComment(s, moment.id, { by: 'me', text: '自己顶一下' });
  ok(momentUnreadTotal(s) === 0, '★ 自己评论不算未读');

  const t0 = Date.now() - 100000;
  markMomentsSeen(s, t0);
  addMomentComment(s, moment.id, { by: PERSONAS[0].id, text: '羡慕', at: t0 + 1000 });
  addMomentComment(s, moment.id, { by: PERSONAS[1].id, text: '带我一个', at: t0 + 2000 });
  ok(momentUnreadTotal(s) === 2, '★ 好友的两条评论都算未读');
  markMomentsSeen(s, Date.now() - 1000);
  ok(momentUnreadTotal(s) === 0, '★ 打开友圈之后未读清零');
  addMomentComment(s, moment.id, { by: PERSONAS[2].id, text: '下次约' });
  ok(momentUnreadTotal(s) === 1, '之后再来一条又有未读');
}

/* ===================================================================== */
console.log('-- 挑人：谁来说说下面评论');
{
  const s4 = newSave(4);
  const list4 = withPersona(s4);
  const names4 = list4.map((f) => f.persona.name);

  // 好友 < 3 位 → 全来
  const s2 = newSave(2);
  const ids2 = localChooseCommenters({ friends: withPersona(s2), text: '随便说说' });
  ok(ids2.length === 2, '★ 好友只有 2 位 → 两位都来评论');

  const s0 = newSave(0);
  ok(localChooseCommenters({ friends: withPersona(s0), text: 'x' }).length === 0, '没有好友 → 没人评论');

  // 随机 2~4 位
  const picked = localChooseCommenters({ friends: list4, text: '今天有点累' });
  ok(picked.length >= 1 && picked.length <= list4.length, '随机挑人数量合理');
  const many = newSave(8);
  const counts = new Set();
  for (let i = 0; i < 60; i += 1) {
    const n = localChooseCommenters({ friends: withPersona(many), text: '今天有点累' }).length;
    counts.add(n);
    ok(n >= MOMENTS.minCommenters && n <= MOMENTS.maxCommenters,
      `★ 好友多时挑 ${MOMENTS.minCommenters}~${MOMENTS.maxCommenters} 位（实际 ${n}）`);
  }
  ok([...counts].length > 1, '每次挑的人数不是死的');

  // 明确 @ 谁 → 谁一定来
  const at = localChooseCommenters({ friends: list4, text: `@${names4[2]} 你说呢` });
  ok(at.includes(list4[2].personaId), `★ 被 @ 的「${names4[2]}」一定会来`);
  ok(at.length >= 1 && at.length <= 3, '@ 之后另外再带 1 位左右');
  // 直接写名字（不写 @）也算点名
  const plain = localChooseCommenters({ friends: list4, text: `${names4[1]} 你看这个` });
  ok(plain.includes(list4[1].personaId), '不写 @、直接写名字也算点名');

  // 被点名的人已经被删了 → 不能选到幽灵
  const s3 = newSave(4);
  const ghostId = s3.friends[1].personaId;
  removeFriend(s3, ghostId);
  const afterDel = localChooseCommenters({ friends: withPersona(s3), text: `@${PERSONAS[1].name} 在吗` });
  ok(!afterDel.includes(ghostId), '★ 删掉的好友不会被挑出来评论');

  // 挑人提示词
  const msgs = buildChooseCommentersMessages({ text: '今天天气真好', friends: list4, playerName: '小徐' });
  const text = msgs.map((m) => m.content).join('\n');
  ok(text.includes('友圈'), '提示词里说清了场景是友圈');
  ok(names4.every((n) => text.includes(n)), '名单里列了所有好友');
  ok(msgs[1].content.includes('小徐'), '把玩家昵称也给了模型');
  ok(/"commenters"/.test(text), '只让它输出 {"commenters": [...]}');

  // 解析：只保留真实存在的 id，容忍代码块和多余的话
  const raw = '```json\n{"commenters": ["' + list4[0].personaId + '", "不存在的人", "'
    + list4[0].personaId + '"]}\n```';
  const parsed = parseChooseCommenters(raw, list4);
  ok(parsed.length === 1 && parsed[0] === list4[0].personaId, '★ 编出来的 id 会被丢掉，重复的会去重');
  ok(parseChooseCommenters('模型今天不想干活', list4) === null, '完全解析不出来 → null（上层走本地兜底）');
  // 兼容直接传 personaId 字符串数组
  ok(parseChooseCommenters(`["${list4[1].personaId}"]`, list4.map((f) => f.personaId))[0] === list4[1].personaId,
    '传 id 列表也能解析');
}

/* ===================================================================== */
console.log('-- 写评论：提示词 + 清理 + 本地兜底');
{
  const s = newSave(4);
  const friend = s.friends[0];
  const persona = PERSONAS[0];
  const msgs = buildMomentCommentMessages({
    persona, friend, text: '今天去爬山了', playerName: '小徐', comments: [{ by: 'me', text: '腿要断了' }],
  });
  const text = msgs.map((m) => m.content).join('\n');
  ok(text.includes('友圈'), '提示词说清了是给友圈的说说写评论');
  ok(text.includes(persona.name), '带上了它的人设');
  ok(text.includes('今天去爬山了'), '把玩家的说说给了它');
  ok(text.includes('腿要断了'), '已有的评论也给了它（免得重复）');
  ok(/不要提"点赞"/.test(text), '不许提点赞字眼');

  /* ★ 用户要求：评论的提示词要包含「友圈内容 + 相关记忆 + 基本信息」 */
  {
    addMemory(s, persona.id, '称呼：小徐');
    addMemory(s, persona.id, '偏好：喝奶茶');
    setSelfMemory(s, persona.id, '老家', '杭州');
    addMomentMemory(s, persona.id, { text: '昨天去打牌了', comment: '赢麻了吧' });
    const t2 = buildMomentCommentMessages({
      persona, friend: findFriend(s, persona.id), text: '今天去爬山了', playerName: '小徐',
      playerGender: '玩家是男生，别叫错。', myBeans: 12345, myTitle: '小有名气',
    }).map((m) => m.content).join('\n');
    // ① 友圈内容
    ok(t2.includes('今天去爬山了'), '★ 提示词里有**说说内容**');
    // ② 相关记忆
    ok(t2.includes('称呼：小徐'), '★ 提示词里有**关于玩家的记忆**（称呼）');
    ok(t2.includes('偏好：喝奶茶'), '★ 提示词里有**偏好记忆**');
    ok(t2.includes('自设：老家=杭州'), '★ 提示词里有**它自己的设定**（自设）');
    ok(t2.includes('友圈：') && t2.includes('昨天去打牌了'), '★ 提示词里带上了它评论过的**友圈记忆**');
    ok(t2.includes('【关于玩家】') && t2.includes('【你自己】'), '★ 每条记忆都标了归属前缀，不会读串');
    // ③ 基本信息
    ok(t2.includes('你是「') || t2.includes(`你是「${persona.name}」`), '★ 提示词里有**人设基本信息**');
    ok(t2.includes(persona.tags[0]), '★ 提示词里有**标签**');
    ok(/你是(男|女)生|性别/.test(t2) || t2.includes('性别'), '★ 提示词里有它的**性别**信息');
    ok(/年龄/.test(t2) || /\d+ 岁/.test(t2), '★ 提示词里有它的**年龄**信息');
    ok(t2.includes('玩家是男生，别叫错。'), '★ 提示词里有**玩家性别**');
    ok(t2.includes('小徐'), '★ 提示词里有**玩家昵称**');
    ok(t2.includes('你平时叫他「小徐」'), '★ 提示词里有**称呼**（怎么叫他）');
    ok(/好感度 \d+/.test(t2), '★ 提示词里有**关系 / 好感度**');
    ok(t2.includes('12,345') && t2.includes('小有名气'), '★ 提示词里有它自己的**身家与称号**');
  }

  // 回复场景
  const replyMsgs = buildMomentCommentMessages({
    persona, friend, text: '今天去爬山了',
    replyTo: { text: '你怎么不叫我' }, replyText: '下次带你', playerName: '小徐',
  }).map((m) => m.content).join('\n');
  ok(/回复了你/.test(replyMsgs) && replyMsgs.includes('下次带你'), '★ 玩家回复它时，提示词明确"接着这句回复"');

  /* ★ 评论区上下文要**标清谁说的**：它自己的写成"你"，别人写成"另一个好友"，
        否则模型分不清哪句是自己说的（用户报的"我回复别的 AI，它像在回自己"） */
  {
    const other = PERSONAS[1].id;
    const t2 = buildMomentCommentMessages({
      persona, friend, text: '今天去爬山了', playerName: '小徐', replyText: '周末一起',
      replyTo: { text: '带我一个' },
      comments: [
        { by: persona.id, text: '带我一个' },
        { by: 'me', text: '好啊' },
        { by: other, text: '我也想去' },
      ],
    }).map((m) => m.content).join('\n');
    ok(t2.includes(`你（${persona.name}）：带我一个`), '★ 它自己说过的那句标成"你"');
    ok(t2.includes('玩家（小徐）：好啊'), '★ 玩家那句标成"玩家（昵称）"');
    ok(t2.includes('另一个好友：我也想去'), '第三个 AI 的评论标成"另一个好友"');
    ok(!/某人/.test(t2), '★ 不再用含糊的"某人"');
  }

  // 清理模型输出（★ 评论允许换行，不再压成一行）
  ok(cleanMomentComment(`${persona.name}：好羡慕啊`, persona) === '好羡慕啊', '去掉名字前缀');
  ok(cleanMomentComment('「带我一个」', persona) === '带我一个', '去掉引号');
  ok(cleanMomentComment('第一行\n第二行', persona) === '第一行\n第二行', '★ 换行**保留**（用户要求：评论允许换行）');
  ok(cleanMomentComment('一\n\n\n二', persona) === '一\n二', '连续空行会压掉');
  ok(cleanMomentComment('一\n二\n三\n四\n五\n六', persona).split('\n').length === MOMENTS.commentMaxLines,
    `最多留 ${MOMENTS.commentMaxLines} 行，不会写成小作文`);
  {
    // ★ 不再按私聊那套"25 字"截断：一段正常长度的评论要完整保留
    const mid = '今天这条路我也走过，山上的风特别大，下次记得带件外套，不然到顶会被吹得站不住，最好再带个保温杯。';
    const kept = cleanMomentComment(mid, persona);
    ok([...mid].length > 40, '测试用的评论本身就超过老的 40 字上限');
    ok(kept === mid, `★ 正常长度的评论不被截断（${[...mid].length} 字，完整保留）`);
    const lines = cleanMomentComment('第一行说点正经的\n第二行补一句玩笑', persona);
    ok(lines === '第一行说点正经的\n第二行补一句玩笑', '★ 多行评论整体保留，行数也没被砍');
    const tooLong = '啊'.repeat(MOMENTS.commentMaxChars + 40);
    const cut = cleanMomentComment(tooLong, persona);
    ok([...cut].length <= MOMENTS.commentMaxChars + 1, `真的超长时才截（${[...cut].length} 字）`);
    ok(cut.endsWith('…'), '截断处有省略号，看得出是被截的');
    // 超长但中间有句号：就断在句号处，不把话切一半
    const withStop = `${'好'.repeat(60)}。${'啊'.repeat(80)}。${'啊'.repeat(80)}`;
    ok(cleanMomentComment(withStop, persona).endsWith('。…'), '★ 超长时断在句号处，不把话切一半');
  }

  // 本地兜底永远有话说
  for (const p of PERSONAS.slice(0, 6)) {
    const line = localMomentComment(p, '今天有点累', '');
    ok(typeof line === 'string' && line.length > 0, `「${p.name}」本地兜底也能评论`);
  }
}

/* ===================================================================== */
console.log('-- 节奏：不会一窝蜂');
{
  ok(MOMENTS.firstMinMs === 10000 && MOMENTS.firstMaxMs === 30000,
    `★ 第一条评论等 ${MOMENTS.firstMinMs / 1000}~${MOMENTS.firstMaxMs / 1000}s`);
  ok(MOMENTS.gapMinMs === 2000 && MOMENTS.gapMaxMs === 30000,
    `★ 之后每条间隔 ${MOMENTS.gapMinMs / 1000}~${MOMENTS.gapMaxMs / 1000}s`);

  let min = Infinity; let max = -Infinity;
  for (let i = 0; i < 200; i += 1) {
    const d = firstCommentDelayMs();
    min = Math.min(min, d); max = Math.max(max, d);
    ok(d >= MOMENTS.firstMinMs && d <= MOMENTS.firstMaxMs, `首条延迟在区间内（${d}）`);
  }
  ok(max - min > 3000, '首条延迟是随机的，不是固定值');

  const sch = commentSchedule(4);
  ok(sch.length === 4, '4 位评论者 → 4 个时间点');
  ok(sch[0] >= MOMENTS.firstMinMs, '第一个时间点 = 首条延迟');
  for (let i = 1; i < sch.length; i += 1) {
    const gap = sch[i] - sch[i - 1];
    ok(gap >= MOMENTS.gapMinMs && gap <= MOMENTS.gapMaxMs, `第 ${i + 1} 条与上一条间隔在区间内（${gap}）`);
  }
  ok(nextCommentDelayMs() >= MOMENTS.gapMinMs, 'nextCommentDelayMs 也守区间');

  /* ★ 玩家回复 AI 的评论之后：1~5s 才回（用户拍板） */
  ok(MOMENTS.replyMinMs === 1000 && MOMENTS.replyMaxMs === 5000,
    `★ 回复间隔是 ${MOMENTS.replyMinMs / 1000}~${MOMENTS.replyMaxMs / 1000}s`);
  let rmin = Infinity; let rmax = -Infinity;
  for (let i = 0; i < 200; i += 1) {
    const d = replyDelayMs();
    rmin = Math.min(rmin, d); rmax = Math.max(rmax, d);
    ok(d >= MOMENTS.replyMinMs && d <= MOMENTS.replyMaxMs, `回复延迟在 1~5s 之内（${d}）`);
  }
  ok(rmax - rmin > 1000, '回复延迟是随机的，不是固定值');
  ok(replyDelayMs(() => 0) === 1000 && replyDelayMs(() => 1) === 5000, '边界值：0 → 1s，1 → 5s');
}

/* ===================================================================== */
console.log('-- 界面 / 文案（静态契约）');
{
  const friendsUi = read('../src/ui/friends.js');
  const momentsUi = read('../src/ui/moments.js');
  const app = read('../src/ui/app.js');
  const idx = read('../index.html');
  const css = read('../styles/moments.css');
  const storage = read('../src/store/storage.js');

  ok(/drawer-title">社交</.test(friendsUi), '★ 面板标题改成了「社交」');
  ok(/data-ftab="moments"/.test(friendsUi) && /id="moments-body"/.test(friendsUi), '★ 社交面板里有「友圈」标签页');
  ok(/data-ftab="friends"/.test(friendsUi) && /data-ftab="groups"/.test(friendsUi), '好友 / 群聊两个老标签还在');
  ok(/renderMoments\(app, momentBox\)/.test(friendsUi), '切到友圈时渲染友圈');
  ok(/momentBox\.hidden = !onMoments/.test(friendsUi), '切标签时友圈容器跟着显示 / 隐藏');
  ok(/el\.querySelector\('#moment-dot'\)\.hidden = momentUnreadTotal\(app\.save\) === 0/.test(friendsUi),
    '★ 有人来评论过 → 友圈标签亮小红点');
  ok(/markMomentsSeen\(app\.save\)[\s\S]{0,80}moment-dot'\)\.hidden = true/.test(friendsUi),
    '★ 进友圈就算看过了，红点灭掉');
  ok(/\.moments-body\[hidden\] \{ display: none; \}/.test(css), '★ 友圈容器 hidden 时真的不显示（踩过坑）');

  ok(/id="nav-friends"[^>]*>.*社交/.test(idx), '底部导航写的是「社交」');

  // 版式：头像在左；评论只有名称
  ok(/class="moment-avatar"/.test(momentsUi), '★ 说说左侧有头像');
  ok(/class="moment-name"/.test(momentsUi), '名称在右侧上部');
  ok(/class="moment-text"/.test(momentsUi), '内容在名称下面');
  ok(/class="mc-name"/.test(momentsUi) && /：\$\{quote\}/.test(momentsUi), '★ 评论是「某某：内容」');
  // 名字是蓝色可点的 → 点一下跳到和那个人的私聊
  ok(/data-chat="\$\{esc\(c\.by\)\}"/.test(momentsUi), '★ 评论里的名字带着 personaId，可以点');
  ok(/app\.openFriendChat\(personaId\)/.test(momentsUi), '★ 点名字 → 跳到对应的私聊面板');
  ok(/openFriendChat\(personaId\) \{/.test(app) && /friendsPanel\.openFriends\(this, \{ personaId \}\)/.test(app),
    'app 里实现了"跳到某位好友的私聊"');
  ok(/export function openFriends\(app, opts = \{\}\)/.test(friendsUi)
    && /list\.some\(\(f\) => f\.personaId === want\)/.test(friendsUi),
    '★ 社交面板支持"一进来就选中这位好友"');
  ok(/\.mc-name \{[\s\S]{0,200}color: #6FD6FF/.test(css), '名字是蓝色的（看得出能点）');
  ok(/:root\[data-theme="light"\] \.mc-name \{ color: #1f7fd0/.test(read('../styles/theme-light.css')),
    '浅色主题下换成深一点的蓝，仍然看得清');

  // ★ 删除：只删这一条说说，确认走**面板里的弹窗**（不用浏览器原生 confirm）
  ok(/data-del="\$\{m\.id\}"/.test(momentsUi) && /class="moment-del"/.test(momentsUi),
    '★ 每条说说的右上角有删除按钮');
  ok(/removeMoment\(app\.save, id\)/.test(momentsUi), '★ 删除调的就是"只删这条说说"');
  ok(/\.moment-del \{[\s\S]{0,200}position: absolute; top: 6px; right: 8px/.test(css), '删除按钮在右上角');
  ok(/function askConfirm\(\{ title, text = '', okText = '确定' \}\)/.test(momentsUi),
    '★ 确认用的是面板里的弹窗（askConfirm）');
  ok(!/window\.confirm/.test(momentsUi), '★ 不再用浏览器原生 confirm');
  ok(/await askConfirm\(\{ title: '删除这条说说？', okText: '删除' \}\)/.test(momentsUi), '删除前先弹一次确认');
  ok(/\.ask-dialog/.test(css), '弹窗有对应样式');

  // ★ 用户要求：别再啰嗦（发布浮层的提示句、删除确认里那句都不显示）
  ok(!/发出去之后，好友们会陆续来点赞和评论/.test(momentsUi), '★ 发布浮层里的"发出去之后…"那句删了');
  ok(!/下面的评论和点赞会一起没掉/.test(momentsUi), '★ 删除确认里那句解释删了');
  ok(/回复 \$\{esc\(nameOfComment\(app, replyTo\.by\)\)\}<\/span> /.test(momentsUi),
    '★ 「回复 某某」后面留了一个空格，再接内容（用户要求）');
  ok(/mc-quote/.test(css), '被回复的人用弱化样式显示');
  ok(!/class="mc-avatar"/.test(momentsUi) && !/mc-avatar/.test(css), '★ 评论行没有头像');
  ok(/data-like=/.test(momentsUi) && /data-send=/.test(momentsUi), '能点赞、能评论');
  // ★ 评论允许换行 + 不截断（用户要求）
  ok(/<textarea class="moment-input"/.test(momentsUi), '★ 评论输入框改成了多行 textarea');
  ok(!/（Shift\+Enter 换行）/.test(momentsUi), '★ 输入框不再写"Shift+Enter 换行"那种提示（用户要求去掉）');
  ok(!/max-height: 96px/.test(css) && /\.moment-input \{[^}]*overflow: hidden/.test(css),
    '★ 输入框没有滚动条箭头（写满了自然折行、框跟着长高）');
  ok(/\.mc-text \{[^}]*white-space: pre-wrap/.test(css), '★ 评论显示保留换行（pre-wrap）');
  ok(MOMENTS.commentMaxChars >= 120, `★ 评论长度上限放宽到 ${MOMENTS.commentMaxChars} 字（不再按私聊短句截断）`);
  ok(!/maxReplyCharsOf/.test(read('../src/ai/moments.js')), '★ 评论不再套用私聊那套长度上限');
  ok(/moment-input \{[^}]*resize: none/.test(css), '输入框随内容长高（不能手动拉、也没有滚动条）');
  ok(/data-reply=/.test(momentsUi), '★ AI 的评论可以"回复"');
  ok(/#moment-new/.test(momentsUi) && /addMoment\(app\.save, text\)/.test(momentsUi), '右上角「+ 发布」能发说说');
  ok(!/gc-hint/.test(momentsUi), '发布浮层里没有多余的说明文字（用户要求去掉）');
  ok(/\.gc-hint \{/.test(css), '（.gc-hint 样式留着：建群那边还在用）');

  // app 侧编排
  ok(/async scheduleMomentCommenters\(momentId, text\)/.test(app), 'app 里有"发完说说去排期"的方法');
  ok(/chooseCommenters\(\{ text, friends, playerName: this\.playerName \}\)/.test(app), '★ 用审查 AI 挑人（失败走本地兜底）');
  ok(/async replyToMomentComment\(/.test(app), 'app 里有"回复某条评论"的实现（界面只负责发出去）');
  ok(/commentSchedule\(picks\.length\)/.test(app), '按节奏表安排每条评论');
  ok(/await sleep\(replyDelayMs\(\)\)/.test(app),
    '★ 玩家回复后先等 1~5s，AI 才回（不是立刻回）');
  ok(/stillMoment[\s\S]{0,120}isFriend\(this\.save, target\.by\)/.test(app),
    '★ 等完之后再确认一次好友 / 说说还在（期间可能被删好友）');
  ok(/async deliverMomentComment\(/.test(app), '有一位好友来评论的实现');
  ok(/isFriend\(this\.save, personaId\)/.test(app), '★ 评论前再确认一次还是好友（删了就跳过）');
  ok(!/momentUnreadTotal\(this\.save\)/.test(app),
    '★ 友圈新评论**不计入**底部「社交」的红圈数字（只在面板里亮友圈标签的小红点）');
  ok(/el\.querySelector\('#moment-dot'\)\.hidden = momentUnreadTotal\(app\.save\) === 0/.test(friendsUi),
    '★ 小红点挂在「友圈」标签上，点开社交就能看到');
  ok(/wait - \(600 \+ Math\.random\(\) \* 1400\)/.test(app), '点赞比评论早一点点');

  ok(/moments: \[\]/.test(storage), '存档默认有 moments');
  ok(/if \(!Array\.isArray\(s\.moments\)\) s\.moments = \[\]/.test(storage), '老存档缺字段会补齐');
  ok(/ensureMoments\(this\.save\)/.test(app), '启动时整理一次友圈数据');
  ok(/styles\/moments\.css/.test(idx), '友圈样式被引入了');
}

/* ===================================================================== */
console.log('-- ★ 离线超过 20 分钟：好友自己发友圈（带赞 + 共同好友的评论）');
{
  // 1) 数据层：说说能记"谁发的"，老存档补 by，补发时按时间插
  const s = defaultSave();
  const r1 = addMoment(s, '我先发的一条', { at: 5000 });
  ok(r1.ok && r1.moment.by === 'me', '玩家发的说说 by = me');
  const r2 = addMoment(s, '好友补发的一条', { at: 3000, by: 'p01' });
  ok(r2.ok && r2.moment.by === 'p01', '★ 说说可以记成"某个好友发的"（AI 也能发）');
  const ids = listMoments(s).map((m) => m.text);
  ok(ids[0] === '我先发的一条' && ids[1] === '好友补发的一条',
    '★ 补发的说说按时间插到正确位置（最新的仍在前）');
  const legacy = { moments: [{ id: 'm1', at: 1, text: '老数据' }] };
  ensureMoments(legacy);
  ok(legacy.moments[0].by === 'me', '★ 老存档的说说补成 by = me（不会变成"别人发的"）');

  // 2) 点赞幂等（补的那批赞不该把同一个人的赞加两次）
  const m = r2.moment;
  ok(addMomentLike(s, m.id, 'p02').ok && addMomentLike(s, m.id, 'p02').likes.length === 1,
    '★ 补赞是幂等的（同一位好友只算一个赞）');
  ok(addMomentLike(s, m.id, 'p03').likes.length === 2, '不同好友各算一个');

  // 3) 配置与排期：20 分钟门槛 / 1~2 位作者 / ≤10 赞 / 评论只由好友发
  const cfg = read('../src/config.js');
  ok(/export const MOMENT_FEED/.test(cfg) && /minAwayMs: 20 \* 60 \* 1000/.test(cfg),
    '★ 离线超过 20 分钟才触发');
  ok(/maxLikes: 10/.test(cfg), '★ 点赞最多 10 个');
  ok(/maxAuthors: 2/.test(cfg) && /maxPostsEach: 2/.test(cfg), '随机 1~2 位好友、各 1~2 条');

  const appSrc = read('../src/ui/app.js');
  ok(/scheduleReturnMoments\(awayMs\)/.test(appSrc) && /this\.scheduleReturnMoments\(awayMs\)/.test(appSrc),
    '★ 回归时排期（和"离线打招呼"并列）');
  ok(/async deliverFriendMoment\(persona, personaId, \{ leftAt, backAt \}\)/.test(appSrc),
    '有一位好友真的发一条的实现');
  const fn = (appSrc.match(/async deliverFriendMoment[\s\S]*?\n  \}/) || [''])[0];
  /** 去掉注释再断言：不然"解释旧 bug 的那句注释"本身会被当成代码命中 */
  const stripComments = (s) => String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const fnCode = stripComments(fn);
  ok(/listFriends\(this\.save\)\.filter\(\(f\) => f\.personaId !== personaId\)/.test(fn),
    '★ 点赞与评论的人都从**玩家的好友**里挑（不会出现非好友）');
  ok(/MOMENT_FEED\.maxLikes/.test(fn) && /addMomentLike\(this\.save, momentId/.test(fn), '★ 随机点赞、最多 10 个');
  /**
   * ★ 用户报的 bug 的回归断言：
   *   离线补的那批评论原来直接调 `localMomentComment(p, text)`（纯本地语料、压根不问模型），
   *   所以全是"原来如此""你这话我爱听"这种兜底话，和说说内容毫无关系。
   *   现在必须走**在线同一条出口** deliverMomentComment（真让模型写），并且带上模拟时刻。
   */
  ok(/deliverMomentComment\(momentId, f\.personaId, \{[\s\S]{0,160}?aiMoment: true[\s\S]{0,120}?at:/.test(fnCode),
    '★ 离线补的评论也走 deliverMomentComment（真问模型），不是本地语料');
  ok(!/localMomentComment\(/.test(fnCode),
    '★ 离线补评论**不许**再调 localMomentComment（旧 bug：全是"原来如此"这类兜底话）');
  ok(/async deliverMomentComment\(momentId, personaId, \{[\s\S]{0,200}?at = 0/.test(appSrc),
    '★ deliverMomentComment 收得下 at（离线补发要把评论时间落回离线窗口）');
  ok(/addMomentComment\(this\.save, momentId, \{ by: personaId, text: line, at: stamp \}\)/.test(appSrc),
    '★ 评论按 at 落库，不是"现在"');
  ok(/if \(onMoments && !backfilled\) toast\(/.test(appSrc),
    '★ 离线补的那批不弹"评论了你的说说"的金框（回来弹一串很吵）');
  ok(/simulatedSendAt\(persona, leftAt, backAt\)/.test(fn),
    '★ 说说时间落在"玩家不在线"的那段时间里（按人设作息模拟）');

  // 3.5) 离线补的评论**兜底也不能是通用私聊语料**（模型不可用时用 aiPost 专用那套）
  const momentsSrc = read('../src/ai/moments.js');
  ok(/opts\.aiPost\s*\n?\s*\?\s*localAiMomentComment\(persona\)/.test(momentsSrc),
    '★ 模型不可用时，评论好友的说说走 localAiMomentComment（不是"原来如此"那套私聊台词）');
  ok(/LOCAL_AI_POST_COMMENTS/.test(momentsSrc), '★ aiPost 专用兜底语料在，按人设风格分池');

  // 4) 面板要认得出是"别人的说说"：名字/头像用它自己的，且不给别人删
  const ui = read('../src/ui/moments.js');
  ok(/const mine = !m\.by \|\| m\.by === 'me'/.test(ui), '★ 面板区分"我发的"与"好友发的"');
  ok(/const authorAvatar = mine \? myAvatar : ASSETS\.avatar/.test(ui)
    && /const authorName = mine \? app\.playerName/.test(ui),
    '★ 好友发的说说显示它自己的名字与头像');
  ok(/title="\$\{mine \? '删除这条说说' : '别人发的说说不能删'\}"/.test(ui)
    && /\$\{mine \? '' : ' hidden'\}/.test(ui),
    '★ 别人发的说说没有删除按钮');

  // 5) 生成器：能生成说说，而且禁止 @ 玩家 / 提问
  ok(typeof buildMomentPostMessages === 'function' && typeof localMomentPost === 'function',
    '有"AI 发说说"的提示词与本地兜底');
  const msgs = buildMomentPostMessages({ persona: PERSONAS[0], friend: { affinity: 50 }, myBeans: 1000, myTitle: '小富' });
  const sys = msgs.map((x) => x.content).join('\n');
  ok(/发一条\*\*友圈说说\*\*/.test(sys), '提示词写明是发说说（不是聊天）');
  ok(/不要 @ 玩家、不要提问/.test(sys), '★ 明确不许 @ 玩家 / 不许提问');
  ok(/你自己的身家/.test(sys), '★ 顺带注入它自己的身家与称号（实时现算）');
  ok(localMomentPost(PERSONAS[0]).length > 0, '本地兜底也能产出一条说说');
}

console.log('-- ★ 在线定时：好友 > 2 人时每 10~30 分钟随机一位发友圈（三类话题）');
{
  // 1) 参数都在 config 里，而且是用户拍板的那些数
  ok(ONLINE_MOMENT.minGapMs === 10 * 60 * 1000 && ONLINE_MOMENT.maxGapMs === 30 * 60 * 1000,
    `★ 间隔 10~30 分钟（实际 ${ONLINE_MOMENT.minGapMs}~${ONLINE_MOMENT.maxGapMs}）`);
  ok(ONLINE_MOMENT.minFriends === 2, '★ 好友数 > 2（≥3）才触发');
  ok(ONLINE_MOMENT.maxLikes === 10, '★ 点赞最多 10 个（和离线那套一个口径）');
  ok(ONLINE_MOMENT.maxComments === 3, '每条说说 1~3 条评论');
  ok(ONLINE_MOMENT.commentMinMs === 1000 && ONLINE_MOMENT.commentMaxMs === 3000,
    `★ 评论之间只错开 1~3 秒真实时间（实际 ${ONLINE_MOMENT.commentMinMs}~${ONLINE_MOMENT.commentMaxMs}）`);
  ok(ONLINE_MOMENT.minFreeSlots > 0 && ONLINE_MOMENT.minFreeSlots < MOMENTS.maxPosts,
    '★ 有"说说快满了就跳过"的保护（别把玩家自己的说说挤出 30 条上限）');
  ok(ONLINE_MOMENT.firstMinMs > 0 && ONLINE_MOMENT.firstMaxMs <= ONLINE_MOMENT.maxGapMs,
    '进游戏后第一次不用等满 10 分钟');
  const kinds = ONLINE_MOMENT.kinds.join(',');
  ok(kinds === 'game,life,mood', `★ 三类话题：吐槽游戏 / 吐槽生活 / 分享心情（实际 ${kinds}）`);

  // 2) 三类话题的提示词：都要明确写清是发说说 + 不许暴露"我是 AI"
  for (const scene of ['game', 'life', 'mood']) {
    const sys = buildMomentPostMessages({ persona: PERSONAS[0], friend: { affinity: 50 }, scene })
      .map((m) => m.content).join('\n');
    ok(/友圈/.test(sys) && /发一条友圈说说/.test(sys), `${scene}：提示词写明是发友圈说说`);
    ok(/AI \/ 机器 \/ 程序 \/ 模型/.test(sys), `★ ${scene}：绝不许暴露"我是 AI"`);
  }
  const gameSys = buildMomentPostMessages({ persona: PERSONAS[0], friend: { affinity: 50 }, scene: 'game' })
    .map((m) => m.content).join('\n');
  ok(/吐槽今天打牌/.test(gameSys), '★ game：吐槽牌桌（运气 / 队友 / 自己刚打完的一局）');
  const lifeSys = buildMomentPostMessages({ persona: PERSONAS[0], friend: { affinity: 50 }, scene: 'life' })
    .map((m) => m.content).join('\n');
  ok(/吐槽一下生活/.test(lifeSys), '★ life：吐槽生活');
  const moodSys = buildMomentPostMessages({ persona: PERSONAS[0], friend: { affinity: 50 }, scene: 'mood' })
    .map((m) => m.content).join('\n');
  ok(/分享此刻的心情/.test(moodSys), '★ mood：分享心情');

  // 3) 本地兜底三类都要有词，而且不暴露身份
  for (const scene of ['game', 'life', 'mood']) {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(localMomentPost(PERSONAS[i % 8], Math.random, scene));
    ok(seen.size >= 3, `★ ${scene}：本地兜底能产出多条不同的说说（${seen.size} 条）`);
    const bad = [...seen].filter((t) => /我是\s*(AI|ai|机器人|模型|程序)|作为\s*(AI|ai)|人工智能/.test(t));
    ok(bad.length === 0, `★ ${scene}：本地兜底不暴露"我是 AI"${bad.length ? `：${bad[0]}` : ''}`);
  }
  // 不给 scene 时还是原来那套（离线补发那条路一个字没变）
  ok(typeof localMomentPost(PERSONAS[0]) === 'string' && localMomentPost(PERSONAS[0]).length > 0,
    '不指定话题时仍走原来的日常语料（离线补发不受影响）');
  // 随机挑话题：只会从三类里挑
  for (let i = 0; i < 50; i += 1) {
    const s = pickMomentScene(ONLINE_MOMENT.kinds);
    ok(['game', 'life', 'mood'].includes(s), `pickMomentScene 只挑三类（挑到 ${s}）`);
  }
  ok(pickMomentScene([]) === 'life', '话题池为空时有兜底，不会返回 undefined');
}

console.log('-- ★ 表白成功：恋人自己发一条友圈 + 其他好友来点赞评论（真跑一遍）');
{
  // DOM 桩 + 假定时器（和 test-app-smoke 一个套路；只为了把 app 的方法真跑起来）
  const bag = {
    hidden: false,
    isConnected: true,
    value: '',
    textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  const stub = (name) => {
    const f = function () { return stub(name); };
    /**
     * ★ 袋子里的东西**最优先**：这个桩默认会给任何属性造一个新桩，
     *   所以"我们显式赋值过的东西"（document.hidden / querySelector …）必须排在默认值前面，
     *   否则永远读回一个函数，`canOnlineMoment()` 之类的判断就全错了。
     */
    const dflt = {
      querySelectorAll: () => [],
      querySelector: () => stub('child'),
      addEventListener: () => {},
      removeEventListener: () => {},
      focus: () => {},
      select: () => {},
      click: () => {},
      remove: () => {},
    };
    return new Proxy(f, {
      get(t, k) {
        if (k === 'toString') return () => `<${name}>`;
        if (k === 'then') return undefined;
        if (k in bag) return bag[k];
        if (k in dflt) return dflt[k];
        bag[k] = stub(`${name}.${String(k)}`);
        return bag[k];
      },
      set(t, k, v) { bag[k] = v; return true; },
      apply() { return stub(name); },
    });
  };
  let screenId = 'screen-lobby';
  const domStub = stub('document');
  globalThis.document = domStub;
  /**
   * 这个万能桩的 `get` 会**先看自己那个袋子**，所以想让它返回我们自己写的东西，
   * 必须用普通赋值（`document.x = fn` → 落进袋子）。
   *   · `.screen.is-active` 每次现取，`id` 跟着 `screenId` 走 —— 用来模拟"在大厅 / 在牌桌"
   *   · `#panel-layer` 不带 is-open → 面板没开着
   */
  domStub.hidden = false;
  domStub.getElementById = (id) => (id === 'panel-layer'
    ? { classList: { contains: () => false } }
    : stub(`#${id}`));
  domStub.querySelector = (sel) => (sel === '.screen.is-active' ? { id: screenId } : stub('q'));
  domStub.querySelectorAll = () => [];
  domStub.addEventListener = () => {};
  globalThis.window = stub('window');
  globalThis.window.addEventListener = () => {};
  globalThis.localStorage = {
    _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
  };
  const realSetTimeout = globalThis.setTimeout;
  const realFetch = globalThis.fetch;
  const timers = [];
  globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };
  // 模型这条路必须掐掉（config 里有真 Key），掐掉就走本地兜底 —— 正是要测的那条
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });

  try {
    const { app } = await import('../src/ui/app.js');
    const { Economy } = await import('../src/store/economy.js');

    // ---- 场景①：表白成功 → 恋人自己发一条（真实时间）→ 别的好友来赞 / 评论
    const save = defaultSave();
    save.nickname = '小徐';
    const mates = PERSONAS.slice(0, 4);
    for (const p of mates) addFriend(save, p);
    const loverId = mates[0].id;
    setLover(save, loverId);
    app.save = save;
    app.economy = new Economy(save, () => {});
    app.table = null; app.fishing = null; app.gomoku = null;
    ok(isLover(app.save, loverId), '先把关系设成恋人');

    timers.length = 0;
    let m = null;
    let err = null;
    try {
      m = await app.deliverLoverMoment(loverId);
    } catch (e) { err = e; }
    ok(!err, `★ 表白那条友圈真的发得出来${err ? `：${err.message}` : ''}`);
    ok(!!m && m.by === loverId, '★ 说说落在**恋人**名下（by = personaId）');
    if (m) {
      ok(Math.abs(Date.now() - m.at) < 5000, '★ 时间是"当下"（真实时间，不是模拟时刻）');
      ok(m.likes.every((id) => id !== loverId), '★ 恋人不会给自己的说说点赞');
      ok(m.likes.length <= ONLINE_MOMENT.maxLikes, `★ 点赞不超过 10 个（实际 ${m.likes.length}）`);
      const allIds = mates.map((p) => p.id);
      ok(m.likes.every((id) => allIds.includes(id)), '★ 赞只来自玩家的好友');
      ok(timers.length > 0, '★ 排上了"其他好友来点赞 / 评论"的定时器');
      const waits = timers.map((t) => t.ms)
        .filter((x) => x >= ONLINE_MOMENT.commentMinMs && x <= ONLINE_MOMENT.commentMaxMs);
      ok(waits.length >= 1, '★ 至少排了一条"1~3 秒后出评论"的定时器');
      ok(waits.every((x) => x >= ONLINE_MOMENT.commentMinMs && x <= ONLINE_MOMENT.commentMaxMs),
        `★ 评论只错开 1~3 秒（不会隔几十分钟；实际 ${waits.join('/')}）`);
      // 把排上的回调真跑一遍（模型不可用 → 走本地兜底）
      for (const t of timers.splice(0)) {
        try { await t.cb(); } catch (e) { ok(false, `定时器回调抛错：${e && e.message}`); }
      }
      const saved = findMoment(app.save, m.id);
      ok(saved.comments.length >= 1 && saved.comments.length <= ONLINE_MOMENT.maxComments,
        `★ 来了 1~3 条评论（实际 ${saved.comments.length}）`);
      ok(saved.comments.every((c) => c.by !== loverId), '★ **恋人自己不来评论**（用户拍板）');
      ok(saved.comments.every((c) => allIds.includes(c.by)), '★ 评论只由玩家的好友发');
      // 这条友圈也进记忆：评论的那位好友记忆里多了一条「友圈」
      const commenter = saved.comments[0] && saved.comments[0].by;
      if (commenter) {
        ok(listMomentMemory(findFriend(app.save, commenter)).length >= 1,
          '★ 友圈互动进了那位好友的记忆（沿用现有写法，没新增分类）');
      }
      // 上限：友圈记忆只留最近 2 条 → 定时发也不会把常规记忆挤爆
      for (let i = 0; i < 6; i += 1) addMomentMemory(app.save, commenter, { text: `第${i}条说说`, comment: '顶一个' });
      ok(listMomentMemory(findFriend(app.save, commenter)).length <= 2,
        '★ 同一位好友的友圈记忆只留最近 2 条（额外记忆，不占常规 16 条）');
    }
    // 分手 / 删好友之后再来一次：不许崩，也不许发
    app.save.loverId = '';
    let after = null;
    try { after = await app.deliverLoverMoment(loverId); } catch (e) { ok(false, `不是恋人时抛错：${e && e.message}`); }
    ok(after === null, '★ 已经不是恋人了 → 不再发（也不抛错）');

    // ---- 场景②：在线定时发一条
    const save2 = defaultSave();
    save2.nickname = '小徐';
    for (const p of mates) addFriend(save2, p);
    app.save = save2;
    app.economy = new Economy(save2, () => {});

    // 好友只有 2 位 → 不发
    const save3 = defaultSave();
    save3.nickname = '小徐';
    for (const p of mates.slice(0, 2)) addFriend(save3, p);
    const app2 = app;
    const keep = app.save;
    app.save = save3;
    let two = null;
    try { two = await app.maybeOnlineMoment(); } catch (e) { ok(false, `好友 2 位时抛错：${e && e.message}`); }
    ok(two === null, '★ 好友只有 2 位（没"多于 2 人"）→ 不发');
    app.save = keep;

    timers.length = 0;
    let posted = null;
    try {
      posted = await app.maybeOnlineMoment();
    } catch (e) { ok(false, `maybeOnlineMoment 抛错：${e && e.message}`); }
    ok(!!posted, '★ 好友 > 2 人 → 真的发了一条');
    if (posted) {
      const ids = mates.map((p) => p.id);
      ok(ids.includes(posted.by), '★ 作者是玩家的好友之一');
      ok(Math.abs(Date.now() - posted.at) < 5000, '这条也是"当下"发的（真实时间）');
      ok(posted.likes.length <= ONLINE_MOMENT.maxLikes, '★ 随机点赞 ≤ 10');
      ok(posted.likes.every((id) => id !== posted.by), '作者不给自己点赞');
      for (const t of timers.splice(0)) {
        try { await t.cb(); } catch (e) { ok(false, `定时器回调抛错：${e && e.message}`); }
      }
      const saved = findMoment(app.save, posted.id);
      ok(saved.comments.length >= 1 && saved.comments.length <= ONLINE_MOMENT.maxComments,
        `★ 1~3 条共同好友评论（实际 ${saved.comments.length}）`);
      ok(saved.comments.every((c) => c.by !== posted.by), '★ 作者不评自己的说说');
      ok(saved.comments.every((c) => ids.includes(c.by)), '★ 评论只由玩家的好友发（不会出现非好友）');
    }

    // ---- 上限保护：快满时跳过，绝不把玩家自己的说说挤掉
    const before = listMoments(app.save).length;
    for (let i = listMoments(app.save).length; i < MOMENTS.maxPosts - ONLINE_MOMENT.minFreeSlots + 1; i += 1) {
      addMoment(app.save, `玩家自己的说说 ${i}`);
    }
    const mineBefore = listMoments(app.save).filter((x) => x.by === 'me').length;
    const near = await app.maybeOnlineMoment();
    ok(near === null, '★ 说说快满（剩 minFreeSlots 条以内）→ 跳过不发');
    const mineAfter = listMoments(app.save).filter((x) => x.by === 'me').length;
    ok(mineAfter === mineBefore, '★ 玩家自己的说说一条没被挤掉');
    ok(listMoments(app.save).length >= before, '说说总数没有被这次操作减少');

    // ---- 定时器：排期 / 切后台停 / 回大厅再来 / 会话说停就停
    screenId = 'screen-lobby'; // 上一步可能停在别的界面
    const save4 = defaultSave();
    save4.nickname = '小徐';
    for (const p of mates) addFriend(save4, p);
    app.save = save4;
    app.economy = new Economy(save4, () => {});
    app.onlineMomentOn = false;
    app.onlineMomentTimer = null;
    app.onlineMomentPaused = false;
    app.onlineMomentSkips = 0;
    timers.length = 0;
    globalThis.document.hidden = false; // 上面那些用例跑过之后可能被置成后台了，这里显式摆正
    app.startOnlineMoments();
    ok(app.onlineMomentOn === true, '★ 起得来（会话开着）');
    ok(timers.length === 1, '只排了一个定时器（不会堆）');
    const first = timers[0];
    ok(first && first.ms >= ONLINE_MOMENT.firstMinMs && first.ms <= ONLINE_MOMENT.firstMaxMs,
      `★ 第一次排在 2~5 分钟内（实际 ${first && first.ms}）`);
    // 到点了：真发一条，并接着排下一次
    const n0 = listMoments(app.save).length;
    first.cb();
    await new Promise((r) => realSetTimeout(r, 60));
    ok(listMoments(app.save).length === n0 + 1, `★ 到点真的发了一条（${n0} → ${listMoments(app.save).length}）`);
    for (const t of timers.splice(0)) { try { await t.cb(); } catch { /* 评论那条是异步的 */ } }
    ok(timers.length >= 1, '★ 发完接着排下一次');
    const next = timers.filter((t) => t.ms >= ONLINE_MOMENT.minGapMs && t.ms <= ONLINE_MOMENT.maxGapMs).pop();
    ok(next && next.ms >= ONLINE_MOMENT.minGapMs && next.ms <= ONLINE_MOMENT.maxGapMs,
      `★ 下一次排在 10~30 分钟（实际 ${next ? next.ms : '没排上'}）`);

    // 页面隐藏 → 停；而且停着的时候不许再发
    app.pauseOnlineMoments();
    ok(app.onlineMomentOn === false && app.onlineMomentTimer === null, '★ 切到后台 → 定时器清掉、不再续排');
    timers.length = 0;
    await app.onlineMomentRound();
    ok(timers.length === 0, '★ 停着的时候 onlineMomentRound 不会再排（也不会发）');

    // 回到前台 → 重新排
    app.resumeOnlineMoments();
    ok(app.onlineMomentOn === true && timers.length === 1, '★ 回到前台 → 重新排一次');

    // 进牌桌 → 停
    screenId = 'screen-table';
    app.showScreen('screen-table');
    ok(app.onlineMomentOn === false, '★ 进牌桌（不在大厅）→ 停');
    timers.length = 0;
    await app.onlineMomentRound();
    ok(timers.length === 0, '打牌的时候不会再堆说说');

    // 回大厅 → 重新起
    screenId = 'screen-lobby';
    app.showScreen('screen-lobby');
    ok(app.onlineMomentOn === true, '★ 回到大厅 → 重新起');
    // 退出登录界面（会话结束）→ 彻底停
    app.stopOnlineMoments();
    ok(app.onlineMomentOn === false && app.onlineMomentTimer === null, '★ 会话结束 → 定时器收掉');
    timers.length = 0;
    await app.onlineMomentRound();
    // 注意：只数"在线发友圈"那种 10~30 分钟的排期 —— 别的模块（AI 调用重试 8s 等）
    // 也会排自己的定时器，混在一起数会误判
    const momentTimers = () => timers.filter((t) => t.ms >= ONLINE_MOMENT.minGapMs && t.ms <= ONLINE_MOMENT.maxGapMs);
    ok(momentTimers().length === 0, '★ 收掉之后不会再排（和挂机群聊的 alive 一个口径）');

    // ---- 崩溃兜底：没有好友 / 好友被删 / 说说被清
    const empty = defaultSave();
    empty.nickname = '小徐';
    app.save = empty;
    app.economy = new Economy(empty, () => {});
    let none = null;
    try { none = await app.maybeOnlineMoment(); } catch (e) { ok(false, `一个好友都没有时抛错：${e && e.message}`); }
    ok(none === null, '★ 一个好友都没有 → 什么都不发，也不崩');

    const gone = defaultSave();
    gone.nickname = '小徐';
    for (const p of mates) addFriend(gone, p);
    app.save = gone;
    addMoment(gone, '待会儿就把它删了', { by: mates[0].id });
    const target = listMoments(gone)[0];
    removeFriend(gone, mates[0].id);
    let noErr = null;
    try { app.afterFriendMoment(target.id, mates[0].id, {}); } catch (e) { noErr = e; }
    ok(!noErr, `★ 作者被删好友之后补赞 / 补评论不抛错${noErr ? `：${noErr.message}` : ''}`);
    removeMoment(gone, target.id);
    let after2 = null;
    try { after2 = app.afterFriendMoment(target.id, mates[0].id, {}); } catch (e) { after2 = 'throw'; }
    ok(after2 && after2.likes === 0 && after2.commenters === 0, '★ 说说被删了 → 什么都不做（返回空结果）');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.fetch = realFetch;
  }
}

console.log('-- ★ 静态契约：app.js 里的接线（两个新场景）');
{
  const appSrc = read('../src/ui/app.js');
  // 场景①：表白成功那一刻（settleFriendChat 的 verdict.accept 分支）
  ok(/setLover\(this\.save, personaId\);[\s\S]{0,600}?void this\.deliverLoverMoment\(personaId\)/.test(appSrc),
    '★ 表白成功、setLover 之后紧接着让恋人自己发一条（不 await，不挡聊天）');
  ok(/async deliverLoverMoment\(personaId/.test(appSrc), '有 deliverLoverMoment 实现');
  const loverFn = (appSrc.match(/async deliverLoverMoment\([\s\S]*?\n  \}/) || [''])[0];
  ok(/scene: 'confession'/.test(loverFn), "★ 用 confession 场景（含蓄、不指名道姓的那套提示词）");
  ok(/isLover\(this\.save, personaId\)/.test(loverFn), '不是恋人 / 已分手就什么都不做');
  // 场景②：在线定时器
  ok(/startOnlineMoments\(\)/.test(appSrc) && /this\.startOnlineMoments\(\)/.test(appSrc),
    '★ 启动时会起在线发友圈的定时器');
  ok(/async maybeOnlineMoment\(\)/.test(appSrc), '有"到点了随机让一位好友发"的实现');
  const maybeFn = (appSrc.match(/async maybeOnlineMoment\([\s\S]*?\n  \}/) || [''])[0];
  ok(/friends\.length <= ONLINE_MOMENT\.minFriends/.test(maybeFn), '★ 好友数必须 **多于** 2 人');
  ok(/MOMENTS\.maxPosts - all\.length/.test(maybeFn) && /ONLINE_MOMENT\.minFreeSlots/.test(maybeFn),
    '★ 说说快满就跳过（别把玩家的说说挤出上限）');
  ok(/pickMomentScene\(ONLINE_MOMENT\.kinds\)/.test(maybeFn), '★ 三类话题随机挑一类');
  const postFn = (appSrc.match(/afterFriendMoment\(momentId, authorId[\s\S]*?\n  \}/) || [''])[0];
  ok(/listFriends\(this\.save\)\.filter\(\(f\) => !skip\.has\(f\.personaId\)\)/.test(postFn),
    '★ 赞与评论都只从**玩家的好友**里挑');
  ok(/ONLINE_MOMENT\.maxLikes/.test(postFn), '★ 随机点赞 ≤ 10');
  ok(/ONLINE_MOMENT\.commentMinMs[\s\S]{0,200}ONLINE_MOMENT\.commentMaxMs/.test(postFn),
    '★ 评论之间错开 1~3 秒真实时间');
  ok(/deliverMomentComment\(momentId, f\.personaId/.test(postFn),
    '★ 评论走已有的写入器 → 顺带写友圈记忆（没新增分类）');
  ok(/async scheduleMomentCommenters\(momentId, text\)/.test(appSrc),
    '原有签名没变，离线那条路不受影响');
  ok(/stopOnlineMoments\(\{ resume: true \}\)/.test(appSrc), '★ 进牌桌 / 退出登录界面会把定时器收掉');
  ok(/pauseOnlineMoments\(\)/.test(appSrc) && /visibilitychange/.test(appSrc),
    '★ 切后台（visibilitychange / pagehide）会拦住它');
  ok(!/momentUnreadTotal\(this\.save\)/.test(appSrc),
    '★ 好友自己发的说说也**不算**底部数字红点（口径没变）');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '友圈检查通过'}`);
process.exit(fail ? 1 : 0);
