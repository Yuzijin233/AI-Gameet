/**
 * 对局概括的措辞工具（纯函数，放 data 层避免 store ↔ ai 互相 import）
 *
 * 背景（用户报的 bug）：对局记录以前是**站在玩家角度**写的 ——
 * "你最后输了 11244 豆""你这边手气差"。可它会被**原样存进 AI 的记忆**，
 * AI 一读，"你"指的就是它自己：于是明明是玩家输了，它却以为输的是它。
 *
 * 正确做法：**记忆是给谁看的，就站在谁的角度写**（见 ai/matchSummary.js 的
 * `perspective: 'ai'`：AI 自己用"你"，玩家写「玩家（昵称）」）。
 * 这里的 `neutralizeSummary` 用于两种"没有具体读者"的场合：
 *   1) save.recentHands 里那份全局概括（哪个 AI 都可能读到）
 *   2) 老存档里已经用"你"写好的对局记忆（搬家成第三人称，至少不再认错）
 */
export function neutralizeSummary(text) {
  return String(text || '')
    .replace(/你们俩/g, '玩家和对手')
    .replace(/你们/g, '玩家他们')
    .replace(/你自己/g, '玩家自己')
    .replace(/你的/g, '玩家的')
    .replace(/你这边/g, '玩家这边')
    // 剩下的"你"（主语/宾语/定语）全部换成"玩家"：这类文本不该有第二人称
    .replace(/你/g, '玩家');
}

/** 这段文字里还有没有第二人称（测试用） */
export const hasSecondPerson = (text) => /你/.test(String(text || ''));

/* ===================================================================== */
/*            对局记忆要"点名玩法"（用户报的 bug，见下）                    */
/* ===================================================================== */
/**
 * 用户报的问题："明明最新的是五子棋，AI 找我聊天聊的却是小猫钓鱼，
 * 还是不清楚上一局打的是什么。"
 *
 * 原因之一：模型写概括时经常不点玩法 ——
 *   "这局你执黑先手，和玩家下了 24 手，最后你输了"（一个字没提五子棋）。
 * 这条记忆存进 AI 脑子以后，它下次读的时候根本不知道那局玩的是什么。
 *
 * 两处兜底：
 *  1) 新写入的：`ai/matchSummary.js` 的 `ensureModeNamed()` 补玩法名；
 *  2) 老存档里已经写好的：按内容猜一下（下面这三个函数），加载存档时补上。
 */
const MODE_WORDS = ['斗地主', '小猫钓鱼', '五子棋'];

/** 按内容猜这局玩的是什么（猜不出返回空串）——注意顺序：五子棋/钓鱼的线索优先于"豆" */
export function guessModeWord(text) {
  const t = String(text || '');
  if (/五子棋|棋盘|棋子|执黑|执白|落子|连成\s*五|下了\s*\d+\s*手/.test(t)) return '五子棋';
  if (/小猫钓鱼|鱼篓|翻牌|钓/.test(t)) return '小猫钓鱼';
  if (/斗地主|地主|农民|出牌|倍数|炸弹|抢地主/.test(t)) return '斗地主';
  return '';
}

/** 给一段概括补上玩法名（已经有了就原样返回；猜不出来也原样返回） */
export function ensureModeInSummary(text, max = 120) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (MODE_WORDS.some((w) => t.includes(w))) return t;
  const mode = guessModeWord(t);
  return mode ? `${mode}：${t}`.slice(0, max) : t;
}

/** 给一整条「对局：[9/20 23:02] …」补玩法名（时间戳之后插） */
export function ensureModeInMatchLine(line, max = 120) {
  const s = String(line || '');
  if (!s.startsWith('对局：')) return s;
  const m = /^(对局：\[\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\]\s*)([\s\S]*)$/.exec(s);
  if (!m) return ensureModeInSummary(s, max);
  return (m[1] + ensureModeInSummary(m[2], max - m[1].length)).slice(0, max);
}
