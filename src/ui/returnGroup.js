/**
 * ★ 离线期间"群里自己聊了一批"（用户拍板）
 *
 * 规则：
 *   · 玩家离线 **超过 20 分钟**（GROUP_OFFLINE.minAwayMs）→ 随机挑 **一个群**，
 *     让群里的 AI **连着聊 5~10 条**（条数上下限见 GROUP_OFFLINE.minLines / maxLines）
 *   · 群里至少要 **2 位 AI** 才叫"AI 之间互相接话"（只有 1 位就是自言自语，跳过）
 *   · 每条的时间都落在**玩家离线的那段时间**里、且**按时间递增**
 *     （见 data/clock.js 的 offlineGroupSendTimes —— 玩家点进去要像一段有序的历史）
 *   · 每条都 **计入未读**（bumpGroupUnread）→ 玩家回来看到「群聊」上有红点，
 *     点进去是一串"我不在的时候他们聊的"
 *
 * ★ 和"挂机自动聊天"（GROUP_IDLE，玩家在线静默 10s）的关系：
 *   那条是玩家**在群里看着**时触发的；这条只在**离线回来**时补一批。
 *   两条路径分别独立（不同函数、不同配置），互不影响 —— 用户明确要求"别打架"。
 *
 * 单独放一个文件（而不是塞进 ui/groups.js）的原因：这段逻辑不依赖群聊面板的 DOM，
 * 纯"存档 + AI 调用 + 定时器"，放这里更好测，也少动面板那条链路。
 */
import { GROUP_OFFLINE } from '../config.js';
import {
  listGroups, findGroup, groupMembers, groupChatLines, appendGroupChat, bumpGroupUnread,
} from '../store/groups.js';
import { findFriend, callNameOf } from '../store/friends.js';
import { aiBeansOf, aiTitleOf } from '../store/aiBeans.js';
import { playerGenderLine, playerIdentityLines } from '../data/player.js';
import { offlineGroupSendTimes } from '../data/clock.js';
import { chooseNextSpeaker, groupReply } from '../ai/group.js';

/** 群里能说话的 AI（群成员本身就是人设；被删好友也不退群，所以不再过滤好友关系） */
const aiMembersOf = (group) => groupMembers(group);

