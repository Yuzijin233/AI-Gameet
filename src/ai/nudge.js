/**
 * 拍一拍（用户拍板 · 双击头像触发）
 * =====================================================================
 * 三件事，都收在这一个文件里（私聊 / 群聊共用同一份口径）：
 *   1) **文案**：`nudgeLineOf()` 从 data/nudgeLines.js 取"你拍了拍「XX」的…"，
 *      30 套人设一人一句；没覆盖到的人设用通用兜底（以后加人设也不会开天窗）。
 *   2) **节流**：同一个人 `NUDGE.cooldownMs` 内重复拍只生效一次
 *      （双击本来就快，很容易连点；这也防刷屏）。
 *   3) **回一句**：被拍的 AI 回一句符合性格的短话（≤18 字）——
 *      模型优先（走 ai/chat.js 的 callDeepSeek，和所有台词同一个通道），
 *      失败 / 没 Key / 断网 → 用 data/nudgeLines.js 里按风格分池的本地兜底。
 *
 * 为什么单独一个文件：私聊（ui/friends.js）和群聊（ui/groups.js）都要用，
 * 两边的 UI 结构差别很大，但**提示语、节流、兜底**必须是同一套，否则会走形。
 */
import { NUDGE } from '../config.js';
import { callDeepSeek } from './chat.js';
import { genderPromptLine, agePromptLine } from '../data/personas.js';
import { styleRules, maxReplyCharsOf } from '../data/style.js';
import { timeContextLine } from '../data/clock.js';
import { nudgeLineOf, pickFallbackNudgeReply } from '../data/nudgeLines.js';

function sanitize(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
}

/* ------------------------------------------------------------------ */
/* ① 提示语                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成"你拍了拍「XX」的…"
 * @param {{personaId:string, name?:string}} p name 没给就用 personaId 兜底
 */
export function buildNudgeLine(personaId, name = '') {
  return nudgeLineOf(personaId, name || personaId);
}

/* ------------------------------------------------------------------ */
/* ② 节流                                                             */
/* ------------------------------------------------------------------ */
/**
 * 拍一拍节流：**同一个人**在 `NUDGE.cooldownMs` 内只生效一次。
 *
 * 状态挂在传进来的 Map 上（调用方一般用 `app.nudgeAt`），所以：
 *   · 不写存档（拍一拍不是需要跨设备的进度，也不该把存档搞脏）
 *   · 关掉面板再打开也还在（挂在 app 上，不是面板闭包里）
 *
 * @param {Map<string, number>} storeMap 形如 `Map(personaId -> 上次生效的时刻)`
 * @param {string} personaId
 * @param {number} [now]
 * @returns {boolean} true = 放行（真的拍到了）；false = 太频繁，这一下不生效
 */
export function allowNudge(storeMap, personaId, now = Date.now()) {
  if (!storeMap || !personaId) return false;
  const last = Number(storeMap.get(personaId)) || 0;
  if (last && now - last < NUDGE.cooldownMs) return false;
  storeMap.set(personaId, now);
  return true;
}

/** 上一次拍成功是什么时候（0 = 没拍过；界面要显示冷却提示时用） */
export function lastNudgeAt(storeMap, personaId) {
  if (!storeMap || !personaId) return 0;
  return Number(storeMap.get(personaId)) || 0;
}

/**
 * 取这个 app 的节流表；没有就地补一个。
 * ★ 容错：旧对象 / 测试里的假 app 可能没有 `nudgeAt` —— 顺手补上，
 *   免得"拍一拍"一点就 TypeError（这类错误只有真跑才看得出来）。
 */
export function ensureNudgeStore(app) {
  if (!app) return new Map();
  if (!(app.nudgeAt instanceof Map)) app.nudgeAt = new Map();
  return app.nudgeAt;
}

/* ------------------------------------------------------------------ */
/* ③ 回一句                                                           */
/* ------------------------------------------------------------------ */
/**
 * 被拍之后的专用提示词。
 *
 * ★ 刻意写得**很短**：这只是一次"被戳了一下"的反应，不需要塞满记忆 / 对局 / 好感度那套
 *   （那些是正常私聊的事）。人设 + 说话风格 + 场景三句话就够了，出话快、也便宜。
 */
export function buildNudgeReplyMessages({ persona, nudgeLine = '', myTitle = '' }) {
  const limit = Math.min(NUDGE.maxChars, maxReplyCharsOf(persona, NUDGE.maxChars));
  const system = [
    '你在一个卡牌游戏 App（Gameet）里，扮演玩家的好友。',
    `你是「${persona.name}」。你的人设：${persona.prompt || (persona.tags || []).join('、')}`,
    genderPromptLine(persona),
    agePromptLine(persona),
    ...styleRules(persona, { maxChars: limit, scene: 'chat' }),
    timeContextLine(),
    myTitle ? `你戴着称号「${myTitle}」（背景知识，别拿它当话题）。` : '',
    '【刚刚发生了什么】玩家在聊天里**双击了你的头像** —— 这是这个 App 里的"拍一拍"，'
      + `相当于伸手戳了你一下。${nudgeLine ? `你这边看到的提示是：「${nudgeLine}」。` : ''}`,
    '【要求】',
    `1) 只回**一句**，${limit} 个字以内，像真人被拍了一下的即时反应（回头看、咦一声、吐槽他、笑着应一声都行）。`,
    '2) 必须保持你的人设语气：话少的人就一两个字，话痨可以多说半句，冷淡的就冷淡。',
    '3) 不要解释"拍一拍"是什么、不要说"我是AI"、不要客服腔、不要引号、不要换行、不要颜文字堆砌。',
    '4) 不要反问"你是谁"这类出戏的话 —— 你**一直知道**他是谁。',
  ].filter(Boolean).join('\n');
  const user = '他刚拍了我一下，回他一句。';
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 被拍之后回一句：模型优先，失败走本地兜底（**一定**会有一句话，不会开天窗）
 * @param {{persona:object, nudgeLine?:string, myTitle?:string}} p
 * @returns {Promise<{text:string, source:'llm'|'fallback'}>}
 */
export async function nudgeReply({ persona, nudgeLine = '', myTitle = '' }) {
  if (!persona) return { text: '', source: 'fallback' };
  const limit = Math.min(NUDGE.maxChars, maxReplyCharsOf(persona, NUDGE.maxChars));
  try {
    const raw = await callDeepSeek(buildNudgeReplyMessages({ persona, nudgeLine, myTitle }));
    const text = sanitize(raw).slice(0, limit);
    if (!text) throw new Error('空回复');
    return { text, source: 'llm' };
  } catch {
    return { text: pickFallbackNudgeReply(persona).slice(0, limit), source: 'fallback' };
  }
}
