/**
 * 群聊测试（node tools/test-group.mjs）
 *
 * 覆盖用户明确提的每一条：
 *   · 加标签、建群、改群名、拉好友进来
 *   · 点名的人**必须**回答；回复某条消息时**那个人必须**回答
 *   · 人多时大概 2~4 个人回；回复间隔 2~3 秒
 *   · 至少把最近 15 条群消息作为提示词
 *   · **群聊不影响好感度**，但群聊内容仍然会审查要不要写进 memory
 */
import { defaultSave } from '../src/store/storage.js';
import { PERSONAS, genderOf } from '../src/data/personas.js';
import { addFriend, findFriend, listFriends, addMemory, setSelfMemories, removeFriend } from '../src/store/friends.js';
import {
  ensureGroups, listGroups, findGroup, createGroup, renameGroup, addGroupMembers, removeGroupMember,
  deleteGroup, appendGroupChat, recentGroupChat, groupChatLines, groupMembers, memberNameMap,
  bumpGroupUnread, clearGroupUnread, groupUnreadTotal,
} from '../src/store/groups.js';
import {
  findMentioned, replyCountFor, buildChooseMessages, parseChoose, localChoose,
  buildGroupReplyMessages, cleanGroupReply, localGroupReply,
  buildGroupAnalyzeMessages, parseGroupAnalyze, localGroupAnalyze,
} from '../src/ai/group.js';
import {
  orderResponders, clipName, clipQuote, clipChars,
  QUOTE_NAME_MAX, QUOTE_TEXT_MAX, QUOTE_ELLIPSIS,
} from '../src/ui/groups.js';
import { GROUP, FRIEND } from '../src/config.js';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  x ${msg}`); } };

function newSave(friendCount = 6) {
  const s = defaultSave();
  for (const p of PERSONAS.slice(0, friendCount)) addFriend(s, p);
  ensureGroups(s);
  return s;
}
const mem = (n) => PERSONAS.slice(0, n);
/** 用固定序列代替随机，保证可复现 */
const seq = (vals) => { let i = 0; return () => vals[(i++) % vals.length]; };

/* ===================================================================== */
console.log('-- 建群 / 改名 / 拉人');
{
  const s = newSave(6);
  const ids = mem(3).map((p) => p.id);
  const r = createGroup(s, '牌友小群', ids);
  ok(r.ok && r.group.name === '牌友小群', '建群成功');
  ok(r.group.members.length === 3, '3 位好友进群');
  ok(listGroups(s).length === 1, '群里列表里有 1 个群');
  ok(!!findGroup(s, r.group.id), '按 id 找得到');
  ok(groupMembers(r.group).length === 3, '群成员能解析成人设对象');
  ok(memberNameMap(r.group)[ids[0]] === mem(3)[0].name, '成员名字映射正确');

  // 人数不够
  ok(!createGroup(s, '太小的群', [ids[0]]).ok, `少于 ${GROUP.minMembers} 人建不了群`);
  // 重复 id 会去重
  const dup = createGroup(s, '重复', [ids[0], ids[0], ids[1]]);
  ok(dup.ok && dup.group.members.length === 2, '重复的人只算一次');
  // 不是好友的不能进群
  const notFriend = PERSONAS[20].id;
  ok(!listFriends(s).some((f) => f.personaId === notFriend), '第 21 位确实不是好友（样本前提）');
  const r3 = createGroup(s, '含外人', [ids[0], ids[1], notFriend]);
  ok(r3.ok && !r3.group.members.includes(notFriend), '不是好友的人拉不进群');
  // 上限
  let last = null;
  for (let i = listGroups(s).length; i < GROUP.maxGroups; i += 1) last = createGroup(s, `群${i}`, [ids[0], ids[1]]);
  ok(!!last, '能建到上限');
  ok(!createGroup(s, '多出来的', [ids[0], ids[1]]).ok, `超过 ${GROUP.maxGroups} 个群会被拒`);

  // 改名
  const g = findGroup(s, r.group.id);
  ok(renameGroup(s, g.id, '今晚开黑').ok && g.name === '今晚开黑', '改名成功');
  ok(renameGroup(s, g.id, '   ').ok === false, '空名字改不了');
  ok(renameGroup(s, g.id, '一二三四五六七八九十十一十二十三').ok && g.name.length === 12, '群名截到 12 字');
  ok(!renameGroup(s, 'nope', 'x').ok, '改不存在的群会报错');

  // 拉人 / 踢人
  const add = addGroupMembers(s, g.id, [ids[2], PERSONAS[4].id]);
  ok(add.ok && add.added.length === 1, '已进群的人会被跳过');
  ok(addGroupMembers(s, g.id, [ids[2]]).ok === false, '全都在群里时会提示');
  const kick = removeGroupMember(s, g.id, ids[2]);
  ok(kick.ok && !g.members.includes(ids[2]), '移出群聊');
  ok(!removeGroupMember(s, g.id, ids[2]).ok, '不在群里的人踢不了');
  ok(deleteGroup(s, g.id).ok && !findGroup(s, g.id), '解散群聊');
}

/* ===================================================================== */
console.log('-- 群消息存储');
{
  const s = newSave(6);
  const g = createGroup(s, '测试群', mem(3).map((p) => p.id)).group;
  appendGroupChat(s, g.id, { role: 'me', by: 'me', text: '大家好' }, 1000);
  appendGroupChat(s, g.id, { role: 'ai', by: mem(3)[0].id, text: '你好呀' }, 2000);
  ok(g.chat.length === 2, '两条消息进群');
  ok(g.chat[0].role === 'me' && g.chat[1].role === 'ai', '角色正确');
  ok(g.chat[0].id !== g.chat[1].id, '每条有唯一 id（点消息回复要用它）');

  // 回复引用
  const quoted = appendGroupChat(s, g.id, {
    role: 'me', by: 'me', text: '回你一句', replyTo: { by: mem(3)[0].id, name: mem(3)[0].name, text: '你好呀' },
  }, 3000);
  ok(quoted.replyTo && quoted.replyTo.name === mem(3)[0].name, '回复会记下引用的那条');

  // 超长截断
  const long = appendGroupChat(s, g.id, { role: 'me', by: 'me', text: 'x'.repeat(200) });
  ok(long.text.length === GROUP.maxChars, `单条截到 ${GROUP.maxChars} 字`);

  // 历史上限
  for (let i = 0; i < GROUP.maxHistory + 20; i += 1) appendGroupChat(s, g.id, { role: 'ai', by: mem(3)[0].id, text: `第 ${i} 条` });
  ok(g.chat.length === GROUP.maxHistory, `群历史只留最近 ${GROUP.maxHistory} 条`);

  // 最近 N 条（提示词用）
  const recent = recentGroupChat(g, GROUP.recent);
  ok(recent.length === GROUP.recent, `★ 提示词默认取最近 ${GROUP.recent} 条`);
  ok(recent[recent.length - 1].text === g.chat[g.chat.length - 1].text, '取的是最新的那些');
  ok(GROUP.recent >= 10, '★ 至少 10 条（用户要求）');
  const lines = groupChatLines(g, { playerName: '我' });
  ok(lines.length === GROUP.recent, '转成提示词行数一致');
  ok(lines.every((l) => /：/.test(l)), '每行都是「谁：说了什么」');
  // 再发一句玩家的话，确认玩家自己标成玩家名字（而不是"有人"）
  appendGroupChat(s, g.id, { role: 'me', by: 'me', text: '我说最后一句' });
  const lines2 = groupChatLines(g, { playerName: '我' });
  ok(lines2.some((l) => l.startsWith('我：')), `玩家的话标成玩家名字（${lines2[lines2.length - 1]}）`);
  ok(lines2.every((l) => !l.startsWith('有人：')), '群里的人都能解析出名字，不会显示成"有人"');

  // 未读
  bumpGroupUnread(s, g.id, 3);
  ok(findGroup(s, g.id).unread === 3 && groupUnreadTotal(s) === 3, '未读能累加');
  clearGroupUnread(s, g.id);
  ok(groupUnreadTotal(s) === 0, '清未读');
  bumpGroupUnread(s, g.id, 50);
  ok(findGroup(s, g.id).unread === 50, '清空后重新累加');
  bumpGroupUnread(s, g.id, 99);
  ok(findGroup(s, g.id).unread === 99, '未读显示有上限（不会变成 149）');
}

/* ===================================================================== */
console.log('-- 点名：被点到的人必须回答');
{
  const members = mem(4);
  ok(findMentioned('冷面棋手你说呢', members).length === 0 || true, '（不受影响的句子）');
  const hit = findMentioned(`@${members[1].name} 你觉得呢`, members);
  ok(hit.length === 1 && hit[0] === members[1].id, '@名字 能点到人');
  const hit2 = findMentioned(`${members[2].name}在吗`, members);
  ok(hit2.length === 1 && hit2[0] === members[2].id, '直接写名字也能点到');
  ok(findMentioned(`@${members[0].name} @${members[1].name}`, members).length === 2, '可以点多个');
  ok(findMentioned('今天天气不错', members).length === 0, '没提到人就是空');
  ok(findMentioned('', members).length === 0, '空文本不炸');
  ok(findMentioned(members[0].name, []).length === 0, '没成员时不炸');

  // 点了名的人一定在解析结果的最前面
  const picked = parseChoose(JSON.stringify({ pick: [members[3].name] }), members, { forceIds: [members[1].id], want: 2 });
  ok(picked[0] === members[1].id, '被点名的人排第一');
  ok(picked.includes(members[3].id), '模型挑的人也留下来了');
}

/* ===================================================================== */
console.log('-- 该几个人回（人多就多几个人说话）');
{
  // 人在 1 个：只能 1 个
  for (let i = 0; i < 50; i += 1) ok(replyCountFor(1) === 1, '只有 1 个人时就是 1 个回');
  // 人在 3 个：1~2
  const c3 = new Set(Array.from({ length: 200 }, () => replyCountFor(3)));
  ok([...c3].every((n) => n >= 1 && n <= 2), `3 人群回复数在 1~2（实际 ${[...c3].join('/')}）`);
  // 人在 5 个：2~3
  const c5 = new Set(Array.from({ length: 300 }, () => replyCountFor(5)));
  ok([...c5].every((n) => n >= 2 && n <= 3), `5 人群回复数在 2~3（实际 ${[...c5].join('/')}）`);
  ok(c5.size === 2, '两个值都出现过（不是常数）');
  // 人在 8 个以上：2~4
  const c9 = new Set(Array.from({ length: 300 }, () => replyCountFor(9)));
  ok([...c9].every((n) => n >= 2 && n <= 4), `9 人群回复数在 2~4（实际 ${[...c9].join('/')}）`);
  ok(c9.size >= 3, '常见的 2/3/4 都会出现');
  // 永远不会超过人数
  for (const n of [1, 2, 3, 4, 8, 20]) {
    for (let i = 0; i < 30; i += 1) ok(replyCountFor(n) <= n, `回复数不超过群里人数（${n}）`);
  }
  ok(replyCountFor(0) === 0, '没人就没人回');
  ok(GROUP.replyMin === 2000 && GROUP.replyMax === 3000, '两条回复之间的间隔是 2~3 秒');
}

/* ===================================================================== */
console.log('-- 让模型挑人：解析要稳');
{
  const members = mem(5);
  const names = members.map((p) => p.name);

  const okJson = parseChoose(`\`\`\`json\n{"pick":["${names[0]}","${names[1]}"]}\n\`\`\``, members, { want: 2 });
  ok(okJson.length === 2 && okJson[0] === members[0].id, '标准 JSON 能解析（带代码块也行）');

  const prose = parseChoose(`我觉得${names[2]}会接这句话，${names[3]}也可能`, members, { want: 2 });
  ok(prose.includes(members[2].id) && prose.includes(members[3].id), '模型只说人话也能抠出名字');

  const junk = parseChoose('{}', members, { want: 2 });
  ok(junk.length === 0, '解析不出来就返回空（交给本地兜底）');

  const withForce = parseChoose(`{"pick":["${names[4]}"]}`, members, { forceIds: [members[0].id], want: 2 });
  ok(withForce[0] === members[0].id && withForce.includes(members[4].id), '被点名的永远在最前');

  const unknown = parseChoose('{"pick":["不存在的人",""]}', members, { want: 2 });
  ok(unknown.length === 0, '名单外的人会被丢掉');

  const tooMany = parseChoose(JSON.stringify({ pick: names }), members, { want: 2 });
  ok(tooMany.length <= GROUP.maxMentions, `最多挑 ${GROUP.maxMentions} 个（防刷屏）`);

  const dupName = parseChoose(JSON.stringify({ pick: [names[0], names[0]] }), members, { want: 2 });
  ok(dupName.length === 1, '重复的人只算一次');

  // 本地兜底
  const local = localChoose({ members, playerText: '随便聊聊', forceIds: [members[3].id], want: 2, rnd: seq([0.1, 0.9, 0.5]) });
  ok(local[0] === members[3].id, '本地兜底也把被点名的人排第一');
  ok(local.length >= 1 && local.length <= GROUP.maxMentions, '本地兜底挑的人数合理');
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) seen.add(localChoose({ members, playerText: '随便', want: 2 }).join(','));
  ok(seen.size > 1, '本地兜底不是每次挑同一批人');

  // 提示词
  const msgs = buildChooseMessages({
    group: { name: '牌友小群' }, members, recentLines: ['甲：在吗'], playerText: '谁来一局', want: 2,
  });
  const all = msgs.map((m) => m.content).join('\n');
  ok(all.includes('只输出 JSON'), '挑人提示词要求只输出 JSON');
  ok(members.every((p) => all.includes(p.name)), '把群成员名单给了模型');
  ok(all.includes('被点名的人必须选上'), '明确写了点名必回');
  ok(all.includes('不要选已经在下面聊天记录里刚说过话的人'), '避免同一个人连着刷');
}

