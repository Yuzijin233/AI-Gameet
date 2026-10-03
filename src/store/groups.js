/**
 * 群聊（存档层，PRD §2.20）
 *
 * 数据形状：
 *   save.groups = [{
 *     id, name, members: ['p03','p07'], createdAt,
 *     unread: 0,
 *     chat: [{ id, role:'me'|'ai', by:'me'|personaId, text, at,
 *              replyTo?: { by, name, text } }]
 *   }]
 *
 * 边界（用户明确要求）：
 *   · **群聊不影响好感度** —— 这个文件里没有任何改好感度的调用
 *   · 群成员只能是**已经是好友**的人（先从好友里拉人）
 *   · 群聊内容仍然会经过 AI 审查，决定要不要写进各自的 memory（在外层做）
 */
import { GROUP } from '../config.js';
import { PERSONAS } from '../data/personas.js';
// 只用于"拉人进群"时的校验（群成员本身不因为是好友才留下，见 ensureGroups）
import { isFriend } from './friends.js';

export function ensureGroups(save) {
  if (!Array.isArray(save.groups)) save.groups = [];
  // 清掉脏数据：群成员必须是**真实存在的人设**
  // ★ 注意：**删掉的好友不退群**（用户拍板）—— 它还留在群里，记忆和聊天记录都在，
  //   所以这里不再用 isFriend() 过滤
  save.groups = save.groups.filter((g) => g && typeof g.id === 'string');
  for (const g of save.groups) {
    if (typeof g.name !== 'string' || !g.name.trim()) g.name = '我的群聊';
    if (!Array.isArray(g.members)) g.members = [];
    g.members = g.members.filter((id) => PERSONAS.some((p) => p.id === id));
    if (!Array.isArray(g.chat)) g.chat = [];
    if (!Number.isFinite(g.unread) || g.unread < 0) g.unread = 0;
  }
  return save.groups;
}

export function listGroups(save) {
  return ensureGroups(save).slice();
}

export function findGroup(save, id) {
  return ensureGroups(save).find((g) => g.id === id) || null;
}

export const groupMembers = (group) => (group ? group.members.map((id) => PERSONAS.find((p) => p.id === id)).filter(Boolean) : []);

const DEFAULT_NAMES = ['牌友小群', '今晚开黑', '摸鱼群', '欢乐斗地主群', '唠嗑群'];
const pickDefaultName = (rnd = Math.random) => DEFAULT_NAMES[Math.floor(rnd() * DEFAULT_NAMES.length)];

let seq = 0;
const nextId = (prefix) => {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
};

/**
 * 建群
 * @param {string[]} memberIds 只能是好友
 * @returns {{ok:boolean, group?:object, error?:string}}
 */
export function createGroup(save, name, memberIds, rnd = Math.random) {
  const groups = ensureGroups(save);
  if (groups.length >= GROUP.maxGroups) {
    return { ok: false, error: `最多建 ${GROUP.maxGroups} 个群，先删掉一个吧` };
  }
  const members = uniqFriends(save, memberIds);
  if (members.length < GROUP.minMembers) {
    return { ok: false, error: `至少拉 ${GROUP.minMembers} 位好友进群` };
  }
  const group = {
    id: nextId('g'),
    name: String(name || '').trim().slice(0, 12) || pickDefaultName(rnd),
    members: members.slice(0, GROUP.maxMembers),
    chat: [],
    unread: 0,
    createdAt: Date.now(),
  };
  groups.push(group);
  return { ok: true, group };
}

/** 去重 + 只留好友 + 截断到上限 */
function uniqFriends(save, ids) {
  const out = [];
  for (const id of ids || []) {
    if (!id || out.includes(id)) continue;
    if (!PERSONAS.some((p) => p.id === id)) continue;
    if (!isFriend(save, id)) continue;
    out.push(id);
    if (out.length >= GROUP.maxMembers) break;
  }
  return out;
}

export function renameGroup(save, id, name) {
  const g = findGroup(save, id);
  if (!g) return { ok: false, error: '群不存在' };
  const t = String(name || '').trim().slice(0, 12);
  if (!t) return { ok: false, error: '群名称不能为空' };
  g.name = t;
  return { ok: true, group: g };
}

