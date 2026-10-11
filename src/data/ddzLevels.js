/**
 * 斗地主 AI 牌技档位（用户拍板：**出牌已经不走大模型了**，大模型只负责说话）
 * ------------------------------------------------------------------
 * 四档：新手 / 熟练 / 高手 / 大师。给现有 30 个人设（p01~p30）**每人固定一档**，
 * 注释里写了为什么这么分（要挪就照着理由挪，别乱调）。
 *
 * 为什么固定、不随机：同一个好友的牌技必须稳定，"这个人打得菜 / 这个人很厉害"才立得住。
 *
 * 档位只影响**出牌**（core/bot.js 的 choosePlay）：
 *   · 新手：勉强能玩（合法、能跟就跟、能走就走），但会犯低级错误、不算残局
 *   · 熟练：正常水平，偶尔次优（前 3 手里随机）
 *   · 高手：几乎总选最优，会记牌（知道这一手是不是"死牌"）
 *   · 大师：最优 + 记牌 + 残局精算（出完这手还剩几手）
 * 界面上一个字都不显示（和五子棋难度一个口径：牌技是隐性的）。
 *
 * 纯数据 + 纯函数，测试可以直接调。
 */
import { PERSONAS } from './personas.js';

/** 四档（由弱到强） */
export const LEVELS = ['新手', '熟练', '高手', '大师'];

/**
 * 人设 → 牌技档位（30 个人设一个不漏）
 * 分档理由都写在后面 —— 大体是：越是"算得清 / 沉得住 / 牌龄长"的越强，
 * 越是"犯困 / 走神 / 刚学会 / 怕出错"的越弱。
 */
export const LEVEL_BY_PERSONA = {
  // —— 大师：算得清、沉得住，走一步看三步 ——
  p01: '大师', // 不吃香菜（知性/沉稳，宁可过一手也不拆牌 —— 走一步看三步）
  p02: '大师', // 小柳先生（只走稳的路线，炸弹不到最后关头绝不动：纪律性最好）
  p11: '大师', // Helloworld（习惯数牌算概率 —— "记住已出的牌"这一档最像他）
  p16: '大师', // 冷月（理科脑，一切按胜率来，说话前先算一遍）
  p17: '大师', // 老张的茶（打牌像泡茶，慢，但心里门儿清，看得懂别人的小动作）

  // —— 高手：会算、敢压，偶尔漏一手 ——
  p03: '高手', // 休怪我无情（挑毛病出身，一眼看得见漏洞；激进但时机准）
  p07: '高手', // 凌晨三点（话少好胜，半夜脑子最清醒，能抢先手就抢）
  p15: '高手', // 嘴上没输过（嘴硬手也硬，护牌护队友，炸弹留着救场）
  p18: '高手', // 我爱数理化（理工直男，算到能压就压，按逻辑走）
  p19: '高手', // 时光不负（较真/认真，讲究牌型与压迫感，炸弹按计算用）
  p23: '高手', // 损友小陈（嘴上损，牌上稳健偏灵活，爱藏一手）
  p29: '高手', // 何知非（学霸：算得清也敢搏，输了会认真复盘）
  p30: '高手', // 说的道理（嘴强又爱赌，炸弹来得比谁都快 —— 但牌是真的会打）
  /* —— p31~p40：后来加的一批（原表只写到 p30，"没有漏掉的人设"一直是红的）—— */
  p36: '高手', // 小白（男护版）（急诊夜班：冷静、先保队友，炸弹留给紧急关头）
  p39: '高手', // 霍格沃兹在逃法师（法援律师：讲证据与节奏，关键争点才出手）
  p40: '高手', // 艺术家们（老画家：先铺画面后收束，重笔留在最后）

  // —— 熟练：会打，偶尔次优 ——
  p04: '熟练', // 深夜絮语（温柔稳重，能压就压但不逞强）
  p09: '熟练', // 老年组之光（牌龄长、攻守分明，但按经验打、不算牌）
  p12: '熟练', // 碎碎念（爱念叨别人的出牌顺序 —— 其实是在算牌，但容易算乱）
  p13: '熟练', // 上分要紧（求稳优先不失误，敢压但不冒进）
  p14: '熟练', // 笑看风云（看得透但不争，炸弹常常留到最后忘掉用）
  p21: '熟练', // 阿北同学（活泼贪先手，节奏快，但容易上头）
  p22: '熟练', // 且闻烟雨声（安静敏感，讲究留有余地：会打，但不激进）
  p26: '熟练', // 才不是傲娇（牌风强势爱抢，一急就出错；心里其实在意队友）
  p27: '熟练', // 广场舞领队（稳当不贪，牌龄长，赢了夸对手）
  p31: '熟练', // 沪上梦想家（大一新生：敢试，但会留后手）
  p32: '熟练', // Ginger（音乐生：节奏灵活，偏爱组合牌）
  p33: '熟练', // 地图加载中（骑行者：先测路径再推进，谨慎但不弱）
  p34: '熟练', // 我不是Bot（脱口秀场务：抓时机，但容易浪）
  p35: '熟练', // 要长高女士（设计师：讲构图与留白，平衡型）
  p37: '熟练', // 中国人能飞（运行协调：看全局、懂等待，按条件放行）

  // —— 新手：勉强能玩，但会犯低级错误 ——
  p05: '新手', // 春和景明（怕出错、炸弹几乎舍不得用，一紧张就不敢出牌）
  p06: '新手', // 不熬夜了（犯困走神，看不住牌）
  p08: '新手', // 菜鸟萌新（名字都写着了）
  p10: '新手', // 菜就多练（半瓶子：嘴上是教练，手上常犯低级错误）
  p20: '新手', // 打字很慢（回话晚半拍、常被孩子打断，打一半就走开）
  p24: '新手', // 慢半拍（出牌比别人迟一点，能过就过）
  p25: '新手', // 本命是张卡片（心思在二次元，一上头就乱丢牌）
  p28: '新手', // 天才少女酱（刚学会就自称天才，出牌很跳）
  p38: '新手', // 海底两万里（太有耐心，该出手时还在检查水流）
};