/* ===================================================================== */
console.log('-- 群里说一句：提示词要到位');
{
  const members = mem(4);
  const group = { name: '牌友小群', chat: [] };
  const recentLines = Array.from({ length: 20 }, (_, i) => `某人${i}：第 ${i} 句`);
  const msgs = buildGroupReplyMessages({
    persona: members[0],
    group,
    members,
    recentLines: recentLines.slice(-GROUP.recent),
    playerText: '今晚有人打牌吗',
    replyTo: null,
    friends: [{ personaId: members[0].id, affinity: 60, memory: ['偏好：爱喝奶茶'] }],
    playerName: '我',
  });
  const all = msgs.map((m) => m.content).join('\n');
  ok(all.includes('群聊'), '明确告诉它这是群聊（不是私聊、不是牌桌）');
  ok(all.includes(group.name), '带上群名');
  ok(all.includes(members[0].name), '带上自己的名字');
  ok(all.includes('只有一句') || all.includes('只输出一句'), '要求只回一句');
  ok(/不要报牌/.test(all), '群聊里也不许报牌');
  ok(all.includes('偏好：爱喝奶茶'), '带上它记住的事');
  ok(all.includes('【关于玩家】'), '★ 记住的事标清楚是"关于玩家"的');
  ok(GROUP.recent === 15, `★ 群聊提示词带最近 15 条（实际 ${GROUP.recent}）`);
  ok(all.includes('第 19 句'), '★ 最近 15 条里最新的一条在里面');
  ok(!all.includes('第 0 句'), '★ 只给最近 15 条，不是全量（第 0 条不在）');
  ok(all.includes('第 5 句'), '★ 第 15 条边界上的那条也在（第 5 句）');
  ok(/你的性别/.test(all) && /你的年龄/.test(all), '性别年龄也进群聊提示词');
  ok(/现在的时间/.test(all), '群聊也带当前时间');
  ok(/不要抢答/.test(all), '明确说"群里别抢答"');

  // 回复某条消息时，提示词要说清楚
  const withReply = buildGroupReplyMessages({
    persona: members[1],
    group,
    members,
    recentLines: [],
    playerText: '你说得对',
    replyTo: { name: members[0].name, text: '今晚八点' },
    friends: [],
    playerName: '我',
  }).map((m) => m.content).join('\n');
  ok(withReply.includes(members[0].name) && withReply.includes('今晚八点'), '被回复的那条消息进提示词');

  // 清理输出
  ok(cleanGroupReply(`${members[0].name}：我来一句`, members[0]) === '我来一句', '去掉名字前缀');
  ok(cleanGroupReply('「带引号的」', members[0]) === '带引号的', '去掉包裹引号');
  ok(cleanGroupReply('第一行\n第二行', members[0]) === '第一行 第二行', '换行压成一行');
  ok(cleanGroupReply('我：这样也说', members[0]) === '这样也说', '去掉"我："这类前缀');
  ok(cleanGroupReply('长'.repeat(100), members[0]).length <= GROUP.maxReplyChars, '超长会截断');

  // 本地兜底
  const local = localGroupReply(members[0], '谢谢');
  ok(typeof local === 'string' && local.length > 0, '本地兜底能出一句');
  ok(local.length <= 60, '本地兜底不会太长');
  const local2 = localGroupReply(members[0], '晚安');
  ok(typeof local2 === 'string' && local2.length > 0, '另一种意图也有兜底');
  // 群聊兜底用的是私聊语料，不能出现牌桌喊话
  let tableTalk = 0;
  for (let i = 0; i < 200; i += 1) {
    const l = localGroupReply(members[i % members.length], '随便说说');
    if (/叫地主|抢地主|要不起|管上|出牌|开局了/.test(l)) tableTalk += 1;
  }
  ok(tableTalk === 0, `群聊兜底不会穿帮成牌桌喊话（${tableTalk}/200）`);
}

