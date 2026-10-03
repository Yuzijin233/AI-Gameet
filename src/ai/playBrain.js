/**
 * AI 出牌大脑（大模型决策 + 脚本兜底）
 * ------------------------------------------------------------------
 * 与"发言"完全分开的两套逻辑：
 *   · 出牌：本文件 —— 提示词给出**身份 + 自己的完整手牌 + 各家剩余张数 + 上一手/最近几手 + 我的打法风格**，
 *           让模型直接决定出哪几张牌；
 *   · 发言：chat.js —— 出牌之后再单独调用，只负责说话（那一套不变）。
 *
 * 兜底策略（PRD §2.8）：15 秒预算内最多调用 2 次（失败/解析不合法都会重试一次），
 * 只要 15 秒没出牌、或连续两次调用失败，就交给脚本机器人（core/bot.js）兜底。
 */
import { CONFIG } from '../config.js';
import { callDeepSeek } from './chat.js';
import { analyze, canBeat, findPlays, TYPE_LABEL } from '../core/rules.js';
import { rankLabel, RANK_LABEL, SUIT_GLYPH, isRed } from '../core/cards.js';

/* ------------------------------------------------------------------ */
/*                          打法风格预设                                */
/* ------------------------------------------------------------------ */
export const PLAY_STYLES = {
  press: {
    name: '爱压',
    prompt: '你打牌爱压人：只要能压就压，宁可拆一点结构也要把场面压住，不喜欢让别人舒服地走牌。',
  },
  small: {
    name: '先走小牌',
    prompt: '你习惯先走小牌：优先把最小的单张/对子丢掉，大牌留到最后再发力。',
  },
  breaker: {
    name: '拆牌成顺',
    prompt: '你喜欢凑长牌型：宁愿拆对子甚至三张，也要把顺子/连对/飞机打出去，喜欢一次走很多张。',
  },
  holder: {
    name: '惜牌留大',
    prompt: '你惜牌：不轻易出大牌、不轻易拆结构，能不出就不出，把好牌留到关键回合。',
  },
  runner: {
    name: '抢着走完',
    prompt: '你追求尽快走完：优先选张数多的牌型，手上越少越激进，有机会就跑。',
  },
  balanced: {
    name: '稳健',
    prompt: '你打牌稳健：不过度拆牌，也不一味退让，尽量用最小代价压住该压的牌。',
  },
};

/** 每个人设一个打法风格（改这里就能调某个 AI 的牌风） */
export const PLAY_STYLE_BY_PERSONA = {
  p01: 'holder', // 不吃香菜（谨慎）
  p02: 'holder', // 小柳先生（稳，不冒进）
  p03: 'press', // 休怪我无情
  p04: 'breaker', // 深夜絮语
  p05: 'holder', // 春和景明
  p06: 'small', // 不熬夜了
  p07: 'press', // 凌晨三点
  p08: 'small', // 菜鸟萌新
  p09: 'balanced', // 老年组之光
  p10: 'runner', // 菜就多练
  p11: 'balanced', // Helloworld
  p12: 'small', // 碎碎念
  p13: 'runner', // 上分要紧
  p14: 'balanced', // 笑看风云
  p15: 'press', // 嘴上没输过
  p16: 'holder', // 冷月
  p17: 'holder', // 老张的茶
  p18: 'press', // 我爱数理化
  p19: 'balanced', // 时光不负
  p20: 'small', // 打字很慢
  p21: 'runner', // 阿北同学
  p22: 'balanced', // 且闻烟雨声
  p23: 'breaker', // 损友小陈
  p24: 'small', // 慢半拍
  p25: 'press', // 本命是张卡片（上头，见大牌就压）
  p26: 'press', // 才不是傲娇（嘴硬，抢着压）
  p27: 'balanced', // 广场舞领队（稳当不贪）
  p28: 'holder', // 一米五五（胆小，大牌舍不得用）
  p29: 'balanced', // 何知非（算得清也敢搏：稳中带活）
  p30: 'press', // 说的道理（嘴上不饶人，打牌也爱压）
};

/** 取这个 AI 的打法风格（没配就按 aggressive/cautious 推） */
export function playStyleOf(persona) {
  const id = persona && persona.id;
  const key = (id && PLAY_STYLE_BY_PERSONA[id])
    || (persona && persona.style === 'aggressive' ? 'press'
      : persona && persona.style === 'cautious' ? 'holder' : 'balanced');
  return { key, ...(PLAY_STYLES[key] || PLAY_STYLES.balanced) };
}

