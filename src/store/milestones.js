/**
 * 里程碑存档层
 * =====================================================================
 * 职责：
 *   · `ensureMilestones(save)`  —— 补齐字段（老存档也安全）
 *   · `syncMilestones(save)`    —— **统一判定入口**：把 33 条全过一遍，
 *                                  新达成的记时间、返回出来（调用方负责弹 toast）
 *   · `milestonePoints(save)`   —— 当前积分（进度条分母是 MILESTONE_TOTAL）
 *   · `claimTier(save, at)`     —— 领某一档奖励（写进邮箱）
 *
 * 为什么用"全量同步"而不是"逐事件分派"：
 *   · 大部分里程碑本来就是**存档状态的函数**（好友数、好感档、是否有恋人、说说点赞数…），
 *     从状态直接算，比在十几个业务点分别上报更不容易漏
 *   · 少数一次性事件（表白被拒 / 分手 / AI 改名 / 收到回赠 / 抽中欧皇 / 上榜首）
 *     由业务点在 `save.milestones.flags` 上打一个标记，这里照样只是"读状态"
 *   · 同步是**幂等**的：跑一百次结果一样，所以可以在任何时机安全调用
 *
 * 调用时机：进入大厅、每次结算、聊天、群聊、友圈、转盘、充值之后 —— 都调 `app.syncMilestones()`。
 */
import { MILESTONES, MILESTONE_TIERS, MILESTONE_TOTAL, milestoneById } from '../data/milestones.js';
import { FRIEND } from '../config.js';
import { listFriends, tierOf } from './friends.js';
import { listGroups } from './groups.js';
import { listMoments } from './moments.js';
import { listEncounterHistory } from './encounters.js';
import { totalPaidYuan } from './activity.js';
import { wealthRanking } from './rank.js';

/** 里程碑里用到的"档位名"（和 store/friends.js 的 affinityTier 对齐） */
const TIER_NODDING = '点头之交';
const TIER_FRIEND = '朋友';
const TIER_CLOSE = '挚友';

/** 恋人维持多久算"永结同心"（用户拍板：7 天） */
export const LOVER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*                          存档结构                                    */
/* ------------------------------------------------------------------ */
export function ensureMilestones(save) {
  if (!save.milestones || typeof save.milestones !== 'object') save.milestones = {};
  const m = save.milestones;
  if (!m.unlocked || typeof m.unlocked !== 'object') m.unlocked = {};
  if (!Array.isArray(m.claimed)) m.claimed = [];
  /**
   * 一次性事件的标记（业务点打的）：
   *   refusedConfess / brokeUp / aiRenamed / giftBack / lucky / rankFirst
   */
  if (!m.flags || typeof m.flags !== 'object') m.flags = {};
  /** 恋人起始时间（分手后清空，重新计时） */
  if (!Number.isFinite(m.loverSinceAt) || m.loverSinceAt < 0) m.loverSinceAt = 0;
  /**
   * 房间满员（熟人组局）：进过"人满的房间"就打一次卡。
   * 房间不是存档里的持久结构，所以用一次性标记。
   */
  if (typeof m.flags.roomFull !== 'boolean') m.flags.roomFull = false;
  // 清掉已经不存在的档位 / 里程碑 id（改过数据表之后不会留脏数据）
  m.claimed = m.claimed.filter((at) => MILESTONE_TIERS.some((t) => t.at === at));
  Object.keys(m.unlocked).forEach((id) => { if (!milestoneById(id)) delete m.unlocked[id]; });
  return m;
}

/* ------------------------------------------------------------------ */
/*                          判定                                        */
/* ------------------------------------------------------------------ */
const any = (arr, fn) => arr.some(fn);

/**
 * 按 checkKey 判定这一条现在达没达成
 * @returns {boolean}
 */