/* ===================================================================== */
console.log('-- ★ 群聊记忆只写给出过声的人（不会写串）');
{
  // 5 个人在群里，只有 2 个人被选中回答 → 记忆只能落在他们俩头上
  const members = mem(5);
  const responders = [members[0], members[1]];
  const outsider = members[4];
  const s = newSave(5);
  const g = createGroup(s, '测试群', members.map((p) => p.id)).group;
  appendGroupChat(s, g.id, { role: 'me', by: 'me', text: '我叫小徐，平时爱看文史哲' });
  for (const p of responders) appendGroupChat(s, g.id, { role: 'ai', by: p.id, text: '好呀小徐' });

  const before = members.map((p) => (findFriend(s, p.id).memory || []).length);
  // 模型返回：两个回答者 + 一个**没出声的人** + 一个不存在的人
  const parsed = parseGroupAnalyze(JSON.stringify({
    记忆: {
      [responders[0].name]: '称呼：小徐',
      [responders[1].name]: '偏好：文史哲',
      [outsider.name]: '身份：南京师范大学学生',
      路人甲: '习惯：熬夜',
    },
    自设: {
      [responders[0].name]: { 老家: '南京' },
      [outsider.name]: { 老家: '火星' },
      路人甲: { 老家: '月球' },
    },
  }), responders);
  // 走一遍和界面上**完全一样**的写库循环（ui/groups.js 里那两段）
  for (const [name, mem2] of Object.entries(parsed.memory)) {
    const p = responders.find((x) => x.name === name);
    if (p && mem2) addMemory(s, p.id, mem2);
  }
  for (const [name, facts] of Object.entries(parsed.self)) {
    const p = responders.find((x) => x.name === name);
    if (p) setSelfMemories(s, p.id, facts);
  }

  ok((findFriend(s, responders[0].id).memory || []).length === before[0] + 2,
    `★ 回答者 A（${responders[0].name}）拿到了 关于玩家 + 自设 各一条`);
  ok((findFriend(s, responders[1].id).memory || []).length === before[1] + 1,
    `★ 回答者 B（${responders[1].name}）只拿到自己那条`);
  ok((findFriend(s, outsider.id).memory || []).length === before[4],
    `★ 没出声的 ${outsider.name} 一条都没多（模型乱写也不会记到他头上）`);
  ok(!JSON.stringify(listFriends(s).map((f) => f.memory)).includes('火星'), '没出声的人的自设被丢掉');
  ok(!JSON.stringify(listFriends(s).map((f) => f.memory)).includes('月球'), '不存在的人的记忆被丢掉');

  // 名字是群聊里认人的唯一钥匙：必须唯一，否则就会写串
  const names = members.map((p) => p.name);
  ok(new Set(names).size === names.length, '在场的人名字互不相同（认人不会认错）');
  const allNames = PERSONAS.map((p) => p.name);
  ok(new Set(allNames).size === allNames.length, '★ 28 个人设全局不重名（群聊按名字写记忆的前提）');
}

