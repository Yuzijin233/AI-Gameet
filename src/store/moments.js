/**
 * 友圈（社交里的"朋友圈"）
 *
 * 数据结构挂在存档上：`save.moments = [说说…]`（**最新的在前**）
 *   { id, at, by, text, likes: ['me'|personaId…], comments: [{ id, at, by, text, replyTo }] }
 *     by = 'me'（玩家发的）或 personaId（**AI 好友发的**，用户要求离线期间 AI 也会发）
 *     replyTo = 被回复的那条评论 id（没有就是空串）
 *
 * 玩家可以发说说、点赞、评论；AI 能点赞、能评论、**离线期间还会自己发说说**。
 * 纯数据层，不碰 DOM、不联网。
 */
import { MOMENTS } from '../config.js';

const rid = (prefix) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

export function ensureMoments(save) {
  if (!Array.isArray(save.moments)) save.moments = [];
  save.moments = save.moments.filter((m) => m && typeof m.id === 'string');
  for (const m of save.moments) {
    if (typeof m.text !== 'string') m.text = '';
    if (!Number.isFinite(m.at)) m.at = Date.now();
    // 老存档没有 by：默认是玩家自己发的
    if (typeof m.by !== 'string' || !m.by) m.by = 'me';
    if (!Array.isArray(m.likes)) m.likes = [];
    if (!Array.isArray(m.comments)) m.comments = [];
    m.comments = m.comments.filter((c) => c && typeof c.text === 'string');
    for (const c of m.comments) {
      if (typeof c.by !== 'string' || !c.by) c.by = 'me';
      if (!Number.isFinite(c.at)) c.at = Date.now();
      if (typeof c.replyTo !== 'string') c.replyTo = '';
      if (typeof c.id !== 'string' || !c.id) c.id = rid('c');
    }
    if (m.comments.length > MOMENTS.maxComments) {
      m.comments = m.comments.slice(-MOMENTS.maxComments);
    }
  }
  if (save.moments.length > MOMENTS.maxPosts) save.moments.length = MOMENTS.maxPosts;
  return save.moments;
}

/** 全部说说（最新在前） */
export const listMoments = (save) => ensureMoments(save).slice();

export const findMoment = (save, id) => ensureMoments(save).find((m) => m.id === id) || null;

/**
 * 发一条说说
 * @param {string} text
 * @param {{at?:number, by?:string}} [opts] by = 'me'（玩家）或 personaId（AI 好友）
 */
export function addMoment(save, text, { at = Date.now(), by = 'me' } = {}) {
  const list = ensureMoments(save);
  const t = String(text || '').trim().slice(0, MOMENTS.maxChars);
  if (!t) return { ok: false, error: '写点什么再发吧' };
  const moment = {
    id: rid('m'), at, by, text: t, likes: [], comments: [],
  };
  // 列表是"最新的在前"：补发（at 早于最新那条）时插到正确位置，别让时间倒着走
  if (list.length && at < (list[0].at || 0)) {
    let i = 0;
    while (i < list.length && (list[i].at || 0) > at) i += 1;
    list.splice(i, 0, moment);
  } else {
    list.unshift(moment);
  }
  if (list.length > MOMENTS.maxPosts) list.length = MOMENTS.maxPosts;
  return { ok: true, moment };
}

/**
 * 删掉一条说说（用户要求：只删这一条，**不影响别的**）
 *   · 它的赞和评论一起没了（它们就挂在这条说说上）
 *   · 不碰好友、不碰好感度、不碰记忆（AI 记得的和它是两回事）
 * @returns {{ok:boolean, moment?:object}}
 */
export function removeMoment(save, id) {
  const list = ensureMoments(save);
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return { ok: false };
  const [moment] = list.splice(i, 1);
  return { ok: true, moment };
}

/** 点赞 / 取消点赞（who = 'me' 或 personaId） */export function toggleMomentLike(save, id, who = 'me') {
  const m = findMoment(save, id);
  if (!m) return { ok: false };
  const i = m.likes.indexOf(who);
  if (i >= 0) m.likes.splice(i, 1);
  else m.likes.push(who);
  return { ok: true, liked: i < 0, likes: m.likes.slice() };
}

export const hasLiked = (save, id, who = 'me') => {
  const m = findMoment(save, id);
  return !!(m && m.likes.includes(who));
};

/**
 * 点赞（**幂等**：已经赞过就什么都不做）
 * ★ 离线补的那批赞用它 —— 那些赞是"玩家不在时陆陆续续点的"，
 *   所以还要能指定 `at`（存在 likes 里的只有 id，时间点在别的字段上不需要）
 */
export function addMomentLike(save, id, who) {
  const m = findMoment(save, id);
  if (!m || !who) return { ok: false };
  if (!m.likes.includes(who)) m.likes.push(who);
  return { ok: true, likes: m.likes.slice() };
}

/** 追加一条评论（by = 'me' 或 personaId；replyTo = 被回复的评论 id） */
export function addMomentComment(save, id, {
  by = 'me', text = '', replyTo = '', at = Date.now(),
} = {}) {
  const m = findMoment(save, id);
  if (!m) return { ok: false, error: '这条说说不见了' };
  const limit = by === 'me' ? MOMENTS.maxChars : MOMENTS.commentMaxChars;
  // ★ 评论允许换行（用户要求）：只把行数限量一下，别把换行压成空格
  let lines = String(text || '').replace(/\r\n?/g, '\n').trim().split('\n');
  if (by !== 'me' && lines.length > MOMENTS.commentMaxLines) lines = lines.slice(0, MOMENTS.commentMaxLines);
  const t = lines.join('\n').slice(0, limit).trim();
  if (!t) return { ok: false, error: '评论不能是空的' };
  const comment = { id: rid('c'), at, by, text: t, replyTo: replyTo || '' };
  m.comments.push(comment);
  if (m.comments.length > MOMENTS.maxComments) m.comments = m.comments.slice(-MOMENTS.maxComments);
  return { ok: true, comment, moment: m };
}

export const findMomentComment = (moment, commentId) => (
  moment && Array.isArray(moment.comments)
    ? moment.comments.find((c) => c.id === commentId) || null
    : null
);

/** 统计（界面用） */
export const momentStats = (moment) => ({
  likes: (moment && moment.likes ? moment.likes.length : 0),
  comments: (moment && moment.comments ? moment.comments.length : 0),
});

/** 最近几条评论的文字（给提示词当上下文） */
export function recentMomentComments(moment, n = 6) {
  const list = (moment && moment.comments) || [];
  return list.slice(-n).map((c) => ({ by: c.by, text: c.text }));
}

/* ===================================================================== */
/*                           未读（小红点）                               */
/* ===================================================================== */
/**
 * 上次看友圈之后，好友们又来了几条评论（玩家自己发的动作不算）
 * 只数评论：赞没有时间戳，单独算会把很久以前的赞也当成"新的"
 * @returns {number}
 */
export function momentUnreadTotal(save) {
  const seen = Number(save.momentsSeenAt) || 0;
  let n = 0;
  for (const m of ensureMoments(save)) {
    n += (m.comments || []).filter((c) => c.by !== 'me' && c.at > seen).length;
  }
  return n;
}

/** 打开友圈那一刻：全部标记为已看 */
export function markMomentsSeen(save, at = Date.now()) {
  ensureMoments(save);
  save.momentsSeenAt = at;
  return at;
}
