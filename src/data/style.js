/**
 * 人设的"表达风格"（PRD §2.6 / §2.8）
 *
 * 光有人设描述还不够：有人爱发表情、有人爱发颜文字、话痨会一口气说好几句。
 * 这里把这类差异做成**人设字段 → 提示词规则 + 本地语料加工**，线上（模型）与离线（本地台词）
 * 表现一致，不会出现"断网就变成另一个性格"。
 *
 * 人设可选字段：
 *   emoji:   ['😪','💤']                    爱用表情（数组就是可用池）
 *   kaomoji: ['(・ω・)','(´▽｀)']           爱用颜文字（**池子给 3~6 个**，每次随机挑一个，别老用同一个）
 *   talky:   true                           话痨：可以说 2~3 句
 *   maxChars: 46                            覆盖默认长度上限（仅少数人设需要）
 *
 * ★ 颜文字的两条口径（用户拍板）：
 *   ① 不是每句都加 —— 提示词里写明"偶尔用、可以不用"，本地兜底也只有约三成半的概率加；
 *   ② 位置不固定在句末 —— 多数贴句末，少数插在句中（第一个句读标点之后）单独放着。
 *   `kaomoji: []`（空数组）= 这个人**完全不用颜文字**，`usesKaomoji()` 返回 false，彻底不进这套逻辑。
 */
import { CONFIG } from '../config.js';

