/**
 * 小猫钓鱼的提示词视图（纯函数，方便测试）
 *
 * 【座位约定，改这里前先看】
 *   索引 0 = 玩家（人类）   索引 1 = AI 对手
 *   所以：`piles[1] / score[1] / bucket[1]` 才是 **AI 自己** 的牌与鱼篓，
 *   而 `piles[0] / score[0]` 是玩家的。写反了会出现"AI 以为自己的鱼篓是玩家的那 7 张"这种穿帮。
 */
import { FISHING } from '../config.js';

const RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };
export const rankTxt = (r) => RANK[r] || String(r);

/** AI 视角：seat 一定是 1；`who(s)` 把座位翻译成"你 / 对手" */
export function fishingView({ game: g, seat = 1, extra = {} } = {}) {
  const who = (s) => (s === seat ? '你' : '对手');

  // 最近几步操作（翻到什么 / 收了几张 / 先不收），让 AI 接着刚才那几手说
  const steps = (g.recentLog ? g.recentLog(5) : []).map((x) => {
    const tag = who(x.seat);
    if (x.type === 'collect') return `${tag}收了 ${x.count} 张（${rankTxt(x.rank)}，鱼篓到 ${x.total}）`;
    if (x.type === 'decline') return `${tag}先不收（${rankTxt(x.rank)} 那叠留在中央）`;
    return x.hit ? `${tag}翻出 ${rankTxt(x.rank)}、可以钓` : `${tag}翻出 ${rankTxt(x.rank)}`;
  });

  return {
    isLandlord: false,
    handReportLine: `你的鱼篓 ${g.score[seat]} 张（不要报牌，也别念叨自己翻到什么）`,
    // 每条都写清是谁的，避免模型自己猜错归属
    countsText: `你（AI）手上还剩 ${g.piles[seat].length} 张、鱼篓 ${g.score[seat]} 张；`
      + `对手（玩家）手上还剩 ${g.piles[1 - seat].length} 张、鱼篓 ${g.score[1 - seat]} 张；`
      + `中央牌堆 ${g.table.length} 张`
      + `（一次钓走 ${FISHING.bigCatchMin} 张以上本局倍数翻倍，现在 ×${g.multiplier || 1}）`,
    multiplier: g.multiplier || 1,
    bombs: 0,
    lastText: g.lastCatch
      ? `${who(g.lastCatch.seat)}刚一次钓走 ${g.lastCatch.count} 张（${rankTxt(g.lastCatch.rank)}）`
      : '',
    historyLabel: '最近几步操作（从早到晚）',
    historyText: steps.join('；'),
    situationText: extra.situation ? extra.situation.text : '',
    playerText: extra.playerText ? extra.playerText : '',
    // 和玩家的关系（好感度 / 关系 / 称呼 / 记忆）：小猫钓鱼也用同一份
    friendLines: extra.friendLines || [],
  };
}
