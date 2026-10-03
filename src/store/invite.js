/**
 * AI 邀请玩家打牌（用户拍板的那套规则）
 *
 * 这里只放**纯逻辑**（能不能邀请、挑谁、挑什么模式、等多久），
 * 界面与计时器在 ui/invite.js 与 ui/app.js 里，这样规则可以被测试直接跑。
 *
 * 规则回顾：
 *   · 玩家停在主界面不动超过 30s → 才可能被邀请；之后每 20~60s 随机一次
 *   · 好友 < 3 位 → 不邀请
 *   · 点过 ✗ → 直到玩家主动玩一局之前都不再打扰
 *   · 接受后：AI 当房主 + 另带一位好友，3~5s 后自动开局（期间退出就不开始）
 */
import { INVITE, ROOMS, FISHING_ROOMS, GOMOKU_ROOMS } from '../config.js';
import { listFriends } from './friends.js';

/** 玩家点过 ✗ 之后的"免打扰"状态 */
export const isInviteMuted = (save) => !!(save && save.inviteMuted);

export function setInviteMuted(save, muted = true) {
  if (!save) return false;
  save.inviteMuted = !!muted;
  return save.inviteMuted;
}

/** 好友够不够（少于 3 位就不邀请） */
export const hasEnoughFriends = (save) => listFriends(save).length >= INVITE.minFriends;

/**
 * 现在能不能邀请玩家
 * @param {object} save
 * @param {{screen?:string, panelOpen?:boolean, inGame?:boolean, idleMs?:number}} ctx
 *   screen = 当前界面（只有 'screen-lobby' 才算"主界面"）
 */
export function canInviteNow(save, ctx = {}) {
  const {
    screen = 'screen-lobby', panelOpen = false, inGame = false, idleMs = 0,
  } = ctx;
  if (isInviteMuted(save)) return { ok: false, reason: 'muted' };
  if (!hasEnoughFriends(save)) return { ok: false, reason: 'few-friends' };
  if (screen !== 'screen-lobby') return { ok: false, reason: 'not-lobby' };
  if (panelOpen) return { ok: false, reason: 'panel-open' }; // 商城 / 设置 / 好友…都不打扰
  if (inGame) return { ok: false, reason: 'in-game' };
  if (idleMs < INVITE.idleMs) return { ok: false, reason: 'not-idle' };
  return { ok: true };
}

/**
 * 挑"房主 + 另一位好友"（两人不同）
 * @returns {{host:object, other:object}|null}
 */
export function pickHostAndOther(friends, rnd = Math.random) {
  const list = (Array.isArray(friends) ? friends : []).filter(Boolean);
  if (list.length < 2) return null;
  const i = Math.floor(rnd() * list.length) % list.length;
  const rest = list.filter((_, k) => k !== i);
  const j = Math.floor(rnd() * rest.length) % rest.length;
  return { host: list[i], other: rest[j] };
}

/**
 * 挑"邀请你进入 XX 模式"的那个模式 + 场次
 * 只挑玩家**进得去**的场次（进不去的没意义）；五子棋没有门槛，永远算"进得去"
 * @param {object} save
 * @param {{canEnterDdz:Function, canEnterFishing:Function, canEnterGomoku:Function, rnd?:Function}} opts
 */
export function pickInviteTarget(save, { canEnterDdz, canEnterFishing, canEnterGomoku, rnd = Math.random } = {}) {
  const pool = [];
  for (const g of INVITE.games || [{ kind: 'ddz', weight: 1 }]) {
    const rooms = g.kind === 'fishing' ? FISHING_ROOMS : (g.kind === 'gomoku' ? GOMOKU_ROOMS : ROOMS);
    const check = g.kind === 'fishing' ? canEnterFishing : (g.kind === 'gomoku' ? canEnterGomoku : canEnterDdz);
    const okRooms = rooms.filter((r) => {
      try {
        return !check || check(r).ok;
      } catch { return false; }
    });
    // 一个场次都进不去 → 允许退回最低场（进去之后再提示充值，总比不邀请好）
    for (const room of (okRooms.length ? okRooms : [rooms[0]])) {
      if (room) pool.push({ kind: g.kind, room, weight: g.weight || 1 });
    }
  }
  if (!pool.length) return null;
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let roll = rnd() * total;
  for (const p of pool) {
    roll -= p.weight;
    if (roll < 0) return { kind: p.kind, room: p.room };
  }
  const last = pool[pool.length - 1];
  return { kind: last.kind, room: last.room };
}

/** 两次邀请之间等多久（20~60s） */
export const nextInviteGapMs = (rnd = Math.random) => Math.round(
  INVITE.minGapMs + rnd() * Math.max(0, INVITE.maxGapMs - INVITE.minGapMs),
);

/** 接受之后多久自动开局（3~5s） */
export const nextStartDelayMs = (rnd = Math.random) => Math.round(
  INVITE.startMinMs + rnd() * Math.max(0, INVITE.startMaxMs - INVITE.startMinMs),
);

/** 邀请文案："邀请你进入「中级场 · 斗地主」" */
export function inviteTargetText(target) {
  if (!target) return '';
  const mode = target.kind === 'fishing' ? '小猫钓鱼' : (target.kind === 'gomoku' ? '五子棋' : '斗地主');
  return `${target.room ? target.room.name : ''} · ${mode}`;
}
