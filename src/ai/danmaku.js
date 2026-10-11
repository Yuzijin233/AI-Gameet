/**
 * 弹幕生成（PRD §2.13）
 * 弹幕只出现在"房间/等人开局"界面（牌桌上还是气泡），
 * 结合人设 + memory + 好感度 + 房间场景 + 最近的弹幕（带说话人），
 * 让房间里的人能互相接话、约战、放狠话。
 */
import { DANMAKU } from '../config.js';
import { callDeepSeek } from './chat.js';
import { affinityTier, sortedMemory, listSelfMemory, listPlayerMemory, selfDisclosureLine, memoryGroups } from '../store/friends.js';
import { pickChatLine, chatBucket } from '../data/chatLines.js';
import { ownedLines, OWNER_PLAYER, OWNER_SELF, OWNER_SYSTEM } from '../data/memory.js';
import { genderPromptLine, agePromptLine } from '../data/personas.js';
import { timeContextLine, lastChatGapLine } from '../data/clock.js';
import { aiEconomyLine } from './friend.js';
import { personaReactionLine } from '../data/style.js';

function sanitize(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
}

/**
 * 房间场景文案（纯函数，便于测试）
 * 把"现在房间里几个人、这局需要几个人、还缺几个"作为**背景知识**告诉 AI，
 * 让它能自然说出"二缺一"这种话，而不是硬编在台词里。
 */
export function danmakuSituationText({ seated = 0, needFriends = 2, game = 'ddz' } = {}) {
  const needTotal = needFriends + 1; // 加上玩家
  const now = seated + 1;
  const missing = Math.max(0, needTotal - now);
  const gameName = game === 'fishing' ? '小猫钓鱼' : '斗地主';
  const lack = missing === 1 && needTotal === 3 ? '二缺一' : `还差${missing}个`;
  return [
    `你们在一个${gameName}房间里等人开局，还没有开始打牌。`,
    `房间里现在有 ${now} 个人：玩家 + ${seated} 位好友；这局需要 ${needTotal} 个人。`,
    missing
      ? `现在还差 ${missing} 个人（可以说"${lack}"这种感觉，但别每句都催）。`
      : '人已经齐了，随时可以开局。',
    '可以聊约战、放狠话、聊刚才的输赢和打法，但不要提"该你出牌了""这把牌"之类正在进行中的牌局细节。',
  ].join('');
}

/**
 * 组装弹幕提示词；recent 里每条都带说话人名字，便于"接别人的话"
 * 名字 / 称号 / 人数都只是**背景知识**：话题要围绕"人和游戏"，不要围着称号做文章
 *
 * ★ 这里的记忆与好感度和**私聊完全是同一份**（同一个 `friend` 记录）：
 *   房间弹幕里聊过的、私聊里说过的，互相都看得到 —— 见 app.settleFriendChat 的回写
 */