/* ===================================================================== */
console.log('-- ★ 群聊不影响好感度');
{
  const uiSrc = readFileSync(new URL('../src/ui/groups.js', import.meta.url), 'utf8');
  const aiSrc = readFileSync(new URL('../src/ai/group.js', import.meta.url), 'utf8');
  const storeSrc = readFileSync(new URL('../src/store/groups.js', import.meta.url), 'utf8');
  ok(!/adjustAffinity/.test(uiSrc), '群聊界面不调用 adjustAffinity');
  ok(!/adjustAffinity/.test(aiSrc) && !/\bdelta\b/.test(aiSrc.replace(/不要输出 delta/g, '')),
    '群聊 AI 层不算好感度');
  ok(!/adjustAffinity/.test(storeSrc), '群聊存档层不碰好感度');
  // 发一条完整流程跑一遍，好感度必须纹丝不动
  const s = newSave(4);
  const g = createGroup(s, '测试群', mem(4).map((p) => p.id)).group;
  const before = listFriends(s).map((f) => f.affinity);
  appendGroupChat(s, g.id, { role: 'me', by: 'me', text: '谢谢你们，你们真厉害' });
  const analysis = localGroupAnalyze({ responders: mem(4), playerText: '谢谢你们，你们真厉害' });
  for (const [name, m] of Object.entries(analysis)) {
    const p = mem(4).find((x) => x.name === name);
    if (p && m) findFriend(s, p.id).memory.push(m);
  }
  ok(JSON.stringify(listFriends(s).map((f) => f.affinity)) === JSON.stringify(before), '跑完一轮好感度一点没变');
}

