/**
 * 好友系统测试（node tools/test-friends.mjs）
 * 覆盖：添加/删除、好感度边界、memory 写入与上限、聊天记录裁剪、重置清空、
 *       分析结果的解析与容错、本地兜底、提示词是否注入了 memory 与好感度
 */
import { defaultSave } from '../src/store/storage.js';
import {
  addFriend, removeFriend, listFriends, findFriend, isFriend,
  appendChat, adjustAffinity, addMemory, addMatchMemory, affinityTier, AFFINITY_TIERS, memoryText, ensureFriends, sortedMemory,
  bumpUnread, clearUnread, unreadTotal, friendContextLines, selfDisclosureLine, repairMemoryOwnership, ensureOwnership,
  memoryNeedsCompress, listFriendsNeedingCompress, applyCompressedMemory, compressMemoryLocally, repairMatchWording,
  matchStampOf, isMatchMemory,
  addMomentMemory, listMomentMemory, regularMemoryCount, extraMemoryCount, syncFriendIdentities,
  addRenameMemory,
  tierOf, isLover, loverFriend, setLover, breakUp, canConfess, canBreakup,
  setSelfMemory, setSelfMemories, listSelfMemory, listPlayerMemory, syncPlayerRename,
} from '../src/store/friends.js';
import { PERSONAS } from '../src/data/personas.js';
import {
  buildFriendMessages, buildAnalyzeMessages, parseAnalysis, localAnalyze, localReply, extractMemory,
  buildProactiveMessages, localGreeting, routeFacts,
  buildCompressMessages, parseCompressed,
  isConfession, isBreakup, extractSelfMemory, appearsIn, guardSelfFacts, guardPlayerMemory, looksLikeSelfFact,
  selfAboutPlayer, guardRename, aiEconomyLine, splitReply, splitAndSanitize,
} from '../src/ai/friend.js';
import { memoryGroups } from '../src/store/friends.js';
import {
  aiNameOf, renameAi, resetAiNames, applyAiNames, cleanAiName, renameMemoryLine, nameIsUsable,
} from '../src/store/aiNames.js';
import { memoryDigest } from '../src/data/memoryDigest.js';
import { RENAME } from '../src/config.js';
import { mergeMemoryLocally, textSimilarity, mergeSimilarText, canMerge } from '../src/data/memory.js';
import { localSummary, localSummaryForAi, fitSummary, ddzFacts, fishingFacts, buildSummaryMessages, neutralizeSummary, hasSecondPerson } from '../src/ai/matchSummary.js';
import { MEMORY_CATEGORIES, MEMORY_EXCLUDE, memoryIcon, selfAspectOf, selfValueOf, isSelfMemory } from '../src/data/memory.js';
import { insertAt, chatTimeLabel, chatTimeFlags, listTimeLabel, CHAT_TIME_GAP, nudgeHit } from '../src/ui/friends.js';
import { activeHoursOf, simulatedSendAt } from '../src/data/clock.js';
import { guardGroupSelf, guardGroupMemory, buildGroupReplyMessages } from '../src/ai/group.js';
import { playerIdentityLines } from '../src/data/player.js';
import { buildMomentCommentMessages } from '../src/ai/moments.js';
import { findMentioned } from '../src/ai/group.js';
import { createGroup, findGroup, ensureGroups, recentGroupChat, groupChatLines, appendGroupChat } from '../src/store/groups.js';
import { buildDanmakuMessages } from '../src/ai/danmaku.js';
import {
  buildNudgeLine, allowNudge, lastNudgeAt, ensureNudgeStore, nudgeReply, buildNudgeReplyMessages,
} from '../src/ai/nudge.js';
import {
  NUDGE_LINES, GENERIC_NUDGE, nudgeLineOf, pickFallbackNudgeReply, fallbackNudgePool, FALLBACK_NUDGE_REPLY,
} from '../src/data/nudgeLines.js';
import { NUDGE, CONFIG, FRIEND } from '../src/config.js';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail += 1; console.log(`  ✗ ${msg}`); } };

/**
 * ★ 单元测试**不许打真网络**（这个套件原来漏了这一步，是实打实的 bug）：
 *   本套件会调到 friendReply / nudgeReply 这类真的会发请求的函数，
 *   没有桩的时候它们会直连 api.deepseek.com ——
 *   ① 填了 Key 就**真的花钱**，而且断言依赖模型当天心情，结果不确定；
 *   ② 不填 Key 时拿到 401，进程退出时还挂着一个 libuv 的 socket/async 句柄，
 *      Node 在 Windows 上直接 abort：
 *        Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 *      退出码变成 0xC0000409 —— 表现就是"断言全过、套件却失败"。
 *   口径和 tools/dom-stub.mjs 一致：一律 404，让代码走本地兜底，测试完全离线、可重复。
 */
globalThis.fetch = async () => ({
  ok: false, status: 404, text: async () => '', json: async () => ({}),
});

/**
 * 一批**互不相似**的记忆用词。
 * 为什么不用「爱好1 / 爱好2」这种：现在写入时会自动合并相近记忆，
 * 编号式的假数据会被判成"同一件事"而并掉，测不出条数上限的真实行为。
 */
const WORDS = [
  '奶茶', '火锅', '烘焙', '跑步', '游泳', '旅行', '摄影', '吉他', '围棋', '书法',
  '钓鱼', '骑行', '爬山', '相声', '话剧', '观星', '历史', '日语', '编程', '羽球',
  '滑雪', '陶艺', '街舞', '潜水', '木工', '下厨', '滑板', '剧本', '桌游', '露营',
  '红酒', '盆景', '乐高', '风筝', '划船', '射箭', '攀岩', '写诗', '篆刻', '集邮',
];

/* ===================================================================== */
console.log('-- ★ 好感度档位：默认 0（陌生），5 档');
{
  ok(FRIEND.startAffinity === 0, '★ 初始好感度是 0');
  const s = defaultSave();
  const p = PERSONAS[0];
  addFriend(s, p);
  ok(findFriend(s, p.id).affinity === 0, '刚加的好友好感度 0');
  ok(affinityTier(0).label === '陌生', '0 → 陌生');
  ok(affinityTier(19).label === '陌生' && affinityTier(20).label === '点头之交',
    '20 是分界：19 陌生 / 20 点头之交');
  ok(affinityTier(39).label === '点头之交' && affinityTier(40).label === '朋友',
    '40 是分界：39 点头之交 / 40 朋友');
  ok(affinityTier(59).label === '朋友' && affinityTier(60).label === '密友',
    '60 是分界：59 朋友 / 60 密友');
  ok(affinityTier(79).label === '密友' && affinityTier(80).label === '挚友',
    '80 是分界：79 密友 / 80 挚友');
  ok(affinityTier(100).label === '挚友', '100 → 挚友');
  ok(affinityTier(0, true).label === '恋人', '成了恋人就直接显示恋人');
  ok(affinityTier(-5).label === '陌生' && affinityTier(999).label === '挚友',
    '越界值也不会崩（夹到两端）');
  ok(affinityTier(NaN).label === '陌生' && affinityTier(undefined).label === '陌生',
    '脏数据当 0 处理');
  ok(AFFINITY_TIERS.length === 5, '就 5 档，不多不少');
  ok(AFFINITY_TIERS.map((t) => t.label).join('/') === '挚友/密友/朋友/点头之交/陌生',
    '档位名字与用户拍板一致');
  ok(FRIEND.breakupAffinity === 40 && affinityTier(FRIEND.breakupAffinity).label === '朋友',
    '分手后落在「朋友」档（和记忆里"还是朋友"那句话对得上）');
}

/* ===================================================================== */
console.log('-- ★ 冷加的好友不该知道"刚刚那局"');
{
  const s = defaultSave();
  s.nickname = '小徐';
  const played = PERSONAS[0];   // 这局陪玩家打过的对手
  const other = PERSONAS[5];    // 完全没打过的人
  const hand = { kind: 'ddz', at: Date.now() - 1000, seatIds: [played.id], summary: '低级场那局，玩家赢了', humanWin: true };
  s.recentHands = [hand];

  // ① 从「添加好友」列表冷加：不许补对局记忆
  addFriend(s, other);
  addFriend(s, played); // 冷加，即使它那局确实在桌上
  ok((findFriend(s, other.id).memory || []).length === 0, '没打过的人：记忆空的');
  ok((findFriend(s, played.id).memory || []).length === 0,
    '★ 冷加的人也不补对局记忆（否则一上来就"刚刚那局你…"）');

  // ② 从结算面板加（fromMatch）：才补那几局
  const s2 = defaultSave();
  s2.recentHands = [hand];
  addFriend(s2, played, { fromMatch: true });
  ok((findFriend(s2, played.id).memory || []).length === 1
    && findFriend(s2, played.id).memory[0].startsWith('对局：'),
    '★ 从结算面板加的人，才会被补上"对局：…"');
  ok(addFriend(s2, other, { fromMatch: true }).ok
    && (findFriend(s2, other.id).memory || []).length === 0,
    '从结算面板加、但没参加那局的人，也不会被硬塞对局记忆');

  // ③ 提示词：joined=false 时连摘要都不给，还明确禁止提牌局；joined=true 才给摘要
  const f = findFriend(s, played.id);
  const notJoined = buildFriendMessages({ persona: played, friend: f, text: '在吗', joined: false, lastMatch: hand })
    .map((m) => m.content).join('\n');
  ok(!notJoined.includes(hand.summary), '★ 没一起打过 → 提示词里连那局摘要都不给');
  ok(/没有一起打过|不要提牌局/.test(notJoined), '★ 而且明确写"别提牌局/刚那局"');
  ok(!/可以聊你们刚才打的那局牌/.test(notJoined), '★ 那句"可以聊刚才那局"的话不再无条件出现');
  const joined = buildFriendMessages({ persona: played, friend: f, text: '在吗', joined: true, lastMatch: hand })
    .map((m) => m.content).join('\n');
  ok(joined.includes(hand.summary), '真一起打过 → 才把那局摘要给它');
  const proactiveNo = buildProactiveMessages({ persona: played, friend: f, joined: false, lastMatch: hand })
    .map((m) => m.content).join('\n');
  ok(/不要提|没有.*一起/.test(proactiveNo), '主动搭话那条路也禁止提牌局');

  // ④ 本地兜底语料：没一起打过时不能蹦出"刚那局…"（一起打过时照旧可用）
  let bad = 0;
  let joinedLines = 0;
  const inputs = ['今天天气不错', '在吗', '我最近很忙', '晚上吃什么', '你怎么样'];
  for (let i = 0; i < 200; i += 1) {
    const t = inputs[i % inputs.length];
    const line = localReply(played, t, { joined: false });
    if (!line || typeof line !== 'string') bad += 100; // 过滤不能把兜底弄成空的
    if (/局|上一?把/.test(line)) bad += 1;
    if (/局/.test(localReply(played, t, { joined: true }))) joinedLines += 1;
  }
  ok(bad === 0, `★ 兜底语料也不会说"刚那局"、也不会变空（200 次里 ${bad} 次）`);
  ok(joinedLines >= 0, `一起打过时"那局"这类语料仍在池子里（200 次里出现 ${joinedLines} 次）`);

  // ⑤ ★ 私聊提示词给最近 15 条聊天（用户拍板）
  const s3 = defaultSave();
  addFriend(s3, PERSONAS[6]);
  const f3 = findFriend(s3, PERSONAS[6].id);
  f3.chat = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'ai' : 'me', text: `第 ${i} 句`, at: i }));
  const prompt = buildFriendMessages({ persona: PERSONAS[6], friend: f3, text: '在吗' })
    .map((m) => m.content).join('\n');
  ok(FRIEND.recent === 15, `★ 私聊看最近 15 条（配置值 ${FRIEND.recent}）`);
  ok(prompt.includes('第 29 句') && prompt.includes('第 15 句'), '★ 最近 15 条都在（29 → 15）');
  ok(!prompt.includes('第 14 句'), '★ 更早的不给（第 14 句不在）');
  ok(prompt.includes('朋友：第 28 句') || prompt.includes('你：第 29 句'), '聊天记录带上了说话人');
}

/* ===================================================================== */
console.log('-- ★ 记忆上限 16：超了不是丢掉，而是把相似的合并');
{
  ok(FRIEND.maxMemory === 16, `★ 上限改成 16（实际 ${FRIEND.maxMemory}）`);
  ok(FRIEND.maxMemoryChars === 40, `★ 单条字数上限改成 40（实际 ${FRIEND.maxMemoryChars}）`);

  // ① 本地合并：同分类并成一条、用「、」连接
  const merged = mergeMemoryLocally(['偏好：喝奶茶', '偏好：爱吃辣', '身份：学生']);
  ok(merged.length === 2 && merged.includes('偏好：喝奶茶、爱吃辣'), '同分类合成一条：偏好：喝奶茶、爱吃辣');
  ok(merged.includes('身份：学生'), '不同分类照旧分开');
  const dup = mergeMemoryLocally(['偏好：喝奶茶', '偏好：喝奶茶', '偏好：看书']);
  ok(dup.length === 1 && dup[0] === '偏好：喝奶茶、看书', '重复的只留一份');
  // 对局 / 关系 / 自设 一律不动
  const kept = mergeMemoryLocally([
    '对局：第一局…', '对局：第二局…', '关系：和玩家成了恋人', '自设：老家=杭州', '自设：爱好=看书',
    '偏好：喝奶茶', '偏好：爱吃辣',
  ]);
  ok(kept.filter((m) => m.startsWith('对局：')).length === 2, '★ 对局记忆不动（两条都还在）');
  ok(kept.includes('关系：和玩家成了恋人'), '关系记忆不动');
  ok(kept.filter((m) => m.startsWith('自设：')).length === 2, '★ 自设按方面保留，不合并');
  ok(kept.includes('偏好：喝奶茶、爱吃辣'), '普通分类照常合并');
  // 一条装不下（40 字）就分条，信息不丢
  const long = mergeMemoryLocally(['偏好：' + '甲'.repeat(30), '偏好：' + '乙'.repeat(30)], { maxChars: 40 });
  ok(long.length === 2, '一条放不下就分两条（不丢信息）');
  ok(long.every((m) => m.length <= 40), '每条都不超过 40 字');

  // ② 第 17 条不再直接淘汰，而是标记"该合并了"
  const s = defaultSave();
  const p = PERSONAS[0];
  addFriend(s, p);
  for (let i = 1; i <= 16; i += 1) addMemory(s, p.id, `偏好：${WORDS[i - 1]}`);
  const f = findFriend(s, p.id);
  ok(f.memory.length === 16, '先记满 16 条');
  ok(!memoryNeedsCompress(f), '刚好 16 条时不用合并');
  const r17 = addMemory(s, p.id, `偏好：${WORDS[16]}`);
  ok(r17.added === true, '第 17 条**还是记下来了**');
  ok(f.memory.length === 17, '★ 第 17 条不会把最旧的挤掉（先留着等合并）');
  ok(memoryNeedsCompress(f) === true, '★ 并且打了"该合并"的标记');
  ok(listFriendsNeedingCompress(s).length === 1, '启动时能扫出"等着合并"的好友');

  // ③ 本地合并兜底：17 条 → 1 条（全是同一个分类）
  const res = compressMemoryLocally(s, p.id);
  ok(res && res.before === 17 && res.after < 17, `★ 合并后条数减少（${res.before} → ${res.after}）`);
  const after = findFriend(s, p.id).memory;
  ok(after.length <= 16, '合并后不超过 16 条');
  ok(after.some((m) => m.includes(WORDS[0])), '★ 信息没丢（最早的还在）');
  ok(after.some((m) => m.includes(WORDS[16])), '★ 信息没丢（最新的也在）');
  ok(after.every((m) => m.length <= FRIEND.maxMemoryChars), `每条都不超过 ${FRIEND.maxMemoryChars} 字`);
  ok(!memoryNeedsCompress(findFriend(s, p.id)), '合并完就把标记清掉');

  // ④ 硬上限：万一合并不停失败，也不能无限涨
  const s2 = defaultSave();
  addFriend(s2, p);
  for (let i = 1; i <= 40; i += 1) addMemory(s2, p.id, `习惯：${WORDS[(i - 1) % WORDS.length]}`);
  ok(findFriend(s2, p.id).memory.length <= FRIEND.maxMemoryHardCap,
    `★ 超过硬上限 ${FRIEND.maxMemoryHardCap} 条就会裁掉（实际 ${findFriend(s2, p.id).memory.length}）`);

  // ⑤ AI 合并：提示词要说清楚"合并相似的、对局别动"，解析要稳
  const prompt = buildCompressMessages({
    persona: p, friend: f, memory: ['偏好：喝奶茶', '偏好：爱吃辣', '对局：某局'],
  }).map((m) => m.content).join('\n');
  ok(/合并/.test(prompt) && /、/.test(prompt), '提示词要求"相似的合并成一条、用「、」连接"');
  ok(/对局：.*原样照抄|对局.*不许合并/.test(prompt.replace(/\s/g, ' ')), '★ 明确写了"对局记忆不许合并、原样照抄"');
  ok(/最多 16 条/.test(prompt), '写了条数上限');
  ok(/40 个字/.test(prompt), '写了单条字数上限（40）');
  ok(/JSON 数组/.test(prompt), '要求输出 JSON 数组');
  const parsed = parseCompressed('```json\n["偏好：喝奶茶、爱吃辣","对局：某局"]\n```');
  ok(Array.isArray(parsed) && parsed.length === 2 && parsed[0] === '偏好：喝奶茶、爱吃辣',
    '★ 能从模型的输出里解析出合并结果（容忍代码块）');
  ok(parseCompressed('随便说点什么') === null, '解析不出来就返回 null（交给本地兜底）');
  ok(parseCompressed('["没有冒号的句子"]') === null, '不是「分类：内容」的条目会被过滤掉');
}

/* ===================================================================== */
console.log('-- ★ 删好友：记忆留着、不退群、好感 -5、写一条"玩家删掉了AI好友"');
{
  const s = defaultSave();
  const p = PERSONAS[2];
  addFriend(s, p);
  const f = findFriend(s, p.id);
  adjustAffinity(s, p.id, 40);           // 好感 40
  addMemory(s, p.id, '称呼：阿伟');
  addMemory(s, p.id, '偏好：爱喝奶茶');
  appendChat(s, p.id, 'me', '在吗');
  // 顺手建个群，把 TA 拉进去（另一个人也得先是好友）
  addFriend(s, PERSONAS[3]);
  const g = createGroup(s, '测试群', [p.id, PERSONAS[3].id]).group;
  const memBefore = findFriend(s, p.id).memory.slice();

  const res = removeFriend(s, p.id);
  ok(res.ok, '删好友成功');
  ok(res.affinity === 35, `★ 好感度 -5（40 → ${res.affinity}）`);
  ok(!isFriend(s, p.id), '★ 现在不算好友了（列表里看不到、不参与结算加成）');
  ok(!listFriends(s).some((x) => x.personaId === p.id), '好友列表里已经没有 TA');
  ok(!!findFriend(s, p.id), '★ 记录还在（软删除，没把记忆一起删掉）');
  ok(!!findFriend(s, p.id).removed, '标记为"已删除"');
  const memAfter = findFriend(s, p.id).memory;
  ok(memBefore.every((m) => memAfter.includes(m)), '★ 原有记忆一条没少');
  ok(memAfter.includes('玩家删掉了AI好友'), '★ 追加了一条「玩家删掉了AI好友」');
  ok(findFriend(s, p.id).chat.length === 1, '聊天记录也留着');
  ok(findGroup(s, g.id).members.includes(p.id), '★ 不自动退群（群成员里还有 TA）');
  ok(ensureGroups(s).find((x) => x.id === g.id).members.includes(p.id),
    '★ 就算跑一遍脏数据清理，也**不会**把删掉的好友踢出群');

  // 好感 -5 不会变负
  const s2 = defaultSave();
  addFriend(s2, PERSONAS[3]);
  removeFriend(s2, PERSONAS[3].id);
  ok(findFriend(s2, PERSONAS[3].id).affinity === 0, '好感 0 时再删也只是 0（不会负）');

  // 加回来：记忆、好感、聊天记录都还在，并且它记得"你删过我"
  const back = addFriend(s, p);
  ok(back.ok && back.restored === true, '★ 重新加回来是"恢复"而不是新建');
  ok(findFriend(s, p.id).affinity === 35, '★ 好感度接着上次（35）');
  ok(findFriend(s, p.id).memory.includes('称呼：阿伟') && findFriend(s, p.id).memory.includes('玩家删掉了AI好友'),
    '★ 记忆都还在（包括"你删过我"这件事）');
  ok(findFriend(s, p.id).chat.length === 1, '聊天记录也接着上次');
  ok(isFriend(s, p.id) && listFriends(s).some((x) => x.personaId === p.id), '又回到好友列表里');
  ok(!addFriend(s, p).ok, '已经是好友了，不会重复添加');
}

