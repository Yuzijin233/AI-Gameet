/**
 * 「遇见」的陌生人对话层。
 *
 * 遇见不是好友私聊：双方只是在匹配里再次碰到，不能把关系、记忆或语气
 * 提前升级成好友。这里单独维护提示词与离线兜底，避免复用牌桌/好友场景时串味。
 */
import { FRIEND } from '../config.js';
import { callDeepSeek } from './chat.js';
import { genderPromptLine, agePromptLine } from '../data/personas.js';
import { maxReplyCharsOf, styleRules, decorateLine } from '../data/style.js';

function clean(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .trim();
}

function encounterNumber(number) {
  const value = Math.floor(Number(number));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function personaDescription(persona = {}) {
  return persona.prompt || (Array.isArray(persona.tags) ? persona.tags.join('、') : '') || '自然、友善';
}

/** 短字段的安全长度（昵称 / 签名都不该把提示词撑开） */
const shortText = (value, max) => clean(value).slice(0, max);

/**
 * ★ 玩家资料（用户拍板）：遇见是"只看见一张资料卡就决定聊两句"，
 *   所以 AI 必须知道自己**只见过这么点东西**（界面确实只显示昵称、性别标与年龄）——
 *   别去聊没见过的信息，也别问"你多大/哪里人"这些卡上根本没有的东西。
 *
 * ★ 用户拍板（第二轮）：**玩家的年龄是隐藏信息**，界面上不给玩家看，
 *   所以这里也不告诉模型"当时是按几岁匹配的" —— 模型连含糊的暗示都给不出来。
 *   `matchedAge` 只留着（调用方还在传），当作文案上不使用的输入。
 */
function playerBackground(playerName, playerGender) {
  const name = shortText(playerName, 16);
  return [
    name ? `玩家昵称是「${name}」。` : '',
    playerGender ? `玩家性别信息：${playerGender}。这只是称呼分寸的背景，不要主动拿它当话题。` : '',
  ].filter(Boolean).join('\n');
}

function historyLines(messages) {
  return (Array.isArray(messages) ? messages : []).filter(Boolean).slice(-FRIEND.recent).map((message) => {
    const who = message.role === 'me' || message.role === 'user' ? '玩家' : '你';
    return `${who}：${clean(message.text || message.content)}`;
  }).filter((line) => !/[：]\s*$/.test(line));
}

function encounterSystem({
  persona = {}, number, previousSummary, playerName, playerGender,
  matchedAge = 0, reply = false,
}) {
  const count = encounterNumber(number);
  const limit = maxReplyCharsOf(persona, FRIEND.maxReplyChars);
  return [
    /* ★ 第一行就把"这是怎么碰上的"讲清楚（用户拍板）：遇见匹配来的陌生人，不是牌桌、不是好友 */
    `你是「${shortText(persona.name, 16) || '一位玩家'}」，正在游戏 App 的「遇见」功能里和玩家一对一聊天。`,
    `★ 你们是**怎么认识的**：「遇见」是 App 里的随机匹配 —— 你俩此前**并不认识**、也没一起玩过，`
      + `是在这里刚被配到一起的。这不是牌桌、也不是好友私聊：你**还不知道** TA 叫什么、做什么、爱玩什么。`,
    `★ 玩家那边只看到你的一张资料卡（你的名字、年龄、签名），你这边只看到 TA 的昵称 —— `
      + `所以**别装熟**，也别问那些卡上根本没有的信息。`,
    `这是你们第 ${count} 次通过「遇见」匹配；你们尚未互加好友，仍是刚认识的人。`,
    `你的人设：${personaDescription(persona)}`,
    genderPromptLine(persona),
    agePromptLine(persona),
    playerBackground(playerName, playerGender, matchedAge),
    ...styleRules(persona, { maxChars: limit, scene: 'chat' }),
    previousSummary && count > 1
      ? `上次遇见的简短摘要：${clean(previousSummary)}。可以在合适时自然接上，但别生硬复述。`
      : '',
    '【遇见身份】保持礼貌、轻松和一点距离感；不要假装已经很熟，不要暧昧示爱，不要自称好友。',
    '【隐私与筛选】绝不提及或暗示性别、年龄、地区、兴趣等匹配筛选；不要声称看过玩家未公开的信息。'
      + ' 性别和年龄仅是人设背景，除非玩家直接问，否则不要主动提。',
    '【禁用开场】不要说“在吗”“你多大”“你哪里人”“你的兴趣爱好是什么”，也不要让玩家做自我介绍。',
    /**
     * ★ 出戏词黑名单（用户报的问题：开场白"现在的开场白是什么玩意"）：
     *   匹配是**平台机制**，真人不会把自己被推荐的过程说出来 ——
     *   像"匹配到你""系统推的""翻到你""缘分""算法"这些一冒出来，整段就假了。
     */
    '【绝不出戏】把匹配当成理所当然的事，**不要说破机制**：不许出现“匹配”“系统”“推荐”“算法”“缘分”'
      + '“翻到”“刷到”“随机”“资料”这类字眼，也不要说“我是被分配来陪聊的”。',
    /**
     * ★ 这是"打招呼"，不是"自我介绍"（用户拍板第二轮）：
     *   上一版只要求"具体、只有你会说"，模型就理解成"讲一件我自己的事"，
     *   结果一上来自顾自说自己的事、连招呼都不打 —— 那不像刚碰面的陌生人。
     *   现在把"先招呼、后内容"写死成硬规则。
     */
    '【先打招呼】不管第几次遇见，**每一条消息的开头都要先招呼一下**（“嗨”“你好”“哟”“嘿”这类，用人设自己的口吻），'
      + '再接着说别的。**绝对不许**一上来就自顾自讲自己的事、把对方晾在一边。',
    '【说人话、别独白】一次只说一件事、两三句就够：**先回应 / 招呼对方**，再补一句自己的小事或一个小问题。'
      + '不要长篇自述、不要连着讲三件自己的事、不要写小作文。',
    reply
      ? '现在请接住玩家刚说的话继续聊（**开头照旧先应一声**，比如“嗯”“哈哈”“是这样啊”），保留「遇见」的陌生人分寸。'
      : `【开场怎么写】第一句是**打招呼**（用人设自己的口吻，别用“你好呀”这种客服腔），`
        + `第二句给一个**具体的小话头** —— 你此刻手头的一件小事、或者一个真好奇的小问题都行，让对方有得接。`
        + `**不许**：只讲自己的事不招呼对方、写小作文、“今天怎么样”“想聊点什么”这种万能问句；`
        + `知道这是第几次遇见，但绝不要机械地说“这是第N次”。`,
    /**
     * ★ 不许把牌桌上的场景搬进遇见（用户报的实际案例："我刚出了一张牌，手指在出上停留了几秒"）：
     *   遇见是**刚被配到一起的两个陌生人**在打招呼 —— 没有牌桌、没有对手、也没有"这一局"，
     *   起手就讲自己刚出哪张牌 / 刚赢了一局，读起来完全不合理。
     *   这里是纯聊天场景：只聊**生活、心情、手头的小事**。
     */
    '【这不是牌桌】你在「遇见」里只是和一个刚被配到一起的人**闲聊**：'
      + '**绝不要**提发牌、出牌、叫地主、抢地主、要不起、炸弹、倍数、这局这把手气输赢这类牌桌内容，'
      + '也不要描述"我刚做了什么游戏操作"。你要么说一句自己的日常，要么问一个生活里的小问题。',
  ].filter(Boolean).join('\n');
}

/** 构建遇见开场的模型消息。 */
export function buildEncounterOpenerMessages({
  persona, number, previousSummary, playerName, playerGender, matchedAge = 0,
} = {}) {
  return [
    {
      role: 'system',
      content: encounterSystem({
        persona, number, previousSummary, playerName, playerGender, matchedAge,
      }),
    },
    { role: 'user', content: '发一条开场消息。' },
  ];
}

/** 构建遇见后续回复的模型消息。 */
export function buildEncounterReplyMessages({
  persona, number, previousSummary, messages, playerText, playerName, playerGender,
  matchedAge = 0,
} = {}) {
  const history = historyLines(messages);
  return [
    {
      role: 'system',
      content: encounterSystem({
        persona, number, previousSummary, playerName,
        playerGender, matchedAge, reply: true,
      }),
    },
    {
      role: 'user',
      content: [
        history.length ? `最近对话（me=玩家，ai=你）：\n${history.join('\n')}` : '',
        `玩家刚说：${clean(playerText)}`,
        '请回一句。',
      ].filter(Boolean).join('\n'),
    },
  ];
}

/** 语料里凡是只有牌桌上才成立的句子，都不许拿来当"遇见"的开场 */
const TABLE_TALK = /(开局|出牌|叫地主|抢地主|要不起|牌桌|手牌|炸弹|倍数|上家|下家|这局|这把牌|轮到我|过牌|别慌|出张|接不住|压住|赢了|输了|人齐)/;
const BANNED_OPENER = /(在吗|你多大|多大了|你哪里人|哪里人|兴趣爱好是什么)/;
/** ★ 出戏词：开场白里出现这些就判不合格，重试或换兜底（用户报的"开场白是什么玩意"） */
const META_OPENER = /(匹配|系统|推荐|算法|缘分|翻到|刷到|随机|资料卡|分配|平台|App|app)/;
/** ★ 万能句：谁都能说的开场，等于没开场 */
const LAZY_OPENER = /(今天(过得|怎么样|如何)|想聊(点|些什么)|聊点什么|你好呀|哈喽|嗨，?我|很高兴认识|交个朋友)/;
/**
 * ★ "在讲自己的游戏操作 / 牌桌场景"的开场（用户报的实际案例）：
 *   「我刚出了一张牌，手指在出上停留了几秒」—— 遇见是**刚被配到一起的陌生人打招呼**，
 *   既没有牌桌、也没有对手，起手就讲自己刚出哪张牌完全不合理。
 *   两道拦：语料侧过掉牌桌句（TABLE_TALK），模型侧用这条判不合格。
 */
const GAMEPLAY_OPENER = /(出了一张|刚出|出牌|要不起|叫地主|抢地主|自摸|胡了|开局|一局|一把|一把牌|哪把牌|这把牌|那把牌|手牌|上家|下家|牌桌|翻牌|钓|落子|连成五个|炸弹|王炸|明牌|底牌|轮到我)/;

/**
 * ★ 开场必须是"打招呼"（用户拍板第二轮：模型老是自顾自说自己的事，连招呼都不打）。
 *   只认真正像招呼的开头 —— "你好呀"这种客服腔由 LAZY_OPENER 管，这里管"有没有招呼"。
 *   注意：**不要**加裸的 `早` 这种单字（"早上起来就…"会被误判），只认明确的招呼语。
 */
const GREETING_HEAD = /^\s*[（(【「『]*\s*(嗨|诶|哎|哟|呦|嘿|喂|哈喽|哈罗|hello|hi|yo|你好|您好|大家好|早啊|早呀|早上好|中午好|下午好|晚上好|晚安|幸会|初次见面|第一次见|又见面|又碰到|又遇上|又遇见)/i;

/** 开场白是否合格（不合格会让模型重试一次，仍不合格就用本地兜底） */
export function isBadOpener(text) {
  const t = clean(text);
  if (!t) return true;
  if (BANNED_OPENER.test(t) || META_OPENER.test(t) || LAZY_OPENER.test(t) || GAMEPLAY_OPENER.test(t)) return true;
  // ★ 没有打招呼 = 不合格（"我刚泡了杯茶…"这种自顾自的开头要被拦下来）
  return !GREETING_HEAD.test(t);
}

/**
 * 本地兜底开场：**按人设定制**，不是万能句、也不能是牌桌戏（用户拍板）
 *   · 第 2 次及以后：沿用"又遇见你了"（这句本来就对，也确实有信息量）
 *   · 第 1 次：优先用这个人设**自带**的问候语料（每人不一样），挑不到再用一句具体的模板
 *   · 语料要过 TABLE_TALK（牌桌术语）与 isBadOpener（出戏 / 万能 / 打牌场景）两道网 ——
 *     所以不会跳出"啊啊啊啊人齐了"这种只有牌桌上才成立的话
 */
function fallbackOpener(persona = {}, number) {
  const count = encounterNumber(number);
  if (count > 1) return '又遇见你了，没想到还能碰上。';
  // ① 人设自带的问候语料里挑一条干净的（挑不到就往下走）
  const candidates = [
    ...(persona.lines?.greeting || []),
    ...(persona.lines?.idle || []),
  ].map(clean).filter((line) => line && !TABLE_TALK.test(line) && !isBadOpener(line));
  if (candidates.length) return decorateLine(candidates[0], persona);
  // ② 最后兜底：**每一句都以招呼开头**（用户拍板：开场必须先打招呼，不能自顾自说自己的事）
  const pool = [
    '嗨，刚闲下来，随便聊两句 —— 你平时都忙些什么？',
    '你好，我这会儿正好没事，找人闲聊两句。',
    '嗨，今天挺普通的，倒是有件小事想找个人说说。',
    '哟，在忙吗？我这边刚把手头的事放下。',
    '诶，刚空下来，你最近怎么样？',
    '嘿，随便聊两句吧，我这边刚闲下来。',
  ];
  return decorateLine(pool[Math.floor(Math.random() * pool.length)], persona);
}

function fallbackReply(persona = {}, playerText) {
  const text = clean(playerText);
  if (/谢谢|感谢/.test(text)) return '不用客气，随口聊聊就好。';
  if (/你好|嗨|哈喽/.test(text)) return '嗨，刚好碰上了，说点你最近的事吧。';
  return decorateLine('听起来挺有意思的，你愿意多说一句吗？', persona);
}

/**
 * 请求一次，并做**开场白质量校验**（只对开场做）：不合格就重试一次，
 * 仍不合格就用本地兜底 —— 保证气泡里不会出现"匹配到你""今天怎么样"这类话。
 */
async function request(messages, fallback, persona, { guard = null, retry = false } = {}) {
  const limit = maxReplyCharsOf(persona, FRIEND.maxReplyChars);
  const attempts = retry ? 2 : 1;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const text = clean(await callDeepSeek(messages));
      if (!text) throw new Error('empty model reply');
      if (guard && guard(text)) throw new Error('bad opener');
      return { text: text.slice(0, limit), offline: false };
    } catch {
      // 还有下一次机会就继续；否则走兜底
      if (i === attempts - 1) break;
    }
  }
  return { text: clean(fallback).slice(0, limit), offline: true };
}

/** AI 在遇见匹配中主动开场。 */
export async function encounterOpener(opts = {}) {
  return request(
    buildEncounterOpenerMessages(opts),
    fallbackOpener(opts.persona, opts.number),
    opts.persona,
    { guard: isBadOpener, retry: true },
  );
}

/** AI 在遇见匹配中的后续回复。 */
export async function encounterReply(opts = {}) {
  return request(
    buildEncounterReplyMessages(opts),
    fallbackReply(opts.persona, opts.playerText),
    opts.persona,
  );
}