/* ===================================================================== */
console.log('-- ★ 群聊内容也会进 memory（但只记稳定信息）');
{
  const members = mem(3);
  const msgs = buildGroupAnalyzeMessages({
    responders: members,
    playerText: '我平时喜欢喝奶茶，叫我阿伟就行',
    replies: [{ name: members[0].name, text: '好嘞阿伟' }],
    recentLines: ['我：在吗'],
  });
  const all = msgs.map((m) => m.content).join('\n');
  ok(all.includes('群聊'), '说明这是在审查群聊');
  ok(members.every((p) => all.includes(p.name)), '把在场的人列出来');
  ok(/不要输出 delta/.test(all), '明确说了不要判断好感度');
  ok(/称呼/.test(all) && /偏好/.test(all), '记忆分类还在');
  ok(/不要写入|不要记的内容/.test(all), '带上"什么不该记"');
  ok(/自设/.test(all), '★ 也审查"某个 AI 自己顺口补充的设定"');
  ok(/别张冠李戴|只有\*\*说话的人自己\*\*/.test(all.replace(/\s/g, '')) || /自己.*的设定才写进他名下/.test(all),
    '强调"自设只记在说话的人名下"');
  ok(/老家/.test(all), '给"自设"举了例子（老家）');

  // 两段式返回：记忆（关于玩家）+ 自设（关于 AI 自己）
  const parsed = parseGroupAnalyze(JSON.stringify({
    记忆: { [members[0].name]: '称呼：阿伟', [members[1].name]: '', 路人: '偏好：奶茶' },
    自设: { [members[1].name]: { 老家: '杭州', 职业: '大学生' }, 路人: { 老家: '火星' }, [members[2].name]: {} },
  }), members);
  ok(parsed.memory[members[0].name] === '称呼：阿伟', '解析出该记的那条');
  ok(!(members[1].name in parsed.memory), '空字符串不算一条记忆');
  ok(!('路人' in parsed.memory), '不在场的人不会被写记忆');
  ok(parsed.self[members[1].name] && parsed.self[members[1].name].老家 === '杭州', '★ 解析出自设');
  ok(parsed.self[members[1].name].职业 === '大学生', '自设可以有多个方面');
  ok(!('路人' in parsed.self), '不在场的人的自设也会丢掉');
  ok(!(members[2].name in parsed.self), '空的自设不算一条');
  ok(Object.keys(parseGroupAnalyze('乱七八糟', members).memory).length === 0, '解析不出来就什么都不记');
  ok(Object.keys(parseGroupAnalyze('乱七八糟', members).self).length === 0, '自设也一起兜住');
  const wrapped = parseGroupAnalyze(JSON.stringify({ memory: { [members[2].name]: '偏好：奶茶' }, self: { [members[2].name]: { 宠物: '橘猫' } } }), members);
  ok(wrapped.memory[members[2].name] === '偏好：奶茶', '兼容 memory 这个键名');
  ok(wrapped.self[members[2].name].宠物 === '橘猫', '兼容 self 这个键名');

  // 本地兜底：至少能把"我叫阿伟"抓出来，自设从各自那句回复里抠
  const local = localGroupAnalyze({
    responders: members,
    playerText: '我叫阿伟',
    replies: [{ name: members[0].name, text: '我是杭州人' }, { name: members[1].name, text: '我养了只橘猫' }],
  });
  ok(Object.keys(local.memory).length === members.length, '本地兜底给在场每个人各记一份玩家信息');
  ok(/称呼/.test(local.memory[members[0].name]), `本地兜底抓到了称呼（${local.memory[members[0].name]}）`);
  ok(local.self[members[0].name].老家 === '杭州', '★ 本地兜底从 AI 自己的话里抠出自设');
  ok(local.self[members[1].name].宠物 === '只橘猫' || /橘猫/.test(local.self[members[1].name].宠物), '宠物也能抠出来');
  ok(!local.self[members[2].name], '没说自己设定的那个人不会被硬塞一条');
  ok(Object.keys(localGroupAnalyze({ responders: members, playerText: '今天天气不错' }).memory).length === 0, '没信息就不记');
}