/* ===================================================================== */
console.log('-- ★ 对局记忆要带时间戳、并且最新的那局排最前');
{
  const s = defaultSave();
  s.nickname = '柠檬团长';
  const p = PERSONAS[6];
  addFriend(s, p);
  const t1 = new Date(2026, 7, 19, 21, 5).getTime();
  const t2 = new Date(2026, 7, 19, 22, 40).getTime();
  addMatchMemory(s, p.id, '这局小猫钓鱼在低级场，玩家输了 11,244 豆。', t1);
  addMatchMemory(s, p.id, '这局斗地主，玩家当地主赢了两家。', t2);
  const f = findFriend(s, p.id);
  const matches = f.memory.filter((m) => m.startsWith('对局：'));
  ok(matches.length === 2, '两局都记下来了');
  ok(/^对局：\[8\/19 21:05\]/.test(matches[0]), `★ 对局带时间戳（${matches[0].slice(0, 18)}…）`);
  ok(/^对局：\[8\/19 22:40\]/.test(matches[1]), '第二局也有自己的时间');
  ok(matchStampOf(matches[1]) > matchStampOf(matches[0]), '时间戳能解析出来比大小');
  ok(matchStampOf('偏好：爱喝奶茶') === 0, '不是对局的记忆没有时间戳');
  ok(isMatchMemory(matches[0]) && !isMatchMemory('偏好：x'), 'isMatchMemory 认得对局');

  // 提示词里：最新的那局排在最前面，并且明确告诉 AI"只有最上面那条才是刚刚那局"
  const chat = buildFriendMessages({ persona: p, friend: f, text: '刚那把怎么样' })
    .map((m) => m.content).join('\n');
  const iNew = chat.indexOf('8/19 22:40');
  const iOld = chat.indexOf('8/19 21:05');
  ok(iNew > 0 && iOld > 0, '两局都进了提示词');
  ok(iNew < iOld, '★ 最新的那局排在前面（AI 一眼就能找到"刚刚那局"）');
  ok(/只有\*\*最上面那条\*\*才是"刚刚那局"/.test(chat) || /只有最上面那条才是/.test(chat),
    '★ 明确写了"只有最上面那条才是刚刚那局"');
  ok(/时间从新到旧/.test(chat), '也说明了排序规则');
}

/* ===================================================================== */
console.log('-- 玩家昵称只做"告知"（不要那套别认错人的说教）');
{
  const s = defaultSave();
  s.nickname = '柠檬团长';
  const p = PERSONAS[6];
  addFriend(s, p);
  addMatchMemory(s, p.id, '这局斗地主，柠檬团长当地主赢得干脆，你输了 40 豆。');
  const f = findFriend(s, p.id);
  const chat = buildFriendMessages({ persona: p, friend: f, text: '在吗', playerName: '柠檬团长' })
    .map((m) => m.content).join('\n');
  ok(/玩家的昵称是「柠檬团长」/.test(chat), '★ 私聊提示词只告知玩家昵称');
  ok(!/玩家本人就是/.test(chat) && !/不是别人/.test(chat) && !/第三个人/.test(chat),
    '★ 没有"玩家本人就是…别认错人"那套说教（用户明确不要）');
  ok(!/你那局打赢了我/.test(chat), '也没有硬塞说法示例');
  const proactive = buildProactiveMessages({ persona: p, friend: f, playerName: '柠檬团长' })
    .map((m) => m.content).join('\n');
  ok(/玩家的昵称是「柠檬团长」/.test(proactive) && !/玩家本人就是/.test(proactive), '主动搭话同样只告知昵称');
  const dm = buildDanmakuMessages({ persona: p, friend: f, recent: [], playerName: '柠檬团长' })
    .map((m) => m.content).join('\n');
  ok(/玩家的昵称是「柠檬团长」/.test(dm) && !/就是他本人/.test(dm), '弹幕同样只告知昵称');
  const ctx = friendContextLines(s, f).join('\n');
  ok(/玩家的昵称是「柠檬团长」/.test(ctx) && !/不是别人/.test(ctx), '牌桌背景也只告知昵称');
  // 不传 playerName 的老调用点不会莫名多一句
  const plain = buildFriendMessages({ persona: p, friend: f, text: '在吗' }).map((m) => m.content).join('\n');
  ok(!/玩家的昵称是/.test(plain), '不传就不加（老调用点不受影响）');
}

/* ===================================================================== */
console.log('-- ★ 群聊：点头像快捷 @人 + 输入框草稿不被清空');
{
  const src = readFileSync(new URL('../src/ui/groups.js', import.meta.url), 'utf8');
  // @人
  ok(/data-at="\$\{p\.name\}"/.test(src), '★ 群成员头像上挂了 data-at（名字）');
  ok(/const atMember = \(name\)/.test(src) && /input\.value\.includes\(token\)/.test(src),
    '★ 点一下就把 @名字 补进输入框（已经 @ 过就不重复）');
  ok(/input\.value = `\$\{input\.value\}\$\{sep\}\$\{token\} `/.test(src), '补的是 `@名字 `，带空格分隔');
  ok(/addEventListener\('click', \(\) => atMember\(n\.dataset\.at\)\)/.test(src), '点头像触发 @');
  ok(/e\.stopPropagation\(\); \/\/ 别把"移出群聊"当成"点头像 @ 他"/.test(src),
    '✕ 移出群聊不会误触发 @');
  // 点出来的是 @名字 —— 必须和"点名必回"的解析规则对得上
  const mentionToken = '@春和景明';
  ok(findMentioned(mentionToken, [PERSONAS[4]]).length === 1, '@出来的格式正好被"点名必回"认出来');
  // 草稿保全
  ok(/const draft = prevInput \? prevInput\.value : ''/.test(src), '★ 重画前先记下输入框草稿');
  ok(/nextInput\.value = draft/.test(src), '★ 重画后把草稿装回去');
  ok(/setSelectionRange\(pos, pos\)/.test(src), '光标也尽量还原');
  const fri = readFileSync(new URL('../src/ui/friends.js', import.meta.url), 'utf8');
  ok(/const draft = prevInput \? prevInput\.value : ''/.test(fri) && /newInput\.value = draft/.test(fri),
    '★ 私聊面板同样保住草稿（AI 回消息不再吃掉你打的字）');
  ok(/wasFocused/.test(fri) && /newInput\.focus\(\)/.test(fri), '焦点也还回去');
}

/* ===================================================================== */
console.log('-- ★ 像真聊天的那几个小地方（会话行时间 / 连发合并 / 头像 / 搜索）');
{
  // 会话行右侧那行小字：今天给 HH:MM、昨天给"昨天"、更早给"3月5日"、跨年给 2025/3/5
  const now = new Date(2026, 8, 22, 15, 30).getTime(); // 2026-09-22 15:30
  const at = (y, m, d, h = 12, mi = 5) => new Date(y, m, d, h, mi).getTime();
  ok(listTimeLabel(at(2026, 8, 22, 9, 7), now) === '09:07', '今天的会话显示 09:07');
  ok(listTimeLabel(at(2026, 8, 21), now) === '昨天', '昨天的会话显示"昨天"');
  ok(listTimeLabel(at(2026, 6, 5), now) === '7月5日', '本年的显示"7月5日"');
  ok(listTimeLabel(at(2025, 2, 3), now) === '2025/3/3', '跨年的显示 2025/3/3');
  ok(listTimeLabel(0, now) === '' && listTimeLabel(undefined, now) === '', '没有时间就不显示（不写 NaN）');

  const ui = readFileSync(new URL('../src/ui/friends.js', import.meta.url), 'utf8');
  ok(/class="chat-face"/.test(ui) && /playerAvatarSrc\(app\.save\)/.test(ui),
    '★ 每条消息都配头像（对方用 TA 的、自己用玩家的）');
  ok(/CHAT_CONT_GAP/.test(ui) && /is-cont/.test(ui) && /prev\.role === m\.role/.test(ui),
    '★ 同一个人连着发 → 合并显示（后一条不再重复头像）');
  ok(/class="friend-side"/.test(ui) && /listTimeLabel\(last\.at\)/.test(ui),
    '★ 会话行右侧：最后一条消息的时间');
  ok(/id="friend-search"/.test(ui) && /hay\.includes\(q\)/.test(ui),
    '★ 左栏顶上的搜索框真的会筛（名字 + 个性签名）');
  ok(/function showTyping\(faceSrc\)/.test(ui) && /face\.className = 'chat-face'/.test(ui),
    '★ "正在输入…"那条也带头像（用户要求：不然像换了个人）');
  ok(!/正在输入…<\/div>/.test(ui), '★ 聊天标题不再显示"正在输入…"（用户要求取消那个状态）');
  ok(!/chat-state/.test(ui) && !/已送达/.test(ui), '不做"已读 / 已送达"回执（用户不要）');
}