/* ------------------------------------------------------------------ */
/*                          提示词                                      */
/* ------------------------------------------------------------------ */
const SUIT_TXT = { S: '♠', H: '♥', C: '♣', D: '♦', J: '' };
const cardText = (c) => (c.rank >= 16 ? RANK_LABEL[c.rank] : `${SUIT_TXT[c.suit] || ''}${RANK_LABEL[c.rank]}`);

/** 把手上的一手牌写清楚（出牌必须知道具体牌，这是唯一允许交出完整手牌的地方） */
function handText(hand) {
  return hand.slice()
    .sort((a, b) => (b.rank - a.rank) || a.suit.localeCompare(b.suit))
    .map(cardText)
    .join(' ');
}

export function buildPlayMessages({
  persona, style, hand, last, counts, names = ['你', '下家', '上家'], seat, landlordSeat,
  mustPlay = false, history = [], multiplier = 1,
}) {
  const isLandlord = seat === landlordSeat;
  const others = counts
    .map((n, s) => (s === seat ? null : `${names[s]} ${n} 张`))
    .filter(Boolean).join('，');

  const system = [
    `你在玩三人斗地主，你是「${persona ? persona.name : 'AI'}」。`,
    persona ? `人设：${persona.prompt || ''}` : '',
    style ? `你的打法风格：${style.name}——${style.prompt}` : '',
    '【规则】',
    '1) 你只能用手里的牌，牌型要合法（单张/对子/三张/三带一/三带二/顺子/连对/飞机/四带二/炸弹/王炸）。',
    '2) 上家出过牌时，你要么出**同类型且更大**的牌，要么出炸弹/王炸，要么选择不出。',
    '3) 你是本轮首出时不能不出。',
    '4) 你不知道别人的具体手牌，只能看他们剩几张来推测，不要假装看到了别人的牌。',
    '【输出格式（非常重要）】',
    '· 只输出你要出的牌的**点数**，用空格分隔。要出对子就写两个相同点数。',
    '· 例如：`3`、`5 5`、`10 J Q K A`、`7 7 7 4`、`小王 大王`。',
    '· 如果这轮你选择不出，只输出 `pass`。',
    '· 不要输出任何解释、标点、花色或多余的字。',
  ].filter(Boolean).join('\n');

  // last 兼容两种形状：{ seat, play } 与 { ...play, seat }（engine.aiContext 给的是后者）
  const lastPlay = last && last.play ? last.play : last;
  const lastSeat = last ? last.seat : undefined;

  const lines = [
    `你的身份：${isLandlord ? '地主' : '农民'}`,
    `你手里的牌（${hand.length} 张）：${handText(hand)}`,
    `其他两家：${others}`,
    `当前倍数：×${multiplier}`,
    lastPlay
      ? `上一手：${names[lastSeat] || '上家'} 出了 ${lastPlay.cards.map(cardText).join(' ')}（${TYPE_LABEL[lastPlay.type] || ''}）`
      : '上一手：无（你是本轮首出，必须出牌）',
    history.length ? `最近几手：${history.join('；')}` : '',
    mustPlay ? '你必须出牌，不能 pass。' : '你可以出牌，也可以 pass。',
    '请只输出点数（或 pass）。',
  ].filter(Boolean);

  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
}

/* ------------------------------------------------------------------ */
/*                          解析模型输出                                */
/* ------------------------------------------------------------------ */
const RANK_WORD = {
  小王: 16, 大王: 17, 王炸: 17, 大鬼: 17, 小鬼: 16, 王: 17,
  J: 11, Q: 12, K: 13, A: 14,
};

