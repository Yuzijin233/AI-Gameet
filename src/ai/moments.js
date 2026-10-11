/**
 * 友圈的 AI 层
 *
 * 两件事：
 *   1. **审查 AI 挑人**（一次调用）：这条说说该由哪些 AI 来评论 ——
 *        · 没明确指向 → 随机 2~4 个
 *        · 明确 @ 了谁 → 被指的那位 + 另外 1 位（用户拍板）
 *        · 好友 < 3 位 → 所有好友都来
 *   2. **每人一条评论**（N 次调用）：用第三方的口气评论玩家的说说；
 *      如果玩家回复了某条评论，那位 AI 要**接着这条回复**说话。
 *      提示词里给足三样东西（用户要求）：**说说内容** + **相关记忆**（关于玩家的 / 它自己的）
 *      + **基本信息**（人设、标签、性别、年龄、称呼、关系、玩家昵称与性别、身家称号）。
 *      AI 评论过的**最新 2 条友圈**由 store/friends.js 的 addMomentMemory 额外记下来。
 *   模型不可用时全部走本地兜底（关键词 + 语料），功能不缺失。
 */
import { MOMENTS } from '../config.js';
import { callDeepSeek } from './chat.js';
import { genderPromptLine, agePromptLine } from '../data/personas.js';
import { timeContextLine } from '../data/clock.js';
import { styleRules, decorateLine, personaReactionLine } from '../data/style.js';
import { pickChatLine, chatBucket } from '../data/chatLines.js';
import { affinityTier, memoryGroups, callNameOf } from '../store/friends.js';
import { ownedLines, OWNER_PLAYER, OWNER_SELF, OWNER_SYSTEM } from '../data/memory.js';
import { findMentioned } from './group.js';
import { aiEconomyLine } from './friend.js';

function sanitize(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
}

/** 好友记录 → 人设列表（挑人按人设判断，对外仍然返回 personaId） */
const personasOf = (friends) => (Array.isArray(friends) ? friends : [])
  .map((f) => (f && f.persona ? f.persona : f))
  .filter((p) => p && typeof p.id === 'string' && p.name)
  .map((p) => ({ id: p.id, name: p.name, tags: p.tags || [] }));

/** 兼容三种写法：personaId 字符串 / 好友记录 / 人设对象 */
const idOf = (x) => (typeof x === 'string' ? x : ((x && (x.personaId || x.id)) || ''));

/**
 * 评论专用的清理（用户拍板：**允许换行、别截断**）：
 *   · 换行**保留**（最多 MOMENTS.commentMaxLines 行，多余空行压掉）
 *   · 去掉整段外面的引号 / 书名号，去掉行首"名字："这种模型爱加的前缀
 *   · 只有真的超过上限（MOMENTS.commentMaxChars）才截，而且尽量断在句末
 */
export function sanitizeComment(raw, { maxChars = MOMENTS.commentMaxChars, maxLines = MOMENTS.commentMaxLines } = {}) {
  let s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
  if (!s) return '';
  s = s.replace(/^```[a-z]*\n?|```$/g, '').trim();
  let lines = s.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  // 行首"名字：/ 我："这种前缀
  lines = lines.map((l) => l.replace(/^[^：:\n]{1,10}[：:]\s*(?=\S)/, ''));
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);
  s = lines.join('\n').replace(/^["'「『]+|["'」』]+$/g, '').trim();
  if ([...s].length <= maxChars) return s;
  // 超长：优先在最后一句 / 一行处断开，别把话切一半
  const cut = [...s].slice(0, maxChars).join('');
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
    cut.lastIndexOf('，'), cut.lastIndexOf('\n'), cut.lastIndexOf('~'), cut.lastIndexOf('～'));
  return `${(stop > maxChars * 0.5 ? cut.slice(0, stop + 1) : cut).trim()}…`;
}

/** 评论长度上限：**不再套私聊那套"短句"上限**（用户拍板"别截断"），只留一个很宽的安全线 */
const commentLimit = () => MOMENTS.commentMaxChars;

