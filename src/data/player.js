/**
 * 玩家档案（性别 / 姓名）—— 首次进入游戏、以及重置存档之后，都要先设一次
 *
 * 为什么性别要有实际作用：它不只是个存档字段 —— AI 的提示词里会带上，
 * 免得 AI 对着一个男生叫"小姐姐"、对着女生叫"老哥"（这是最出戏的地方）。
 *
 * 纯数据 + 纯函数，不碰 DOM，测试可以直接调。
 */

import { PERSONAS } from './personas.js';

/** 可选的性别（默认男；`call` 是给 AI 看的称呼示例） */
export const GENDERS = [
  { id: 'male', label: '男', sign: '♂', emoji: '🙋‍♂️', call: '兄弟 / 老哥 / 小哥', desc: 'AI 会拿你当哥们聊' },
  { id: 'female', label: '女', sign: '♀', emoji: '🙋‍♀️', call: '姐妹 / 小姐姐', desc: 'AI 会拿你当姐妹聊' },
];

export const DEFAULT_GENDER = 'male';

/** 昵称长度上限（和「改名」保持一致） */
export const PLAYER_NAME_MAX = 12;

export const genderById = (id) => GENDERS.find((g) => g.id === id) || null;

/** 存档里的性别（缺省或非法都落回"男"） */
export function playerGenderOf(save) {
  const g = genderById(save && save.gender);
  return g ? g.id : DEFAULT_GENDER;
}

export const playerGenderLabel = (save) => {
  const g = genderById(playerGenderOf(save));
  return g ? g.label : '男';
};

/**
 * 给 AI 的提示词用：说明玩家是男是女，并给几个称呼示例。
 * 返回空串表示"不用提"（老存档没设过性别时也能用，落回默认值）
 */
export function playerGenderLine(save) {
  const g = genderById(playerGenderOf(save));
  if (!g) return '';
  return `玩家是${g.label}生（称呼别叫错性别，可以用「${g.call}」这类说法）`;
}

/**
 * ★ 玩家的感情状况（用户拍板）：玩家有恋人时，**其他 AI 也要知道这件事**。
 *   不一定要主动提，但必须知道 —— 免得它们还去撩、去问"你有没有对象"、或者酸。
 *
 * @param {object} save
 * @param {string} [selfId] 当前说话的这位 AI 的 id：**它本人就是恋人时不再注入**
 *   （那一位有自己的"你俩是恋人"口径）
 * @returns {string} 一行提示词；玩家单身（或就是这位）时返回空串
 */
export function playerLoverLine(save, selfId = '') {
  const id = save && save.loverId;
  if (!id || id === selfId) return '';
  const p = PERSONAS.find((x) => x.id === id);
  const name = (p && p.name) || '某位好友';
  return `【玩家的感情状况】玩家已经有恋人了，是「${name}」。这是背景知识：`
    + '**不要主动提、不要追问、不要酸也不要拆台**（别问"你喜欢谁""怎么不找一个"这类话）；'
    + '玩家自己聊到的时候，你就当知道这件事，正常接话。';
}

/**
 * ★ 「玩家是谁」这块背景知识 —— **所有会开口的 AI 都要知道**（用户拍板）。
 *
 * 为什么单独抽一份：以前各处只零散地塞了半句，结果 AI 常常"不知道玩家叫什么"，
 * 或者把昵称当成自己/别人的设定。这里统一成一段，私聊 / 群聊 / 弹幕 / 友圈 / 主动搭话共用。
 *
 * @param {object} save
 * @param {{callName?:string, scene?:string, selfId?:string}} [opts]
 *   callName = 玩家让它怎么称呼自己（memory 里的「称呼：X」）
 *   scene    = 'chat' | 'table'，桌上话少一点
 *   selfId   = 当前说话这位 AI 的 id（用来判断要不要注入"玩家有恋人"那一行）
 * @returns {string} 多行文本（已按行拼好，可直接 push 进 system 提示词）
 */
export function playerIdentityLines(save, { callName = '', scene = 'chat', selfId = '' } = {}) {
  const name = (save && save.nickname) || '玩家';
  const g = genderById(playerGenderOf(save));
  const out = [];
  out.push(`【玩家是谁】昵称「${name}」（${g ? g.label : '男'}生）`
    + `${g ? `，称呼别叫错性别，可以用「${g.call}」这类说法` : ''}。`);
  out.push(callName
    ? `你平时叫他「${callName}」，聊天里可以直接用这个称呼。`
    : `他还没让你改口，直接叫昵称「${name}」就行。`);
  // ★ 玩家有恋人 → 所有 AI 都知道（但除了恋人本人）
  const lover = playerLoverLine(save, selfId);
  if (lover) out.push(lover);
  out.push(scene === 'table'
    ? '（这是背景知识：**不要报昵称、不要问他是谁**，只是让你知道在跟谁说话。）'
    : `（这是背景知识，你一直就知道：**不用问"你叫什么"**，也不要拿名字当话题；但也不用每句都叫他的名字。）`);
  return out.join('\n');
}

/** 要不要弹"设置性别 + 姓名"那一屏（新手 / 刚重置过存档） */
export function needsProfileSetup(save) {
  if (!save) return true;
  return save.profileSet !== true;
}

/** 昵称清洗：去首尾空白、压掉换行、按上限截断（空则返回空串，交给调用方兜底） */
export function cleanPlayerName(raw, max = PLAYER_NAME_MAX) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('');
}
