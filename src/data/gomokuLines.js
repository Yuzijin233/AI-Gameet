/**
 * 五子棋台词库（AI 本地兜底用）
 *
 * 为什么单独一套（用户报的 bug）：
 *   以前五子棋走的是 `personas.js` 里的**牌桌台词**，于是棋盘上冒出
 *   "先出张小的探探路""这张大牌我压了很久""各家剩余张数"这种串台话。
 *   这里只放**下棋口气**的话：棋子、线路、连五、堵与让，一个字都不提牌。
 *
 * 和前几套语料一致：按人设风格分三档（aggressive / balanced / cautious），
 * 场景键和牌桌共用（greeting / playBig / playSmall / suppress / praised / idle / win / lose / draw / egged），
 * 由 `ai/chat.js` 按 mode='gomoku' 分派到这里。
 */
export const GOMOKU_LINES = {
  greeting: {
    aggressive: ['开局了，别磨蹭', '今天想赢我可不容易', '棋盘摆好了，来'],
    balanced: ['开局吧，好好下', '请多指教', '来吧，先落子'],
    cautious: ['我…开始下了', '请多指教', '先落一子看看'],
  },
  // 自己下出一手好棋（活三 / 冲四）
  playBig: {
    aggressive: ['这手你挡不住', '看清楚，活三了', '这一手够你忙的'],
    balanced: ['这手有点意思了', '活三了，你看着办', '这一手我挺满意'],
    cautious: ['这里好像能连…', '我下一手试试', '这手应该不差'],
  },
  // 自己下了一手平平的棋
  playSmall: {
    aggressive: ['先占个点，不急', '铺路而已', '随便下下，别紧张'],
    balanced: ['先占个位置', '稳一点，慢慢来', '这手不急'],
    cautious: ['先放着，看看', '我占个点', '慢慢来'],
  },
  // 自己这手是拦玩家的
  suppress: {
    aggressive: ['堵死你这条线', '想连五？没门', '这一手就掐在这儿'],
    balanced: ['这里不能让你连', '先堵上再说', '这条线到此为止'],
    cautious: ['这里得堵住', '差点让你连上', '先挡一手'],
  },
  praised: {
    aggressive: ['下得不错，可惜不够', '有点意思，继续', '这手还行，别得意'],
    balanced: ['你这手不错', '可以啊，看得挺远', '有点东西'],
    cautious: ['谢谢…我再想想', '过奖了', '运气好而已'],
  },
  idle: {
    aggressive: ['想好了没？我可等着', '别磨蹭，下子', '棋盘上见真章'],
    balanced: ['该你下了', '想好了吗', '这盘有意思'],
    cautious: ['轮到你下了…', '我在想', '这盘有点难'],
  },
  win: {
    aggressive: ['连五了，服不服', '赢了，再来一局？', '就说你挡不住'],
    balanced: ['连五了，这局我赢了', '承让，赢了', '五子连成，结束了'],
    cautious: ['我赢了…承让', '侥幸赢了', '连成五个了'],
  },
  lose: {
    aggressive: ['这局我认，下局别想', '输一手而已，再来', '让你一局，别得意'],
    balanced: ['这局你赢了，我认', '是我看漏了', '下局我小心点'],
    cautious: ['我输了…再想想', '是我漏了', '下局我会小心'],
  },
  draw: {
    aggressive: ['平局？没劲，再来', '棋盘满了，算你走运', '和棋，下局分高下'],
    balanced: ['下满了，平局', '和棋，再来一局', '谁也没赢，接着下'],
    cautious: ['平局…也行', '没分出胜负', '再来一局吧'],
  },
  egged: {
    aggressive: ['鸡蛋我收了，照样赢你', '就这？继续', '有脾气，我喜欢'],
    balanced: ['收到，不影响下棋', '别急，输赢看棋盘', '鸡蛋我接着'],
    cautious: ['……我收下了', '不影响下棋', '我会认真下的'],
  },
};

/**
 * 取一句五子棋台词
 * @param {object} persona 人设（用它的 style 挑口吻）
 * @param {string} scene 场景键
 * @param {Set<string>} [avoidSet] 这个 AI 最近说过的，尽量不重复
 */
export function pickGomokuLine(persona, scene, avoidSet = new Set()) {
  const byStyle = GOMOKU_LINES[scene] || GOMOKU_LINES.idle;
  const pool = byStyle[(persona && persona.style) || 'balanced'] || byStyle.balanced || [];
  const list = pool.length ? pool : ['……', '这盘有点意思'];
  const fresh = list.filter((l) => !avoidSet.has(l));
  const use = fresh.length ? fresh : list;
  return use[Math.floor(Math.random() * use.length)];
}
