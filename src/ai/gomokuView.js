/**
 * 五子棋的提示词视图（纯函数，方便测试）
 *
 * 为什么单独一个（用户报的 bug）：
 *   以前五子棋的台词也走 `buildView()` —— 那是**斗地主**的视图，张口就是
 *   "你在玩三人斗地主""你的身份：地主/农民""各家剩余张数""上一手出牌"。
 *   于是棋盘上会出现"出一张牌""出个 3 探探路"这种完全串台的台词。
 *   现在五子棋有自己的视图：只给棋局事实（谁先手、下了几手、轮到谁、有没有活三冲四），
 *   外加和玩家的关系（好感度 / 关系 / 记忆）——和牌桌、私聊共用同一份口径。
 *
 * 座位约定（和 fishingView 一致）：talk 的是 AI 自己，`你` 永远指 AI；
 * 玩家一律写「玩家（昵称）」或名字，不许用"你"，免得模型把两边搞混。
 */
import { boardSituation, BLACK, WHITE } from '../core/gomoku.js';

/** 棋局结束的几种说法 */
const OVER_TEXT = { player: '这盘你输了', ai: '这盘你赢了', draw: '这盘下成平局了' };

/**
 * @param {{board:any, moves:number, last:object|null, playerColor:number, turn:number,
 *          over:boolean, winner?:'player'|'ai'|'draw'|null, extra?:object}} p
 */
export function gomokuView({
  board, moves = 0, last = null, playerColor, turn, over = false, winner = null, extra = {},
} = {}) {
  const aiColor = playerColor === BLACK ? WHITE : BLACK;
  const situationText = boardSituation(board, {
    playerColor, aiColor, moves, last,
  });
  return {
    mode: 'gomoku',
    /** 棋盘上的客观事实（手数 / 威胁点 / 最后一手） */
    situationText,
    turnText: over
      ? (OVER_TEXT[winner] || '这盘已经下完了')
      : (turn === playerColor ? '现在轮到玩家落子' : '现在轮到你落子'),
    playerText: extra.playerText ? extra.playerText : '',
    // 和玩家的关系（好感度 / 关系 / 称呼 / 记忆）：和私聊、牌桌共用同一份
    friendLines: extra.friendLines || [],
    playerGender: extra.playerGender || '',
  };
}