/** 把模型输出解析成点数数组；返回 { pass } 或 { ranks } 或 { error } */
export function parseRankTokens(text) {
  let t = String(text || '').trim();
  if (!t) return { error: '空回复' };
  t = t.replace(/[「」『』"'`]/g, ' ').replace(/[，,、。；;：:]+/g, ' ');
  if (/^pass$/i.test(t.trim()) || /不出|不要|过牌|^过$/.test(t)) return { pass: true };

  const ranks = [];
  // 先吃掉"小王/大王"，再把剩下的字母数字切成 token
  const replaced = t.replace(/小王|大王/g, (m) => ` ${m} `);
  const CN = {
    三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 二: 15, 两: 2,
  };
  for (const rawToken of replaced.split(/[^0-9A-Za-z\u4e00-\u9fa5]+/)) {
    if (!rawToken) continue;
    // "对三 / 三张5 / 一张A" 这类写法：把前缀去掉再认点数
    const raw = rawToken.replace(/^(对|双|一张|两张|三张|四张|单张|单|一对)/, '') || rawToken;
    if (RANK_WORD[raw] !== undefined) { ranks.push(RANK_WORD[raw]); continue; }
    if (raw === '10') { ranks.push(10); continue; }
    if (/^[2-9]$/.test(raw)) { ranks.push(Number(raw)); continue; }
    if (/^(J|Q|K|A)$/i.test(raw)) { ranks.push(RANK_WORD[raw.toUpperCase()]); continue; }
    if (CN[raw] !== undefined) { ranks.push(CN[raw]); continue; }
    // 兜底：从"对三"这类 token 里取出最后那个能认的字
    const last = raw[raw.length - 1];
    if (CN[last] !== undefined) { ranks.push(CN[last]); continue; }
    if (/^[2-9]$/.test(last)) { ranks.push(Number(last)); continue; }
    if (/^(J|Q|K|A)$/i.test(last)) { ranks.push(RANK_WORD[last.toUpperCase()]); continue; }
  }
  if (!ranks.length) return { error: `看不懂的回复：${t.slice(0, 30)}` };
  return { ranks };
}

/**
 * 把点数映射回手里的具体牌，并校验合法性
 * @returns {{ok:true, play:object|null}} play=null 表示不出
 *          {{ok:false, error:string}}
 */
export function parsePlayReply(text, hand, last, { mustPlay = false } = {}) {
  const parsed = parseRankTokens(text);
  if (parsed.error) return { ok: false, error: parsed.error };
  if (parsed.pass) {
    if (mustPlay) return { ok: false, error: '首出不能 pass' };
    return { ok: true, play: null };
  }
  const pool = new Map(); // rank -> 可用的牌
  for (const c of hand) {
    if (!pool.has(c.rank)) pool.set(c.rank, []);
    pool.get(c.rank).push(c);
  }
  const cards = [];
  const usedIds = new Set();
  for (const r of parsed.ranks) {
    const list = (pool.get(r) || []).filter((c) => !usedIds.has(c.id));
    if (!list.length) return { ok: false, error: `手里没有更多的 ${RANK_LABEL[r] || r}` };
    const pick = list[0];
    usedIds.add(pick.id);
    cards.push(pick);
  }
  const play = analyze(cards);
  if (!play) return { ok: false, error: '这组牌不是合法牌型' };
  if (!canBeat(play, last)) return { ok: false, error: '这组牌管不上上一手' };
  return { ok: true, play };
}

/* ------------------------------------------------------------------ */
/*                          决策入口                                    */
/* ------------------------------------------------------------------ */
/**
 * 让大模型决定这一手出什么
 * @returns {Promise<{play:object|null, source:'llm'|'fallback', error?:string, ms:number}>}
 *   source = 'fallback' 表示超时/连续失败，调用方应改用脚本机器人
 */
export async function decidePlayWithLLM(ctx) {
  const {
    timeoutMs = CONFIG.ai.playTimeout,
    attempts = CONFIG.ai.playRetry + 1,
  } = ctx;
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let lastError = null;
  let hint = '';

  for (let i = 0; i < attempts; i += 1) {
    const left = deadline - Date.now();
    if (left < 300) { lastError = lastError || '超时'; break; }
    const messages = buildPlayMessages(ctx);
    if (hint) {
      messages.push({
        role: 'user',
        content: `你刚才的回复「${hint}」无法使用。请**只输出点数**（空格分隔，如 \`5 5\`），或输出 pass。`,
      });
    }
    try {
      const raw = await callDeepSeek(messages, { timeoutMs: left });
      const parsed = parsePlayReply(raw, ctx.hand, ctx.last, { mustPlay: ctx.mustPlay });
      if (parsed.ok) {
        return { play: parsed.play, source: 'llm', ms: Date.now() - t0 };
      }
      lastError = parsed.error;
      hint = String(raw).slice(0, 20);
    } catch (e) {
      lastError = e && e.message ? e.message : '调用失败';
    }
  }
  return {
    play: null, source: 'fallback', error: lastError, ms: Date.now() - t0,
  };
}

/** 给测试/调试用：把合法出牌列成文本 */
export function legalPlaysText(hand, last) {
  return findPlays(hand, last).slice(0, 12)
    .map((p) => `${TYPE_LABEL[p.type] || p.type}: ${p.cards.map(cardText).join(' ')}`)
    .join(' | ');
}

export { handText, cardText, SUIT_GLYPH, isRed };
