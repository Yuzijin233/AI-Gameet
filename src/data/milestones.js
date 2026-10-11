/**
 * 里程碑数据（用户拍板定稿）
 * =====================================================================
 * 设计纪律（和项目里其他地方一致）：
 *   · **未达成时不告诉触发条件**（界面显示 `？？？`）—— 清单里 `condition` 只在解锁后才展示
 *   · 不给豆子/道具奖励，**只累计积分**；积分到档位才换奖励（见 MILESTONE_TIERS）
 *   · 纯数据 + 纯函数：判定逻辑在 store/milestones.js，界面在 ui/milestones.js
 *
 * 三组（用户拍板的分组）：
 *   · social  社交 19 条 · 175 分
 *   · match   对局  9 条 ·  80 分
 *   · wealth  财富  5 条 ·  85 分
 *   合计 33 条 · **340 分**
 *
 * ★ 两处按你口述时的合并要求处理的地方（原表里"要合并进去"的那两条没有单独给分值，
 *   按它们在原表里的分值保留）：
 *   · 「超级欧皇」并入**财富**（30 分）
 *   · 「赌怪」并入**对局**（20 分）
 *
 * `checkKey` 是判定用的键名，store/milestones.js 里按它分派到具体的检查函数；
 * 这样数据文件保持"纯数据"，加一条里程碑不用碰业务代码。
 */

/** 分组（顺序就是界面标签的顺序） */
export const MILESTONE_GROUPS = [
  { id: 'social', name: '社交' },
  { id: 'match', name: '对局' },
  { id: 'wealth', name: '财富' },
];

export const MILESTONES = [
  /* ---------------- 社交（21 条 · 200 分） ---------------- */
  { id: 'm_first_friend', group: 'social', name: '初次相遇', points: 10, condition: '第一次加好友', checkKey: 'friendCount' },
  { id: 'm_full_house', group: 'social', name: '高朋满座', points: 10, condition: '好友满 10 位', checkKey: 'friendFull' },
  { id: 'm_nodding', group: 'social', name: '点头之交', points: 5, condition: '第一次达到「点头之交」', checkKey: 'affinityTier2' },
  { id: 'm_friend_tier', group: 'social', name: '熟客', points: 10, condition: '与任意一位达到「朋友」档', checkKey: 'affinityTier3' },
  { id: 'm_close_tier', group: 'social', name: '无话不谈', points: 10, condition: '与任意一位达到「挚友」', checkKey: 'affinityTier4' },
  { id: 'm_lover', group: 'social', name: '真爱至上', points: 20, condition: '第一次成为恋人', checkKey: 'lover' },
  { id: 'm_breakup', group: 'social', name: '一别两宽', points: 5, condition: '第一次经历分手', checkKey: 'breakup' },
  { id: 'm_refused', group: 'social', name: '无疾而终', points: 5, condition: '表白被拒', checkKey: 'refused' },
  { id: 'm_lover_7d', group: 'social', name: '永结同心', points: 30, condition: '恋人维持 7 天或以上', checkKey: 'lover7d' },
  { id: 'm_ai_rename', group: 'social', name: '刮目相看', points: 10, condition: '任意一位 AI 因你而改名', checkKey: 'aiRenamed' },
  { id: 'm_group_create', group: 'social', name: '相亲相爱一家人', points: 5, condition: '第一次创建群聊', checkKey: 'groupCreated' },
  { id: 'm_group_mention', group: 'social', name: '一呼百应', points: 5, condition: '@ 一位群成员并得到回应', checkKey: 'groupMentioned' },
  { id: 'm_moment_post', group: 'social', name: '友圈', points: 10, condition: '第一次发朋友圈', checkKey: 'momentPosted' },
  { id: 'm_moment_comment', group: 'social', name: '点赞评论', points: 5, condition: '第一次给别人友圈评论', checkKey: 'momentComment' },
  { id: 'm_moment_liked3', group: 'social', name: '社牛', points: 5, condition: '第一次说说被 ≥3 位好友点赞', checkKey: 'momentLiked3' },
  { id: 'm_gift_sent', group: 'social', name: '礼赠友人', points: 5, condition: '第一次赠送礼物', checkKey: 'giftSent' },
  { id: 'm_gift_back', group: 'social', name: '礼尚往来', points: 10, condition: '第一次收到 AI 主动回赠的礼物', checkKey: 'giftBack' },
  { id: 'm_encounter_first', group: 'social', name: '初次遇见', points: 5, condition: '完成一次「遇见」匹配', checkKey: 'encounterFirst' },
  { id: 'm_encounter_again', group: 'social', name: '再见一面', points: 10, condition: '同一个人遇见 2 次', checkKey: 'encounterAgain' },

  /* ---------------- 对局（7 条 · 70 分） ---------------- */
  { id: 'm_first_win', group: 'match', name: '开门红', points: 10, condition: '第一局胜利', checkKey: 'firstWin' },
  { id: 'm_spring', group: 'match', name: '春天', points: 10, condition: '打出一次春天', checkKey: 'spring' },
  { id: 'm_bombs', group: 'match', name: '蹦蹦炸弹', points: 10, condition: '单局丢出超过 1 个炸弹', checkKey: 'bombs' },
  { id: 'm_fishing_lose', group: 'match', name: '空军', points: 5, condition: '第一次小猫钓鱼输', checkKey: 'fishingLose' },
  { id: 'm_fishing_lead', group: 'match', name: '钓鱼高手', points: 5, condition: '小猫钓鱼单局鱼篓差 ≥20 张', checkKey: 'fishingLead' },
  { id: 'm_gomoku_normal', group: 'match', name: '下棋爱好者', points: 5, condition: '五子棋赢「普通」难度', checkKey: 'gomokuNormal' },
  { id: 'm_gomoku_master', group: 'match', name: '妙手', points: 10, condition: '五子棋赢「大师」难度', checkKey: 'gomokuMaster' },
  { id: 'm_room_full', group: 'match', name: '熟人组局', points: 5, condition: '第一次创建房间并人满', checkKey: 'roomFull' },
  { id: 'm_high_multi', group: 'match', name: '赌怪', points: 20, condition: '单局倍数 ≥ ×64', checkKey: 'highMulti' },

  /* ---------------- 财富（5 条 · 85 分） ---------------- */
  { id: 'm_rank_top10', group: 'wealth', name: '豆子大亨', points: 10, condition: '第一次上排行榜前 10', checkKey: 'rankTop10' },
  { id: 'm_rank_first', group: 'wealth', name: '天下首富', points: 30, condition: '排行榜第一名', checkKey: 'rankFirst' },
  { id: 'm_lucky', group: 'wealth', name: '超级欧皇', points: 30, condition: '转盘抽中 1,000,000 开心豆或「欧皇」称号', checkKey: 'lucky' },
  { id: 'm_paid', group: 'wealth', name: '氪金玩家', points: 5, condition: '第一次充值', checkKey: 'paid' },
  { id: 'm_broke', group: 'wealth', name: '倾家荡产', points: 10, condition: '开心豆少于 100', checkKey: 'broke' },
];