function isAchieved(save, checkKey) {
  const m = ensureMilestones(save);
  const friends = listFriends(save);

  switch (checkKey) {
    /* ---------- 社交 ---------- */
    case 'friendCount': return friends.length >= 1;
    case 'friendFull': return friends.length >= FRIEND.maxFriends;
    case 'affinityTier2': return any(friends, (f) => {
      const label = tierOf(save, f).label;
      return label === TIER_NODDING || label === TIER_FRIEND || label === TIER_CLOSE || label === '恋人';
    });
    case 'affinityTier3': return any(friends, (f) => {
      const label = tierOf(save, f).label;
      return label === TIER_FRIEND || label === TIER_CLOSE || label === '恋人';
    });
    case 'affinityTier4': return any(friends, (f) => {
      const label = tierOf(save, f).label;
      return label === TIER_CLOSE || label === '恋人';
    });
    case 'lover': return !!save.loverId;
    case 'breakup': return m.flags.brokeUp === true;
    case 'refused': return m.flags.refusedConfess === true;
    case 'lover7d': {
      if (!save.loverId) return false;
      const since = m.loverSinceAt || 0;
      return since > 0 && (Date.now() - since) >= LOVER_DAYS * DAY_MS;
    }
    case 'aiRenamed': return m.flags.aiRenamed === true;
    case 'groupCreated': return listGroups(save).length >= 1;
    case 'groupMentioned': return m.flags.groupMentioned === true;
    case 'momentPosted': return listMoments(save).some((x) => x.by === 'me');
    case 'momentComment': return listMoments(save).some(
      (x) => (x.comments || []).some((c) => c.by === 'me'),
    );
    case 'momentLiked3': return listMoments(save).some(
      (x) => x.by === 'me' && (x.likes || []).length >= 3,
    );
    case 'giftSent': return m.flags.giftSent === true;
    case 'giftBack': return m.flags.giftBack === true;
    case 'encounterFirst': return listEncounterHistory(save).length >= 1;
    case 'encounterAgain': {
      const records = (save.encounters && save.encounters.records) || {};
      return Object.values(records).some((r) => (r.encounterCount || 0) >= 2);
    }

    /* ---------- 对局 ---------- */
    case 'firstWin': return (save.stats && save.stats.wins) >= 1;
    case 'spring': return m.flags.spring === true;
    case 'bombs': return m.flags.bombs === true;
    case 'fishingLose': return m.flags.fishingLose === true;
    case 'fishingLead': return m.flags.fishingLead === true;
    case 'gomokuNormal': return m.flags.gomokuNormal === true;
    case 'gomokuMaster': return m.flags.gomokuMaster === true;
    case 'roomFull': return m.flags.roomFull === true;
    case 'highMulti': return m.flags.highMulti === true;

    /* ---------- 财富 ---------- */
    case 'rankTop10': {
      if (m.flags.rankTop10 === true) return true;
      // 名次是"实时算"的：自己进前 10 就算达成（玩家与 AI 用同一张榜，不给自己特权）
      const r = wealthRanking(save, 10);
      return !!(r && r.inTop);
    }
    case 'rankFirst': {
      if (m.flags.rankFirst === true) return true;
      // ★ 注意别用 `r.me`：榜单只填 `top` 里的行，`me` 是空的（踩过一次）
      const r = wealthRanking(save, 10);
      const first = r && r.top && r.top[0];
      return !!(first && first.kind === 'me');
    }
    case 'lucky': return m.flags.lucky === true;
    case 'paid': return totalPaidYuan(save) > 0;
    case 'broke': return (save.beans || 0) < 100;

    default: return false;
  }
}

/* ------------------------------------------------------------------ */
/*                          同步                                        */
/* ------------------------------------------------------------------ */
/**
 * 全量同步一遍：新达成的记下来
 * @returns {{ ids:string[], newly:object[] }} newly = 这一次新解锁的里程碑（按数据表顺序）
 */
export function syncMilestones(save) {
  const m = ensureMilestones(save);
  const newly = [];
  for (const item of MILESTONES) {
    if (m.unlocked[item.id]) continue;
    let ok = false;
    try { ok = isAchieved(save, item.checkKey); } catch (err) {
      // 判定出错绝不影响游戏（宁可这条晚一点解锁）
      console.warn('[milestone] 判定失败：', item.id, err);
      continue;
    }
    if (!ok) continue;
    m.unlocked[item.id] = Date.now();
    newly.push(item);
  }
  if (newly.length) {
    // 第一次成为恋人 → 记下计时起点（永结同心用）
    if (newly.some((x) => x.id === 'm_lover') && !m.loverSinceAt) m.loverSinceAt = Date.now();
  }
  return { ids: newly.map((x) => x.id), newly };
}

/** 当前积分 */
export function milestonePoints(save) {
  const m = ensureMilestones(save);
  return MILESTONES.reduce((sum, item) => (m.unlocked[item.id] ? sum + item.points : sum), 0);
}

/** 已达成数量 / 总数（标签页角标用） */
export function milestoneCounts(save) {
  const m = ensureMilestones(save);
  const total = MILESTONES.length;
  const done = MILESTONES.filter((x) => m.unlocked[x.id]).length;
  return { done, total };
}

