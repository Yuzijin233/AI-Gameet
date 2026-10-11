/**
 * 礼物台词（本地生成，赠礼消息正文用）
 *
 * 两个用途：
 *   1. 玩家在好友界面赠送礼物 → 聊天里出现一条**赠礼消息**（玩家那一侧）
 *   2. 审查 AI 决定回赠 → 它那一侧出现一条赠礼消息
 *
 * 为什么要本地写死：赠礼消息要**稳定、简短、带礼物本身**（emoji + 名字已经单独渲染成礼物卡），
 * 再让模型自由发挥反而容易写出"我给你转了个 520"这种跑偏的句子。
 * 人设口吻由 `decorateLine` 补（表情 / 颜文字 / 叠句）。
 */
import { decorateLine } from './style.js';

/** 玩家送出去时显示的那句（玩家视角，第一人称） */
export const PLAYER_GIFT_LINES = {
  g_rose: ['给你带了一支花，收下吧。', '路过看到，顺手买的。', '这支玫瑰给你。'],
  g_box: ['挑了个礼盒，希望你喜欢。', '包了一下，打开看看。', '给你准备了个小礼物。'],
  g_diamond: ['这个给你，别嫌俗。', '攒了挺久，收着吧。', '一点心意，比花实在。'],
  g_ring: ['这个…你收着。', '想了很久，还是给你。', '不用我多说吧，收下。'],
};

/** AI 回赠时的那句（第三人称叙述 + 它的口吻由 decorateLine 补） */
export const AI_GIFT_LINES = {
  g_rose: ['这个给你，收下吧', '顺手带的，别嫌弃', '给你的，一支花而已'],
  g_box: ['给你挑了个礼盒，拆开看看', '这个你收着，别客气', '一点心意，收下'],
  g_diamond: ['这个给你，够意思吧', '收着吧，我留着也没用', '算你运气好，给你了'],
  g_ring: ['这个…你收着', '想了很久，还是给你', '不用我多说吧'],
};

const pick = (pool, rnd = Math.random) => pool[Math.floor(rnd() * pool.length)] || '';

/** 玩家赠礼时那句话（带礼物名，方便聊天里直接看懂） */
export function playerGiftLine(gift, rnd = Math.random) {
  const line = pick(PLAYER_GIFT_LINES[gift && gift.id] || ['送你一件礼物。'], rnd);
  return `${gift && gift.emoji ? `${gift.emoji} ` : ''}${line}`;
}

/** AI 回赠时那句话（人设口吻交给 decorateLine） */
export function aiGiftLine(persona, gift, rnd = Math.random) {
  const line = pick(AI_GIFT_LINES[gift && gift.id] || ['这个给你'], rnd);
  return decorateLine(line, persona);
}
