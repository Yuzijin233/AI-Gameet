/**
 * AI 改名（用户拍板的功能）
 *
 * 规则：
 *   · 只有**私聊里明确聊到改名、而且它自己那句话里答应了**，才会真改
 *     （审查那一步额外判一次，见 ai/friend.js 的 rename 字段 + guardRename）
 *   · 名字**不超过 RENAME.maxChars（8）个字**；不能是玩家的昵称（会乱）
 *   · 改完写一条记忆：`改名：旧名→新名`；再改就接着写 `旧名→新名，又改名更新的名`
 *   · **重置存档 → 名字回到人设里的默认名**（自定义只存在 `save.aiNames` 里）
 *
 * 名字怎么"生效"：`PERSONAS` 是人名的唯一真相源（界面、提示词、群聊、牌桌全都读它），
 * 所以这里在启动时把 `save.aiNames` **贴回 PERSONAS**（`applyAiNames`），
 * 而不是去改几十处取值的地方。人设原文（prompt）里那句自称也一起换掉，
 * 免得它一边叫新名字、一边在提示词里自称旧名字。
 */
import { PERSONAS } from '../data/personas.js';
import { RENAME } from '../config.js';

/**
 * 人设里的"出厂名"与"出厂人设"。
 * 必须在任何改名发生**之前**拍下快照（模块第一次用到时拍，之后一直用它来还原）。
 */
let BASE = null;
function base() {
  if (!BASE) {
    BASE = new Map(PERSONAS.map((p) => [p.id, { name: p.name, prompt: p.prompt || '' }]));
  }
  return BASE;
}

/** 出厂名（重置 / 没改过名时用这个） */
export function defaultNameOf(personaId) {
  const b = base().get(personaId);
  return b ? b.name : String(personaId || '');
}

/** 存档里的自定义名字表：`{ [personaId]: { name, history:[出厂名, …] } }` */
export function ensureAiNames(save) {
  if (!save || typeof save !== 'object') return {};
  if (!save.aiNames || typeof save.aiNames !== 'object' || Array.isArray(save.aiNames)) save.aiNames = {};
  for (const [id, v] of Object.entries(save.aiNames)) {
    if (typeof v === 'string') {
      // 兼容"直接存字符串"的写法 → 补成结构
      save.aiNames[id] = { name: v, history: [defaultNameOf(id), v] };
    } else if (!v || typeof v !== 'object') {
      delete save.aiNames[id];
    } else {
      if (typeof v.name !== 'string' || !v.name) { delete save.aiNames[id]; continue; }
      if (!Array.isArray(v.history) || !v.history.length) v.history = [defaultNameOf(id), v.name];
    }
  }
  return save.aiNames;
}

/**
 * 把玩家/AI 起的新名字洗干净：
 *   · 去掉引号、书名号、句末标点、空白与换行（名字就一行）
 *   · 去掉开头的"叫 / 你就叫 / 名字是"这类废话
 *   · **不截断**（超长的名字由 nameIsUsable 直接拒掉，截一半更奇怪）
 * @returns {string} 洗不干净（空的）就返回空串
 */
export function cleanAiName(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/^["'「『《]+|["'」』》]+$/g, '')
    .replace(/^(?:你|我)?(?:以后|就|从此)?(?:叫|叫做|名字(?:是|叫)|改(?:名叫|名为|成|为))\s*/, '')
    .replace(/[。！？，、；：.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** 这个名字能不能用（长度、是不是空、是不是玩家自己的名字） */
export function nameIsUsable(name, { playerName = '', currentName = '' } = {}) {
  const n = cleanAiName(name);
  if (!n) return { ok: false, reason: 'empty' };
  if ([...n].length > RENAME.maxChars) return { ok: false, reason: 'too-long' };
  if (playerName && n === cleanAiName(playerName)) return { ok: false, reason: 'same-as-player' };
  if (currentName && n === currentName) return { ok: false, reason: 'same-as-now' };
  return { ok: true, name: n };
}

/** 这个 AI 现在叫什么（没改过就是出厂名） */
export function aiNameOf(save, personaId) {
  const rec = ensureAiNames(save)[personaId];
  return (rec && rec.name) || defaultNameOf(personaId);
}

/** 某人设现在显示的名字（对象或 id 都行） */
export function displayNameOf(save, personaOrId) {
  const id = typeof personaOrId === 'string' ? personaOrId : (personaOrId && personaOrId.id);
  return aiNameOf(save, id);
}

/** 改名历史（出厂名 → … → 现在）：记忆里那句"改名：…"就按它生成 */
export function renameHistoryOf(save, personaId) {
  const rec = ensureAiNames(save)[personaId];
  if (!rec) return [defaultNameOf(personaId)];
  const h = Array.isArray(rec.history) ? rec.history.filter(Boolean) : [];
  return h.length ? h : [defaultNameOf(personaId), rec.name];
}

/**
 * 记忆里那条改名记录：`改名：旧名→新名，又改名更新的名`
 * 只改过一次就写成 `改名：旧名→新名`。
 */
export function renameMemoryLine(save, personaId) {
  const h = renameHistoryOf(save, personaId).slice(-(RENAME.maxHistory + 1));
  if (h.length < 2) return '';
  const first = `${h[0]}→${h[1]}`;
  const more = h.slice(2).map((n) => `又改名${n}`).join('，');
  return `改名：${first}${more ? `，${more}` : ''}`;
}

/**
 * 把存档里的自定义名字贴回 PERSONAS（启动、改名后、重置后都要调）
 * @returns {number} 有几个人的名字不是出厂名
 */
export function applyAiNames(save) {
  const table = ensureAiNames(save);
  let n = 0;
  for (const p of PERSONAS) {
    const b = base().get(p.id) || { name: p.name, prompt: p.prompt || '' };
    const rec = table[p.id];
    const name = (rec && rec.name) || b.name;
    if (rec && rec.name) n += 1;
    p.name = name;
    // 人设里那句自称（「你是X，…」）跟着换；出厂人设原文一直留着，能还原
    p.prompt = b.prompt.replace(/^你是[^，,]{1,12}(?=[，,])/, `你是${name}`);
  }
  return n;
}

/**
 * 记一次改名（**只改数据**，不写记忆 —— 记忆由 store/friends.js 的 addRenameMemory 写）
 * @returns {{ok:boolean, reason?:string, from?:string, to?:string}}
 */
export function renameAi(save, personaId, newName, { playerName = '', at = Date.now() } = {}) {
  const table = ensureAiNames(save);
  const from = aiNameOf(save, personaId);
  const check = nameIsUsable(newName, { playerName, currentName: from });
  if (!check.ok) return { ok: false, reason: check.reason };
  const rec = table[personaId] || { name: from, history: [defaultNameOf(personaId)] };
  // 历史 = 出厂名 → … → 现在这个名字 → 新名字（不重复记同一个名字）
  const history = Array.isArray(rec.history) && rec.history.length
    ? [...rec.history]
    : [defaultNameOf(personaId)];
  if (history[history.length - 1] !== from) history.push(from);
  history.push(check.name);
  table[personaId] = { name: check.name, history: history.slice(-(RENAME.maxHistory + 1)), at };
  applyAiNames(save);
  return { ok: true, from, to: check.name };
}

/** 重置：清掉所有自定义名字，名字回到人设默认（重置存档会走 defaultSave，这里是二次保险） */
export function resetAiNames(save) {
  if (save && typeof save === 'object') save.aiNames = {};
  applyAiNames(save || {});
  return true;
}