export const milestoneById = (id) => MILESTONES.find((m) => m.id === id) || null;

/** 全部里程碑的积分总和（界面上的进度条分母就是它） */
export const MILESTONE_TOTAL = MILESTONES.reduce((sum, m) => sum + m.points, 0);

/* =====================================================================
 *                              积分档位
 * =====================================================================
 * ★ 用户拍板：达到 20 / 40 / 100 / 200 可以点节点领奖，**奖励发到邮箱**。
 *   阈值做成**可调常量**：上线后如果觉得 100 / 200 来得太早或太晚，只改这里。
 *   （总积分 340，所以 200 那档大约要拿到六成 —— 需要真的玩、真的社交。）
 */
export const MILESTONE_TIERS = [
  {
    at: 20,
    label: '初见之礼',
    rewards: [{ kind: 'beans', amount: 20000 }, { kind: 'item', id: 'g_box', n: 1 }],
    mailTitle: '里程碑 · 初见之礼',
    mailBody: '你在 Gameet 已经留下 20 点足迹。这份薄礼收下，后面还有更长的路。',
  },
  {
    at: 40,
    label: '往来之礼',
    rewards: [{ kind: 'beans', amount: 50000 }, { kind: 'renameCard', n: 1 }],
    mailTitle: '里程碑 · 往来之礼',
    mailBody: '40 点到手，你已经开始和这里的人有来有往了。',
  },
  {
    at: 100,
    label: '社交达人',
    rewards: [{ kind: 'beans', amount: 200000 }, { kind: 'title', id: 't_socialite' }],
    mailTitle: '里程碑 · 社交达人',
    mailBody: '100 点。这个称号是给真正在这里认识过人的人准备的，戴上吧。',
  },
  {
    at: 200,
    label: '鎏金之礼',
    rewards: [{ kind: 'beans', amount: 200000 }, { kind: 'item', id: 'g_ring', n: 1 }, { kind: 'theme', id: 'th_gilded' }],
    mailTitle: '里程碑 · 鎏金之礼',
    mailBody: '200 点。送上一枚戒指，和「鎏金」—— 只有走到这里的人才能换上的那套配色。',
  },
];

/** 这一档的累计奖励文案（界面上"20 20000欢乐豆+礼盒×1"那行） */
export const tierSummary = (tier) => (tier && tier.rewards ? tier.rewards : []);

/** 按积分换算当前进度（0~1，给进度条用） */
export function milestoneProgress(points) {
  const p = Math.max(0, Number(points) || 0);
  return Math.min(1, p / Math.max(1, MILESTONE_TOTAL));
}