/** 5~10 条之间随机一个条数 */
function pickLineCount(rnd = Math.random) {
  const lo = Math.max(1, Number(GROUP_OFFLINE.minLines) || 1);
  const hi = Math.max(lo, Number(GROUP_OFFLINE.maxLines) || lo);
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

/**
 * 这一条到底该显示成几点
 *   · 尽量用排好的模拟时刻，夹进 [leftAt, backAt]
 *   · **保证不比群里最后一条更早** —— appendGroupChat 是追加，时间倒着会出现
 *     "最后一条显示 9:05、倒数第二条显示 9:40"这种穿帮
 */
export function resolveOfflineGroupAt(app, groupId, at, { leftAt, backAt } = {}) {
  const group = findGroup(app && app.save, groupId);
  const last = group && group.chat && group.chat.length
    ? Number(group.chat[group.chat.length - 1].at) || 0
    : 0;
  const now = Date.now();
  const hi = Number.isFinite(Number(backAt)) ? Number(backAt) : now;
  const lo = Number.isFinite(Number(leftAt)) ? Number(leftAt) : 0;
  let t = Number(at);
  if (!Number.isFinite(t)) t = hi - 1000;
  t = Math.max(lo, Math.min(hi, t));
  if (last && t <= last) t = last + 1000; // 兜底：绝不倒着
  if (t <= 0) t = Math.max(1, now - 1000);
  return Math.round(t);
}

/**
 * 排期：离线回来时补一批群聊
 * @param {object} app 应用实例（需要 save / persist；其余都容错）
 * @param {number} awayMs 这次离线了多久
 * @returns {number} 排了多少条（0 = 没触发）
 */
export function scheduleReturnGroupChat(app, awayMs) {
  if (!app || !app.save) return 0;
  const away = Number(awayMs);
  if (!Number.isFinite(away) || away < GROUP_OFFLINE.minAwayMs) return 0; // 不到 20 分钟不补
  // 防御：没群、群被解散、群里 AI 不够 → 什么都不做（绝不许崩）
  const groups = listGroups(app.save).filter((g) => aiMembersOf(g).length >= GROUP_OFFLINE.minAi);
  if (!groups.length) return 0;
  const group = groups[Math.floor(Math.random() * groups.length)];
  if (!group) return 0;
  const count = pickLineCount();
  const backAt = Date.now();
  const leftAt = Math.max(0, backAt - away);
  /**
   * 5~10 条的时间一次性排好：都落在 [leftAt, backAt] 里、按时间递增。
   * 传 personas 只是让时刻带一点"这个人设的作息味"（真正的发言人由 AI 挑）。
   */
  const times = offlineGroupSendTimes({
    leftAt,
    backAt,
    count,
    personas: aiMembersOf(group),
    minGapMs: GROUP_OFFLINE.minGapMs,
  });
  if (!times.length) return 0;
  times.forEach((at, idx) => {
    // 真实投递错开一点（别让 5~10 条同时去打大模型）；消息落库用的是模拟时刻 at
    setTimeout(() => {
      void deliverOfflineGroupLine(app, group.id, { at, leftAt, backAt });
    }, idx * GROUP_OFFLINE.staggerMs);
  });
  return times.length;
}

/**
 * 真的让群里某位 AI 说一条（离线补聊用）
 *   · 谁接下一句：chooseNextSpeaker（和挂机那套同一份实现，AI 之间能接上话）
 *   · 说什么：groupReply（mingle = 玩家没说话，你们自己聊）
 *   · 落库带**模拟时刻**，并计入未读
 * @returns {Promise<object|null>} 追加的那条群消息（跳过时返回 null）
 */
export async function deliverOfflineGroupLine(app, groupId, { at, leftAt, backAt } = {}) {
  if (!app || !app.save) return null;
  const group = findGroup(app.save, groupId);
  if (!group) return null; // 群被解散了 → 跳过
  const members = aiMembersOf(group);
  if (members.length < GROUP_OFFLINE.minAi) return null; // 人退了 / 被踢了 → 跳过
  const chat = findGroup(app.save, groupId);
  if (!chat) return null;
  const recent = groupChatLines(chat, app);
  const lastLine = recent[recent.length - 1] || '';
  const lastSpeaker = lastLine.includes('：') ? lastLine.split('：')[0] : '';
  const who = await chooseNextSpeaker({ group: chat, members, recentLines: recent, lastSpeaker });
  if (!who) return null;
  const persona = members.find((p) => p.id === who.id) || null;
  if (!persona) return null;
  const friend = findFriend(app.save, who.id);
  const { text } = await groupReply({
    persona,
    group: chat,
    members,
    recentLines: recent,
    playerText: '',
    replyTo: null,
    friends: [friend].filter(Boolean),
    playerName: app.playerName,
    playerGender: playerGenderLine(app.save),
    playerIdentity: playerIdentityLines(app.save, { callName: callNameOf(friend), selfId: who.id }),
    // 它自己的身家与称号（实时现算，和在线群聊一个口径）
    myBeans: aiBeansOf(app.save, who.id),
    myTitle: (aiTitleOf(app.save, who.id) || {}).name || '',
    mingle: true, // 玩家这轮没说话：AI 之间自己聊
    lastSpeaker,
  });
  if (!text) return null;
  if (!findGroup(app.save, groupId)) return null; // 期间群被删了 → 别写进去
  const when = resolveOfflineGroupAt(app, groupId, at, { leftAt, backAt });
  const entry = appendGroupChat(app.save, groupId, { role: 'ai', by: who.id, text }, when);
  /**
   * ★ 计入未读（用户拍板）：玩家不在的这段时间里，群里攒了 5~10 条，
   *   回来时「群聊」上要有红点（红点数 = 未读总数，见 app.updateFriendDot）。
   */
  bumpGroupUnread(app.save, groupId);
  if (typeof app.persist === 'function') app.persist('groupOffline');
  if (typeof app.updateFriendDot === 'function') app.updateFriendDot();
  return entry;
}