/**
 * ★ 四档的参数表（**要调强弱就改这里**，别去翻 choosePlay 的分支）
 *
 *   topN        ：评分排序后，从**前几名**里随机挑（1 = 每次都选最优）
 *   blunder     ：犯懒概率 —— 直接丢手里最小的一手（低级失误）
 *   countCards  ：是否记牌（用已出的牌推算"这一手对手管不管得上"）
 *   teamwork    ：是否认队友（农民不压队友的牌）
 *   pressDanger ：对手报单/报双时是否懂得"压死"
 *   breakWeight ：在意"拆牌代价"的程度（拆炸弹/拆对子/拆顺子扣多少分）
 *   bombSave    ：只能靠炸弹才压得住时，舍不得动炸弹的概率（同时也是残局里的克制）
 *   finishAware ：是否算残局（出完这一手还要几手才能走完）
 *   think       ：假装思考的时长区间（毫秒）——**四档都落在 1~5 秒内**
 */
export const LEVEL_PARAMS = {
  新手: {
    topN: 4,
    blunder: 0.3,
    countCards: false,
    teamwork: false,
    pressDanger: false,
    breakWeight: 0.4,
    bombSave: 0.5,
    finishAware: false,
    think: [1000, 2600], // 手快，想得少
  },
  熟练: {
    topN: 2,
    blunder: 0.18,
    countCards: false,
    teamwork: true,
    pressDanger: true,
    breakWeight: 0.7,
    bombSave: 0.6,
    finishAware: false,
    think: [1200, 3200],
  },
  高手: {
    topN: 1, // 几乎总选最优，只留 5% 的"手滑"
    blunder: 0.05,
    countCards: true,
    teamwork: true,
    pressDanger: true,
    breakWeight: 1,
    bombSave: 0.75,
    finishAware: true,
    think: [1600, 4000],
  },
  大师: {
    topN: 1, // 永远选最优
    blunder: 0,
    countCards: true,
    teamwork: true,
    pressDanger: true,
    breakWeight: 1.15,
    bombSave: 0.85,
    finishAware: true,
    think: [2000, 5000], // 想得久，看起来最"在算"
  },
};

/** 认不出的档位一律按"熟练"兜底（和五子棋那张表一个口径） */
export const DEFAULT_LEVEL = '熟练';

/** 这个 AI 的牌技档位（没配的兜底"熟练"） */
export function levelOf(personaId) {
  return LEVEL_BY_PERSONA[personaId] || DEFAULT_LEVEL;
}

/** personaId / 人设对象都收 */
export function levelOfPersona(persona) {
  if (!persona) return DEFAULT_LEVEL;
  return levelOf(typeof persona === 'string' ? persona : persona.id);
}

/** 档位序号（0 = 新手 … 3 = 大师），比较强弱用 */
export function levelIndex(level) {
  const i = LEVELS.indexOf(level);
  return i < 0 ? 1 : i;
}

/** 档位名字 / personaId / 人设对象 都收 → 参数表（认不出就给"熟练"的） */
export function levelParamsOf(levelOrPersona) {
  if (typeof levelOrPersona === 'string' && LEVEL_PARAMS[levelOrPersona]) {
    return LEVEL_PARAMS[levelOrPersona];
  }
  return LEVEL_PARAMS[levelOfPersona(levelOrPersona)] || LEVEL_PARAMS[DEFAULT_LEVEL];
}

/** 档位分布（给文档 / 测试看：四档各有几个人） */
export function levelCounts() {
  const out = {};
  for (const l of LEVELS) out[l] = 0;
  for (const p of PERSONAS) out[levelOf(p.id)] += 1;
  return out;
}