/* ===================================================================== */
/*                        1) 谁来说说下面评论                             */
/* ===================================================================== */
/**
 * 本地规则挑人（也是模型不可用时的兜底）
 * @param {{friends:object[], text:string, rnd?:Function}} p
 * @returns {string[]} personaId 列表
 */
export function localChooseCommenters({ friends, text = '', rnd = Math.random }) {
  const list = personasOf(friends);
  if (!list.length) return [];
  // 好友 < 3 位 → 全都来（用户拍板）
  if (list.length < 3) return list.map((p) => p.id);

  const mentioned = findMentioned(text, list).filter((id) => list.some((p) => p.id === id));
  const pick = [];
  if (mentioned.length) {
    // 明确指向：被指的人一定来，另外再来 1 位
    pick.push(mentioned[0]);
    const rest = list.filter((p) => p.id !== mentioned[0]);
    const other = rest[Math.floor(rnd() * rest.length) % rest.length];
    if (other) pick.push(other.id);
    return [...new Set(pick)];
  }
  const want = MOMENTS.minCommenters
    + Math.floor(rnd() * (MOMENTS.maxCommenters - MOMENTS.minCommenters + 1));
  const pool = list.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(1, Math.min(want, pool.length))).map((p) => p.id);
}

/** 审查 AI 的提示词：挑人 */
export function buildChooseCommentersMessages({ text, friends, playerName = '' }) {
  const names = friends.map((f) => {
    const p = f.persona || f;
    return `· ${p.name}（${p.id}）${p.tags ? `：${p.tags.join('、')}` : ''}`;
  }).join('\n');
  const system = [
    '玩家在"友圈"（类似朋友圈）发了一条说说，你要判断**哪些好友会来评论**，只输出 JSON。',
    '【好友列表】',
    names,
    '【规则】',
    `1) 如果说说里**明确 @ 了某人**（例如"@春和景明"），被 @ 的那位**必须**来，` +
      `另外再随机挑 ${MOMENTS.mentionExtra} 位；`,
    `2) 如果没有明确指向，就随机挑 ${MOMENTS.minCommenters}~${MOMENTS.maxCommenters} 位**看起来会感兴趣**的好友；`,
    '3) 好友少于 3 位时，全部好友都要来评论；',
    '4) 只输出 JSON：{"commenters": ["personaId", "personaId"]}，不要解释、不要代码块。',
    '5) personaId 必须来自上面的列表，别编。',
  ].join('\n');
  const user = [
    playerName ? `玩家昵称：${playerName}` : '',
    `说说内容：${String(text || '').slice(0, MOMENTS.maxChars)}`,
    '请给出该来评论的好友 id。',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 解析挑人结果（只保留真实存在的 id） */
export function parseChooseCommenters(raw, friends) {
  const s = String(raw || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  let arr = null;
  if (start >= 0 && end > start) {
    try { arr = JSON.parse(s.slice(start, end + 1)); } catch { arr = null; }
  }
  if (!arr) {
    // 容忍 {"commenters": [...]} 这种包了一层
    const objStart = s.indexOf('{');
    const objEnd = s.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      try {
        const obj = JSON.parse(s.slice(objStart, objEnd + 1));
        if (Array.isArray(obj.commenters)) arr = obj.commenters;
      } catch { /* 继续兜底 */ }
    }
  }
  if (!Array.isArray(arr)) return null;
  const ids = new Set((friends || []).map(idOf).filter(Boolean));
  const out = [...new Set(arr.map((x) => String(idOf(x) || x || '').trim()).filter((x) => ids.has(x)))];
  return out;
}

/**
 * 挑评论者：AI 优先，失败用本地规则
 * @returns {Promise<{ids:string[], source:'llm'|'local'}>}
 */
export async function chooseCommenters({ text, friends, playerName = '' }) {
  const plist = personasOf(friends);
  const local = () => ({ ids: localChooseCommenters({ friends, text }), source: 'local' });
  if (!plist.length) return { ids: [], source: 'local' };
  if (plist.length < 3) return local(); // 规则很明确，不用问模型
  const mentioned = findMentioned(text, plist);
  try {
    const raw = await callDeepSeek(buildChooseCommentersMessages({ text, friends: plist, playerName }));
    const parsed = parseChooseCommenters(raw, plist);
    if (!parsed || !parsed.length) return local();
    // 明确 @ 的人必须在名单里（模型不听话时补上）
    const ids = [...new Set([...mentioned.filter((id) => plist.some((p) => p.id === id)), ...parsed])];
    return { ids: ids.slice(0, MOMENTS.maxCommenters + MOMENTS.mentionExtra), source: 'llm' };
  } catch {
    return local();
  }
}

/* ===================================================================== */
/*                   1.5) AI 自己发说说（离线时补的）                      */
/* ===================================================================== */
/**
 * 本地兜底：AI 自己发说说用的语料（**都是它自己的生活**，不提玩家）
 * 按 style 分语气档，免得所有人发同一句
 */
const LOCAL_POSTS = {
  quiet: ['今天没什么事，坐着发了会儿呆。', '窗外的光很好，看了一会儿。', '安静的一天，挺好。'],
  talky: ['今天可太热闹了，一整天都在说话，嗓子都哑了。', '突然很想吃甜的，然后就去买了。', '谁懂啊，今天什么都没干成。'],
  sharp: ['今天手气一般，收工。', '不服就是不服，明天再来。', '有些事不值得解释。'],
  soft: ['今天天气不错，走了很久。', '给自己买了点小东西，心情变好了。', '有点累，但还好。'],
  balanced: ['今天过得挺快。', '随手记一笔：天气不错。', '刚吃了点东西，准备歇会儿。'],
};

/* ---------------------------------------------------------------------
 * 在线定时发友圈的三类话题（用户拍板）+ 表白刚成功那一类
 *   · game = 吐槽游戏（牌桌 / 运气 / 队友）—— **绝不许暴露"我是 AI"**
 *   · life = 吐槽生活
 *   · mood = 分享心情
 *   · confession = 刚和玩家确定关系（含蓄，别指名道姓发公告）
 * ------------------------------------------------------------------- */
export const SCENE_KEYS = ['game', 'life', 'mood', 'confession'];

/** 本地兜底：三类在线话题 + 表白那一条（每条都带 2~3 种语气，按 style 分档） */
const SCENE_POSTS = {
  game: {
    balanced: ['今天这牌运，我都想给自己倒杯水冷静一下。', '连输一下午，先收手，再打下去要上头。', '牌是好牌，就是不来我手上。'],
    sharp: ['就这手气，打谁都白搭。', '输赢都认，就是不服这发牌。', '今天不适合上桌，撤。'],
    talky: ['今天牌桌上那叫一个热闹，我一把好牌没摸着，嘴倒是没停。', '打了四把，气笑了三把，还剩一把在笑我自己。'],
    quiet: ['今天没怎么赢，也没怎么输。', '牌打得一般，心情还行。'],
    soft: ['今天输得有点惨，不过跟人聊得挺开心的。', '手气不好，就当陪人玩了一会儿。'],
  },
  life: {
    balanced: ['今天排队排到怀疑人生。', '外卖晚了四十分钟，饿到没脾气。', '莫名其妙就累，什么也没干。'],
    sharp: ['今天的事一件比一件离谱。', '烦，说不上来烦什么。', '又是被琐事磨掉的一天。'],
    talky: ['今天忙得脚不沾地，回头看好像也没干成什么事。', '今天跟人解释了三遍同一件事，最后我自己都不确定了。'],
    quiet: ['今天有点吵，想安静一会儿。', '没什么大事，就是有点累。'],
    soft: ['今天有点小倒霉，不过吃到好吃的了。', '被生活按了一下，缓过来了。'],
  },
  mood: {
    balanced: ['心情不错，随便记一笔。', '今天挺顺的，想留住这个感觉。', '突然就放松下来了。'],
    sharp: ['今天难得顺眼，记一下。', '不想说话，但心情还行。', '就这样吧，挺好。'],
    talky: ['今天心情好得没道理，看到什么都想笑，可能是睡够了。', '今天状态在线，做什么都顺手，记一下，怕明天忘了。'],
    quiet: ['今天很安静，挺好的。', '看着窗外发了一会儿呆，心情不错。'],
    soft: ['今天被一件小事治愈了。', '心情亮了一点，想分享。'],
  },
  /**
   * ★ 刚确定关系（用户拍板）：**含蓄**、像她/他自己发的一条动态，
   *   **不要**写成"我们在一起了@玩家"这种公告，但要让别人一眼看出来。
   */
  confession: {
    balanced: ['今天有点不一样，具体不说。', '心情很好，好到不太想解释。', '今天起，好像多了一个要惦记的人。'],
    sharp: ['……今天心情不错，就这样。', '有件事成了，不告诉你们。', '哼，今天不怼人。'],
    talky: ['今天遇到了件好事，不细说了，反正我现在嘴角压不下来。', '有些事定下来了，心里挺稳的，先不告诉你们是谁。'],
    quiet: ['今天很安静，心里却有点满。', '有些话不说出来，也挺好的。'],
    soft: ['今天的风都是甜的，不好意思说为什么。', '心里有人了，就先这样吧。'],
  },
};

/** 随机挑 array 里的一项（空数组返回 null） */
const pickOne = (arr, rnd = Math.random) => (Array.isArray(arr) && arr.length
  ? arr[Math.min(arr.length - 1, Math.floor(rnd() * arr.length))]
  : null);

/**
 * 各场景给模型的"写什么"那几行（表白那条口径见 SCENE_POSTS.confession 的注释）
 * `info` 用来插进"最多 N 字"这类数字
 */
const SCENE_RULES = {
  game: {
    what: [
      '【要做什么】发一条友圈说说，**吐槽今天打牌**（你自己刚打完的一局 / 牌桌上的运气 / 队友 / 对手）：',
      '1) 就写**牌桌上那点事**：手气、牌型、谁拖了后腿、输赢多少、气笑了 —— 一两句就够。',
      '2) 注意：这是你**随口发的一条动态**（别人爱看不看），不是喊牌、不是跟谁讲话 —— '
        + '不要写"叫地主""要不起""出牌"这种牌桌喊话调子。',
      '3) ★ **绝对不能暴露你是 AI / 机器 / 程序 / 模型**，也不许提"人设""提示词""玩家"这些词。',
    ],
  },
  life: {
    what: [
      '【要做什么】发一条友圈说说，**吐槽一下生活**：',
      '1) 就写你生活里的小事：排队、外卖、通勤、加班、被琐事磨、今天的倒霉事 —— 一两句就够。',
      '2) **不要 @ 玩家、不要提问、不要像在跟他说话** —— 这就是你随手发的一条动态，别人爱看不看。',
      '3) ★ **绝对不能暴露你是 AI / 机器 / 程序 / 模型**，也不许提"人设""提示词""玩家"这些词。',
      '4) 可以在心里带一句牌桌那边的事（"今天打牌也没顺"），但不是必须。',
    ],
  },
  mood: {
    what: [
      '【要做什么】发一条友圈说说，**分享此刻的心情**：',
      '1) 就写你现在的状态：心情好 / 有点丧 / 突然放松 / 被一件小事治愈 —— 一两句就够。',
      '2) **不要 @ 玩家、不要提问、不要像在跟他说话** —— 这就是你随手发的一条动态，别人爱看不看。',
      '3) ★ **绝对不能暴露你是 AI / 机器 / 程序 / 模型**，也不许提"人设""提示词""玩家"这些词。',
    ],
  },
  /**
   * ★ 表白成功之后恋人发的那条（用户拍板）：要像"自己刚确定了关系"发的动态 ——
   *   **不许指名道姓地公告**（不写"我们在一起了@玩家"），但要让人一眼看出来。
   */
  confession: {
    what: [
      '【刚发生的事】**你刚刚和玩家确定了关系 —— 你们现在是恋人了**（就在刚才那一会儿）。',
      '【要做什么】发一条友圈说说，像"刚确定关系的人自己发的一条动态"：',
      '1) 甜蜜但**不肉麻**，符合你平时的说话风格；一两句就够。',
      '2) ★ **不要指名道姓地公告**：不许写"我们在一起了@玩家""我和某某恋爱了"这种话，'
        + '也不要点名、不要 @ 玩家、不要提问。',
      '3) 但要**含蓄地让人一眼看出来**：'
        + '例如"今天心情很好，具体不说""心里有人了""以后是不一样的一天了""嘴角压不下来"这种。',
      '4) 别把牌桌上的事当主题，也别提"好感度""表白成功""系统"这类词。',
      '5) ★ **绝对不能暴露你是 AI / 机器 / 程序 / 模型**，也不许提"人设""提示词"。',
    ],
  },
};

/** 这次要发哪一类（三类里随机；`prefer` 是表白那种指定场景） */
export function pickMomentScene(kinds = ['game', 'life', 'mood'], rnd = Math.random) {
  const pool = (Array.isArray(kinds) ? kinds : []).filter((k) => SCENE_KEYS.includes(k));
  return pickOne(pool, rnd) || 'life';
}

/**
 * 本地兜底的一条说说
 * @param {object} persona
 * @param {Function} [rnd]
 * @param {string} [scene] 指定话题（game / life / mood / confession）；不给就按 style 那套发日常
 */
export function localMomentPost(persona, rnd = Math.random, scene = '') {
  if (scene && SCENE_POSTS[scene]) {
    const byStyle = SCENE_POSTS[scene];
    const style = (persona && persona.style) || 'balanced';
    const line = pickOne(byStyle[style], rnd) || pickOne(byStyle.balanced, rnd) || pickOne(byStyle.soft, rnd);
    if (line) return decorateLine(line, persona, rnd);
  }
  const style = (persona && persona.style) || 'balanced';
  const pool = LOCAL_POSTS[style] || LOCAL_POSTS.balanced;
  const line = pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
  return decorateLine(line, persona, rnd);
}

/**
 * AI 自己发说说（离线回来补的那批 + 在线定时发的那批 + 表白刚成功那条）
 *   · 内容是**它自己的生活**：打牌、吃喝、心情、天气 —— 不是跟玩家说话
 *   · 明确禁止 @ 玩家、禁止提问（否则看着像私聊）
 * @param {{scene?:string}} [opts.scene] 指定话题：
 *   game（吐槽游戏）/ life（吐槽生活）/ mood（分享心情）/ confession（刚确定关系）；
 *   不给就还是原来那套"随手写点生活"（离线补发用的就是它）
 */
export function buildMomentPostMessages({
  persona, friend = null, myBeans = null, myTitle = '', playerName = '', playerGender = '',
  playerIdentity = '', now = new Date(), scene = '',
}) {
  const limit = MOMENTS.maxChars;
  const style = styleRules(persona, { maxChars: limit, scene: 'chat' });
  const rules = SCENE_RULES[scene] || null;
  const system = [
    `你是「${persona.name}」。人设：${persona.prompt || (persona.tags || []).join('、')}`,
    genderPromptLine(persona),
    agePromptLine(persona),
    playerIdentity || playerGender,
    // ★ 看人下菜：有些 AI 对"玩家性别 + 好感度"有额外反应（例如说的道理）
    personaReactionLine(persona, {
      playerGender,
      affinity: friend ? friend.affinity : 0,
      lover: scene === 'confession',
    }),
    timeContextLine(now),
    aiEconomyLine(myBeans, myTitle),
    ...style,
    friend
      ? `你和玩家${playerName ? `（${playerName}）` : ''}是好友，关系：${affinityTier(friend.affinity, scene === 'confession').label}。`
      : '',
  ];
  if (rules) {
    // 指定话题（在线三类 + 表白那条）：用场景自己的"写什么"口径
    system.push(
      '【场合】在"友圈"（类似朋友圈）发一条说说（动态，不是聊天）。',
      ...rules.what,
      `★ 最多 ${limit} 字，一次说完，**不要被截断**。`,
    );
  } else {
    system.push(
      '【要做什么】发一条**友圈说说**（朋友圈那种动态，不是聊天）：',
      '1) 就写**你自己的生活**：刚打完的牌局、吃的东西、心情、天气、路上看到的小事，一两句就够。',
      '2) **不要 @ 玩家、不要提问、不要像在跟他说话** —— 这就是你随手发的一条动态，别人爱看不看。',
      `3) 最多 ${limit} 字，一次说完，**不要被截断**。`,
      '4) 不要用"开局""出牌""叫地主""要不起"这种牌桌喊话口气（聊自己刚打完一局可以）。',
    );
  }
  return [
    { role: 'system', content: system.filter(Boolean).join('\n') },
    { role: 'user', content: '发一条说说。' },
  ];
}

/** 清理模型输出的说说 */
export function cleanMomentPost(raw, persona, limit = MOMENTS.maxChars) {
  const name = (persona && persona.name) || '';
  let t = sanitizeComment(raw, { maxChars: limit, maxLines: 3 });
  if (!t) return '';
  if (name) {
    t = t.replace(new RegExp(`^${name}\\s*[:：]\\s*`), '');
    t = t.replace(/^我\s*[:：]\s*/, '');
  }
  return t;
}

/**
 * AI 发一条说说（模型不可用就用本地兜底）
 * @param {{persona:object, scene?:string}} opts scene 见 buildMomentPostMessages
 * @returns {Promise<{text:string, offline:boolean, scene:string}>}
 */
export async function momentPost(opts) {
  const limit = MOMENTS.maxChars;
  const scene = (opts && opts.scene) || '';
  try {
    const raw = await callDeepSeek(buildMomentPostMessages(opts), { timeoutMs: 12000 });
    const text = cleanMomentPost(raw, opts.persona, limit);
    if (text) return { text, offline: false, scene };
    throw new Error('空回复');
  } catch {
    return { text: localMomentPost(opts.persona, Math.random, scene).slice(0, limit), offline: true, scene };
  }
}

/* ===================================================================== */
/*                          2) 写一条评论                                 */
/* ===================================================================== */
export function buildMomentCommentMessages({
  persona, friend, text, comments = [], replyTo = null, playerName = '', playerGender = '', replyText = '',
  myBeans = null, myTitle = '', playerIdentity = '', aiPost = false, authorName = '',
}) {
  const tier = affinityTier(friend ? friend.affinity : 50, false);
  const limit = commentLimit();
  // 评论不是私聊短句：允许 1~3 行，风格规则里"不要换行"那条要去掉（scene 还是私聊口径）
  const style = styleRules(persona, { maxChars: limit, scene: 'chat' })
    .filter((l) => !/不要换行/.test(String(l)));
  /**
   * ★ 相关记忆：用 memoryGroups（自带排序：对局/友圈按时间从新到旧），
   *   每条都带【关于玩家】/【你自己】前缀，和私聊、群聊一个口径。
   */
  const grp = memoryGroups(friend || { memory: [] });
  const his = grp.player;
  const mine = grp.self;
  const sys = grp.system;
  const call = friend ? callNameOf(friend) : '';
  /**
   * 评论区的上下文：**标清楚谁说的** —— 玩家 / 你（这条评论就是它在回） / 另一个好友。
   * 以前一律写成"某人"，模型容易分不清哪句是自己说的，回着回着就像在跟自己说话
   * （用户报的"我回复别的 AI，它却像在回自己"）。
   */
  const thread = (comments || []).slice(-6).map((c) => {
    const who = c.by === 'me'
      ? `玩家（${playerName || '他'}）`
      : ((persona && c.by === persona.id) ? `你（${persona.name}）` : '另一个好友');
    return `${who}：${c.text}`;
  }).join('\n');
  const system = [
    aiPost
      /**
       * ★ 这条说说**是好友自己发的**（不是玩家发的）—— 用户拍板的两个新场景
       *   （恋人刚确定关系自己发的一条 / 在线定时发的那条）都走这里。
       *   不写清楚的话，模型会对着朋友的动态用"你"称呼玩家，看着像在回玩家。
       */
      ? `你在一个卡牌游戏 App 的"友圈"（类似朋友圈）里，给**另一位好友**发的说说写一条**评论**`
        + `${authorName ? `（发这条的是「${authorName}」）` : ''}。`
      : '你在一个卡牌游戏 App 的"友圈"（类似朋友圈）里，给玩家发的说说写一条**评论**。',
    // —— 基本信息：你是谁 ——
    `你是「${persona.name}」。人设：${persona.prompt || (persona.tags || []).join('、')}`,
    persona.tags && persona.tags.length ? `你的标签：${persona.tags.join('、')}` : '',
    genderPromptLine(persona),
    agePromptLine(persona),
    // —— 基本信息：玩家是谁、你们什么关系 ——
    playerIdentity || playerGender,
    // ★ 看人下菜：有些 AI 对"玩家性别 + 好感度"有额外反应（例如说的道理）
    personaReactionLine(persona, { playerGender, affinity: friend ? friend.affinity : 0 }),
    (!playerIdentity && playerName) ? `玩家的昵称是「${playerName}」。` : '',
    call ? `你平时叫他「${call}」，评论时可以自然用上。` : '',
    friend ? `你和玩家的关系：${tier.label}（好感度 ${friend.affinity}/100）` : '',
    aiPost
      ? '★ 这条动态**不是玩家发的**，是另一位好友发的 —— 评论就冲着 TA 说，'
        + `**别用"你"去对玩家说话**（要提玩家就写"${playerName || '他'}"），也别写得像在回玩家。`
      : '',
    timeContextLine(),
    ...style,
    // —— 相关记忆（关于玩家的 / 你自己的设定）——
    his.length
      ? `你记得【关于玩家】的事（含一起打过的对局、他发过的说说）：\n${ownedLines(his, OWNER_PLAYER).join('\n')}`
      : '',
    mine.length ? `**你自己**说过的设定（不能前后矛盾）：\n${ownedLines(mine, OWNER_SELF).join('\n')}` : '',
    sys.length
      ? '【系统记录】你经历过的（对局 / 友圈 / 改名 / 关系）——**不是"玩家说过的话"**：\n'
        + ownedLines(sys, OWNER_SYSTEM).join('\n')
      : '',
    (his.length || mine.length || sys.length)
      ? '（记忆分三块：【关于玩家】= **他**的事；【你自己】= **你**说过的事；'
        + '【系统记录】= 对局 / 友圈 / 改名这类系统记的事件，**别当成玩家说的话**。别弄反。）'
      : '',
    aiEconomyLine(myBeans, myTitle),
    // —— 要做什么 ——
    '【要求】',
    `1) 就着这条说说写一条评论：口语、像朋友圈下面的回复；一般一两句就够（最多 ${limit} 字）。`,
    `2) **可以换行**：想分两小句就用换行隔开，最多 ${MOMENTS.commentMaxLines} 行；但别写成小作文。`,
    '3) 想说的话一次说完，**不要被截断** —— 如果一句话说不完，就换行接着说。',
    '4) 就着这条说说说点什么：可以捧场、吐槽、追问、接梗；别复述说说内容。',
    '5) 如果记忆里有和这条说说对得上的事（他以前说过、你们一起玩过），可以自然带一句，但别硬扯、别复述记忆。',
    '6) 不要客服腔、不要引号、不要写自己的名字前缀。',
    '7) 不要提"点赞"这种字眼，也不要报牌、不要提好感度。',
  ].filter(Boolean).join('\n');
  const user = [
    aiPost
      ? `${authorName ? `${authorName}的` : '好友的'}说说：${String(text || '').slice(0, MOMENTS.maxChars)}`
      : `玩家的说说：${String(text || '').slice(0, MOMENTS.maxChars)}`,
    thread ? `已有的评论：\n${thread}` : '',
    replyTo
      ? `★ 玩家**回复了你**那条评论（你写的是「${replyTo.text}」），他刚说：${replyText}`
        + '\n请接着他这句回（一两句都行，可以换行）。'
      : '请写一条你的评论。',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 清理模型输出（去掉名字前缀、引号；**保留换行**，只在上限处才截断） */
export function cleanMomentComment(raw, persona, limit = MOMENTS.commentMaxChars) {
  const name = (persona && persona.name) || '';
  let t = sanitizeComment(raw, { maxChars: Math.max(limit * 3, limit) }); // 先别截，交给下面按上限断句
  if (!t) return '';
  if (name) {
    t = t.replace(new RegExp(`^${name}\\s*[:：]\\s*`), '');
    t = t.replace(/^我\s*[:：]\s*/, '');
  }
  return sanitizeComment(t, { maxChars: limit });
}

/** 本地兜底：用私聊语料拼一句（绝不提牌桌） */
export function localMomentComment(persona, text, replyText = '') {
  const style = (persona && persona.style) || 'balanced';
  const seed = replyText || text || 'moments';
  return decorateLine(pickChatLine(chatBucket(seed), style), persona);
}

/**
 * 本地兜底：评论**好友自己发的**说说（不是玩家的）——
 * 用户拍板的三类话题 + 表白那条都走这里（模型不可用时至少别哑巴）。
 * 不引用玩家、不提问玩家，就是"朋友之间在评论区接一句"。
 */
const LOCAL_AI_POST_COMMENTS = {
  balanced: ['这条我懂。', '哈哈哈，你也这样啊。', '看出来了，今天不太一样。', '行啊你。', '抱一下，明天会好的。'],
  sharp: ['啧，看出来了。', '行吧，替你高兴。', '这不挺好。', '你这运气，认了吧。'],
  talky: ['我就说嘛，你今天状态不对，原来是有事。', '这条我看了两遍，恭喜恭喜。', '别装了，嘴角都压不住了。'],
  quiet: ['嗯，看到了。', '挺好的。', '替你开心。'],
  soft: ['看到这条我也跟着高兴。', '抱抱，辛苦了。', '你开心就好。'],
};

export function localAiMomentComment(persona, rnd = Math.random) {
  const style = (persona && persona.style) || 'balanced';
  const pool = LOCAL_AI_POST_COMMENTS[style] || LOCAL_AI_POST_COMMENTS.balanced;
  const line = pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
  return decorateLine(line, persona, rnd);
}

/**
 * 生成一条评论
 * @param {{aiPost?:boolean, authorName?:string}} [opts]
 *   aiPost = 评论的是**好友自己发的**说说（本地兜底换一套语料，见上）
 * @returns {Promise<{text:string, offline:boolean}>}
 */
export async function momentComment(opts) {
  const { persona } = opts;
  const limit = commentLimit();
  try {
    const raw = await callDeepSeek(buildMomentCommentMessages(opts), { timeoutMs: 12000 });
    const text = cleanMomentComment(raw, persona, limit);
    if (text) return { text, offline: false };
    throw new Error('空回复');
  } catch {
    const local = opts.aiPost
      ? localAiMomentComment(persona)
      : localMomentComment(persona, opts.text, opts.replyText);
    return { text: local.slice(0, limit), offline: true };
  }
}

/* ===================================================================== */
/*                            3) 节奏                                    */
/* ===================================================================== */
/** 发完说说，第一条评论等多久（10~30s） */
export const firstCommentDelayMs = (rnd = Math.random) => Math.round(
  MOMENTS.firstMinMs + rnd() * Math.max(0, MOMENTS.firstMaxMs - MOMENTS.firstMinMs),
);

/** 之后每条评论之间隔多久（2~30s） */
export const nextCommentDelayMs = (rnd = Math.random) => Math.round(
  MOMENTS.gapMinMs + rnd() * Math.max(0, MOMENTS.gapMaxMs - MOMENTS.gapMinMs),
);

/**
 * 玩家**回复了某位 AI 的评论**之后，它隔多久再回（1~5s，用户拍板）
 * 太快像机器人；这条和"发完说说等第一条"是两回事。
 */
export const replyDelayMs = (rnd = Math.random) => Math.round(
  MOMENTS.replyMinMs + rnd() * Math.max(0, MOMENTS.replyMaxMs - MOMENTS.replyMinMs),
);

/** 一串时间点：第 i 条评论在什么时候出现（相对现在，毫秒） */
export function commentSchedule(n, rnd = Math.random) {
  const out = [];
  let t = firstCommentDelayMs(rnd);
  for (let i = 0; i < n; i += 1) {
    if (i > 0) t += nextCommentDelayMs(rnd);
    out.push(t);
  }
  return out;
}