export function buildDanmakuMessages({
  persona, friend, situation, recent = [], target, playerTitle, playerName, opener = false, lover = false,
  playerGender = '', playerIdentity = '', myBeans = null, myTitle = '',
}) {
  const lines = [
    `你是「${persona.name}」。人设：${persona.prompt || (persona.tags || []).join('、')}`,
    genderPromptLine(persona),
    agePromptLine(persona),
    // ★ 玩家是谁：明确的一段背景知识（昵称 + 性别 + 该怎么叫他），别回头问"你是谁"
    playerIdentity || playerGender,
    // ★ 看人下菜：有些 AI 对"玩家性别 + 好感度"有额外反应（例如说的道理）
    personaReactionLine(persona, { playerGender, affinity: friend ? friend.affinity : 0, lover }),
    timeContextLine(),
    // ★ 它自己的身家与称号（实时注入；背景知识，别拿它当话题）
    aiEconomyLine(myBeans, myTitle),
    lastChatGapLine(recent.map((x) => ({ at: x && x.at }))),
  ];
  // 关系 + 记忆：与私聊共用，分成"关于玩家 / 系统记录 / 你自己说过的设定"三组
  if (friend) {
    const tier = affinityTier(friend.affinity, lover);
    // 排序 + 分组：对局/友圈按时间从新到旧
    const grp = memoryGroups(friend);
    const mine = grp.self;
    const his = grp.player;
    const sys = grp.system;
    lines.push(`你和玩家的关系：${tier.label}（好感度 ${friend.affinity}/100）`);
    if (lover) lines.push('**你和玩家已经是恋人了** —— 房间里也可以护着他、接他的话，但别腻，也别每句都提关系。');
    // ★ 归属标清楚：这几组一个是他、一个是你，别混
    if (his.length) lines.push(`你记得【关于玩家】的事：\n${ownedLines(his, OWNER_PLAYER).join('\n')}`);
    if (sys.length) {
      lines.push('【系统记录】你经历过的（对局 / 友圈 / 改名 / 关系）——**不是"玩家说过的话"**：\n'
        + ownedLines(sys, OWNER_SYSTEM).join('\n'));
    }
    if (his.some((m) => String(m).startsWith('对局：'))) {
      lines.push('（对局记忆按时间从新到旧，带 [月/日 时:分] 的是对局；只有最上面那条才是"刚刚那局"。）');
    }
    if (mine.length) lines.push(`**你自己**说过的设定（不能前后矛盾）：\n${ownedLines(mine, OWNER_SELF).join('\n')}`);
    if (!his.length && !mine.length) lines.push('你和玩家还不算很熟，还没什么特别的记忆。');
    // ★ 关系到哪一档，决定能不能说自己的事（点头之交才可以提家乡）
    lines.push(selfDisclosureLine(friend, { isLover: lover }));
  }
  // 背景知识区：知道就行，不用拿出来讲
  const bg = [];
  if (!playerIdentity && playerName) bg.push(`玩家的昵称是「${playerName}」（可以直接叫他的名字）`);
  if (playerTitle) bg.push(`玩家佩戴的称号是「${playerTitle}」（仅作背景，不用拿它当话题）`);
  if (bg.length) lines.push(`【背景知识】${bg.join('；')}。`);
  if (situation) lines.push(`当前场景：${situation}`);
  // ★ 前几条弹幕：带说话人、按从早到晚的顺序给全，用来"接话"
  if (recent.length) {
    lines.push(`前面几条弹幕（从早到晚，共 ${recent.length} 条，"玩家"就是跟你聊天的人）：`);
    for (const r of recent) lines.push(`  ${r.name}：${r.text}`);
    lines.push('上面最后一条如果就是你自己的，那说明你刚说过话，这次换个说法、或者接别人的话。');
  } else {
    lines.push('前面还没有人发过弹幕，这是第一条。');
  }
  if (target) lines.push(`玩家刚发的弹幕：${target}（可以针对它回应）`);
  if (opener) lines.push('房间里有点冷场，没人说话，你决定先开个口（起个话头、打招呼、约战、吐槽都行）。');

  const system = [
    '你们在一个斗地主游戏的房间里等人开局，大家用**弹幕**聊天（弹幕会从屏幕右边飘到左边）。',
    ...lines,
    '【要求】',
    `1) 发一条弹幕，不超过 ${DANMAKU.maxChars} 个字，越短越好。`,
    '2) **话题围绕"人"和"游戏"**：约战、放狠话、聊刚才那局的输赢与打法、打招呼、叫对方名字、吐槽等待时间；'
      + '也可以接上一条弹幕的话（注意分辨是谁说的）。',
    '3) 称号、身家这类信息只是你知道的背景，最多顺口带一句，不要当成主要话题反复提。',
    '4) 不要客服腔、不要引号、不要换行，不要在开头写自己的名字。',
    '5) 不要主动报时间、不要主动提年龄、不要报牌。',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: '发一条弹幕。' },
  ];
}

/** 本地兜底：弹幕是房间里的闲聊，绕开牌桌上的术语 */
export function localDanmaku(persona, seedText) {
  const style = (persona && persona.style) || 'balanced';
  if (seedText) return pickChatLine(chatBucket(seedText), style);
  return pickChatLine('room', style);
}

/** 生成一条弹幕文案 */
export async function danmakuLine({
  persona, friend, situation, recent, target, playerTitle, playerName, opener, lover, playerGender,
  myBeans = null, myTitle = '',
}) {
  try {
    const raw = await callDeepSeek(buildDanmakuMessages({
      persona, friend, situation, recent, target, playerTitle, playerName, opener, lover, playerGender,
      myBeans, myTitle,
    }));
    const out = sanitize(raw);
    if (out) return { text: out.slice(0, DANMAKU.maxChars + 6), offline: false };
    throw new Error('空回复');
  } catch {
    return { text: localDanmaku(persona, target), offline: true };
  }
}

/**
 * 谁该主动发弹幕？
 * 规则：只有 1 个 AI 且不是"开场第一句"时不主动发（玩家发了才回）；2 个 AI 时随机选一个，
 * 且避免连续两次同一个人。
 */
export function pickSpeaker(seats, lastSpeaker, rnd = Math.random) {
  if (!seats || seats.length < 2) return null;
  const pool = lastSpeaker == null ? seats : seats.filter((s) => s !== lastSpeaker);
  const list = pool.length ? pool : seats;
  return list[Math.floor(rnd() * list.length)];
}

/**
 * 玩家发完弹幕到 AI 回复之间要等多久（模拟真人打字，3~5 秒）
 * 纯函数，便于测试
 */
export function danmakuReplyDelay(rnd = Math.random, cfg = DANMAKU) {
  const min = cfg.replyMin;
  const max = cfg.replyMax;
  return Math.round(min + (max - min) * Math.max(0, Math.min(1, rnd())));
}
