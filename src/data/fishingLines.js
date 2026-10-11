/**
 * 小猫钓鱼台词库（AI 本地兜底用）
 *
 * 和五子棋同一个起因：以前钓鱼的兜底台词走的是 `personas.js` 里的**牌桌台词**
 * （"先走单张，探探路""叫地主"…），而小猫钓鱼根本没有"出牌/地主"这回事 ——
 * 它只有翻牌、鱼篓、收与不收。这里只放钓鱼口气的话。
 *
 * 场景键和牌桌共用（greeting / idle / win / lose / praised / egged），
 * 由 `ai/chat.js` 按 mode='fishing' 分派到这里；按人设风格分三档。
 */
export const FISHING_LINES = {
  greeting: {
    aggressive: ['来，看谁钓得多', '今天手气在我这边', '开局吧，别让我等'],
    balanced: ['开局了，随便玩玩', '来吧，翻牌', '今天钓两把'],
    cautious: ['我先翻吧…', '随便玩玩', '希望运气好点'],
  },
  idle: {
    aggressive: ['快点翻，我等着收', '手别抖，翻吧', '磨蹭什么呢'],
    balanced: ['你翻吧', '看看这手是什么', '中央还挺厚的'],
    cautious: ['要不…先攒着？', '我再看看', '这手有点犹豫'],
  },
  win: {
    aggressive: ['鱼篓满了吧，服不服', '赢你没什么难度', '下次别来送分'],
    balanced: ['这局我钓得多，运气不错', '承让，赢了', '鱼篓比你厚一点'],
    cautious: ['我赢了？有点意外', '侥幸，运气好', '承让了'],
  },
  lose: {
    aggressive: ['这局算你的，再来', '手气差而已，别得意', '下把我要赢回来'],
    balanced: ['这局你钓得多，我认', '差了几张，下次再来', '运气不在我这边'],
    cautious: ['输给你了…', '是我犹豫了', '下局我早点收'],
  },
  praised: {
    aggressive: ['少来，我本来就强', '夸我也没用，接着来', '花我收下了'],
    balanced: ['谢谢，你也挺会钓', '花好看，谢了', '收到，谢谢'],
    cautious: ['谢谢…有点不好意思', '花我收下了', '哪有，运气而已'],
  },
  egged: {
    aggressive: ['扔我也没用，照样赢', '鸡蛋留着下饭吧', '就这？'],
    balanced: ['鸡蛋收下了', '别急，手气会回来的', '下次钓赢我就行'],
    cautious: ['……我收下了', '我是不是拖后腿了', '不打紧，继续吧'],
  },
};

/**
 * 取一句小猫钓鱼台词
 * @param {object} persona 人设（用它的 style 挑口吻）
 * @param {string} scene 场景键
 * @param {Set<string>} [avoidSet] 这个 AI 最近说过的，尽量不重复
 */
export function pickFishingLine(persona, scene, avoidSet = new Set()) {
  const byStyle = FISHING_LINES[scene] || FISHING_LINES.idle;
  const pool = byStyle[(persona && persona.style) || 'balanced'] || byStyle.balanced || [];
  const list = pool.length ? pool : ['……', '这局有点意思'];
  const fresh = list.filter((l) => !avoidSet.has(l));
  const use = fresh.length ? fresh : list;
  return use[Math.floor(Math.random() * use.length)];
}
