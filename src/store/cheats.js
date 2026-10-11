/**
 * 聊天里的"指令"（用户拍板：给好友发 【/happy】 直接满好感度）
 *
 * 为什么单独一个模块：这是个**开关**，不是对话内容 ——
 *   · 不该发给大模型（AI 回一句"什么是 /happy"很出戏）
 *   · 不该进聊天记录
 *   · 但又要好用、可测、以后好加别的指令
 *
 * 目前只有一条：
 *   `/happy`   → 把这位好友的好感度直接拉满（100）
 *
 * 识别规则：去掉首尾空白、**不分大小写**、允许全角斜杠（／）。
 */
import { FRIEND } from '../config.js';
import { findFriend } from './friends.js';

/** 支持的指令表（以后要加就加在这里） */
export const CHEATS = [
  {
    key: 'happy',
    usage: '/happy',
    desc: '把这位好友的好感度直接拉满',
  },
];

/**
 * 这句是不是一条指令
 * @returns {{key:string, usage:string}|null}
 */
export function parseCheat(text) {
  const raw = String(text == null ? '' : text).trim().replace(/^／/, '/');
  if (!raw.startsWith('/')) return null;
  const word = raw.slice(1).trim().toLowerCase();
  if (!word) return null;
  return CHEATS.find((c) => c.key === word) || null;
}

/**
 * 执行指令
 * @param {object} save
 * @param {string} personaId
 * @param {string} text
 * @returns {{handled:false} | {handled:true, key:string, message:string, before?:number, after?:number}}
 */
export function applyCheat(save, personaId, text) {
  const hit = parseCheat(text);
  if (!hit) return { handled: false };
  const friend = findFriend(save, personaId);
  if (!friend) return { handled: true, key: hit.key, message: '还不是好友' };
  if (hit.key === 'happy') {
    const before = Number(friend.affinity) || 0;
    friend.affinity = FRIEND.maxAffinity;
    // 顺带把"拒绝过"的痕迹清掉：好感都满了，当然可以再表白一次
    friend.refusedAt = 0;
    return {
      handled: true,
      key: hit.key,
      before,
      after: friend.affinity,
      message: `好感度已拉满（${before} → ${friend.affinity}）`,
    };
  }
  return { handled: true, key: hit.key, message: '这条指令还没实现' };
}
