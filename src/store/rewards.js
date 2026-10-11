/**
 * 奖励发放 + 邮箱（PRD §2.16 / §2.18）
 *
 * 奖励是一个纯数据对象：`{ kind, ... }`
 *   beans      { amount }
 *   item       { id, n }            牌桌道具，进库存
 *   frame      { id }               头像框，进"已拥有"，不自动佩戴
 *   cardBack   { id }               牌背，进"已拥有"，不自动使用
 *   title      { id }               称号，直接解锁
 *   renameCard { n }                改名卡，进数量
 *
 * 两种发放方式：
 *   · 直接到账（免费礼包、限时礼包、累计充值、折扣、转盘）—— 即时反馈
 *   · **走邮箱**（**目前只有首充礼包**）—— 仪式感在"收到一封邮件、点领取"那一刻，
 *     也让邮箱有存在意义
 */
import { addItems } from './items.js';
import { ensureCosmetics, ownFrame, ownCardBack, addRenameCard } from './cosmetics.js';
import { ensureTitleState } from './titles.js';
import { rewardLabel } from '../data/activities.js';

/* ===================================================================== */
/*                              发奖                                     */
/* ===================================================================== */

/**
 * 把一条奖励落到存档上
 * @returns {string} 人话描述（用于 toast / 出货弹窗）
 */
export function applyReward(save, r) {
  const { emoji, text } = rewardLabel(r);
  if (!r || !r.kind) return `${emoji} ${text}`;
  switch (r.kind) {
    case 'beans':
      save.beans = Math.max(0, Math.round(save.beans + Number(r.amount || 0)));
      break;
    case 'item':
      addItems(save, r.id, Number(r.n || 1));
      break;
    case 'frame':
      ownFrame(save, r.id);
      break;
    case 'cardBack':
      ownCardBack(save, r.id);
      break;
    case 'title': {
      const st = ensureTitleState(save);
      if (!st.unlocked.includes(r.id)) st.unlocked.push(r.id);
      break;
    }
    case 'renameCard':
      addRenameCard(save, Number(r.n || 1));
      break;
    default:
      break;
  }
  return `${emoji} ${text}`;
}

/** 一批奖励一起发，返回文案数组 */
export function applyRewards(save, list) {
  ensureCosmetics(save);
  return (list || []).map((r) => applyReward(save, r));
}

/* ===================================================================== */
/*                              邮箱                                     */
/* ===================================================================== */
/** 邮件有效期：30 天，过期就不能再领（真游戏的惯例） */
export const MAIL_TTL_MS = 30 * 86400000;
export const MAIL_MAX = 50;

export function ensureMail(save) {
  if (!Array.isArray(save.mail)) save.mail = [];
  return save.mail;
}

let mailSeq = 0;
function nextMailId() {
  mailSeq += 1;
  return `m${Date.now().toString(36)}${mailSeq}`;
}

/**
 * 发一封带奖励的邮件
 * @param {{from?:string, title:string, body?:string, rewards?:object[]}} opts
 */
export function pushMail(save, {
  from = '游戏运营', title = '奖励', body = '', rewards = [],
} = {}) {
  const box = ensureMail(save);
  const at = Date.now();
  const mail = {
    id: nextMailId(),
    from,
    title,
    body,
    rewards: rewards.map((r) => ({ ...r })),
    at,
    expireAt: at + MAIL_TTL_MS,
    read: false,
    claimed: false,
  };
  box.unshift(mail);
  if (box.length > MAIL_MAX) box.length = MAIL_MAX; // 只留最近的，防止存档无限膨胀
  return mail;
}

/** 已过期的邮件：不能领，但还留着让人知道自己错过了什么 */
export function isMailExpired(mail, now = Date.now()) {
  return !!mail && Number(mail.expireAt) > 0 && now > Number(mail.expireAt);
}

/** 可领取的邮件数（红点用） */
export function claimableMailCount(save, now = Date.now()) {
  return ensureMail(save).filter((m) => !m.claimed && !isMailExpired(m, now)).length;
}

/** 未读邮件数（红点用；领取状态与已读状态分开） */
export function unreadMailCount(save) {
  return ensureMail(save).filter((m) => !m.read).length;
}

export function markMailRead(save, id) {
  const m = ensureMail(save).find((x) => x.id === id);
  if (m) m.read = true;
  return !!m;
}

export function markAllMailRead(save) {
  ensureMail(save).forEach((m) => { m.read = true; });
}

/**
 * 领取一封邮件里的奖励
 * @returns {{ok:boolean, error?:string, got?:string[]}}
 */
export function claimMail(save, id, now = Date.now()) {
  const m = ensureMail(save).find((x) => x.id === id);
  if (!m) return { ok: false, error: '邮件不存在' };
  if (m.claimed) return { ok: false, error: '这封已经领过了' };
  if (isMailExpired(m, now)) return { ok: false, error: '邮件已过期' };
  m.read = true;
  m.claimed = true;
  m.claimedAt = now;
  return { ok: true, got: applyRewards(save, m.rewards), mail: m };
}

/** 一键领取（返回领到的全部奖励文案） */
export function claimAllMail(save, now = Date.now()) {
  const got = [];
  let count = 0;
  for (const m of ensureMail(save)) {
    if (m.claimed || isMailExpired(m, now)) continue;
    const res = claimMail(save, m.id, now);
    if (res.ok) { count += 1; got.push(...res.got); }
  }
  return { ok: count > 0, count, got };
}

/** 面板用列表：带上"能不能领 / 过没过期"，按时间从新到旧 */
export function listMailWithState(save, now = Date.now()) {
  return ensureMail(save).map((m) => ({
    ...m,
    expired: isMailExpired(m, now),
    canClaim: !m.claimed && !isMailExpired(m, now),
  })).sort((a, b) => b.at - a.at);
}

/** 清理已被领取且超过 7 天的邮件（保持存档干净，但别删太快，让人还能回看） */
export function pruneMail(save, now = Date.now()) {
  const box = ensureMail(save);
  const keep = box.filter((m) => !(m.claimed && now - Number(m.claimedAt || m.at) > 7 * 86400000));
  const removed = box.length - keep.length;
  save.mail = keep;
  return removed;
}