/** 拉好友进群（已进群的自动跳过） */
export function addGroupMembers(save, id, ids) {
  const g = findGroup(save, id);
  if (!g) return { ok: false, error: '群不存在' };
  const want = uniqFriends(save, [...g.members, ...(ids || [])]);
  const added = want.filter((x) => !g.members.includes(x));
  if (!added.length) return { ok: false, error: '这几位已经在群里了' };
  g.members = want;
  return { ok: true, added, group: g };
}

export function removeGroupMember(save, id, personaId) {
  const g = findGroup(save, id);
  if (!g) return { ok: false, error: '群不存在' };
  if (!g.members.includes(personaId)) return { ok: false, error: '它不在这个群里' };
  g.members = g.members.filter((x) => x !== personaId);
  return { ok: true, group: g, empty: g.members.length === 0 };
}

export function deleteGroup(save, id) {
  const groups = ensureGroups(save);
  const i = groups.findIndex((g) => g.id === id);
  if (i < 0) return { ok: false, error: '群不存在' };
  groups.splice(i, 1);
  return { ok: true };
}

/**
 * 追加一条群消息
 * @param {{role:'me'|'ai'|'sys', by?:string, text:string, replyTo?:object, sys?:boolean}} msg
 *   role:'sys'（或 sys:true）= **系统行**（拍一拍那类）：界面上渲染成居中一行小灰字，
 *   不进提示词、也不算任何人说的话（见 ui/groups.js 与 groupChatLines）。
 */
export function appendGroupChat(save, groupId, msg, at = Date.now()) {
  const g = findGroup(save, groupId);
  if (!g) return null;
  const role = msg.role === 'me' ? 'me' : (msg.role === 'sys' ? 'sys' : 'ai');
  const entry = {
    id: nextId('m'),
    role,
    by: msg.by,
    text: String(msg.text || '').trim().slice(0, GROUP.maxChars),
    at,
  };
  // 标记留着：提示词那边一眼就能跳过它（不靠文案前缀去认）
  if (role === 'sys' || msg.sys) entry.sys = true;
  if (msg.replyTo) {
    entry.replyTo = {
      by: msg.replyTo.by,
      name: String(msg.replyTo.name || '').slice(0, 16),
      text: String(msg.replyTo.text || '').slice(0, 40),
    };
  }
  g.chat.push(entry);
  if (g.chat.length > GROUP.maxHistory) g.chat.splice(0, g.chat.length - GROUP.maxHistory);
  return entry;
}

/**
 * 提示词里给 AI 看最近 N 条。
 * ★ 系统行（拍一拍那类，`sys: true` / `role: 'sys'`）**不算消息**：
 *   它是给玩家看的界面提示，AI 把它当成谁说的话都会很怪（"你拍了拍…"到底谁说的？）。
 */
export function recentGroupChat(group, n = GROUP.recent) {
  const list = ((group && group.chat) || []).filter((m) => m && m.role !== 'sys' && !m.sys);
  return list.slice(-Math.max(1, n));
}

/** 把消息转成提示词里的"谁：说了什么" */
export function groupChatLines(group, app, n = GROUP.recent) {
  const names = memberNameMap(group);
  return recentGroupChat(group, n).map((m) => {
    const who = m.role === 'me' ? (app && app.playerName) || '玩家' : names[m.by] || '有人';
    const quote = m.replyTo ? `（回复 ${m.replyTo.name}：${m.replyTo.text}）` : '';
    return `${who}${quote}：${m.text}`;
  });
}

/** personaId → 名字 */
export function memberNameMap(group) {
  const map = {};
  for (const p of groupMembers(group)) map[p.id] = p.name;
  return map;
}

export function bumpGroupUnread(save, id, n = 1) {
  const g = findGroup(save, id);
  if (!g) return 0;
  g.unread = Math.min(99, (g.unread || 0) + n);
  return g.unread;
}

export function clearGroupUnread(save, id) {
  const g = findGroup(save, id);
  if (g) g.unread = 0;
  return g;
}

export function groupUnreadTotal(save) {
  return listGroups(save).reduce((s, g) => s + (g.unread || 0), 0);
}
