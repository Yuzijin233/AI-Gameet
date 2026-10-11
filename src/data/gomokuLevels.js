/**
 * 五子棋难度（用户拍板：**由 AI 人设决定，玩家不能自选、界面也不显示**）
 *
 * 内部五档：新手 / 入门 / 熟练 / 精通 / 大师（见 GOMOKU.levels）。
 * 分配原则（用户给的）：棋手 / 理性 / 冷面类 → 大师~精通；萌新 / 年长 / 慢半拍类 → 新手~入门。
 * 每个 AI 的难度**固定**（不随机），这样同一个好友的棋力是稳定的，"场次"才有意义。
 *
 * 场次只决定**匹配池**（见 GOMOKU_ROOMS）：
 *   低级场 → 新手 / 入门｜中级场 → 入门 / 熟练 / 精通｜高级场 → 精通 / 大师
 *
 * 纯数据 + 纯函数，测试可以直接调。
 */
import { GOMOKU_ROOMS } from '../config.js';
import { PERSONAS } from './personas.js';

export const LEVELS = ['新手', '入门', '熟练', '精通', '大师'];

/**
 * 人设 → 难度。注释里写了为什么（改的时候照着理由调，别乱挪）。
 */
export const LEVEL_BY_PERSONA = {
  // —— 大师：棋手、钻研型、看得很透的 ——
  p02: '大师', // 小柳先生（古风小生，落子如落笔，算得极清）
  p11: '大师', // Helloworld（理性/钻研，爱算概率）
  p16: '大师', // 冷月（冷淡/理科，下棋像做题）
  p14: '大师', // 笑看风云（佛系散淡 —— 不争，但看得最远）
  p01: '大师', // 不吃香菜（知性/沉稳，走一步看三步）

  // —— 精通：较真、理工、嘴上不服输的 ——
  p19: '精通', // 时光不负（较真/认真，规则算得比谁都细）
  p18: '精通', // 我爱数理化（理工直男，连成活三）
  p07: '精通', // 凌晨三点（话少/好胜，半夜下棋最清醒）
  p03: '精通', // 休怪我无情（毒舌，专挑你的漏洞）
  p15: '精通', // 嘴上没输过（嘴硬，棋也不肯输）
  p17: '精通', // 老张的茶（老练/慢热，下了几十年）
  p30: '精通', // 说的道理（爱抬杠，一边下一边指点你）

  // —— 熟练：会下、偶尔漏招 ——
  p04: '熟练', // 深夜絮语（温柔，稳稳当当）
  p13: '熟练', // 上分要紧（要强/好胜，有套路）
  p21: '熟练', // 阿北同学（活泼/克制，爱抢先手）
  p23: '熟练', // 损友小陈（损友，边下边逗你）
  p26: '熟练', // 才不是傲娇（嘴硬心软，一急就下错）
  p12: '熟练', // 碎碎念（爱操心，边念边算）

  // —— 入门：知道要连五，但不太会算 ——
  p05: '入门', // 春和景明（安静/谨慎，怕下错反而保守）
  p09: '入门', // 老年组之光（沉稳前辈，娱乐为主）
  p22: '入门', // 且闻烟雨声（文艺/慢，下棋像发呆）
  p25: '入门', // 本命是张卡片（二次元，心思在别处）
  p28: '入门', // 天才少女酱（自称天才，其实刚学会）
  p27: '入门', // 广场舞领队（热心阿姨，随手就下）

  // —— 新手：刚上手 / 犯困 / 反应慢 ——
  p06: '新手', // 不熬夜了（犯困，看着看着就走神）
  p08: '新手', // 菜鸟萌新（名字都写着了）
  p10: '新手', // 菜就多练（新手/活泼，落子很快但不看）
  p20: '新手', // 打字很慢（迟钝，想半天也想不到）
  p24: '新手', // 慢半拍（温和/不争，随便下）

  // —— 后来加的 p29 ——
  p29: '精通', // 何知非（学霸：会算，也爱复盘，下得有章法）

  /* —— p31~p40：新增的一批（原表只写到 p29，"28 位人设都分配了难度"一直是红的）—— */
  p33: '精通', // 地图加载中（GIS 学生：脑子就是画格子的，路线感极强）
  p36: '精通', // 小白（男护版）（夜班练出来的稳定，几乎不漏招）
  p39: '精通', // 霍格沃兹在逃法师（做调解的人，耐心和算路都在线）
  p40: '精通', // 艺术家们（画城市写生：看的是一整片，不是一颗子）
  p31: '熟练', // 沪上梦想家（新生：有冲劲，连胜时容易上头）
  p32: '熟练', // Ginger（音乐生：凭节奏感下，偶尔漏防）
  p34: '熟练', // 我不是Bot（场务：爱抢先手，也爱逗你，稳不住）
  p35: '熟练', // 要长高女士（设计师：讲究布局与留白）
  p37: '熟练', // 中国人能飞（协调员：看全局，但下得偏保守）
  p38: '入门', // 海底两万里（太安静了，自己下自己的，不看对手）
};

/** 这个 AI 的棋力（没配的兜底"熟练"，保证场次池里总有人） */
export function levelOf(personaId) {
  return LEVEL_BY_PERSONA[personaId] || '熟练';
}

/** 人和人设对象都收 */
export function levelOfPersona(persona) {
  if (!persona) return '熟练';
  return levelOf(typeof persona === 'string' ? persona : persona.id);
}

/** 难度的序号（0 = 新手 … 4 = 大师），比较棋力用 */
export const levelIndex = (level) => {
  const i = LEVELS.indexOf(level);
  return i < 0 ? 2 : i;
};

/** 按场次挑人设：只从**该场次的难度池**里选（机器模式没有池子，直接给个难度） */
export function pickByRoom(roomId, { pool = PERSONAS, rnd = Math.random } = {}) {
  const room = GOMOKU_ROOMS.find((r) => r.id === roomId) || GOMOKU_ROOMS[0];
  const list = (Array.isArray(pool) ? pool : PERSONAS)
    .filter((p) => room.levels.includes(levelOf(p.id)));
  const use = list.length ? list : PERSONAS.slice();
  return use[Math.floor(rnd() * use.length) % use.length];
}

/** 机器模式（匿名对手）用哪个难度：从场次池里随机一档 */
export function botLevelOfRoom(roomId, rnd = Math.random) {
  const room = GOMOKU_ROOMS.find((r) => r.id === roomId) || GOMOKU_ROOMS[0];
  const list = room.levels.length ? room.levels : LEVELS;
  return list[Math.floor(rnd() * list.length) % list.length];
}

/** 难度分布（给文档 / 测试看：五档各有几个人） */
export function levelCounts() {
  const out = {};
  for (const l of LEVELS) out[l] = 0;
  for (const p of PERSONAS) out[levelOf(p.id)] += 1;
  return out;
}