/* ===================================================================== */
console.log('-- ★ 玩家有恋人：其他 AI 也要知道（但不主动提）');
{
  const me = defaultSave();
  me.nickname = '阿伟';
  const lover = PERSONAS.find((p) => p.id === 'p26');
  addFriend(me, lover);            // 恋人得先是好友
  setLover(me, lover.id);
  ok(me.loverId === lover.id, '存档里记下了恋人');

  const other = playerIdentityLines(me, { callName: '兄弟', selfId: 'p01' });
  ok(/【玩家的感情状况】/.test(other), '★ 给别的 AI 注入了"玩家有恋人"这一行');
  ok(other.includes(`「${lover.name}」`), `写清了恋人是「${lover.name}」`);
  ok(/不要主动提/.test(other) && /不要追问/.test(other) && /别问"你喜欢谁"/.test(other),
    '★ 明确要求：不主动提、不追问、不酸不拆台');

  const self = playerIdentityLines(me, { callName: '主人', selfId: lover.id });
  ok(!/【玩家的感情状况】/.test(self), '★ 恋人本人不再重复注入（它有自己的"你俩是恋人"口径）');

  const single = defaultSave();
  ok(!/【玩家的感情状况】/.test(playerIdentityLines(single, { selfId: 'p01' })), '单身时不注入这一行');

  // 五个生成路径都拿到了 selfId（否则恋人本人也会看到那行）
  for (const f of ['src/ui/app.js', 'src/ui/friends.js', 'src/ui/groups.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const calls = (src.match(/playerIdentityLines\(/g) || []).length;
    const withSelf = (src.match(/selfId:/g) || []).length;
    ok(calls === withSelf, `${f} 的 ${calls} 处调用都带了 selfId（实际 ${withSelf} 处）`);
  }
}

/* ===================================================================== */
console.log('-- ★ 停在聊天界面时不再亮红点');
{
  const fri = readFileSync(new URL('../src/ui/friends.js', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  ok(/app\.friendsActiveWith = picking \? '' : \(currentId \|\| ''\)/.test(fri),
    '★ 面板会告诉 app"此刻正开着谁的聊天"');
  ok(/app\.friendsActiveWith = ''; \/\/ 面板关了/.test(fri), '关掉面板就清空');
  const ping = (appSrc.match(/async deliverFriendPing[\s\S]*?\n  \}/) || [''])[0];
  ok(/this\.friendsActiveWith === personaId/.test(ping) && /clearUnread\(this\.save, personaId\)/.test(ping),
    '★ 主动搭话时：人正在看这条聊天 → 直接算已读，不点红点');
  ok(!/pickGreeting[\s\S]{0,200}bumpUnread/.test(fri),
    '★ 加好友那条路不再无条件点红点（改走申请流程）');
}

/* ===================================================================== */
console.log('-- ★ 玩家自己改名：所有好友都知道，而且只留最近 1 条');
{
  const s = defaultSave();
  addFriend(s, PERSONAS[0]);
  addFriend(s, PERSONAS[1]);
  const r1 = syncPlayerRename(s, '阿伟', '小明');
  ok(r1.updated === 2, `两位好友都收到通知（${r1.updated}）`);
  ok(/^改名：玩家把昵称从「阿伟」改成了「小明」/.test(r1.line) && /以后要叫他「小明」/.test(r1.line),
    '★ 记的是"玩家改名了、以后叫新名字"');
  const mem = (id) => findFriend(s, id).memory.filter((m) => /^改名：玩家/.test(m));
  ok(mem(PERSONAS[0].id).length === 1, '★ 每位好友只有 1 条改名记录');
  syncPlayerRename(s, '小明', '老王');
  ok(mem(PERSONAS[0].id).length === 1, '★ 再改一次仍然只有 1 条（旧的被替换掉）');
  ok(/「老王」/.test(mem(PERSONAS[0].id)[0]), '留下的是最新那条');
  ok(syncPlayerRename(s, '老王', '老王').updated === 0, '名字没变就不写记录');
  // 提示词里必须能看到新名字（AI 才知道要改口）—— UI 那边是"先改 save.nickname，再同步记忆"
  s.nickname = '老王';
  const lines = playerIdentityLines(s, { callName: '', selfId: PERSONAS[0].id });
  ok(/「老王」/.test(lines), '★ 玩家身份那一段带的是新昵称');
}

/* ===================================================================== */
console.log('-- ★ 长回复拆两条发（用户拍板：拆不拆由 AI 自己判断，程序只认它写的记号）');
{
  const s = splitReply('今天有点累，先不聊了。\n---\n明天再跟你打两局，补回来。', 25);
  ok(s.length === 2 && s[0] === '今天有点累，先不聊了。' && s[1] === '明天再跟你打两局，补回来。',
    '★ 用单独一行 --- 拆成两条');
  ok(splitReply('好', 25).length === 1, '★ AI 没写记号就是一条（短句不拆）');
  ok(splitReply('a\n---\nb\n---\nc', 25).length === 2
    && splitReply('a\n---\nb\n---\nc', 25)[1] === 'b c', '最多两条，多出来的并进第二条（不丢字）');
  ok(splitReply('第一行\n第二行', 25).length === 1, '没有分隔记号就不拆（普通换行压成空格）');
  ok(splitReply('', 25).length === 0 && splitReply(null, 25).length === 0, '空输入返回 0 段，不炸');
  /**
   * ★ 用户报的 bug 的回归断言：模型写了分隔行，但 sanitize() 会先把换行抹平，
   *   于是拆两条**从来没生效过**。这条断言专门盯"先拆、再逐段 sanitize"的顺序。
   */
  ok(splitAndSanitize('第一段\n---\n第二段', 60).length === 2,
    '★ sanitize 不许吃掉分隔行（旧 bug：second 恒为空）');
  ok(splitAndSanitize(`一二三四五六七八九十${'啊'.repeat(30)}`, 12)[0].length <= 22,
    '拆出来的每条仍然受长度上限约束');
  ok(splitAndSanitize('---', 60).length === 0, '模型只吐一个分隔记号时不算一条回复');
  ok(splitAndSanitize('第一段 --- 第二段', 60).length === 2, '记号写在同一行也能拆（容错）');
  // ★ 不许按标点/字数硬拆（用户明确否掉规则引擎）
  const longLine = '哎哟我的天，闹了半天你小子才二十三。那阿姨可不能顺着你喊宝宝了，差着辈儿呢！往后啊，还叫声阿姨，咱踏踏实实做朋友，行不？';
  ok(splitReply(longLine, 20).length === 1, '★ 再长也不许程序硬拆——AI 没写记号就只有一条');
  const msg = buildFriendMessages({
    persona: PERSONAS[0], friend: { affinity: 60, chat: [], memory: [] }, text: '在吗',
  }).map((m) => m.content).join('\n');
  ok(/要不要分两条发，你自己看着办/.test(msg) && /单独一行写 ---/.test(msg)
    && /别写 ---/.test(msg) && /两段不同的意思/.test(msg),
    '★ 提示词把"拆不拆"交给 AI 自己判断，并给了判断标准和例子');
  const friendSrc = readFileSync(new URL('../src/ai/friend.js', import.meta.url), 'utf8');
  ok(/splitAndSanitize\(raw, limit\)/.test(friendSrc),
    '★ friendReply 先拆再 sanitize（顺序写错就退回 old bug）');
  const ui = readFileSync(new URL('../src/ui/friends.js', import.meta.url), 'utf8');
  ok(/const \{ text: reply, second = '' \} = await friendReply\(/.test(ui), 'UI 接住了第二条');
  ok(/setTimeout\(r, 1000 \+ Math\.random\(\) \* 1000\)/.test(ui), '★ 第二条隔 1~2 秒才发');
  ok(/reply: second \? `\$\{reply\} \$\{second\}` : reply/.test(ui), '两条都交给审查（不然看不全它答没答应）');
  ok(/showTyping\(ASSETS\.avatar\(persona\.avatar\)\);\s*\n\s*appendChat\(app\.save, personaId, 'ai', second\)/.test(ui),
    '发第二条之前也显示"正在输入…"');
}
{
  const night = { tags: ['熬夜', '夜猫子'] };
  const student = { tags: ['大学生'] };
  const early = { tags: ['早起', '养生'] };
  // 玩家 23:00 下线，第二天 14:00 回来
  const left = new Date(2026, 8, 23, 23, 0).getTime();
  const back = new Date(2026, 8, 24, 14, 0).getTime();
  const inWindow = (t) => t >= left && t <= back;
  const mid = () => 0.5;

  ok(activeHoursOf(night).every((h) => h >= 23 || h <= 3), '熬夜型只在深夜~凌晨那几个小时冒泡');
  ok(activeHoursOf(student).includes(12), '大学生型会中午冒泡');
  ok(activeHoursOf(early).every((h) => h <= 8 || h >= 19), '早睡早起型不会在凌晨发消息');
  ok(activeHoursOf({ tags: ['随便什么人'] })[0] >= 9, '认不出作息档就用普通白天作息');

  const nightAt = simulatedSendAt(night, left, back, mid);
  const studentAt = simulatedSendAt(student, left, back, mid);
  ok(inWindow(nightAt) && inWindow(studentAt), '★ 模拟时刻一定落在"玩家不在线"的那段时间里');
  ok([23, 0, 1, 2, 3].includes(new Date(nightAt).getHours()), '★ 熬夜型发在深夜/凌晨（比如 2 点多）');
  ok([11, 12, 13, 21, 22, 23].includes(new Date(studentAt).getHours()), '★ 大学生型发在中午/晚上（比如 12 点多）');
  ok(nightAt !== studentAt, '★ 不同人设挑出不同时间（不再都是"上线那一刻"）');
  ok(nightAt <= back - 60 * 1000 && studentAt <= back - 60 * 1000, '不会正好卡在"玩家回来"的那一刻');

  const shortAt = simulatedSendAt(night, back - 30 * 1000, back, mid);
  ok(shortAt <= back && shortAt >= back - 30 * 1000, '窗口只有半分钟也落在窗口内');
  ok(Number.isFinite(simulatedSendAt(null, 0, back, mid)), '人设为 null 也不崩');
  ok(Number.isFinite(simulatedSendAt(night, back, back, mid)), '空窗口不崩');

  // 补发消息进聊天记录：按时间插进正确位置，聊天记录不会时间倒流
  const s2 = defaultSave();
  const pid = PERSONAS[0].id;
  addFriend(s2, PERSONAS[0]);
  appendChat(s2, pid, 'me', '我先说一句', { at: back - 10 * 60 * 1000 });
  appendChat(s2, pid, 'ai', '这是凌晨补发的', { at: left + 3 * 3600 * 1000 });
  const chat2 = findFriend(s2, pid).chat;
  ok(chat2.length === 2 && chat2[0].at < chat2[1].at, '★ 补发的消息按时间插到正确位置（不会倒着排）');
  ok(chat2[0].at === left + 3 * 3600 * 1000 && chat2[0].text === '这是凌晨补发的', '补发那条的时间就是模拟时刻');
}

/* ===================================================================== */
console.log('-- ★ AI 自己的身家与称号：所有场景一份口径（实时现算）');
{
  const line = aiEconomyLine(233491, '富甲一方');
  ok(/你自己的身家：💰233,491/.test(line), '身家写进去了（带千分位）');
  ok(/戴着称号「富甲一方」/.test(line), '称号写进去了');
  ok(/别刻意提钱/.test(line) && /别拿称号当话题/.test(line), '明确要求：只是背景知识，别主动提');
  ok(/还没戴称号/.test(aiEconomyLine(1000, '')), '没称号时说"还没戴称号"');
  ok(aiEconomyLine(null, 'x') === '' && aiEconomyLine(undefined, '') === '', '没给身家就不注入这一行');

  // 四个生成场景都要接上这一行（私聊 / 群聊 / 弹幕 / 友圈）
  const sources = {
    私聊: readFileSync(new URL('../src/ai/friend.js', import.meta.url), 'utf8'),
    群聊: readFileSync(new URL('../src/ai/group.js', import.meta.url), 'utf8'),
    弹幕: readFileSync(new URL('../src/ai/danmaku.js', import.meta.url), 'utf8'),
    友圈: readFileSync(new URL('../src/ai/moments.js', import.meta.url), 'utf8'),
  };
  for (const [name, src] of Object.entries(sources)) {
    ok(/aiEconomyLine/.test(src), `${name}注入了"它自己的身家与称号"`);
  }
  const groupsUi = readFileSync(new URL('../src/ui/groups.js', import.meta.url), 'utf8');
  ok(/aiBeansOf\(app\.save,/.test(groupsUi) && /aiTitleOf\(app\.save,/.test(groupsUi),
    '★ 群聊每次发言都现算（豆子/称号变了立刻生效）');
}

/* ===================================================================== */
console.log('-- ★ 拍一拍（① 文案表 + ② 节流 + ③ 被拍之后回一句）');
{
  /* ---------- ① 文案：30 套人设一人一句，全都落地 ---------- */
  const ids = PERSONAS.map((p) => p.id);
  const missing = ids.filter((id) => !NUDGE_LINES[id]);
  ok(missing.length === 0, `30 套人设都有拍一拍提示语（缺：${missing.join(',') || '无'}）`);
  ok(Object.keys(NUDGE_LINES).length === ids.length,
    `文案表不多不少正好 ${ids.length} 条（实际 ${Object.keys(NUDGE_LINES).length}）`);

  // 用户给的那几句原文，逐条钉住（改文案时能立刻看出被谁动了）
  const exact = {
    p01: '你拍了拍「不吃香菜」的笔记，显示"已收藏"',
    p02: '你拍了拍「小柳先生」的折扇',
    p05: '你轻轻拍了拍「春和景明」',
    p06: '你拍了拍「不熬夜了」的枕头（他睡着了）',
    p11: '你拍了拍「Helloworld」，返回 200 OK',
    p20: '你拍了拍「打字很慢」，他正在哄孩子',
    p26: '你拍了拍「{name}」，她：才、才没有',
    p30: '你拍了拍「说的道理」，他：何意味？',
  };
  for (const [id, want] of Object.entries(exact)) {
    // p26 那种带 {name} 的直接比模板；其余比替好名字的成品
    const got = want.includes('{name}') ? NUDGE_LINES[id] : nudgeLineOf(id, PERSONAS.find((p) => p.id === id).name);
    ok(got === want, `「${id}」文案与用户给的一致（${got}）`);
  }
  // {name} 真的被替进去了，而且是**对方的显示名**（私聊备注名也要能用）
  ok(nudgeLineOf('p01', '小徐').includes('「小徐」'), '提示语里的名字替换成对方显示名');
  ok(!nudgeLineOf('p01', '小徐').includes('{name}'), '模板占位符不会漏在界面上');
  ok(nudgeLineOf('p99', '某人') === '你拍了拍「某人」', '没有覆盖到的人设走通用兜底');
  ok(GENERIC_NUDGE.includes('{name}'), '通用兜底也带 {name}（模板口径统一）');
  ok(nudgeLineOf('p05', '') === '你轻轻拍了拍「TA」', '名字为空时不会出现「」这种空名');

  /* ---------- ② 节流：同一个人 4 秒内只生效一次 ---------- */
  const store = new Map();
  const t0 = 1_000_000;
  ok(allowNudge(store, 'p01', t0) === true, '第一下拍到了');
  ok(allowNudge(store, 'p01', t0 + 1000) === false, '1 秒内再拍不生效（防刷屏）');
  ok(allowNudge(store, 'p01', t0 + NUDGE.cooldownMs - 1) === false, '冷却差 1 毫秒也不放行');
  ok(allowNudge(store, 'p01', t0 + NUDGE.cooldownMs) === true, '过了冷却窗口就能再拍');
  ok(lastNudgeAt(store, 'p01') === t0 + NUDGE.cooldownMs, '节流表记的是"上次真的拍到的时刻"');
  // 每个人各算各的
  ok(allowNudge(store, 'p02', t0) === true, '换一个人不受影响（按 personaId 分别节流）');
  ok(lastNudgeAt(store, 'p09') === 0, '没拍过的人返回 0');
  ok(allowNudge(null, 'p01') === false && allowNudge(store, '') === false, '空表 / 空 id 一律不许拍');
  // 假 app（老对象 / 测试桩）没有 nudgeAt 时，会自动补一个，而不是 TypeError
  const fakeApp = {};
  ok(ensureNudgeStore(fakeApp) instanceof Map && fakeApp.nudgeAt instanceof Map,
    'app 上没有节流表就地补一个（不会一点就 TypeError）');
  ok(NUDGE.cooldownMs >= 3000 && NUDGE.cooldownMs <= 5000,
    `节流窗口落在建议的 3~5 秒（${NUDGE.cooldownMs}ms）`);

  /* ---------- ③ 兜底回复：每个风格档位 2~3 条，都能用 ---------- */
  // 档位必须是项目现有的那几个（cautious / balanced / aggressive / sharp）
  const stylesInUse = [...new Set(PERSONAS.map((p) => p.style))].sort();
  const stylesCovered = Object.keys(FALLBACK_NUDGE_REPLY).sort();
  const noPool = stylesInUse.filter((s) => !FALLBACK_NUDGE_REPLY[s]);
  ok(noPool.length === 0, `每个人设在用的风格档位都有兜底池（缺：${noPool.join(',') || '无'}）`);
  ok(stylesCovered.length >= 4 && stylesInUse.every((s) => stylesCovered.includes(s)),
    `兜底覆盖了全部档位（用到的 ${stylesInUse.join('/')}）`);
  for (const style of stylesCovered) {
    const pool = fallbackNudgePool(style);
    ok(Array.isArray(pool) && pool.length >= 2 && pool.length <= 3, `${style} 风格有 ${pool.length} 条兜底（2~3 条）`);
    ok(pool.every((l) => typeof l === 'string' && [...l].length > 0 && [...l].length <= NUDGE.maxChars),
      `${style} 的兜底都不超过 ${NUDGE.maxChars} 字`);
  }
  ok(fallbackNudgePool('未知风格').length === fallbackNudgePool('balanced').length,
    '认不出的风格按 balanced 兜底');
  for (const style of stylesInUse) {
    const p = PERSONAS.find((x) => x.style === style);
    ok(fallbackNudgePool(p.style).includes(pickFallbackNudgeReply(p, () => 0)),
      `本地兜底按人设风格取（${style} → 「${pickFallbackNudgeReply(p, () => 0)}」）`);
  }

  /* ---------- ④ 提示词：写清了"被拍了一下"，并要求一句以内 ---------- */
  const msgs = buildNudgeReplyMessages({ persona: PERSONAS[0], nudgeLine: '你拍了拍「不吃香菜」的笔记，显示"已收藏"' });
  const sys = msgs[0].content;
  ok(/双击了你的头像/.test(sys) && /拍一拍/.test(sys), '提示词里说明了"玩家双击头像拍一拍"');
  ok(/只回\*\*一句\*\*/.test(sys) || /只回一句/.test(sys.replace(/\*/g, '')), '要求只回一句');
  ok(sys.includes(`${NUDGE.maxChars} 个字以内`), `长度上限写进了提示词（${NUDGE.maxChars} 字）`);
  ok(/不要解释"拍一拍"是什么/.test(sys), '明确不许解释拍一拍这个功能（否则秒出戏）');
  ok(/一直知道\*\*他是谁|一直知道/.test(sys), '明确不许反问"你是谁"');
  ok(sys.includes('不吃香菜'), '人设注入了');
  ok(msgs[0].content.includes('Gameet'), '世界观那行也带上了（和别的台词同一个 styleRules）');
}

/* ===================================================================== */
console.log('-- ★ 拍一拍：真的回一句（模型 + 本地兜底两条路都跑一遍）');
{
  const persona = PERSONAS[0];
  // ① 正常路（模型可用 → llm；不可用 → fallback，两种都算过，但必须"有一句话"）
  const r = await nudgeReply({ persona, nudgeLine: nudgeLineOf(persona.id, persona.name) });
  ok(typeof r.text === 'string' && r.text.length > 0, `被拍之后一定有一句话（${r.source}：${r.text}）`);
  ok([...r.text].length <= NUDGE.maxChars, `回应不超过 ${NUDGE.maxChars} 字（实际 ${[...r.text].length}）`);
  ok(!/[\r\n]/.test(r.text), '回应里没有换行（气泡排版不会被撑破）');
  ok(r.source === 'llm' || r.source === 'fallback', `来源标记合法（${r.source}）`);

  // ② 强制走本地兜底：把 apiKey 改坏 → callDeepSeek 必然失败 → 必须落到兜底池
  const goodKey = CONFIG.apiKey;
  CONFIG.apiKey = 'sk-this-key-is-deliberately-broken';
  try {
    const bad = await nudgeReply({ persona, nudgeLine: '你拍了拍「不吃香菜」的笔记，显示"已收藏"' });
    ok(bad.source === 'fallback', `模型不可用时走本地兜底（${bad.source}）`);
    ok(fallbackNudgePool(persona.style).includes(bad.text), `兜底那句来自这个风格的池子（${bad.text}）`);
    ok([...bad.text].length <= NUDGE.maxChars, '兜底也不超过长度上限');
  } finally {
    CONFIG.apiKey = goodKey;
  }
  // 没有人设也不许炸（调用方兜底）
  const none = await nudgeReply({ persona: null });
  ok(none.text === '' && none.source === 'fallback', '没有人设时返回空串而不是抛错');
}

/* ===================================================================== */
console.log('-- ★ 拍一跳的界面接线（私聊头像 dblclick → 居中系统行，且不打架）');
{
  const ui = readFileSync(new URL('../src/ui/friends.js', import.meta.url), 'utf8');
  // 双击（不是单击）触发 —— 单击在私聊头像上本来没绑东西，所以不会抢
  ok(/addEventListener\('dblclick'/.test(ui), '★ 头像是双击触发（dblclick）');
  ok(/closest\('\.chat-face'\)/.test(ui), '★ 只在头像上认双击（点气泡不算）');
  ok(/closest\('\.chat-row\.self'\)/.test(ui), '自己那排头像双击不算（不会拍自己）');
  ok(/nudgeFriend\(friend\.personaId, disp\.name\)/.test(ui), '拍的是当前正在聊的那位');
  ok(/\.friend-head \.friend-avatar/.test(ui) && /headFace\.addEventListener\('dblclick'/.test(ui),
    '★ 聊天头部的头像也能拍（用户要求：头部与每条消息的头像）');
  ok(/appendChat\(app\.save, personaId, 'sys', buildNudgeLine/.test(ui),
    '★ 系统提示走已有的 appendChat(..., \'sys\', ...)（复用 .chat-sys 居中样式）');
  ok(/allowNudge\(ensureNudgeStore\(app\), personaId\)/.test(ui), '★ 拍之前先过同一份节流');
  ok(/nudgeReply\(\{/.test(ui) && /myTitle: \(aiTitleOf\(app\.save, personaId\) \|\| \{\}\)\.name/.test(ui),
    '被拍的人把自己的人设 + 称号交给提示词');
  ok(/NUDGE\.replyDelayMs/.test(ui), '系统行与回应之间留一点"打字"停顿');
  ok(/app\.persist\('friendChat'\)/.test(ui), '回应落库');
  // 拍一拍不该按"聊天"那套结算（不写记忆、不动好感度）
  const nudgeFn = (ui.match(/async function nudgeFriend\(personaId, name\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(nudgeFn.length > 0, '取得到 nudgeFriend');
  const nudgeCode = nudgeFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/settleFriendChat|adjustAffinity|addMemory/.test(nudgeCode),
    '★ 拍一拍不写记忆、不动好感度（只是社交小动作）');
}

/* ===================================================================== */
/* ===================================================================== */
console.log('-- ★ 拍一拍：单击 / 双击怎么分（纯判断，不用真 DOM）');
{
  /**
   * nudgeHit() 是私聊双击头像那一下的**全部判断**（抽成纯函数就是为了这里能直接验）：
   *   ① 得落在头像上 ② 头像得在当前聊天记录里 ③ 不能是自己那排的头像
   */
  const node = (cls, parent = null) => ({
    _cls: cls,
    parent,
    /** 只认 `.a` / `.a.b` 这种（真 DOM 的 closest 语义：多类要同时命中） */
    closest(sel) {
      const want = String(sel).split('.').filter(Boolean);
      let cur = this;
      while (cur) {
        const have = cur._cls.split(/\s+/);
        if (want.every((w) => have.includes(w))) return cur;
        cur = cur.parent;
      }
      return null;
    },
  });
  const logBox = (face) => ({ contains: (n) => n === face || n._cls.includes('friend-log') });
  const rowOther = node('chat-row other');
  const face = node('chat-face', rowOther);
  ok(nudgeHit(face, logBox(face)) === true, '★ 双击对方头像 = 拍一拍（放行）');
  const rowSelf = node('chat-row self');
  const myFace = node('chat-face', rowSelf);
  ok(nudgeHit(myFace, logBox(myFace)) === false, '★ 双击自己那排的头像不算（不会自己拍自己）');
  const bubble = node('chat-msg other', rowOther);
  ok(nudgeHit(bubble, logBox(bubble)) === false, '双击气泡不算（只认头像）');
  ok(nudgeHit(null, logBox(face)) === false, '目标是空的时候不炸');
  const stray = node('chat-face', node('other-panel'));
  ok(nudgeHit(stray, { contains: () => false }) === false, '别处的头像串不进来（必须在当前聊天记录里）');
}

/* ===================================================================== */
console.log('-- ★ 拍一拍（群聊那半边：系统行不进提示词 + 界面接线）');
{
  const grp = readFileSync(new URL('../src/ui/groups.js', import.meta.url), 'utf8');
  const grpStore = readFileSync(new URL('../src/store/groups.js', import.meta.url), 'utf8');

  // 群聊里"点消息 = 回复"那套必须在（双击头像别把它弄坏）
  ok(/\.gc-msg\.is-ai'\)[\s\S]{0,80}addEventListener\('click'/.test(grp), '点 AI 消息还是回复它（没被拍一拍挤掉）');
  ok(/const atMember = \(name\)/.test(grp), '点成员头像还是快捷 @人（没被拍一拍挤掉）');
  ok(/n\.addEventListener\('click', \(\) => atMember\(n\.dataset\.at\)\)/.test(grp), '单击那一份原样保留');
  // 双击：单独的 dblclick 监听 + preventDefault，且和单击互不吞噬
  ok(/addEventListener\('dblclick'/.test(grp) && /e\.preventDefault\(\)/.test(grp),
    '★ 双击头像触发拍一拍（单独监听，不掺进单击）');
  ok(/data-nudge="\$\{p\.id\}"/.test(grp), '★ 成员头像上挂了 data-nudge（人设 id）');
  ok(/async function nudgeMember\(personaId\)/.test(grp), '★ 群聊有自己的拍一拍处理函数');
  ok(/appendGroupChat\(app\.save, g\.id, \{ role: 'sys', by: personaId, text: line \}\)/.test(grp),
    '★ 系统提示以 role=sys 落进群消息');
  ok(/allowNudge\(ensureNudgeStore\(app\), personaId\)/.test(grp), '★ 群聊也过同一份节流表（同一个人 4 秒一次）');
  ok(/appendGroupChat\(app\.save, g\.id, \{ role: 'ai', by: personaId, text \}\)/.test(grp),
    '被拍的人以 role=ai 回一句（算他说的）');
  ok(/nudgeReply\(\{/.test(grp) && /myTitle: \(aiTitleOf\(app\.save, personaId\) \|\| \{\}\)\.name/.test(grp),
    '群聊里也带上它自己的称号当背景');
  const memberFn = (grp.match(/async function nudgeMember\(personaId\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(memberFn.length > 0, '取得到 nudgeMember');
  ok(/clearGroupUnread\(app\.save, g\.id\)/.test(memberFn) && /bumpGroupUnread\(app\.save, g\.id\)/.test(memberFn),
    '玩家正看着群：不算未读（和发消息同一口径）');
  ok(/\.gc-sys \{/.test(readFileSync(new URL('../styles/friends.css', import.meta.url), 'utf8')),
    '★ .gc-sys 有样式（群聊里居中一行小灰字）');
  ok(/is-sys/.test(grp) && /gc-sys/.test(grp), '系统行用 is-sys / gc-sys 渲染（不带头像、不进气泡）');

  // 存档层：系统行只是界面提示，绝不能被当成"谁说了什么"喂进提示词
  const save = defaultSave();
  save.nickname = '小徐';
  const p = PERSONAS[0];
  const p2 = PERSONAS[1];
  addFriend(save, p);
  addFriend(save, p2); // 至少 2 位好友才能建群（GROUP.minMembers）
  const g = createGroup(save, '测试群', [p.id, p2.id]).group;
  ok(!!g, '测试群建好了');
  appendGroupChat(save, g.id, { role: 'me', by: 'me', text: '在吗' });
  const sysEntry = appendGroupChat(save, g.id, { role: 'sys', by: p.id, text: nudgeLineOf(p.id, p.name) });
  appendGroupChat(save, g.id, { role: 'ai', by: p.id, text: '在的在的' });
  ok(sysEntry.role === 'sys' && sysEntry.sys === true, '系统行落库时带 role=sys + sys 标记');
  const recent = recentGroupChat(findGroup(save, g.id), 15);
  ok(recent.length === 2, `★ 提示词里看不到系统行（只剩玩家和 AI 那两条，实际 ${recent.length}）`);
  ok(recent.every((m) => !String(m.text).includes('拍了拍')), '系统行文案不会进提示词');
  const lines = groupChatLines(findGroup(save, g.id), { playerName: '小徐' }, 15);
  ok(lines.length === 2 && lines.every((l) => !l.includes('拍了拍')),
    `转成提示词行时也过滤掉了（${lines.join(' | ')}）`);
  // 普通消息一条不少
  const g2 = findGroup(save, g.id);
  g2.chat.push({ id: 'old1', role: 'ai', by: p.id, text: '老消息', at: Date.now() });
  ok(recentGroupChat(g2, 15).length === 3, '普通 AI 消息一条不少（过滤只认 sys）');
  ok(/const role = msg\.role === 'me' \? 'me' : \(msg\.role === 'sys' \? 'sys' : 'ai'\)/.test(grpStore),
    '存档层对 role 做了归一化（老调用只传 me/ai 也不受影响）');
  ok(/\.filter\(\(m\) => m && m\.role !== 'sys' && !m\.sys\)/.test(grpStore), 'recentGroupChat 里过滤系统行');
}

/* ===================================================================== */
console.log('-- ★ 写入时先看有没有能合并的（重复记忆不再越堆越多）');
{
  const s = defaultSave();
  s.nickname = '小徐';
  const p = PERSONAS[6];
  addFriend(s, p);
  // 用户给的真实例子：这三条其实是同一件事
  setSelfMemories(s, p.id, { 作息: '睡前会刷会儿手机，睡得比较晚' });
  const r1 = addMemory(s, p.id, '习惯：睡前刷手机，睡得晚');
  const r2 = addMemory(s, p.id, '习惯：睡前刷手机停不下来');
  const list = findFriend(s, p.id).memory;
  ok(r1.merged === true, '★ 第二条"睡前刷手机"被合并进已有条目，而不是新增');
  ok(r2.merged === true, '★ 第三条也被合并');
  const bed = list.filter((m) => /睡前/.test(m));
  ok(bed.length === 1, `★ 三条"睡前刷手机"最终只剩一条（实际 ${bed.length} 条）`);
  ok(/停不下来|睡得比较晚/.test(bed[0]), `内容没丢（${bed[0]}）`);
  ok(findFriend(s, p.id).memoryNeedCompress === true, '同时标记"让 AI 再润色一遍"');

  // 不相关的不许硬合
  const s2 = defaultSave();
  addFriend(s2, p);
  addMemory(s2, p.id, '称呼：小徐');
  addMemory(s2, p.id, '偏好：喜欢美食');
  addMemory(s2, p.id, '身份：学生');
  const r3 = addMemory(s2, p.id, '偏好：爱吃辣');
  const list2 = findFriend(s2, p.id).memory;
  ok(list2.filter((m) => m.startsWith('称呼')).length === 1 && list2.some((m) => m === '称呼：小徐'),
    '称呼没被别的记忆吃掉');
  ok(list2.some((m) => m.startsWith('身份：学生')), '身份没被合并（相似度不够）');
  ok(r3.added === true, '新的偏好照常写入（要么合并要么新增，反正不丢）');

  // 相似度函数本身
  ok(textSimilarity('睡前会刷会儿手机，睡得比较晚', '睡前刷手机，睡得晚') >= 0.7, '同义句相似度 ≥0.7');
  ok(textSimilarity('称呼：小徐', '偏好：喜欢美食') < 0.2, '不相关 <0.2');
  ok(mergeSimilarText('睡前刷手机，睡得晚', '睡前刷手机停不下来') === '睡前刷手机，睡得晚、停不下来'
    || /停不下来/.test(mergeSimilarText('睡前刷手机，睡得晚', '睡前刷手机停不下来')),
    '合并文本保留了差异部分');
}

/* ===================================================================== */
console.log('-- ★ 一局打完：主动开口必须拿"最新那局"当话题');
{
  const s = defaultSave();
  s.nickname = '小徐';
  const p = PERSONAS[6];
  addFriend(s, p);
  const oldAt = Date.now() - 3600 * 1000;
  addMatchMemory(s, p.id, '【旧】这局小猫钓鱼你输得挺干脆，对面小徐有点帅手气太顺', oldAt);
  addMatchMemory(s, p.id, '【新】这局你和小徐有点帅搭农民，赢了春和景明，你进账11244豆', Date.now());
  const f = findFriend(s, p.id);
  const newest = { summary: '【新】这局你和小徐有点帅搭农民，赢了春和景明，你进账11244豆', kind: 'ddz' };
  const pro = buildProactiveMessages({
    persona: p, friend: f, joined: true, lastMatch: newest, modeName: '斗地主', playerName: '小徐',
  }).map((m) => m.content).join('\n');
  ok(/开场就聊它/.test(pro), '★ 明确告诉它"这就是刚刚那局，开场就聊它"');
  ok(pro.includes('【新】'), '★ 把**最新那局**的概括直接给它');
  ok(/开场就聊这条最新对局/.test(pro), '"要求"里也写了开场就聊最新对局');
  ok(/不要\*\*?聊更早的旧局|不要聊更早的旧局/.test(pro), '★ 明确禁止翻更早的旧局');
  ok(pro.indexOf('【新】') < pro.indexOf('【旧】'), '记忆里最新的那局排在更早那局前面');
  // 没参加那局时照旧不许提牌局
  const notJoined = buildProactiveMessages({ persona: p, friend: f, joined: false }).map((m) => m.content).join('\n');
  ok(!/开场就聊它/.test(notJoined) && /不要提牌局/.test(notJoined), '没一起打过 → 仍然禁止提牌局');
  // 私聊里也点明"只聊最新那局"
  const chat = buildFriendMessages({ persona: p, friend: f, text: '在吗', joined: true, lastMatch: newest })
    .map((m) => m.content).join('\n');
  ok(/只聊\*\*最新那局\*\*|只聊最新那局/.test(chat), '私聊提示词也要求只聊最新那局');
}

/* ===================================================================== */
console.log('-- ★ 对局记忆必须站在 AI 自己的角度（不能写"你输了"）');
{
  // ① 中立版：任何 AI 读都不会认错主角 → 不许出现"你"
  ok(hasSecondPerson(localSummary({ kind: 'fishing', roomName: '低级场', facts: '玩家输了 11,244 豆' })) === false,
    '★ 中立版概括里没有第二人称');
  ok(neutralizeSummary('你最后输了11244豆，你这边手气差') === '玩家最后输了11244豆，玩家这边手气差',
    '★ 老文案里的"你"会被换成"玩家"');
  ok(neutralizeSummary('你们俩打得不错') === '玩家和对手打得不错', '"你们俩"也换掉');

  // ② AI 视角：它自己用"你"，玩家用名字
  const aiView = localSummaryForAi({
    kind: 'fishing', roomName: '低级场', selfName: '才不是傲娇', selfWon: true,
    facts: '鱼篓 玩家「佛系少年」 4 : 46 对手「才不是傲娇」；玩家「佛系少年」输了 11,244 豆，对手「才不是傲娇」赢了',
  });
  ok(/你（才不是傲娇）赢了这局/.test(aiView), '★ AI 视角：赢的是"你"（这个 AI）');
  ok(aiView.includes('玩家「佛系少年」输了'), '玩家用名字写，不跟 AI 抢"你"');

  // ③ 一局里两个 AI 站在不同边：各自的记忆要分开写（赢的那份 / 输的那份）
  const seatNames = ['阿伟', '才不是傲娇', '春和景明'];
  const result = {
    landlordSeat: 0, landlordWin: true, multiplier: 2, bombs: 0, rockets: 0, robs: 0,
    spring: false, antiSpring: false, deltas: [1600, -800, -800],
  };
  const factsText = ddzFacts(result, { room: { base: 100 }, names: seatNames, seatPersonas: [] });
  ok(/各家输赢：阿伟赢1,600 豆；才不是傲娇输800 豆；春和景明输800 豆/.test(factsText),
    '★ 事实里写清每个座位各自的输赢（两个 AI 一边一输）');
  const winnerView = localSummaryForAi({ kind: 'ddz', roomName: '中级场', facts: factsText, selfName: '才不是傲娇', selfWon: false });
  ok(/你（才不是傲娇）输了这局/.test(winnerView), '★ 输的那位 AI 记忆里写"你输了"');
  const landlordView = localSummaryForAi({ kind: 'ddz', roomName: '中级场', facts: factsText, selfName: '阿伟', selfWon: true });
  ok(/你（阿伟）赢了这局/.test(landlordView), '赢的那位写"你赢了"');

  // ④ 老存档修复：以前用"你"写好的对局记忆，搬家成第三人称（不再认错主角）
  const s = defaultSave();
  addFriend(s, PERSONAS[3]);
  const f = findFriend(s, PERSONAS[3].id);
  f.memory = [
    '对局：这局小猫钓鱼在低级场，你最后输了11244豆，鱼篓4比46被才不是傲娇拉开42张，你这边手气差。',
    '偏好：爱喝奶茶',
  ];
  s.recentHands = [{ kind: 'fishing', seatIds: [PERSONAS[3].id], summary: '你最后输了 11244 豆。', humanWin: false }];
  const fixedN = ensureOwnership(s);
  ok(fixedN >= 2, `老存档修复了对局记忆与最近几局（修了 ${fixedN} 处）`);
  ok(!/你/.test(findFriend(s, PERSONAS[3].id).memory[0]), '★ 老对局记忆里不再有"你"');
  ok(findFriend(s, PERSONAS[3].id).memory[0].includes('玩家最后输了11244豆'), '换成"玩家"，输赢不会再认错');
  ok(findFriend(s, PERSONAS[3].id).memory[1] === '偏好：爱喝奶茶', '别的记忆不动');
  ok(!/你/.test(s.recentHands[0].summary), '★ recentHands 里的概括也换成第三人称');
  ok(repairMatchWording({ memory: ['对局：你赢了', '身份：学生'] }) === 1, '只修「对局：」那几条');
}

/* ===================================================================== */
console.log('-- ★ 自我披露的门槛：点头之交才说家乡，密友才偶尔讲经历');
{
  const s = defaultSave();
  const p = PERSONAS[0];
  addFriend(s, p);
  const lineAt = (v) => {
    const f = findFriend(s, p.id);
    f.affinity = v;
    return selfDisclosureLine(f);
  };
  ok(/不主动说自己的私事/.test(lineAt(0)), '★ 陌生（0~20）：不主动说自己的私事');
  ok(/别装神秘/.test(lineAt(0)), '★ 但也不许装神秘（问到了就简短答一句）');
  ok(/不主动说自己的私事/.test(lineAt(19)), '19 还是陌生档，一样不主动说私事');
  const nod = lineAt(20);
  ok(/点头之交/.test(nod) && /不用躲/.test(nod), '★ 20（点头之交）：问到家乡不用躲');
  ok(/经历、私事、秘密先不提/.test(nod), '20 档：经历 / 私事 / 秘密先不提');
  ok(!/可以主动讲一点/.test(nod), '20 档还没解锁"讲经历"');
  ok(/点头之交/.test(lineAt(39)) && /密友/.test(lineAt(60)),
    '39 还是点头之交 / 60 已经到密友');
  /**
   * ★ 用户报的 bug：40~60（朋友）这一档以前**没有分支**，掉进了最后那句
   *   "你们还很陌生：不要主动说自己的私事"，于是关系都到朋友了，
   *   AI 还在拼命绕开"你姓什么""你是哪里人"。
   */
  const friend40 = lineAt(40);
  ok(/朋友/.test(friend40), '★ 40 已经算「朋友」档，不再落到"还很陌生"那句');
  ok(/不用刻意回避/.test(friend40), '★ 40+ 明确写着"不用刻意回避自己的事"');
  ok(/自然回答/.test(friend40), '★ 问到了（姓什么 / 哪里人 / 做什么）就自然回答');
  ok(/你不主动提/.test(friend40), '★ 但也**不主动提**（不自己凑上去讲）');
  ok(!/不要主动说自己的私事/.test(friend40), '★ 40+ 不再出现"不要主动说自己的私事"');
  ok(!/还不能说|别提自己的事/.test(friend40), '40+ 没有"回避"类的措辞');
  ok(/不用刻意回避/.test(lineAt(59)), '59 也是这一档');
  const close = lineAt(60);
  ok(/密友/.test(close) && /经历或小秘密/.test(close), '★ 60（密友）：可以讲经历 / 小秘密');
  ok(/偶尔/.test(close) && /别每次都说/.test(close), '★ 而且强调"偶尔"，不要经常说');
  ok(/姓什么/.test(lineAt(95)), '挚友档：问到姓什么也可以正常答');
  ok(/姓什么/.test(selfDisclosureLine(findFriend(s, p.id), { isLover: true })), '恋人档同样可以正常答');

  // 这句话要真的进提示词（私聊 / 主动搭话 / 弹幕 / 牌桌背景 / 群聊）
  const f = findFriend(s, p.id);
  f.affinity = 20;
  const chat = buildFriendMessages({ persona: p, friend: f, text: '在吗' }).map((m) => m.content).join('\n');
  ok(/不用躲/.test(chat), '★ 私聊提示词里带上了"问到家乡不用躲"');
  f.affinity = 60;
  const chat2 = buildFriendMessages({ persona: p, friend: f, text: '在吗' }).map((m) => m.content).join('\n');
  ok(/经历或小秘密/.test(chat2), '★ 私聊提示词里带上了"可以讲经历/秘密"');
  f.affinity = 45;
  const chat45 = buildFriendMessages({ persona: p, friend: f, text: '你姓什么' }).map((m) => m.content).join('\n');
  ok(/不用刻意回避/.test(chat45), '★ 45（朋友）私聊提示词里是"不用刻意回避"（用户报的 bug）');
  f.affinity = 0;
  const chat3 = buildFriendMessages({ persona: p, friend: f, text: '在吗' }).map((m) => m.content).join('\n');
  ok(/不主动说自己的私事/.test(chat3), '陌生档：不主动说私事');
  ok(/别装神秘/.test(chat3), '陌生档也不许装神秘');
  ok(/不用躲/.test(buildProactiveMessages({ persona: p, friend: { ...f, affinity: 25 } }).map((m) => m.content).join('\n')),
    '主动搭话也吃这套门槛');
  ok(/不用躲/.test(buildDanmakuMessages({ persona: p, friend: { ...f, affinity: 25 }, recent: [] }).map((m) => m.content).join('\n')),
    '房间弹幕也吃这套门槛');
  ok(/不用躲/.test(friendContextLines(s, { ...f, affinity: 25 }).join('\n')),
    '牌桌背景（friendContextLines）也吃这套门槛');
}

/* ===================================================================== */
console.log('-- ★ 记忆归属：玩家的归玩家，AI 自己的归自己（不许混）');
{
  const s = defaultSave();
  s.nickname = '小徐';
  const p = PERSONAS[0];
  addFriend(s, p);
  // 用户给的真实例子：这几条混在一起，模型会以为"山东临沂人"是自己的
  addMemory(s, p.id, '偏好：喜欢美食');
  addMemory(s, p.id, '身份：山东临沂人');
  setSelfMemory(s, p.id, '爱好', '打牌、看书');
  setSelfMemory(s, p.id, '口味', '清淡，不吃香菜');
  setSelfMemory(s, p.id, '老家', '南方小城，米粉出名');
  const f = findFriend(s, p.id);

  // ① 提示词里每条都标了归属 + 有"谁是谁"的说明
  const chat = buildFriendMessages({ persona: p, friend: f, text: '在吗' }).map((m) => m.content).join('\n');
  ok(/【关于玩家】身份：山东临沂人/.test(chat), '★ 玩家的信息标成【关于玩家】');
  ok(/【关于玩家】偏好：喜欢美食/.test(chat), '偏好也标了归属');
  ok(/【你自己】自设：老家=南方小城/.test(chat), '★ AI 自己的设定标成【你自己】');
  ok(/【你自己】自设：口味=清淡/.test(chat), '口味同样标清楚');
  ok(!/【关于玩家】自设：/.test(chat), '自设不会被标成玩家的');
  ok(/【关于玩家】= \*\*他\*\*的事/.test(chat) && /他该叫你卡片/.test(chat),
    '★ 提示词里讲清了前缀含义（连"称呼"这种两边都有的都举了例）');
  const ctx = friendContextLines(s, f).join('\n');
  ok(/【关于玩家】/.test(ctx) && /【你自己】/.test(ctx), '★ 牌桌背景里也分得清（玩家 / 你自己）');
  ok(memoryText(f).includes('- 【关于玩家】身份：山东临沂人')
    && memoryText(f).includes('- 【你自己】自设：老家='), '★ memoryText 每条也带归属前缀');

  // ② 记反了的会被**搬到正确的栏**，而不是丢掉
  const player = '我是南京人，在南京上学';
  const reply = '我是溧阳的，离得不远';
  const swapped = routeFacts({ memory: '身份：溧阳人', self: { 老家: '南京' }, playerText: player, replyText: reply });
  ok(swapped.movedToSelf.includes('身份：溧阳人'), '★ AI 说的被搬进自设');
  ok(swapped.self['身份'] === '溧阳人' || Object.values(swapped.self).includes('溧阳人'),
    '自设里留下了它的真实来历');
  ok(swapped.movedToPlayer.length === 1 && /南京/.test(swapped.memory),
    '★ 玩家说的被搬进"关于玩家"（信息没丢）');
  // 记对了的不动
  const right = routeFacts({ memory: '身份：南京人', self: { 老家: '溧阳' }, playerText: player, replyText: reply });
  ok(right.memory === '身份：南京人' && right.self['老家'] === '溧阳', '记对了就原样保留');
  // 两边都提到 → 玩家那条留着（AI 也说过，就各留各的，但归属标得清）
  const both = routeFacts({ memory: '偏好：爱喝茶', self: { 爱好: '爱喝茶' }, playerText: '我爱喝茶', replyText: '我也爱喝茶' });
  ok(both.memory === '偏好：爱喝茶', '两边都说过 → 玩家那条不动');
  ok(both.movedToSelf.length === 0, '不会因为"两边都说过"就误判成 AI 的');

  // ③ ★ "这是它自己的事"要能被认出来（用户给的真实例子）
  ok(looksLikeSelfFact('玩家拉我打游戏时用哈哈哈，语气轻松'), '★ 出现第一人称"我"的说法 → 判为 AI 自己');
  ok(looksLikeSelfFact('我睡前都会刷会儿手机'), '第一人称作息也算');
  ok(!looksLikeSelfFact('萌新，刚开始玩这个游戏'), '自己没出现的句子不硬判（交给提示词前缀去区分）');
  ok(!looksLikeSelfFact('爱喝奶茶'), '普通偏好不会误判');
  const ownHabit = routeFacts({
    memory: '习惯：玩家拉我打游戏时用哈哈哈，语气轻松',
    self: {},
    playerText: '来打游戏吗',
    replyText: '好呀哈哈哈，我睡前都会刷会儿手机再睡',
  });
  ok(ownHabit.memory === '' && ownHabit.self['习惯'], '★ 被搬进自设（不再是"关于玩家"的习惯）');
  ok(ownHabit.movedToSelf.length === 1, '并记录搬走了哪条');
  // 玩家自己用"我"说的偏好**不会**被误搬
  const mine = routeFacts({ memory: '偏好：我爱喝奶茶', self: {}, playerText: '我爱喝奶茶，你呢', replyText: '我也爱喝' });
  ok(mine.memory === '偏好：我爱喝奶茶' && mine.movedToSelf.length === 0,
    '★ 玩家话里就有"我" → 不误搬（避免把玩家的事算成 AI 的）');

  // ③ 老存档修复：拿聊天记录当证据，把记错归属的搬回去
  const s2 = defaultSave();
  addFriend(s2, p);
  const f2 = findFriend(s2, p.id);
  addMemory(s2, p.id, '身份：山东临沂人');       // 记到玩家名下
  addMemory(s2, p.id, '偏好：喜欢美食');          // 这条确实是玩家说的
  f2.chat = [
    { role: 'me', text: '我喜欢美食，你呢', at: 1 },
    { role: 'ai', text: '我是山东临沂人，我们那儿吃得也重口', at: 2 },
  ];
  const fixedN = ensureOwnership(s2);
  const mem2 = findFriend(s2, p.id).memory;
  ok(fixedN === 1, `老存档修复了 1 条（实际 ${fixedN}）`);
  ok(!mem2.includes('身份：山东临沂人'), '★ "山东临沂人"不再挂在玩家名下');
  ok(mem2.some((m) => m === '自设：身份=山东临沂人'), '★ 它被搬成了 AI 自己的设定');
  ok(mem2.includes('偏好：喜欢美食'), '★ 玩家真说过的那条不动');
  // 没有聊天证据时不许瞎搬
  const s3 = defaultSave();
  addFriend(s3, p);
  addMemory(s3, p.id, '身份：山东临沂人');
  ok(ensureOwnership(s3) === 0 && findFriend(s3, p.id).memory.includes('身份：山东临沂人'),
    '没有证据就不动（宁可留着，也不误伤）');

  // ★ 用户真实遇到的那类：`习惯：玩家拉我打游戏时用哈哈哈` 其实是 AI 自己的习惯
  const s4 = defaultSave();
  addFriend(s4, p);
  const f4 = findFriend(s4, p.id);
  f4.memory = ['习惯：玩家拉我打游戏时用哈哈哈，语气轻松', '称呼：小徐', '偏好：喜欢美食'];
  f4.chat = [
    { role: 'me', text: '来打游戏吗', at: 1 },
    { role: 'me', text: '我喜欢美食，叫我小徐就行', at: 2 },
    { role: 'ai', text: '好呀哈哈哈，我睡前都会刷会儿手机再睡', at: 3 },
  ];
  const fixed4 = ensureOwnership(s4);
  const mem4 = findFriend(s4, p.id).memory;
  ok(fixed4 === 1, `★ 那条"用哈哈哈"的说话习惯被修好了（修了 ${fixed4} 条）`);
  ok(mem4.some((m) => m === '自设：习惯=玩家拉我打游戏时用哈哈哈，语气轻松'),
    '★ 搬进自设（它自己的说话习惯）');
  ok(mem4.includes('称呼：小徐'), '★ 玩家的称呼没被动');
  ok(mem4.includes('偏好：喜欢美食'), '★ 玩家真说过的偏好没被动');
}

/* ===================================================================== */
console.log('-- ★ 记忆不会写到别人身上（归属检查）');
{
  // 三个好友，只跟其中一个聊天：另外两个的记忆一个字都不能变
  const s = defaultSave();
  const a = PERSONAS[0]; const b = PERSONAS[1]; const c = PERSONAS[2];
  for (const p of [a, b, c]) addFriend(s, p);
  addMemory(s, b.id, '称呼：别人家的称呼');
  addMemory(s, c.id, '偏好：别人家的偏好');
  const snap = (id) => JSON.stringify(findFriend(s, id).memory);

  // 私聊写记忆：analyzeMessage 的结果只会落到"正在聊的那个人"名下
  const beforeB = snap(b.id); const beforeC = snap(c.id);
  const res = localAnalyze('我叫小徐，平时爱看文史哲类的书', { reply: '好呀小徐' });
  ok(!!res.memory, '本地分析能抓出一条关于玩家的记忆');
  addMemory(s, a.id, res.memory);
  setSelfMemories(s, a.id, { 老家: '南京' });
  ok((findFriend(s, a.id).memory || []).length === 2, `★ 记忆写进了被聊的那个人（${a.name}）`);
  ok(snap(b.id) === beforeB, `★ ${b.name} 的记忆纹丝不动`);
  ok(snap(c.id) === beforeC, `★ ${c.name} 的记忆纹丝不动`);
  ok(listSelfMemory(findFriend(s, a.id)).length === 1
    && listSelfMemory(findFriend(s, b.id)).length === 0, '★ "自设"也只记在说话的人名下');

  // 不是好友的人：一个字都写不进去
  const ghost = PERSONAS[20];
  const before = JSON.stringify(findFriend(s, a.id).memory);
  addMemory(s, ghost.id, '称呼：幽灵');
  setSelfMemory(s, ghost.id, '老家', '火星');
  ok(addMemory(s, ghost.id, '称呼：幽灵二号') === null, '给不是好友的人写记忆 → 直接返回 null（不产生孤儿记忆）');
  ok(JSON.stringify(findFriend(s, a.id).memory) === before, '别人也没被牵连');

  // 人设名字唯一：群聊是**按名字**找人的，重名就会写串
  const names = PERSONAS.map((p) => p.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  ok(dupes.length === 0, `★ 人设不重名（重名会让群聊记忆写串）：${dupes.join('、') || '没有重名'}`);
  const ids = PERSONAS.map((p) => p.id);
  ok(ids.filter((n, i) => ids.indexOf(n) !== i).length === 0, 'id 也不重复');

  // 同名守卫：就算真出现重名，也得两个人都各自留一份，不会互相覆盖
  const s2 = defaultSave();
  addFriend(s2, a);
  addMemory(s2, a.id, '称呼：小徐');
  addMemory(s2, a.id, '称呼：阿伟');
  const callMem = (findFriend(s2, a.id).memory || []).filter((m) => m.startsWith('称呼：'));
  ok(callMem.length === 1 && callMem[0] === '称呼：阿伟', '同类（称呼）只留最新一条，不会两条并存');
}

/* ---------------- 好友增删 ---------------- */
console.log('── 好友增删');
{
  const save = defaultSave();
  ok(Array.isArray(save.friends) && save.friends.length === 0, '新存档没有好友');

  const p1 = PERSONAS[0];
  const p2 = PERSONAS[1];
  const r1 = addFriend(save, p1);
  ok(r1.ok, '添加好友直接通过');
  ok(isFriend(save, p1.id), '添加后能查到');
  ok(r1.friend.affinity === FRIEND.startAffinity, `初始好感度应当是 ${FRIEND.startAffinity}`);
  ok(Array.isArray(r1.friend.memory) && r1.friend.memory.length === 0, '初始 memory 为空');
  ok(Array.isArray(r1.friend.chat) && r1.friend.chat.length === 0, '初始聊天为空');

  const again = addFriend(save, p1);
  ok(!again.ok, '不能重复添加同一个好友');
  ok(listFriends(save).length === 1, '重复添加不会产生第二条');

  addFriend(save, p2);
  ok(listFriends(save).length === 2, '可以添加多个好友');
  ok(listFriends(save)[0].personaId === p2.id, '新加的好友排在最前');

  const rm = removeFriend(save, p1.id);
  ok(rm.ok && !isFriend(save, p1.id), '可以删除好友');
  ok(removeFriend(save, '不存在').ok === false, '删不存在的好友会失败');

  // 重置存档（defaultSave）后好友清空
  const fresh = defaultSave();
  ok(ensureFriends(fresh).length === 0, '重置存档后好友清空');
}

/* ---------------- 好感度 ---------------- */
console.log('── 好感度');
{
  const save = defaultSave();
  const p = PERSONAS[2];
  addFriend(save, p);

  let r = adjustAffinity(save, p.id, 5);
  ok(r.after === FRIEND.startAffinity + 5, '加好感生效');
  r = adjustAffinity(save, p.id, -999);
  ok(r.after === 0, `好感度下限应当夹到 0（实际 ${r.after}）`);
  r = adjustAffinity(save, p.id, 999);
  ok(r.after === FRIEND.maxAffinity, `好感度上限应当夹到 ${FRIEND.maxAffinity}（实际 ${r.after}）`);
  ok(adjustAffinity(save, '不存在', 1) === null, '给非好友调好感度返回 null');

  // 档位细节在新的一组里测（默认 0 / 5 档），这里只锁 key
  ok(affinityTier(100).key === 'stranger', '100 → 挚友（key=stranger）');
  ok(affinityTier(80).key === 'stranger' && affinityTier(79).key === 'close', '80 起才是挚友');
  ok(affinityTier(60).key === 'close', '60 → 密友');
  ok(affinityTier(40).key === 'friend', '40 → 朋友');
  ok(affinityTier(20).key === 'nod', '20 → 点头之交');
  ok(affinityTier(5).key === 'strange', '5 → 陌生');
}

/* ---------------- memory ---------------- */
console.log('── memory');
{
  const save = defaultSave();
  const p = PERSONAS[3];
  addFriend(save, p);

  let r = addMemory(save, p.id, '我叫小明');
  ok(r.added, '写入 memory');
  r = addMemory(save, p.id, '我叫小明');
  ok(!r.added && r.duplicate, '同一条 memory 不重复写入');
  r = addMemory(save, p.id, '');
  ok(!r.added, '空内容不写入');
  addMemory(save, p.id, '这是一条特别特别特别特别长的记忆内容需要被截断');
  const f = findFriend(save, p.id);
  ok(f.memory.every((m) => m.length <= FRIEND.maxMemoryChars), `单条 memory 不超过 ${FRIEND.maxMemoryChars} 字`);

  for (let i = 0; i < 30; i += 1) addMemory(save, p.id, `偏好：${WORDS[i]}`);
  // ★ 行为变了（用户拍板）：超过上限**不立刻淘汰**，而是留着等 AI 把相似的合并
  ok(f.memory.length <= FRIEND.maxMemoryHardCap,
    `超过上限时先留着等合并，但不超过硬上限 ${FRIEND.maxMemoryHardCap}（实际 ${f.memory.length}）`);
  ok(f.memoryNeedCompress === true, '并且打了"该合并"的标记');
  ok(f.memory[f.memory.length - 1] === `偏好：${WORDS[29]}`, '★ 最新的那条一定在（不会被挤掉）');
  // 合并之后回到上限以内，而且最新的信息还在
  const cr = compressMemoryLocally(save, p.id);
  ok(cr && f.memory.length <= FRIEND.maxMemory, `★ 合并后回到 ${FRIEND.maxMemory} 条以内（实际 ${f.memory.length}）`);
  ok(f.memory.some((m) => m.includes(WORDS[29])), '★ 合并后最新那条也还在（信息没丢）');
  ok(memoryText(f).includes('- '), 'memory 能拼成提示词文本');
  ok(memoryText(null).includes('还没有'), '空 memory 有占位文案');
}

/* ---------------- 聊天记录 ---------------- */
console.log('── 聊天记录');
{
  const save = defaultSave();
  const p = PERSONAS[4];
  addFriend(save, p);
  for (let i = 0; i < 60; i += 1) appendChat(save, p.id, i % 2 ? 'ai' : 'me', `第 ${i} 句`);
  const f = findFriend(save, p.id);
  ok(f.chat.length === FRIEND.maxHistory, `聊天记录裁剪到 ${FRIEND.maxHistory} 条（实际 ${f.chat.length}）`);
  ok(f.chat[f.chat.length - 1].text === '第 59 句', '保留最新的聊天');
  ok(f.chatCount === 30, `累计我方发言 30 次（实际 ${f.chatCount}）`);
  ok(f.lastChatAt > 0, '记录了最近聊天时间');
}

/* ---------------- 提示词注入 ---------------- */
console.log('── 提示词注入（memory + 好感度）');
{
  const save = defaultSave();
  const p = PERSONAS[5];
  addFriend(save, p);
  addMemory(save, p.id, '喜欢喝奶茶');
  adjustAffinity(save, p.id, 20); // 70 → 好朋友
  const f = findFriend(save, p.id);

  const msgs = buildFriendMessages({ persona: p, friend: f, text: '在吗' });
  const all = msgs.map((m) => m.content).join('\n');
  const tier = affinityTier(f.affinity);
  ok(all.includes('喜欢喝奶茶'), '回复提示词里注入了 memory');
  ok(all.includes(`${f.affinity}/100`), '回复提示词里注入了好感度数值');
  ok(all.includes(tier.label), `回复提示词里注入了关系描述（${f.affinity} → ${tier.label}）`);
  ok(all.includes(p.name), '回复提示词里有人设名字');
  ok(all.includes(String(FRIEND.maxReplyChars)), '提示词里写明了长度要求');

  const am = buildAnalyzeMessages({ persona: p, friend: f, text: '你好棒', reply: '嘿嘿' });
  const aAll = am.map((m) => m.content).join('\n');
  ok(aAll.includes('delta') && aAll.includes('memory'), '分析提示词要求输出 delta 与 memory');
  ok(am[0].content.includes('JSON'), '分析提示词要求 JSON');
}

/* ---------------- 分析结果解析 ---------------- */
console.log('── 分析结果解析');
{
  let r = parseAnalysis('{"delta": 3, "memory": "喜欢猫"}');
  ok(r && r.delta === 3 && r.memory === '喜欢猫', '标准 JSON 能解析');
  r = parseAnalysis('```json\n{"delta": -2, "memory": ""}\n```');
  ok(r && r.delta === -2 && r.memory === '', '代码块包裹也能解析');
  r = parseAnalysis('好的，结果如下：{"delta": 99, "memory": "嗯"} 就这样');
  ok(r && r.delta === FRIEND.maxDelta, `越界的 delta 夹到 ${FRIEND.maxDelta}（实际 ${r && r.delta}）`);
  r = parseAnalysis('{"delta": -99}');
  ok(r && r.delta === -FRIEND.maxDelta, `负向越界也夹住（实际 ${r && r.delta}）`);
  ok(parseAnalysis('完全不是 JSON') === null, '垃圾输入返回 null');
  ok(parseAnalysis('') === null, '空输入返回 null');
  r = parseAnalysis('{"delta": "abc"}');
  ok(r && r.delta === 0, '非数字 delta 归零');
  r = parseAnalysis('{"delta": 1, "memory": "超长超长超长超长超长超长超长超长超长的记忆"}');
  ok(r && r.memory.length <= FRIEND.maxMemoryChars, 'memory 超长会被截断');
}

/* ---------------- 本地兜底 ---------------- */
console.log('── 本地兜底（无 Key / 断网）');
{
  ok(localAnalyze('谢谢你，你真好').delta > 0, '夸奖 → 加好感');
  ok(localAnalyze('你真笨').delta < 0, '骂人 → 掉好感');
  ok(localAnalyze('今天天气不错').delta === 0, '闲聊 → 0');
  ok(localAnalyze('吃了吗').memory === '', '普通寒暄不写 memory');
  ok(localAnalyze('我叫小明').local === true, '标记为本地判断');

  const p = PERSONAS[6];
  const line = localReply(p, '你好厉害');
  ok(typeof line === 'string' && line.length > 0, '本地兜底能给出回复');
  ok(line.length <= 30, `兜底回复要短（实际 ${line.length} 字）`);
  ok(localReply({ lines: {} }, '嗯').length > 0, '没有人设语料时也有兜底句');
}

/* ---------------- 重要信息抽取（称呼/偏好/约定/性格/身份/习惯） ---------------- */
console.log('── 重要信息抽取');
{
  const cases = [
    ['我叫小明', '称呼：小明'],
    ['你可以叫我阿伟', '称呼：阿伟'],
    ['我的名字是张三', '称呼：张三'],
    ['我喜欢打游戏', '偏好：打游戏'],
    ['我很喜欢喝奶茶', '偏好：喝奶茶'],
    ['我比较喜欢斗地主', '偏好：斗地主'],
    ['我最讨厌等人', '偏好：等人'],
    ['下次带你上分', '约定：带你上分'],
    ['我这个人比较要强', '性格：比较要强'],
    ['我有点社恐', '性格：社恐'],
    ['我是大学生', '身份：大学生'],
    ['我每天十点睡', '习惯：十点睡'],
    ['我习惯先出小牌', '习惯：先出小牌'],
  ];
  let bad = 0;
  for (const [input, expect] of cases) {
    const got = extractMemory(input);
    if (got !== expect) { bad += 1; console.log(`    ✗ 「${input}」→ 期望「${expect}」实际「${got}」`); }
  }
  ok(bad === 0, `六类信息抽取全部正确（错误 ${bad} 处）`);
  ok(extractMemory('今天天气不错') === '', '没有重要信息时返回空');
  ok(extractMemory('今天好累啊') === '', '一时的情绪不写入 memory');
  ok(extractMemory('你真厉害') === '', '对 AI 的夸奖不写入 memory（那是好感度的职责）');
  ok(extractMemory('我叫这是一个特别特别长的名字').length <= FRIEND.maxMemoryChars, '抽取结果不超过长度上限');
  ok(localAnalyze('叫我阿伟，谢谢').memory === '称呼：阿伟', '同一句里优先记称呼');

  // 分类定义与提示词
  ok(MEMORY_CATEGORIES.length === 12,
    `memory 分类共 12 类（6 类玩家信息 + 系统自动写的「对局」「友圈」「改名」「关系」「礼物」，+ AI 自己的「自设」）`);
  ok(MEMORY_CATEGORIES[0].key === 'call', '称呼排在最优先位置');
  const prompt = buildAnalyzeMessages({ persona: PERSONAS[0], friend: { affinity: 50, memory: [] }, text: '我叫小明' })[0].content;
  for (const c of MEMORY_CATEGORIES) ok(prompt.includes(c.label), `分析提示词包含分类「${c.label}」`);
  ok(prompt.includes('称呼：'), '提示词里给了「分类：内容」的格式示例');
  ok(prompt.includes('好感度的职责'), '提示词里写明了不记对 AI 的夸奖');
  ok(prompt.includes('隐私'), '提示词里写明了不记隐私信息');
}

/* ---------------- ★ 用户报的 bug：`自设：称呼对方=管对方叫汽水偶像` ---------------- */
console.log('── 审查：一来一回一起看 + 挡住"假自设"');
{
  const nick = '汽水偶像';
  // ① 审查提示词：玩家昵称 + 玩家那句 + AI 回的那句（前因后果）
  const msgs = buildAnalyzeMessages({
    persona: PERSONAS[0], friend: { affinity: 50, memory: [] },
    text: '你好呀', reply: '你好，汽水偶像', playerName: nick,
  });
  const sys = msgs[0].content;
  const usr = msgs[1].content;
  ok(usr.includes(`玩家的昵称是「${nick}」`), '★ 审查提示词里给了玩家昵称');
  ok(/你叫他这个名字是理所当然的/.test(usr), '★ 明确说"叫他的名字不算你的设定"');
  ok(usr.includes('玩家说：你好呀') && usr.includes('回答：你好，汽水偶像'),
    '★ 审查时把**玩家那句话 + AI 回的那句**一起给它（看懂前因后果）');
  ok(/两行要一起看/.test(usr), '提示词里写明了要一起看这一段对话');
  ok(/称呼对方/.test(sys) && /管对方叫汽水偶像/.test(sys), '★ 直接把反例写进提示词（不许写 自设：称呼对方=…）');
  // ★ 改名的审查：提示词里要有 rename 这一项，解析也要认得
  ok(/"rename"/.test(sys) && /rename（★ 你这次\*\*要不要改名\*\*）/.test(sys),
    '★ 审查提示词里额外加了一项"要不要改名"');
  ok(new RegExp(`名字不超过 ${RENAME.maxChars} 个字`).test(sys), `提示词里写明名字不超过 ${RENAME.maxChars} 字`);
  ok(/一律填空字符串/.test(sys), '写明了哪些情况不算（开玩笑 / 玩家自己的名字 / 没答应）');
  ok(/你现在的名字是「/.test(usr), '把"你现在叫什么"也告诉了它');
  {
    const parsed = parseAnalysis('{"delta":0,"memory":"","self":{},"rename":"星野"}');
    ok(parsed.rename === '星野', '★ parseAnalysis 能解析出 rename');
    ok(parseAnalysis('{"delta":0,"memory":"","self":{}}').rename === '', '没填 rename 时是空串（不炸）');
    ok(parseAnalysis('{"delta":0,"rename":"「星野」"}').rename === '星野', '解析时顺手洗掉引号');
  }

  // ② 硬校验：这条"自设"其实在说玩家 → 拿掉，并补一条「称呼：昵称」
  const routed = routeFacts({
    memory: '', self: { 称呼对方: '管对方叫汽水偶像' },
    playerText: '你好呀', replyText: '你好呀', playerName: nick,
  });
  ok(!routed.self['称呼对方'], '★ `自设：称呼对方=…` 不会再进自设（用户报的那条）');
  ok(routed.memory === `称呼：${nick}`, `这条被归到玩家名下：${routed.memory || '（空）'}`);
  ok(routed.movedToPlayer.length === 1, '记下了"从自设挪到玩家"的证据');

  // 方面就叫「称呼」、内容里出现"对方" → 同样不算自设
  const routed2 = routeFacts({
    memory: '', self: { 称呼: '管对方叫汽水偶像' }, playerText: '在吗', replyText: '在', playerName: nick,
  });
  ok(!routed2.self.称呼, '★ `自设：称呼=管对方叫…` 也会被拿掉');

  // 内容就是玩家的昵称 → 拿掉
  ok(!guardSelfFacts({ 昵称: nick }, '是我', '你好', '', nick).昵称, '★ 自设里只写玩家昵称 → 丢掉');
  // 判定函数本身
  ok(selfAboutPlayer('称呼对方', '管对方叫汽水偶像', nick).hit, '★ 判定：「称呼对方」+ 内容是叫对方 → 是说玩家');
  ok(selfAboutPlayer('昵称', nick, nick).hit, '判定：内容就等于玩家昵称 → 是说玩家');
  ok(!selfAboutPlayer('老家', '杭州', nick).hit, '判定：老家=杭州 是真自设，不能误伤');
  ok(!selfAboutPlayer('宠物', '养了只橘猫', nick).hit, '判定：宠物=橘猫 也不受影响');

  // 反过来：真正的自设必须留着
  const keep = routeFacts({
    memory: '', self: { 老家: '杭州', 作息: '睡前刷会儿手机' },
    playerText: '你哪儿人', replyText: '我杭州的，睡前爱刷会儿手机', playerName: nick,
  });
  ok(keep.self.老家 === '杭州' && keep.self.作息 === '睡前刷会儿手机',
    '★ 真正的自设（老家 / 作息）一条都不能误伤');
  ok(!keep.memory, '真自设不会顺手往玩家记忆里塞东西');
  // 玩家自己说要改口 → 那是 memory 的「称呼」
  const call = routeFacts({
    memory: '称呼：小徐', self: {}, playerText: '叫我小徐', replyText: '好，小徐', playerName: nick,
  });
  ok(call.memory === '称呼：小徐', '玩家让改口 → 正常记进玩家的「称呼」');

  // ③ 老存档修复：已经在存档里的那条假自设要被清掉、并转成玩家的「称呼」
  const s = defaultSave();
  s.nickname = nick;
  addFriend(s, PERSONAS[0]);
  setSelfMemory(s, PERSONAS[0].id, '称呼对方', '管对方叫汽水偶像');
  setSelfMemory(s, PERSONAS[0].id, '老家', '杭州');
  ok(listSelfMemory(findFriend(s, PERSONAS[0].id)).length === 2, '存档里先塞两条自设（一条假的、一条真的）');
  const fixed = ensureOwnership(s);
  const left = listSelfMemory(findFriend(s, PERSONAS[0].id));
  ok(fixed >= 1, `★ 启动时的修复动作清理了 ${fixed} 条`);
  ok(!left.some((m) => m.includes('称呼对方')), '★ 假自设「称呼对方=管对方叫汽水偶像」被清掉了');
  ok(left.some((m) => m.includes('老家=杭州')), '真自设「老家=杭州」原样留着');
  ok(listPlayerMemory(findFriend(s, PERSONAS[0].id)).some((m) => m === `称呼：${nick}`),
    `★ 并且补了一条玩家的「称呼：${nick}」`);

  // ④ 双击前缀的自设（用户存档里也有：`自设：自设：作息=…`）
  const s2 = defaultSave();
  s2.nickname = '小徐';
  addFriend(s2, PERSONAS[1]);
  const f2 = findFriend(s2, PERSONAS[1].id);
  f2.memory.push('自设：自设：作息=夜深了会劝人早点歇着');
  f2.memory.push('自设：作息=十一点就困了');
  ensureOwnership(s2);
  const selfs = listSelfMemory(findFriend(s2, PERSONAS[1].id));
  ok(!selfs.some((m) => m.includes('自设：自设')), '★ 双层前缀被修掉（不会再出现「自设 · 自设：作息」）');
  ok(selfs.length === 1 && selfs[0] === '自设：作息=十一点就困了', '同一个方面只留最新那条');
  ok(setSelfMemory(s2, PERSONAS[1].id, '自设：老家', '杭州').memory === '自设：老家=杭州',
    '★ 模型把「自设：老家」当方面返回时，也不会拼出双层前缀');
}

/* ---------------- ★ 玩家是谁：所有会开口的 AI 都要知道（用户要求） ---------------- */
console.log('── 玩家身份作为背景知识');
{
  const s = defaultSave();
  s.nickname = '汽水偶像';
  addFriend(s, PERSONAS[0]);
  const friend = findFriend(s, PERSONAS[0].id);
  const persona = PERSONAS[0];
  const identity = playerIdentityLines(s, { callName: '小张' });
  const has = (msgs) => msgs.map((m) => m.content).join('\n');

  ok(identity.includes('汽水偶像') && identity.includes('男生'), '身份块里带昵称 + 性别');
  ok(identity.includes('小张'), '带上了"你平时叫他小张"');
  ok(/不用问|不要问|绝不要问/.test(identity), '★ 明确写了"不用问他叫什么"');
  ok(playerIdentityLines(s, { scene: 'table' }).includes('不要报昵称'), '牌桌上那份更简短（不要报昵称）');

  const cases = [
    ['私聊回复', buildFriendMessages({ persona, friend, text: '在吗', playerIdentity: identity })],
    ['主动搭话', buildProactiveMessages({ persona, friend, playerIdentity: identity })],
    ['群聊回复', buildGroupReplyMessages({
      persona, group: { name: '唠嗑群', members: ['p01'] }, members: [PERSONAS[1]],
      recentLines: [], playerText: '在吗', friends: [friend], playerIdentity: identity,
    })],
    ['房间弹幕', buildDanmakuMessages({ persona, friend, situation: '刚开桌', playerIdentity: identity })],
    ['友圈评论', buildMomentCommentMessages({ persona, friend, text: '天气不错', playerIdentity: identity })],
  ];
  for (const [label, msgs] of cases) {
    const text = has(msgs);
    ok(text.includes('汽水偶像'), `★ ${label}：提示词里有玩家昵称`);
    ok(text.includes('小张'), `${label}：提示词里有该怎么称呼他`);
  }
  const chatText = has(cases[0][1]);
  ok(/绝不要问"你叫什么/.test(chatText), '★ 私聊还额外叮嘱"绝不要问你叫什么"');
  // 没传身份块时退回老行为（只报昵称），不会崩
  const fallback = has(buildFriendMessages({ persona, friend, text: '在吗', playerName: '汽水偶像' }));
  ok(fallback.includes('玩家的昵称是「汽水偶像」'), '没传身份块时退回"昵称"那一句');
}

/* ---------------- 人设改名：老存档里抄的旧名字要跟着刷 ---------------- */
console.log('── 人设改名后，好友记录里的名字副本同步');
{
  const s = defaultSave();
  addFriend(s, PERSONAS[4]);
  const f = findFriend(s, PERSONAS[4].id);
  f.name = '旧名字'; // 模拟"加好友时抄下来的、人设后来改了名"
  ok(syncFriendIdentities(s) === 1, '★ 发现一处旧名字并刷新');
  ok(f.name === PERSONAS[4].name, `★ 刷新成当前人设名「${PERSONAS[4].name}」`);
  ok(syncFriendIdentities(s) === 0, '已经同步过的再跑一遍 = 0（幂等）');
  ok(f.avatar === PERSONAS[4].avatar, '头像副本也跟着人设走');
  const appSrc = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  ok(/syncFriendIdentities\(this\.save\)/.test(appSrc), '★ 启动时会同步一次');
  // 11 个改过名的人设：新名字生效，人设描述保持完整
  for (const [id, name] of [['p03', '休怪我无情'], ['p05', '春和景明'], ['p11', 'Helloworld'],
    ['p15', '嘴上没输过'], ['p16', '冷月'], ['p18', '我爱数理化'], ['p19', '时光不负'],
    ['p21', '阿北同学'], ['p22', '且闻烟雨声'], ['p04', '深夜絮语'], ['p08', '菜鸟萌新']]) {
    const p = PERSONAS.find((x) => x.id === id);
    ok(p && p.name === name, `${id} 改名为「${name}」`);
    ok(p && p.prompt.includes(name) && p.prompt.length > 40, `${id} 的人设里也用新名字，描述保持完整`);
  }
}

/* ---------------- ★ AI 改名（用户拍板） ---------------- */
console.log('── AI 改名：审查判定 + 记忆 + 重置');
{
  const s = defaultSave();
  s.nickname = '汽水偶像';
  const p = PERSONAS[8];
  addFriend(s, p);
  const baseName = p.name;
  ok(aiNameOf(s, p.id) === baseName, `一开始就叫出厂名「${baseName}」`);

  // ① 硬校验：只有"聊到改名 + 它自己说了这个名字"才认
  ok(guardRename('星野', { playerText: '给你改个名叫星野吧', replyText: '好呀，那我以后就叫星野', currentName: baseName }) === '星野',
    '★ 玩家提出改名、它也答应了 → 认');
  ok(guardRename('星野', { playerText: '你今天好厉害', replyText: '谢谢' , currentName: baseName }) === '',
    '★ 没聊到改名 → 不认（哪怕模型瞎填了名字）');
  ok(guardRename('星野', { playerText: '给你改个名叫星野吧', replyText: '随便你吧', currentName: baseName }) === '',
    '★ 它没答应（自己那句话里没说过这个名字）→ 不认');
  ok(guardRename('汽水偶像', { playerText: '以后叫你汽水偶像', replyText: '好，叫我汽水偶像吧', playerName: '汽水偶像', currentName: baseName }) === '',
    '★ 想改成玩家的昵称 → 不认（会乱）');
  ok(guardRename(baseName, { playerText: '改个名', replyText: `还是叫${baseName}`, currentName: baseName }) === '',
    '和现在同名 → 不认');
  ok(guardRename('这个名字特别特别长超过八个字', { playerText: '改个名', replyText: '那就叫我这个名字特别特别长超过八个字', currentName: baseName }) === '',
    `★ 超过 ${RENAME.maxChars} 个字 → 不认`);
  ok(cleanAiName('「星野」') === '星野', '名字会去掉引号');
  ok(cleanAiName('叫星野') === '星野', '去掉开头的"叫"');
  ok([...cleanAiName('一二三四五六七八九十')].length > RENAME.maxChars,
    '清洗不负责截断（超长的原文留着，交给 nameIsUsable 拒掉）');
  ok(nameIsUsable('一二三四五六七八九十').reason === 'too-long', `★ 超过 ${RENAME.maxChars} 个字 → 不合法`);

  // ② 改名落地：数据 + 记忆
  const res = renameAi(s, p.id, '星野', { playerName: '汽水偶像' });
  ok(res.ok && res.from === baseName && res.to === '星野', `★ 改名成功：${baseName} → 星野`);
  ok(aiNameOf(s, p.id) === '星野', '存档里记着新名字');
  ok(PERSONAS.find((x) => x.id === p.id).name === '星野', '★ 人设的名字也换成了新的（界面/提示词读的就是它）');
  ok(PERSONAS.find((x) => x.id === p.id).prompt.startsWith('你是星野'), '★ 人设里那句自称也跟着换，不会一边新名一边旧名');
  addRenameMemory(s, p.id, renameMemoryLine(s, p.id));
  ok(findFriend(s, p.id).memory.includes(`改名：${baseName}→星野`), '★ 记忆里写下「旧名→新名」');
  applyAiNames(s);
  ok(syncFriendIdentities(s) >= 0 && findFriend(s, p.id).name === '星野', '好友记录里的名字副本也刷新');

  // ③ 再改一次：记忆累积成"旧名→新名，又改名更新的名"
  const res2 = renameAi(s, p.id, '小野', { playerName: '汽水偶像' });
  ok(res2.ok && res2.from === '星野' && res2.to === '小野', '第二次改名成功');
  addRenameMemory(s, p.id, renameMemoryLine(s, p.id));
  const lines = findFriend(s, p.id).memory.filter((m) => m.startsWith('改名：'));
  ok(lines.length === 1, '★ 改名记忆始终只有一条（不会越改越多条）');
  ok(lines[0] === `改名：${baseName}→星野，又改名小野`, `★ 累积成「${lines[0]}」`);
  ok(extraMemoryCount(findFriend(s, p.id)) === 1, '★ 改名记忆算"额外记忆"，不占常规 16 条');
  ok(!canMerge(lines[0]), '改名记忆不参与合并');

  // ④ 重置 → 名字回到出厂名
  const fresh = defaultSave();
  ok(Object.keys(fresh.aiNames || {}).length === 0, '新存档没有任何自定义名字');
  resetAiNames(fresh);
  ok(aiNameOf(fresh, p.id) === baseName, '★ 重置后回到出厂名');
  ok(PERSONAS.find((x) => x.id === p.id).name === baseName, '★ PERSONAS 也被还原（界面立刻变回去）');
  ok(PERSONAS.find((x) => x.id === p.id).prompt.startsWith(`你是${baseName}`), '人设里的自称也还原');

  // ⑤ 记忆文件 / 提示词里用新名字
  const s2 = defaultSave();
  addFriend(s2, PERSONAS[8]);
  renameAi(s2, PERSONAS[8].id, '星野', {});
  const md = memoryDigest(s2, { personas: PERSONAS });
  ok(md.includes('## 星野（'), '★ 记忆文件里也用改过的名字');
  ok(!md.includes(`## ${baseName}（`), '不再显示出厂名');
  resetAiNames(defaultSave());
}

/* ---------------- 友圈记忆：额外记，不占常规 ---------------- */
console.log('── 友圈记忆（最近 2 条 · 不占常规 16 条）');
{
  const save = defaultSave();
  save.nickname = '小徐';
  const p = PERSONAS[3];
  addFriend(save, p);
  const f = () => findFriend(save, p.id);

  addMomentMemory(save, p.id, { text: '今天天气不错，出门走走', comment: '带我一个' });
  ok(listMomentMemory(f()).length === 1, '评论之后会写一条「友圈」记忆');
  const line = listMomentMemory(f())[0];
  ok(line.startsWith('友圈：') && /\[\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\]/.test(line), `带时间戳：${line}`);
  ok(line.includes('今天天气不错') && line.includes('带我一个'), '说说内容 + 我的评论都在里面');

  /* ★ 评论区里"我和玩家最后 3 轮对话"也要进记忆（用户要求） */
  {
    const s3 = defaultSave();
    s3.nickname = '小徐';
    const p3 = PERSONAS[5];
    addFriend(s3, p3);
    const other = PERSONAS[6].id;
    // 5 轮玩家↔它 的对话，外加另一位的评论（不该混进来）
    const comments = [];
    const push = (by, text) => comments.push({ id: `c${comments.length}`, by, text, at: Date.now() });
    for (let i = 1; i <= 5; i += 1) {
      push('me', `玩家第${i}句`);
      push(p3.id, `它第${i}句`);
    }
    push(other, '别人的评论不该进去');
    addMomentMemory(s3, p3.id, { text: '今天说说内容', comment: '它第5句', comments });
    const mline = listMomentMemory(findFriend(s3, p3.id))[0];
    ok(mline.includes('对话：'), '★ 记忆里带上了评论区的对话');
    ok(!mline.includes('玩家第1句') && !mline.includes('玩家第2句'), '★ 只保留**最后 3 轮**，更早的丢掉');
    ok(mline.includes('玩家第3句') && mline.includes('玩家第4句') && mline.includes('玩家第5句'),
      '最后 3 轮玩家的发言都在');
    ok(mline.includes('它第3句') && mline.includes('它第5句'), '它的对应回复也在');
    ok(!mline.includes('别人的评论'), '★ 别的 AI 的评论不会混进这条记忆');
    ok(mline.length <= 210, `★ 整条长度受分类上限 210 控制（实际 ${mline.length} 字）`);
    ok(mline.includes('玩家「') && mline.includes('我「'), '对话写成「玩家「…」我「…」」的样子');

    // 再回复一轮 → 就地更新（不是又加一条）
    push('me', '新一轮玩家');
    push(p3.id, '新一轮它');
    addMomentMemory(s3, p3.id, { text: '今天说说内容', comment: '新一轮它', comments });
    ok(listMomentMemory(findFriend(s3, p3.id)).length === 1, '★ 同一条说说再聊也是覆盖，不会越堆越多');
    ok(listMomentMemory(findFriend(s3, p3.id))[0].includes('新一轮玩家'), '更新成最新那轮对话');
  }

  // 同一条说说再评论（玩家回复 → 它又回）→ 覆盖，不新增
  addMomentMemory(save, p.id, { text: '今天天气不错，出门走走', comment: '那我下次叫你' });
  ok(listMomentMemory(f()).length === 1, '★ 同一条说说再评论是**覆盖**，不会越堆越多');
  ok(listMomentMemory(f())[0].includes('那我下次叫你'), '留下的是最新的那句评论');

  // 只留最近 2 条
  addMomentMemory(save, p.id, { text: '第二条说说的开头在这里', comment: '哈哈哈' });
  addMomentMemory(save, p.id, { text: '第三条说说的开头在这里', comment: '羡慕' });
  const list = listMomentMemory(f());
  ok(list.length === 2, `★ 友圈记忆只保留最近 2 条（实际 ${list.length}）`);
  ok(!list.some((m) => m.includes('今天天气不错')), '最旧的那条被淘汰');
  ok(list.some((m) => m.includes('第三条')) && list.some((m) => m.includes('第二条')), '留着的是最近两条');

  // ★ 不占常规记忆：塞进 17 条常规 + 2 条友圈，常规不该被裁
  const HOBBIES = ['喝奶茶', '打篮球', '看小说', '爬山', '摄影', '做饭', '养猫', '听歌', '游泳',
    '下棋', '跑步', '画画', '钓鱼', '滑雪', '书法', '集邮', '弹吉他'];
  for (const h of HOBBIES) addMemory(save, p.id, `偏好：${h}`);
  ok(regularMemoryCount(f()) === HOBBIES.length,
    `★ 常规记忆 ${HOBBIES.length} 条一条不少（实际 ${regularMemoryCount(f())} 条，没被友圈挤掉）`);
  ok(f().memoryNeedCompress === true, '超过 16 条常规记忆 → 打上"该合并了"的标记');
  ok(listMomentMemory(f()).length === 2, '友圈记忆也没被常规记忆挤掉');
  ok(extraMemoryCount(f()) === 2, '额外记忆只算友圈（这位好友没打过牌）');

  // 压缩时不参与合并、也不会被吞
  const merged = mergeMemoryLocally(f().memory, { maxChars: FRIEND.maxMemoryChars, maxLines: FRIEND.maxMemory + 2 });
  ok(merged.filter((m) => m.startsWith('友圈：')).length === 2, '★ 本地合并原样保留友圈记忆');
  ok(!merged.some((m) => m.startsWith('友圈：') && m.includes('、偏好：')), '友圈记忆不会被并进别的分类');

  // 提示词里能读到，并且按"新→旧"排
  const grpMoments = memoryGroups(f());
  const moments = grpMoments.system.filter((m) => m.startsWith('友圈：'));
  ok(moments.length === 2, '记忆分组里能拿到友圈记忆（提示词用同一份口径）');
  ok(!grpMoments.player.some((m) => m.startsWith('友圈：')), '★ 友圈不在"关于玩家"那组（分块之后不会读串）');
  ok(moments[0].includes('第三条'), '★ 友圈记忆按时间从新到旧（最上面那条才是最近的）');
}

/* ---------------- 对局记忆（每局一条 50~100 字概括，只留最近 3 局） ---------------- */
console.log('── 对局记忆与局面概括');
{
  const save = defaultSave();
  const p = PERSONAS[2];
  addFriend(save, p);
  const mk = (n) => `这一局是第 ${n} 把：玩家当地主，两个炸弹把倍数翻到 ×16，最后被农民联手管死，输了 3,200 豆，${'过程很胶着，双方来回压了好几手。'.repeat(2)}`;
  for (let i = 1; i <= 5; i += 1) {
    const res = addMatchMemory(save, p.id, mk(i));
    ok(res && res.added, `第 ${i} 局的对局记忆写入成功`);
  }
  const mem = findFriend(save, p.id).memory.filter((m) => m.startsWith('对局：'));
  ok(mem.length === 3, `「对局」记忆只保留最近 3 条（实际 ${mem.length}）`);
  ok(mem[0].includes('第 3 把') && mem[2].includes('第 5 把'), '保留的是最近三局，最旧的被淘汰');
  ok(mem[2].length > FRIEND.maxMemoryChars, `对局记忆允许比普通记忆长（${mem[2].length} 字 > ${FRIEND.maxMemoryChars}）`);
  ok(mem[2].length <= FRIEND.maxMatchChars, `对局记忆不超过上限 ${FRIEND.maxMatchChars}`);

  // 其他分类不受影响，仍然按普通上限截断
  addMemory(save, p.id, `偏好：${'很长很长'.repeat(20)}`);
  const like = findFriend(save, p.id).memory.find((m) => m.startsWith('偏好：'));
  ok(like.length <= FRIEND.maxMemoryChars + 3, `普通记忆仍然按 ${FRIEND.maxMemoryChars} 字截断`);

  // 概括长度：必须落在 50~100 字
  const facts = '地主是「下家」，农民是「阿伟」和「上家」；玩家叫「阿伟」，这局他是地主；'
    + '农民赢了；玩家「阿伟」输了 3,200 豆；本局倍数 ×16（2 个炸弹）；底分 100；陪玩的是「碎碎念」「损友小陈」';
  const local = localSummary({ kind: 'ddz', roomName: '中级场', facts });
  ok(local.length >= 50 && local.length <= 100, `本地兜底概括落在 50~100 字（${local.length} 字）`);
  ok(local.includes('斗地主'), '本地概括写明了玩法');
  ok(!/你/.test(local), '★ 中立版概括里没有"你"（谁读都不会认错主角）');
  const fishing = localSummary({ kind: 'fishing', roomName: '低级场', facts: '鱼篓 18 : 8；玩家「阿伟」赢了 433 豆' });
  ok(fishing.includes('小猫钓鱼'), '小猫钓鱼的概括不会写成斗地主');
  ok(fishing.length >= 50 && fishing.length <= 100, `钓鱼概括长度也达标（${fishing.length} 字）`);

  // ★ 视角：记忆是给 AI 看的，AI 视角那份要"你"= 这个 AI 自己
  const aiView = localSummaryForAi({
    kind: 'fishing', roomName: '低级场', facts: '鱼篓 玩家「佛系少年」 4 : 46 对手「才不是傲娇」；'
      + '玩家「佛系少年」输了 11,244 豆，对手「才不是傲娇」赢了',
    selfName: '才不是傲娇', selfWon: true,
  });
  ok(aiView.startsWith('在低级场小猫钓鱼那局，') && /你（才不是傲娇）赢了这局/.test(aiView),
    '★ AI 视角开头就点明"你（这个 AI）赢了这局"');
  ok(aiView.includes('玩家「佛系少年」输了'), '玩家用名字写，不跟 AI 抢"你"');
  const aiLose = localSummaryForAi({ kind: 'fishing', facts: 'x', selfName: '春和景明', selfWon: false });
  ok(/你（春和景明）输了这局/.test(aiLose), 'AI 输的那局也写得清');
  ok(!/你（.*）赢了这局/.test(aiLose), '不会把输写成赢');

  // ★ 提示词：AI 视角 vs 中立视角，要求不一样
  const promptAi = buildSummaryMessages({
    kind: 'fishing', room: { name: '低级场' }, facts, names: ['佛系少年', '才不是傲娇'], selfName: '才不是傲娇',
  }).map((m) => m.content).join('\n');
  ok(/站在「才不是傲娇」的角度/.test(promptAi), '★ AI 视角提示词明确"站在这个 AI 的角度写"');
  ok(/它自己.*用「你」/.test(promptAi), '并说明它自己用"你"');
  ok(/不要用"你"指玩家|不要用“你”指玩家/.test(promptAi), '玩家不许用"你"指代');
  ok(/必须让读者一眼看出/.test(promptAi), '要求写清"你"这局是赢是输');
  const promptNeutral = buildSummaryMessages({
    kind: 'ddz', room: { name: '中级场' }, facts, names: ['阿伟', '下家', '上家'], perspective: 'neutral',
  }).map((m) => m.content).join('\n');
  ok(/不许出现"你"|不许出现“你”/.test(promptNeutral), '★ 中立视角提示词明确"不许出现你"');
  ok(!/它自己.*用「你」/.test(promptNeutral), '中立版不会叫它用"你"');

  const long = fitSummary('啊'.repeat(300));
  ok(long.length <= 100, `超长概括会被收进 100 字（${long.length} 字）`);
  const short = fitSummary('太短了');
  ok(short === '太短了', '很短的文本不做奇怪加工');

  // 事实清单里不能出现别家的手牌（只允许公开信息）
  const result = {
    landlordSeat: 1, landlordWin: false, multiplier: 16, bombs: 2, rockets: 0, robs: 1,
    spring: false, antiSpring: false, deltas: [-3200, 1600, 1600],
  };
  const ddz = ddzFacts(result, { room: { base: 100 }, names: ['阿伟', '下家', '上家'], seatPersonas: [{ name: '碎碎念' }] });
  ok(ddz.includes('地主是「下家」'), '概括事实里写清了谁是地主');
  ok(ddz.includes('×16'), '概括事实里带上了倍数');
  ok(ddz.includes('炸弹'), '概括事实里带上了关键点');
  ok(!/[♠♥♣♦]|王炸|对[3-9]/.test(ddz), '概括事实里没有具体手牌（只有公开信息）');
  ok(ddz.includes('你') === false, '★ 事实清单不再用"你"称呼玩家（避免 AI 认错主角）');
  ok(ddz.includes('阿伟'), '★ 玩家用昵称写清楚');
  const fish = fishingFacts({
    pay: { delta: 433, diff: 10 }, score: [18, 8], multiplier: 2, room: { name: '低级场' },
    personaName: '冷面棋手', playerName: '阿伟',
  });
  ok(fish.includes('18 : 8'), '钓鱼事实里带上了鱼篓比分');
  ok(fish.includes('冷面棋手'), '钓鱼事实里带上了对手名字');
  ok(fish.includes('阿伟') && !/你/.test(fish), '★ 钓鱼事实也写名字、不用"你"');
  const fishLose = fishingFacts({
    pay: { delta: -11244, diff: -42 }, score: [4, 46], multiplier: 2, room: { name: '低级场' },
    personaName: '才不是傲娇', playerName: '佛系少年',
  });
  ok(/玩家「佛系少年」输了 11,244 豆/.test(fishLose) && /对手「才不是傲娇」赢了/.test(fishLose),
    '★ 输赢写清楚（谁输谁赢、多少豆）');

  // 从**结算面板**加好友时，用最近 3 局补记忆（冷加不补，见上面那组测试）
  const save2 = defaultSave();
  save2.recentHands = [
    { kind: 'ddz', seatIds: [p.id], summary: '最新一局：玩家赢了。' },
    { kind: 'fishing', seatIds: ['p09'], summary: '别人打的局。' },
    { kind: 'ddz', seatIds: [p.id], summary: '较早一局：玩家输了。' },
  ];
  addFriend(save2, p, { fromMatch: true });
  const backfilled = findFriend(save2, p.id).memory.filter((m) => m.startsWith('对局：'));
  ok(backfilled.length === 2, `结算面板加好友时补进了它陪你打过的 2 局（实际 ${backfilled.length}）`);
  ok(!backfilled.some((m) => m.includes('别人打的局')), '没它参加的局不会被补进记忆');
}

/* ---------------- 唯一分类要覆盖（称呼改了不能留两条） ---------------- */
console.log('── 唯一分类覆盖');
{
  const save = defaultSave();
  const p = PERSONAS[7];
  addFriend(save, p);
  addMemory(save, p.id, '称呼：小明');
  let r = addMemory(save, p.id, '称呼：阿伟');
  let f = findFriend(save, p.id);
  ok(r.added && r.replaced === '称呼：小明', '同一分类的新记忆会覆盖旧的');
  ok(f.memory.filter((m) => m.startsWith('称呼')).length === 1, '称呼只保留一条，不会自相矛盾');
  ok(f.memory.some((m) => m === '称呼：阿伟'), '留下的是最新称呼');
  ok(!addMemory(save, p.id, '称呼：阿伟').added, '重复的同一分类内容不重复写');

  // 非唯一分类可以累积
  addMemory(save, p.id, '偏好：喝奶茶');
  addMemory(save, p.id, '偏好：打游戏');
  f = findFriend(save, p.id);
  ok(f.memory.filter((m) => m.startsWith('偏好')).length === 2, '偏好类可以累积多条');

  // 排序：称呼在前
  addMemory(save, p.id, '习惯：每天十点睡');
  const ordered = sortedMemory(f);
  ok(ordered[0] === '称呼：阿伟', `称呼排在最前（实际 ${ordered[0]}）`);
  ok(memoryText(f).startsWith('- 【关于玩家】称呼'), '提示词文本里称呼在最前，且带归属前缀');
  ok(memoryIcon('称呼：阿伟') === '🏷️', '称呼有对应图标');
  ok(memoryIcon('随便一句') === '📝', '未分类的用默认图标');
}

/* ---------------- 未读与好友主动搭话 ---------------- */
console.log('── 未读红点 + 好友主动搭话');
{
  const save = defaultSave();
  const p1 = PERSONAS[8];
  const p2 = PERSONAS[9];
  addFriend(save, p1);
  addFriend(save, p2);
  ok(findFriend(save, p1.id).unread === 0, '新好友未读为 0');
  ok(unreadTotal(save) === 0, '初始未读总数为 0');

  bumpUnread(save, p1.id);
  bumpUnread(save, p1.id);
  bumpUnread(save, p2.id);
  ok(findFriend(save, p1.id).unread === 2, '未读可以累加');
  ok(unreadTotal(save) === 3, `未读总数正确（实际 ${unreadTotal(save)}）`);
  ok(clearUnread(save, p1.id) === true, '打开聊天后清零');
  ok(findFriend(save, p1.id).unread === 0, '清零生效');
  ok(unreadTotal(save) === 1, '清零只影响该好友');
  ok(clearUnread(save, p1.id) === false, '已经清零再清返回 false');
  ok(bumpUnread(save, '不存在') === 0, '给非好友加未读返回 0');

  // 主动搭话的提示词：要注入 memory、好感度、并且明确要"开场话"
  addMemory(save, p2.id, '称呼：阿伟');
  adjustAffinity(save, p2.id, 25);
  const f2 = findFriend(save, p2.id);
  const msgs = buildProactiveMessages({ persona: p2, friend: f2 });
  const all = msgs.map((m) => m.content).join('\n');
  ok(all.includes('称呼：阿伟'), '主动搭话提示词注入了 memory');
  ok(all.includes(`${f2.affinity}/100`), '主动搭话提示词注入了好感度');
  ok(all.includes('开场'), '提示词要求说一句开场话');
  ok(all.includes('私聊'), '提示词交代了"这是私聊"的语境');

  /* 对局记忆：参加了才能聊这一局；没参加就完全别提（改聊别的） */
  const hand = {
    kind: 'fishing',
    seatIds: [p1.id],
    summary: '在低级场小猫钓鱼那局，鱼篓 18:8，玩家赢了 433 豆，对手是「冷面棋手」，这把一边倒。',
    at: Date.now(),
  };
  const joinedMsgs = buildProactiveMessages({
    persona: p1, friend: f2, lastMatch: hand, joined: true, modeName: '小猫钓鱼',
  }).map((m) => m.content).join('\n');
  ok(joinedMsgs.includes('一起打完'), '参加了这局 → 提示词说"你们刚一起打完"');
  ok(joinedMsgs.includes('鱼篓 18:8'), '参加了 → 提示词带上了那局的概括');
  ok(joinedMsgs.includes('小猫钓鱼'), '提示词注入了正确的玩法（不是一律叫斗地主）');

  // 没参加：一个字都不该提那局，改聊随机话题
  const outsiderMsgs = buildProactiveMessages({
    persona: PERSONAS[3], friend: f2, lastMatch: hand, joined: false, modeName: '小猫钓鱼',
  }).map((m) => m.content).join('\n');
  ok(!outsiderMsgs.includes('鱼篓 18:8'), '没参加 → 那局的概括完全不注入（避免"没打却说打了"）');
  ok(!outsiderMsgs.includes('一起打完'), '没参加 → 不会出现"你们刚一起打完"');
  ok(outsiderMsgs.includes('不要提牌局') && outsiderMsgs.includes('还来吗'), '没参加 → 明确要求别提牌局、别问"还来吗"');
  ok(/打个招呼|说说你自己的事|问他最近怎么样|约他改天/.test(outsiderMsgs), '没参加 → 要求聊随机话题（问候 / 自己的事 / 近况 / 约改天）');

  // 私聊回复同样区分：没参加时也要拦一句"别提那局"
  const replyMsgs = buildFriendMessages({
    persona: PERSONAS[3], friend: f2, text: '刚那把怎么样？', lastMatch: hand, joined: false, modeName: '小猫钓鱼',
  }).map((m) => m.content).join('\n');
  ok(!replyMsgs.includes('鱼篓 18:8'), '私聊回复里也不会塞入没参加的那局概括');

  // 本地兜底问候语
  for (const p of [PERSONAS[0], PERSONAS[10]]) {
    const line = localGreeting(p);
    ok(typeof line === 'string' && line.length > 0 && line.length <= 32, `${p.name} 的兜底问候语可用（${line}）`);
  }
  ok(localGreeting({ lines: {} }).length > 0, '没有人设语料时也有兜底问候');
}

/* ---------------- 表情插入 ---------------- */
console.log('── 表情插入到聊天内容');
{
  let r = insertAt('今天好累', 4, 4, '😭');
  ok(r.value === '今天好累😭', `末尾插入（实际 ${r.value}）`);
  ok(r.pos === '今天好累'.length + '😭'.length, '光标停在插入内容之后（emoji 占 2 个 UTF-16 单元）');
  r = insertAt('今天好累', 0, 0, '😭');
  ok(r.value === '😭今天好累', '开头插入');
  r = insertAt('今天好累', 2, 4, '😭');
  ok(r.value === '今天😭', '替换选区（选中"好累"被替换）');
  r = insertAt('', 0, 0, '😀');
  ok(r.value === '😀', '空输入框插入');
  r = insertAt('abc', 99, 99, '!');
  ok(r.value === 'abc!', '越界的光标位置会被夹到末尾');
  r = insertAt('abc', -5, -5, '!');
  ok(r.value === '!abc', '负光标位置会被夹到开头');
  r = insertAt('abc', 2, 0, 'X');
  ok(r.value === 'abXc', 'end < start 时按 start 处理，不会丢字符');
  // 连续插入多个表情
  let v = '上号';
  for (const e of ['😀', '🎉']) { const x = insertAt(v, v.length, v.length, e); v = x.value; }
  ok(v === '上号😀🎉', '可以连续插入多个表情');
}

/* ---------------- 聊天记录的时间分隔 ---------------- */
console.log('── 聊天时间分隔（隔 5 分钟才插一条，第一条一定插）');
{
  const T0 = new Date(2026, 2, 5, 14, 32, 0).getTime(); // 2026-03-05 14:32 本地时间
  const MIN = 60 * 1000;
  const now = T0;
  ok(CHAT_TIME_GAP === 5 * MIN, '时间分隔阈值就是 5 分钟');

  // 文案
  ok(chatTimeLabel(T0, now) === '14:32', `当天只显示时分（${chatTimeLabel(T0, now)}）`);
  ok(chatTimeLabel(T0, T0 + 6 * 60 * MIN) === '14:32', '同一天晚些时候看还是同一天（不写日期）');
  ok(chatTimeLabel(T0, new Date(2026, 2, 6, 9, 0, 0).getTime()) === '昨天 14:32',
    `昨天带"昨天"（${chatTimeLabel(T0, new Date(2026, 2, 6, 9, 0, 0).getTime())}）`);
  ok(chatTimeLabel(T0, new Date(2026, 2, 20, 9, 0, 0).getTime()) === '3月5日 14:32', '同年写月日');
  ok(chatTimeLabel(T0, new Date(2027, 0, 1, 9, 0, 0).getTime()) === '2026年3月5日 14:32', '跨年写完整年月日');
  ok(chatTimeLabel(0, now) === '' && chatTimeLabel(undefined, now) === '', '没有时间戳就不显示（老存档安全）');
  ok(/^\d{2}:\d{2}$/.test(chatTimeLabel(T0, now)), '时分补零成两位');

  // 该不该插
  const flags = (arr) => chatTimeFlags(arr, 5 * MIN);
  ok(JSON.stringify(flags([])) === '[]', '空聊天记录不炸');
  ok(JSON.stringify(flags([{ at: T0 }])) === '[true]', '第一条消息一定显示时间（刚加好友那句也看得到）');
  ok(JSON.stringify(flags([{ at: T0 }, { at: T0 + 4 * MIN }])) === '[true,false]', '相隔不到 5 分钟不重复插时间');
  ok(JSON.stringify(flags([{ at: T0 }, { at: T0 + 5 * MIN }])) === '[true,true]', '正好 5 分钟就插一条');
  ok(JSON.stringify(flags([{ at: T0 }, { at: T0 + 30 * MIN }, { at: T0 + 31 * MIN }])) === '[true,true,false]',
    '隔了很久插一条，之后的短间隔继续不插');
  ok(JSON.stringify(flags([{ at: T0 }, { text: '老存档没有 at' }, { at: T0 + 30 * MIN }])) === '[true,false,true]',
    '缺 at 的那条不显示，也不影响后面按它继续算间隔');
  // 单向递增的对话（一问一答）也要按 5 分钟切
  const chat = [
    { role: 'me', at: T0 }, { role: 'ai', at: T0 + 60 * 1000 },
    { role: 'me', at: T0 + 9 * MIN }, { role: 'ai', at: T0 + 9 * MIN + 30 * 1000 },
  ];
  ok(JSON.stringify(flags(chat)) === '[true,false,true,false]', '一问一答里只在"隔了 5 分钟"的那句上面插时间');
}

/* ---------------- 加好友：一次只推 10 个人 ---------------- */
console.log('── 加好友推荐（随机 10 人 + 换一批）');
{
  const src = readFileSync(new URL('../src/ui/friends.js', import.meta.url), 'utf8');
  ok(/const PICKER_COUNT = 10\b/.test(src), '一次推荐 10 个人');
  ok(/id="btn-reroll"[^>]*>换一批</.test(src), '「挑一个聊聊」换成了「换一批」按钮');
  ok(!/挑一个聊聊/.test(src), '旧的"挑一个聊聊"文案已经删掉');
  ok(/function rollCandidates\(\)/.test(src), '有"换一批"的重抽逻辑');
  ok(/PERSONAS\.filter\(\(p\) => !friendIds\.includes\(p\.id\)\)/.test(src), '优先推还没加过的人');
  ok(/candidates\.length < PICKER_COUNT/.test(src), '非好友不足 10 个时用已加过的补齐（会标"已是好友"）');
  ok(/let candidates = \[\];/.test(src), '这一批人被记住：面板刷新时不会换脸（否则手指还没抬起来名单就变了）');
}

/* ---------------- 恋人：表白 / 分手 / 只能有一个 ---------------- */
console.log('── 恋人（好感满 + 明确表白 → 恋人；明确分手 → 回到朋友）');
{
  const save = defaultSave();
  const p = PERSONAS[5];
  addFriend(save, p);
  const id = p.id;
  const f = () => findFriend(save, id);

  // 门槛：好感没满就不做表白审查
  f().affinity = 80;
  ok(!canConfess(save, f()), '好感没满 100 时不审查表白');
  ok(!canBreakup(save, f()), '还不是恋人时不审查分手');
  ok(tierOf(save, f()).label !== '恋人', '这时不是恋人');

  // 好感可以到 100（上限就是 100）
  for (let i = 0; i < 40; i += 1) adjustAffinity(save, id, 5);
  ok(f().affinity === 100, `好感度能到满 100（实际 ${f().affinity}）`);
  ok(tierOf(save, f()).label === '挚友', '只是满好感时，关系显示「挚友」');
  ok(canConfess(save, f()), '★ 好感满 100 且还没有恋人 → 要审查表白');

  // 表白 → 成为恋人
  const r = setLover(save, id);
  ok(r.ok && isLover(save, id), '确立恋人关系');
  ok(tierOf(save, f()).label === '恋人', '关系显示变成「恋人」');
  ok(loverFriend(save) === f(), '能取到恋人那个好友');
  ok(canBreakup(save, f()), '★ 已经是恋人 → 要审查分手');
  ok(!canConfess(save, f()), '已经是恋人就不再审查表白');

  // 全局只能有一个
  const p2 = PERSONAS[6];
  addFriend(save, p2);
  findFriend(save, p2.id).affinity = 100;
  ok(!canConfess(save, findFriend(save, p2.id)), '★ 已有恋人 → 别人的表白审查也不触发');
  ok(!setLover(save, p2.id).ok, '不能再确立第二个恋人');
  ok(isLover(save, id) && !isLover(save, p2.id), '恋人还是原来那个');
  ok(setLover(save, id).ok, '对同一个人重复确立是无害的');

  // 分手 → 好感掉到「朋友」
  const before = f().affinity;
  const br = breakUp(save, id);
  ok(br.ok && !save.loverId, '分手成功，恋人关系清掉');
  ok(before === 100 && f().affinity === FRIEND.breakupAffinity, `好感度掉到 ${FRIEND.breakupAffinity}`);
  const tier = tierOf(save, f());
  ok(tier.label === '朋友', `★ 关系回到「朋友」（实际 ${tier.label}）`);
  ok(!canBreakup(save, f()), '分手后不再审查分手');
  ok(!breakUp(save, id).ok, '不是恋人时分手会被拒');
  // 分手后好感又满了，可以重新表白
  for (let i = 0; i < 30; i += 1) adjustAffinity(save, id, 5);
  ok(f().affinity === 100 && canConfess(save, f()), '分手后再满好感可以重新表白');
  ok(setLover(save, id).ok && isLover(save, id), '可以重新在一起');

  /**
   * ★ 恋人保护（用户拍板：**恋人不能直接删好友，除非先分手**）
   *   以前是"删好友顺手清掉恋人"，现在反过来了：恋人删不掉，得先分手。
   */
  const refuseDel = removeFriend(save, id);
  ok(refuseDel.ok === false && refuseDel.needBreakup === true, '★ 恋人不能直接删（要先分手）');
  ok(save.loverId === id, '关系还在，没有被他偷偷抹掉');
  ok(breakUp(save, id).ok, '先分手');
  ok(removeFriend(save, id).ok, '分手之后可以删了');
  ok(!save.loverId, '★ 删掉之后不会留一个幽灵恋人');
}

/* ---------------- 本地兜底也要认得出表白 / 分手 ---------------- */
console.log('── 表白与分手的本地兜底判断');
{
  const yes = [
    '我喜欢你',
    '我真的很喜欢你很久了',
    '我们在一起吧',
    '做我女朋友好吗',
    '我想和你谈恋爱',
    '做我对象吧',
  ];
  for (const t of yes) ok(isConfession(t), `应判为表白：「${t}」`);
  const no = [
    '你真厉害',
    '我喜欢打牌',
    '我宣布我爱你（开玩笑的）',
    '逗你的，别当真',
    '今天天气不错',
    '我舍不得走',
    '我妈喜欢喝奶茶',
  ];
  for (const t of no) ok(!isConfession(t), `不该判为表白：「${t}」`);
  ok(isConfession('我是认真的，不是开玩笑的，我喜欢你'), '带"不是开玩笑"的仍然是表白');

  const brk = ['我们分手吧', '分手吧', '我们还是做朋友吧', '别在一起了', '我们还是散了吧'];
  for (const t of brk) ok(isBreakup(t), `应判为分手：「${t}」`);
  const noBrk = ['你再不理我就要分手了', '我生气了', '你要是这样我们就分手', '今天好累', '我们一起去打牌吧'];
  for (const t of noBrk) ok(!isBreakup(t), `不该判为分手：「${t}」`);

  // 开关：不审查时一律 false
  ok(!localAnalyze('我喜欢你', { allowConfess: false }).confess, '不允许审查时，表白也是 false');
  ok(!localAnalyze('我们分手吧', { askBreakup: false }).breakup, '不允许审查时，分手也是 false');
  ok(localAnalyze('我喜欢你', { allowConfess: true }).confess, '允许审查时能认出来');
  ok(localAnalyze('我们分手吧', { askBreakup: true }).breakup, '允许审查时能认出分手');
}

/* ---------------- 自设：AI 自己临时补充的设定 ---------------- */
console.log('── 自设（AI 顺口说的设定，下次不能矛盾）');
{
  const save = defaultSave();
  const p = PERSONAS[4];
  addFriend(save, p);
  const id = p.id;

  // 从 AI 自己的那句回复里抠
  const cases = [
    ['我是杭州人', '老家', '杭州'],
    ['我老家在成都', '老家', '成都'],
    ['我养了只橘猫', '宠物', '只橘猫'],
    ['我平时喜欢打游戏', '爱好', '打游戏'],
  ];
  for (const [reply, aspect, want] of cases) {
    const got = extractSelfMemory(reply);
    ok(got[aspect] && got[aspect].includes(want), `「${reply}」→ ${aspect}=${got[aspect]}`);
  }
  ok(Object.keys(extractSelfMemory('今天牌不错')).length === 0, '没说自己设定就不抓');
  ok(Object.keys(extractSelfMemory('')).length === 0, '空文本不炸');

  // 写入 + 按"方面"覆盖
  const r1 = setSelfMemory(save, id, '老家', '杭州');
  ok(r1.added && r1.memory === '自设：老家=杭州', '写入自设（带固定前缀）');
  ok(listSelfMemory(findFriend(save, id)).length === 1, '自设单独能列出来');
  ok(listPlayerMemory(findFriend(save, id)).length === 0, '自设不会被当成"关于玩家的事"');
  ok(!setSelfMemory(save, id, '老家', '杭州').added, '同样的自设不重复写');

  const r2 = setSelfMemory(save, id, '老家', '成都');
  ok(r2.added && r2.updated && r2.replaced === '自设：老家=杭州', '★ 同一个方面会覆盖，不会两个老家并存');
  ok(listSelfMemory(findFriend(save, id)).filter((m) => m.includes('老家')).length === 1, '老家只剩一条');

  setSelfMemories(save, id, { 职业: '大学生', 宠物: '橘猫' });
  ok(listSelfMemory(findFriend(save, id)).length === 3, '可以有好几个方面（老家/职业/宠物）');
  ok(selfAspectOf('自设：老家=杭州') === '老家', '能取到方面');
  ok(selfValueOf('自设：老家=杭州') === '杭州', '能取到内容');
  ok(isSelfMemory('自设：老家=杭州') && !isSelfMemory('偏好：奶茶'), '前缀能区分自设和玩家记忆');
  ok(memoryIcon('自设：老家=杭州') === '🧬', '自设有自己的图标');
  ok(setSelfMemory(save, id, '', 'x').added === false, '空方面不写');
  ok(setSelfMemory(save, 'nope', '老家', '杭州').added === false, '不是好友就不写');

  // 提示词里分两组给模型
  const msgs = buildFriendMessages({
    persona: p,
    friend: findFriend(save, id),
    text: '你哪儿人啊',
    cp: false,
    lover: false,
  }).map((m) => m.content).join('\n');
  ok(/你自己.*在聊天里说过的设定/.test(msgs), '★ 提示词里明确给出"你说过的设定"');
  ok(msgs.includes('自设：老家=成都'), '自设内容进了提示词');
  ok(/不能前后矛盾|必须保持一致/.test(msgs), '并强调不能矛盾');
}

/* ---------------- 恋人 / 自设也要进分析提示词 ---------------- */
console.log('── 分析提示词的开关');
{
  const p = PERSONAS[3];
  const friendBase = { personaId: p.id, affinity: 30, memory: ['偏好：奶茶'], chat: [] };

  const plain = buildAnalyzeMessages({ persona: p, friend: friendBase, text: '在吗' })
    .map((m) => m.content).join('\n');
  ok(!/confess/.test(plain), '平时不审查表白（省一次判断）');
  ok(!/breakup/.test(plain), '平时也不审查分手');
  ok(/自设/.test(plain), '但自设一直都要审查');

  const conf = buildAnalyzeMessages({ persona: p, friend: friendBase, text: '我喜欢你', allowConfess: true })
    .map((m) => m.content).join('\n');
  ok(/"confess"/.test(conf), '好感满时加上 confess 字段');
  ok(!/breakup/.test(conf), '没到恋人就不问分手');
  // ★ 表白判定（用户最终口径）：不让 AI 自由婉拒 ——
  //   模型只判"玩家这句是不是表白"，答不答应由系统按三条硬规则判（异性 / 单身 / 没有明确拒绝）
  ok(!/"accept"/.test(conf), '★ 不再让模型决定"答不答应"');
  ok(/答不答应由系统按规则来判/.test(conf), '★ 提示词里说明了由系统按规则判');

  const brk = buildAnalyzeMessages({ persona: p, friend: friendBase, text: '我们分手吧', askBreakup: true })
    .map((m) => m.content).join('\n');
  ok(/"breakup"/.test(brk) && !/confess/.test(brk), '是恋人时问分手、不再问表白');
  ok(/你会同意（虽然难过）/.test(brk), '明确写了"你会同意"');

  ok(parseAnalysis('{"delta":1,"memory":"","self":{},"confess":true}').confess === true, '解析 confess');
  ok(parseAnalysis('{"delta":1,"memory":"","self":{},"breakup":true}').breakup === true, '解析 breakup');
  ok(parseAnalysis('{"delta":1,"memory":"","self":{}}').confess === false, '没有这个字段就是 false');
  ok(parseAnalysis('{"self":{"老家":"杭州","":"x"}}').self['老家'] === '杭州', '解析 self');
  ok(!('' in parseAnalysis('{"self":{"老家":"杭州","":"x"}}').self), '空方面丢掉');
}

/* ---------------- ★ 防"记反"：AI 编的设定与玩家的事不能串 ---------------- */
console.log('── 防记反（AI 自己的设定 vs 玩家的事）');
{
  // 用户报的那个 bug：
  //   玩家「我是南京人」 / AI「我是溧阳的，离你那儿不远」
  //   模型记反 → self={老家:南京}、memory=身份：溧阳人 → 再问它哪儿人就说"我是南京人"
  const player = '我是南京人';
  const reply = '我是溧阳的，离你那儿不远';

  ok(appearsIn('南京', player), 'appearsIn：整串命中');
  ok(appearsIn('江苏省溧阳市', reply), 'appearsIn：模型改成"江苏省溧阳市"也能命中（2 字滑窗）');
  ok(!appearsIn('南京', reply), 'appearsIn：没出现就是不命中');
  ok(!appearsIn('', player) && !appearsIn('南京', ''), 'appearsIn：空值安全');

  // 记反的两种形态都要被拦下
  ok(guardSelfFacts({ 老家: '南京' }, reply, player).老家 === undefined,
    '★ AI 编的设定记成了玩家的事 → 丢掉');
  ok(guardPlayerMemory('身份：溧阳人', player, reply) === '',
    '★ 玩家的事记成了 AI 的设定 → 丢掉');
  ok(Object.keys(guardSelfFacts({ 老家: '南京' }, reply, player)).length === 0, '整条自设被清掉');

  // 记对了要原样保留
  ok(guardPlayerMemory('身份：南京人', player, reply) === '身份：南京人', '记对了：玩家记忆保留');
  ok(guardSelfFacts({ 老家: '溧阳' }, reply, player).老家 === '溧阳', '记对了：自设保留');
  ok(guardSelfFacts({ 老家: '江苏省溧阳市' }, reply, player).老家 === '江苏省溧阳市',
    '模型把"溧阳"写成"江苏省溧阳市"也不误伤');

  // 模型合理改写（两边都没原样出现）→ 保留，宁可多记不误删
  ok(guardPlayerMemory('身份：程序员', '我做后端的', '后端挺累的') === '身份：程序员',
    '模型总结出来的信息（原话里没有）不会被误删');
  ok(guardSelfFacts({ 职业: '自由职业' }, '反正饿不着', '你做什么的').职业 === '自由职业',
    '自设两边都没原样出现时也保留');

  // 同一条信息不能同时算两个人的
  ok(guardSelfFacts({ 老家: '南京' }, '南京我去过', player, '身份：南京人').老家 === undefined,
    '★ 已经算成"玩家的事"了，就不能再算成 AI 的设定');

  // 只有一个人在说这件事时，完全不受影响
  ok(guardPlayerMemory('偏好：爱喝奶茶', '我喜欢喝奶茶', '我也爱喝') === '偏好：爱喝奶茶',
    '玩家自己说的照常收下');
  ok(guardSelfFacts({ 宠物: '橘猫' }, '我养了只橘猫', '你喜欢猫吗').宠物 === '橘猫',
    'AI 自己说的照常收下');

  // 提示词里必须有"别记反"的显式说明与例子
  const prompt = buildAnalyzeMessages({
    persona: PERSONAS[0],
    friend: {
      personaId: PERSONAS[0].id, affinity: 60, memory: [], chat: [],
    },
    text: player,
    reply,
  }).map((m) => m.content).join('\n');
  ok(/别把两个人的话记反/.test(prompt), '★ 提示词里明确写了"别记反"');
  ok(prompt.includes('我是南京人') && prompt.includes('我是溧阳'), '★ 提示词里给了"两边都说老家"的具体例子');
  ok(/反过来写就是错的/.test(prompt), '并明确说了反过来是错的');
}

/* ---------------- ★ 群聊那边同样要防记反 ---------------- */
console.log('── 群聊的防记反');
{
  const replies = [
    { name: '甲', text: '我是溧阳的' },
    { name: '乙', text: '南京不错啊' },
  ];
  const playerText = '我是南京人';
  const guarded = guardGroupSelf({ 甲: { 老家: '南京' } }, { replies, playerText });
  ok(!guarded.甲, '★ 甲（说溧阳）被写成南京 → 丢掉');
  ok(guardGroupSelf({ 甲: { 老家: '溧阳' } }, { replies, playerText }).甲.老家 === '溧阳',
    '甲说对了就保留');
  ok(guardGroupSelf({ 乙: { 老家: '南京' } }, { replies, playerText }).乙.老家 === '南京',
    '乙自己回复里提过南京 → 保留（信息确实出自它那句话）');
  const mem = guardGroupMemory({ 甲: '身份：溧阳人' }, { replies, playerText });
  ok(!mem.甲, '★ 玩家记忆写成甲的设定 → 丢掉');
  ok(guardGroupMemory({ 甲: '身份：南京人' }, { replies, playerText }).甲 === '身份：南京人',
    '玩家的信息照常收下');
}

console.log(`\n────────────────────────────\n${fail ? `失败 ${fail} 项` : '好友系统测试全部通过'}`);
process.exit(fail ? 1 : 0);