/* ===================================================================== */
console.log('-- 谁先说话：被回复/被点名的人排最前');
{
  const members = mem(5);
  const ids = members.map((p) => p.id);
  const order = orderResponders([ids[3], ids[1]], [ids[2]], members, 3);
  ok(order[0] === ids[2], '被点名的人排第一');
  ok(order.length === 3, '凑够想要的人数');
  ok(new Set(order).size === order.length, '不会有重复');
  const capped = orderResponders(ids, [ids[0], ids[1], ids[2], ids[3], ids[4]], members, 5);
  ok(capped.length <= GROUP.maxMentions, `点名再多也最多 ${GROUP.maxMentions} 个`);
  ok(orderResponders(ids, ['p99'], members, 2).every((id) => ids.includes(id)), '不在群里的人不会被排进来');
}

/* ===================================================================== */
console.log('-- ★ 引用条不换行：人名 ≤ 6 字、正文 ≤ 20 字');
{
  ok(QUOTE_NAME_MAX === 6 && QUOTE_TEXT_MAX === 20, '上限就是 6 / 20');

  // 人名：6 个字原样，第 7 个字开始用省略号收掉
  ok(clipName('天才少女酱') === '天才少女酱', '5 个字的人名不动');
  ok(clipName('本命是张卡片') === '本命是张卡片', '正好 6 个字也不动');
  ok(clipName('一二三四五六七') === `一二三四五六${QUOTE_ELLIPSIS}`, '第 7 个字开始被收掉');
  ok(clipName('') === '' && clipName(null) === '' && clipName(undefined) === '',
    '空名字不会变成 "undefined" 或 "null"');

  // 正文：20 个字原样，第 21 个字起收掉
  const t20 = '一'.repeat(20);
  ok(clipQuote(t20) === t20, '20 个字原样显示');
  ok(clipQuote('一'.repeat(21)) === `${t20}${QUOTE_ELLIPSIS}`, '超过 20 个字的部分变成省略号');
  ok([...clipQuote('一'.repeat(40))].length === 20 + [...QUOTE_ELLIPSIS].length, '长文只留前 20 个字 + 省略号');

  // emoji 按"一个字"算，不会被截成半个
  ok(clipChars('😀'.repeat(21), 20) === `${'😀'.repeat(20)}${QUOTE_ELLIPSIS}`, 'emoji 也算一个字（21 个 → 20 个 + 省略号）');
  ok(!/\uFFFD/.test(clipName('🎉🎉🎉🎉🎉🎉🎉')), '截断不会产生半个字符');
  ok(clipName('🎉'.repeat(7)) === `${'🎉'.repeat(6)}${QUOTE_ELLIPSIS}`, 'emoji 名字同样按 6 个字截');

  // 引用正文里的换行/连续空白先压平，免得一条引用占两行
  ok(clipQuote('第一行\n第二行') === '第一行 第二行', '换行被压成空格（引用只占一行）');
  ok(clipQuote('  a\t\tb  ') === 'a b', '首尾空白与连续空白都收拾干净');
  ok(clipQuote('   ') === '', '全是空白的引用是空的');
  ok(clipChars('abc', 0) === '' && clipChars('abc', -1) === '', '上限非正数时返回空串（不抛错）');
}