/** 这个人的台词长度上限（话痨可以更长） */
export function maxCharsOf(persona, fallback = CONFIG.ai.maxChars) {
  const n = persona && persona.maxChars;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 这个人的私聊回复长度上限 */
export function maxReplyCharsOf(persona, fallback) {
  const n = persona && persona.maxChars;
  const talky = !!(persona && persona.talky);
  if (!talky) return fallback;
  return Math.max(fallback, Math.round((n || fallback) * 1.6));
}

/** 是否爱发表情 / 颜文字（kaomoji 空数组 = 这个人不用颜文字，这里必然是 false） */
export const usesEmoji = (persona) => !!(persona && persona.emoji && persona.emoji.length);
export const usesKaomoji = (persona) => !!(persona && persona.kaomoji && persona.kaomoji.length);
export const isTalky = (persona) => !!(persona && persona.talky);

/** 颜文字池（已去空值、去重），挑的时候随机取一个 —— 别永远拿第一个 */
export function kaomojiPoolOf(persona) {
  if (!usesKaomoji(persona)) return [];
  return [...new Set(persona.kaomoji.filter((k) => typeof k === 'string' && k.trim()))];
}

/**
 * 「看人下菜」的那一行：有些 AI 对**玩家性别 + 好感度**有额外反应
 * （用户拍板；现在有三种，写在人设的 `reactions` 上，别硬编码人名）
 *
 *   `softenForWomen: true`  → 玩家是**男生**就一直保持原样；玩家是**女生**时，
 *                             好感度越高越不知所措、攻击性明显下降
 *   `toneDownSlang: true`   → 好感度越高，**网络用语/口癖占比越低**（小红书重度用户那类）
 *   `easeIntoReality: true` → 好感度越高，**越会聊到三次元的内容**（平时比较宅那种）
 *
 * @param {object} persona
 * @param {{playerGender?:string, affinity?:number, lover?:boolean}} [ctx]
 *   playerGender 可以传性别 id（'male' / 'female'），也可以直接传
 *   `playerGenderLine()` 生成的那句话（含"男生 / 女生"，这里自己认）
 * @returns {string} 提示词片段；这个人设没这些设定就返回空串
 */
export function personaReactionLine(persona, { playerGender = '', affinity = 0, lover = false } = {}) {
  const r = (persona && persona.reactions) || null;
  if (!r) return '';
  const aff = Math.max(0, Math.min(100, Number(affinity) || 0));
  const out = [];
  if (r.softenForWomen) out.push(softenForWomenLine(normalizeGender(playerGender), aff, lover));
  if (r.toneDownSlang) out.push(toneDownSlangLine(aff));
  if (r.easeIntoReality) out.push(easeIntoRealityLine(aff));
  return out.filter(Boolean).join('\n');
}

/** p30 那种：对女生会收着火 */
function softenForWomenLine(g, aff, lover) {
  if (g !== 'female') {
    return '【对玩家的态度】玩家是男生 —— 你**一直**是那副高强度冲浪的样子，'
      + '嘴上一点不让，该开火就开火，不用收敛。';
  }
  if (lover || aff >= 80) {
    return '【对玩家的态度】玩家是女生，而且你俩已经很熟了（好感度很高）—— 你那套攻击性**基本收起来了**：'
      + '会不知所措、说话打结、想找梗又怕说错（"啊……这个、我不是那个意思"），'
      + '但面子还要，偶尔嘴硬半句再自己先笑场。**不要**再冲她甩"急/孝/典"那一套。';
  }
  if (aff >= 50) {
    return '【对玩家的态度】玩家是女生，你俩还算聊得来 —— 你**明显没那么冲**了：'
      + '梗还在用，但下嘴轻、会先看一眼她的反应；被她认真一夸就卡壳、赶紧转移话题。';
  }
  return '【对玩家的态度】玩家是女生，但你们还不熟 —— 你嘴上还是冲，'
    + '不过**火力收着点**：可以毒舌打牌技术，别对她本人下狠嘴（你其实有点不敢）。';
}

/** 口癖党：好感越高，网络用语越少 */
function toneDownSlangLine(aff) {
  if (aff >= 70) {
    return '【口癖浓度】你俩已经很熟了 —— 网络用语/口癖**明显退潮**了：'
      + '大部分时候就是正常说话，只在特别激动的时候偶尔冒一句（"啊啊啊啊这个我行了"），'
      + '不要一路堆到最后，也不要一下全戒掉（那样不像你）。';
  }
  if (aff >= 40) {
    return '【口癖浓度】你们算熟了 —— 口癖**比刚认识时少一些**：'
      + '一句里最多一个，闲聊时正常说话，情绪上来了才连着来。';
  }
  return '【口癖浓度】你们还不太熟 —— 你就是典型的那种说话方式：'
    + '口癖密度高、一惊一乍的，但**一句里最多一个**，别堆成一串。';
}

/** 宅系：好感越高越会聊到现实里的日常 */
function easeIntoRealityLine(aff) {
  if (aff >= 70) {
    return '【话题范围】你俩很熟了 —— 你会**主动聊一点三次元的事**了：'
      + '上课/作业、打工、吃了什么、现实里的小烦恼，都能自然说出来（不用刻意，也别一次性倒完）。';
  }
  if (aff >= 40) {
    return '【话题范围】你们聊得来了 —— 偶尔会漏出一点现实日常（今天干了什么、有点累），'
      + '但大部分时候还是二次元/宅内容为主。';
  }
  return '【话题范围】你们还不算熟 —— 你基本只聊二次元、游戏、番剧这些自己熟悉的东西，'
      + '现实里的事**很少主动说**（有点不好意思）。';
}

/** 性别输入的容错：'female' / 'female…' / '玩家是女生（…）' 都能认出来 */
function normalizeGender(x) {
  const s = String(x == null ? '' : x);
  if (!s) return '';
  if (s === 'female' || s === 'male') return s;
  if (/女生|女性|小姐姐|姐妹/.test(s)) return 'female';
  if (/男生|男性|老哥|兄弟/.test(s)) return 'male';
  return '';
}

/**
 * ★ 「你也在这款游戏里」（用户拍板）：让 AI 知道自己**和玩家玩的是同一个平台**，
 *   而不是一个只会在旁边念台词的 NPC —— 它有自己的号、自己的身家与称号，
 *   也会在友圈发动态、在群里聊天、被邀请进局。
 *
 * 这是**背景知识**：不主动解释、不拿它当话题，更不许说"我是 AI / 系统 / 程序 / NPC"。
 */
export const GAME_WORLD_LINE = '【你在哪】你和玩家都在玩同一款叫「Gameet」的游戏 —— '
  + '一个**卡牌桌游 + 社交**的平台：里面有斗地主、小猫钓鱼、五子棋，也有好友私聊、群聊和友圈。'
  + '你自己也是这个平台的用户（有自己的号、自己的开心豆和称号，会在友圈发动态、在群里闲聊、被朋友拉去开局），'
  + '**不是站在旁边的 NPC**。这是背景知识：**别主动解释这个平台、也别拿它当话题**，'
  + '更不要说"我是 AI / 系统 / 程序 / 机器人 / NPC"这类出戏的话。';

/**
 * 生成"说话风格"提示词片段（没有特殊风格就返回空数组，不占提示词空间）
 * @returns {string[]}
 */
export function styleRules(persona, { maxChars, scene = 'table' } = {}) {
  const out = [GAME_WORLD_LINE];
  if (usesEmoji(persona)) {
    const pool = persona.emoji.slice(0, 4).join(' ');
    out.push(`你爱用表情：约一半的台词结尾带一个 emoji（可用 ${pool}），一句最多一个，别每句都带。`);
  }
  if (usesKaomoji(persona)) {
    const pool = kaomojiPoolOf(persona).slice(0, 6).join(' ');
    out.push(`你偶尔用颜文字（可用 ${pool}）：大约每三四句才带一次就够，**也完全可以不用**；`
      + '位置**不固定在句末** —— 可以放在句中，也可以在一句话说完之后另起一行单独放；'
      + '别老用同一个，从上面这几个里换着来，一句最多一个，别堆。');
  }
  if (isTalky(persona)) {
    out.push(
      scene === 'table'
        ? `你是话痨：可以一口气说 2~3 个短句，总长不超过 ${maxChars || maxCharsOf(persona)} 字，中间用逗号或句号，不要换行。`
        : `你是话痨：可以连说 2~3 个短句，总长不超过 ${maxChars || maxReplyCharsOf(persona, CONFIG.ai.maxChars)} 字，不要换行。`,
    );
  }
  if (persona && persona.quiet) {
    out.push('你惜字如金：尽量 4~8 个字说完，能省的字都省掉。');
  }
  return out;
}

/**
 * 本地语料加工：给台词补上表情/颜文字（talky 的拼接在 pickLocal 里做）
 *
 * 规则（用户拍板）：
 *   · emoji 还是"约一半"；颜文字降到**约三成半**，而且不是每句都有；
 *   · 位置随机：多数贴句末，少数插在第一个句读标点（，、；）之后；
 *   · 每次从池子里**随机挑一个**（不再永远取第一个），已经带 emoji / 颜文字结尾的不重复加。
 */
export function decorateLine(line, persona, rnd = Math.random) {
  const t = String(line || '').trim();
  if (!t) return t;
  // 已经有 emoji / 颜文字结尾就不再加（原来就有这条，保留）
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]$/u.test(t)
    || (/[)）]$/.test(t) && /[(（]/.test(t))) return t;

  const e = usesEmoji(persona) && rnd() < 0.5 ? persona.emoji : null;
  const k = !e && usesKaomoji(persona) && rnd() < 0.35 ? kaomojiPoolOf(persona) : null;
  const pool = e || k;
  if (!pool || !pool.length) return t;
  const tail = pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
  if (!tail) return t;

  // 颜文字少数时候放在句中：插在第一个句读标点之后，像"话说一半想起来补一个"
  if (k && rnd() < 0.25) {
    const m = /[，,、；;]/.exec(t);
    if (m && m.index + 1 < t.length) {
      const head = t.slice(0, m.index + 1);
      const pad = /[\u4e00-\u9fa5]$/.test(t.slice(0, m.index)) ? '' : ' ';
      return `${head}${pad}${tail}${t.slice(m.index + 1)}`;
    }
  }
  return `${t}${/[\u4e00-\u9fa5]$/.test(t) ? '' : ' '}${tail}`;
}

/** 话痨：把两条台词接成一句（本地兜底用） */
export function joinChatty(a, b) {
  const x = String(a || '').trim().replace(/[。！!？?…~～]+$/, '');
  const y = String(b || '').trim();
  if (!x) return y;
  if (!y || x === y) return String(a).trim();
  return `${x}，${y}`;
}