/* ------------------------------------------------------------------ */
/*                          一次性事件打标                              */
/* ------------------------------------------------------------------ */
/**
 * 业务点调用：打一个一次性标记（表白被拒 / 分手 / AI 改名 / 收到回赠 / 抽中欧皇 / 上榜首…）
 * ★ 打完之后**请顺手调一次 `app.syncMilestones()`**，否则要等下一次同步才解锁。
 */
export function flagMilestone(save, key, value = true) {
  const m = ensureMilestones(save);
  if (m.flags[key] === value) return false;
  m.flags[key] = value;
  return true;
}

/** 现在是不是恋人（给"永结同心"计时用；分手后由业务点调 clearLoverSince） */
export function markLoverSince(save, at = Date.now()) {
  const m = ensureMilestones(save);
  if (!m.loverSinceAt) m.loverSinceAt = at;
  return m.loverSinceAt;
}

export function clearLoverSince(save) {
  const m = ensureMilestones(save);
  m.loverSinceAt = 0;
}

/* ------------------------------------------------------------------ */
/*                          档位与领奖                                  */
/* ------------------------------------------------------------------ */
/**
 * 四个档位现在的状态（进度条节点用）
 * @returns {{at,label,rewards,reached,claimed,claimable}[]}
 */
export function tierStates(save) {
  const m = ensureMilestones(save);
  const points = milestonePoints(save);
  return MILESTONE_TIERS.map((t) => ({
    ...t,
    reached: points >= t.at,
    claimed: m.claimed.includes(t.at),
    claimable: points >= t.at && !m.claimed.includes(t.at),
  }));
}

/** 下一个没领的档位（进度条上"还差多少分"的提示用） */
export function nextTier(save) {
  const points = milestonePoints(save);
  return MILESTONE_TIERS.find((t) => points < t.at) || null;
}

/**
 * 领某一档的奖励 → **发到邮箱**（用户拍板：奖励发送到邮箱）
 * @param {object} save
 * @param {number} at 档位阈值（20 / 40 / 100 / 200）
 * @param {Function} pushMailFn store/rewards.js 的 pushMail（由调用方注入，避免循环依赖）
 * @returns {{ok:boolean, error?:string, tier?:object}}
 */
export function claimTier(save, at, pushMailFn) {
  const m = ensureMilestones(save);
  const tier = MILESTONE_TIERS.find((t) => t.at === at);
  if (!tier) return { ok: false, error: '没有这一档奖励' };
  if (m.claimed.includes(at)) return { ok: false, error: '这一档已经领过了' };
  const points = milestonePoints(save);
  if (points < at) return { ok: false, error: `还差 ${at - points} 点积分` };
  if (typeof pushMailFn !== 'function') return { ok: false, error: '邮箱未就绪' };
  pushMailFn(save, { title: tier.mailTitle, body: tier.mailBody, rewards: tier.rewards });
  m.claimed.push(at);
  return { ok: true, tier };
}

/* ------------------------------------------------------------------ */
/*                          面板列表                                    */
/* ------------------------------------------------------------------ */
/**
 * 界面用的列表：**未达成时不暴露触发条件**（用户拍板：只在达成时才告知触发条件）
 */
export function milestoneList(save) {
  const m = ensureMilestones(save);
  return MILESTONES.map((item) => {
    const at = m.unlocked[item.id] || 0;
    const unlocked = at > 0;
    return {
      ...item,
      unlocked,
      at,
      // ★ 没达成 → 条件藏起来，界面显示 ？？？
      shownCondition: unlocked ? item.condition : '？？？',
    };
  });
}

/** 面板整体状态（一次取全，避免界面里到处 import） */
export function milestoneState(save) {
  const m = ensureMilestones(save);
  return {
    points: milestonePoints(save),
    total: MILESTONE_TOTAL,
    counts: milestoneCounts(save),
    tiers: tierStates(save),
    list: milestoneList(save),
    /** 有没有"可领取但还没领"的档位（左侧导航红点用） */
    hasClaimable: MILESTONE_TIERS.some((t) => milestonePoints(save) >= t.at && !m.claimed.includes(t.at)),
    /** 有没有"新解锁但还没看过"的里程碑（红点用；打开面板即清） */
    seen: Array.isArray(m.seen) ? m.seen : [],
  };
}

/** 打开面板时把"红点"清掉 */
export function markMilestonesSeen(save) {
  const m = ensureMilestones(save);
  m.seen = Object.keys(m.unlocked);
  return m.seen;
}

/** 有没有还没看过的解锁（导航红点） */
export function hasUnseenMilestones(save) {
  const m = ensureMilestones(save);
  const seen = new Set(Array.isArray(m.seen) ? m.seen : []);
  return Object.keys(m.unlocked).some((id) => !seen.has(id));
}