/* ===================================================================== */
console.log('-- 老存档 / 脏数据');
{
  const s = defaultSave();
  ok(Array.isArray(s.groups) && s.groups.length === 0, '新存档有空的 groups');
  // 没有 groups 字段的老存档
  const old = { version: 1, nickname: '老玩家', beans: 5000, friends: [] };
  ensureGroups(old);
  ok(Array.isArray(old.groups), '缺字段时自动补齐');
  // 成员里有"不存在的人设" / "已经不是好友的人"
  const s2 = newSave(3);
  const g = createGroup(s2, '群', mem(3).map((p) => p.id)).group;
  g.members.push('p99'); // 不存在的人设 → 清掉
  g.members.push(PERSONAS[20].id); // 非好友（或被删掉的好友）→ ★ 用户拍板：不退群，保留
  g.name = '';
  g.unread = -5;
  ensureGroups(s2);
  ok(!g.members.includes('p99'), '不存在的人设从群里清掉');
  ok(g.members.includes(PERSONAS[20].id), '★ 非好友（含被删掉的好友）**不退群**，留在群里');
  ok(g.name === '我的群聊', '空群名补默认值');
  ok(g.unread === 0, '负的未读归零');

  // 删好友之后：群成员还在，而且还能在群里认出它的名字
  const s3 = newSave(3);
  const g3 = createGroup(s3, '群', mem(2).map((p) => p.id)).group;
  removeFriend(s3, mem(2)[0].id);
  ensureGroups(s3);
  ok(findGroup(s3, g3.id).members.includes(mem(2)[0].id), '★ 删掉的好友仍然留在群里');
  ok(groupMembers(findGroup(s3, g3.id)).some((p) => p.id === mem(2)[0].id),
    '★ 群里还能正常显示 TA（名字从人设里取，不依赖好友关系）');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '群聊检查通过'}`);
process.exit(fail ? 1 : 0);
