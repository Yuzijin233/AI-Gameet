/**
 * AI 记忆的"本地文件"版本（PRD §2.12 的落地补充）
 *
 * 记忆平时存在浏览器 localStorage 里（一个 JSON 字符串），人肉翻起来很痛苦。
 * 这里把存档里的记忆整理成**人能直接读的 Markdown** + **好处理的 JSON**，
 * 由本地服务每次收到存档就重新生成一份，落在项目根的 `save/` 目录里：
 *
 *   save/ddz_save.json   —— 完整存档（原始数据，可备份 / 可手改）
 *   save/AI记忆.md       —— 每个好友的记忆清单（直接打开看）
 *   save/AI记忆.json     —— 只有记忆部分（好 diff / 好搜索）
 *
 * 本文件是**纯函数**：不碰 DOM、不碰 fs、不联网，服务端与测试共用。
 */
import { MEMORY_CATEGORIES, categoryOf, SELF_PREFIX, isSystemMemory } from './memory.js';

const CAT_BY_KEY = new Map(MEMORY_CATEGORIES.map((c) => [c.key, c]));

/**
 * 名字来源：优先用传进来的 persona 列表，找不到就退回 id。
 * ★ AI 改过名的话（save.aiNames）以**改过的名字**为准 —— 这个文件是给玩家读的，
 *   服务端进程不会跑 app 的启动流程，所以这里得自己看一眼存档。
 */
function makeNameOf(personas, save = null) {
  const byId = new Map((personas || []).map((p) => [p.id, p]));
  const custom = (save && save.aiNames) || {};
  return (personaId) => {
    const rec = custom[personaId];
    if (rec && typeof rec === 'object' && rec.name) return rec.name;
    if (typeof rec === 'string' && rec) return rec;
    const p = byId.get(personaId);
    return p ? p.name : String(personaId || '未知');
  };
}

/**
 * 一条记忆 → { icon, label, text, owner }
 * owner：`对玩家` / `自设` —— **每条都写清楚是谁的**，而且**归属写在分类前面**
 * （`- 🏷️ **对玩家 · 称呼**：小徐`），这样"称呼 / 身份 / 习惯"这类分类
 * 一眼就知道说的是玩家还是 AI 自己，不会再读串（用户拍板）。
 */
export function tagMemory(line) {
  const raw = String(line == null ? '' : line);
  if (raw.startsWith(SELF_PREFIX)) {
    const body = raw.slice(SELF_PREFIX.length);
    const eq = body.indexOf('=');
    return {
      icon: '🧬',
      label: '自设',
      owner: '自设',
      system: false,
      aspect: eq > 0 ? body.slice(0, eq) : '',
      text: eq > 0 ? body.slice(eq + 1) : body,
    };
  }
  const cat = categoryOf(raw);
  const hit = cat ? CAT_BY_KEY.get(cat.key) : null;
  const label = hit ? hit.label : '其他';
  // 记忆本身就长这样「称呼：阿伟」—— 标签已经写在前面了，正文里就别再重复一次
  const text = label !== '其他' && raw.startsWith(`${label}：`) ? raw.slice(label.length + 1) : raw;
  const system = isSystemMemory(raw);
  return {
    icon: hit ? hit.icon : '📌',
    label,
    owner: system ? '其他' : '对玩家',
    system,
    aspect: '',
    text,
  };
}

/** 显示用的归属标签：`对玩家 · 称呼` / `自设 · 作息` */
export function tagLabelOf(m) {
  if (m.label === '自设') return m.aspect ? `自设 · ${m.aspect}` : '自设';
  return `对玩家 · ${m.label}`;
}

/**
 * 记忆文件的**格式版本**：改一次格式就 +1。
 * 为什么写进文件里：本地服务是**常驻进程**，改了代码不重启它，它还会用旧代码重写这个文件
 * —— 文件里带上版本号，一眼就能看出"是不是还在用旧的"。
 */
export const DIGEST_FORMAT = 'blocks-v2';

/** 好友的一条记录（给 JSON 和 Markdown 共用，保证两边口径一致） */
export function friendRecord(friend, nameOf, { lover = false } = {}) {
  const memory = Array.isArray(friend && friend.memory) ? friend.memory.filter(Boolean) : [];
  const tagged = memory.map((line) => ({ raw: line, ...tagMemory(line) }));
  /** ★ 分三块（用户要求）：自设 / 玩家 / 其他（系统记录）—— 写入和读取用同一套划分 */
  const blocks = {
    self: tagged.filter((m) => m.label === '自设').map((m) => m.raw),
    player: tagged.filter((m) => m.label !== '自设' && !m.system).map((m) => m.raw),
    system: tagged.filter((m) => m.label !== '自设' && m.system).map((m) => m.raw),
  };
  return {
    personaId: friend && friend.personaId,
    name: nameOf(friend && friend.personaId),
    affinity: Number(friend && friend.affinity) || 0,
    lover: !!lover,
    isLover: !!lover,
    memoryCount: memory.length,
    memory: tagged,
    blocks,
    blockCount: { self: blocks.self.length, player: blocks.player.length, system: blocks.system.length },
    chatCount: Array.isArray(friend && friend.chat) ? friend.chat.length : 0,
  };
}

/**
 * 记忆部分的 JSON（只有记忆，不含豆子之类的无关字段）
 * @returns {{generatedAt:string, friendCount:number, memoryCount:number, friends:object[], recentHands:object[]}}
 */
export function memoryJson(save, { personas = [], now = new Date() } = {}) {
  const nameOf = makeNameOf(personas, save);
  const friends = (Array.isArray(save && save.friends) ? save.friends : [])
    .filter(Boolean)
    .map((f) => friendRecord(f, nameOf, { lover: save && save.loverId === f.personaId }));
  return {
    format: DIGEST_FORMAT,
    generatedAt: now.toISOString(),
    friendCount: friends.length,
    memoryCount: friends.reduce((n, f) => n + f.memoryCount, 0),
    friends,
    recentHands: (Array.isArray(save && save.recentHands) ? save.recentHands : []).map((h) => ({
      kind: h && h.kind, roomId: h && h.roomId, at: h && h.at,
      humanWin: h && h.humanWin, summary: h && h.summary,
    })),
  };
}

/**
 * 记忆部分的 Markdown（给人读的）
 * @param {object} save 存档
 * @param {{personas?:object[], now?:Date}} opts
 */
export function memoryDigest(save, { personas = [], now = new Date() } = {}) {
  const nameOf = makeNameOf(personas, save);
  const data = memoryJson(save, { personas, now });
  const L = [];
  L.push('# AI 记忆（自动生成）');
  L.push('');
  L.push(`生成时间：${now.toLocaleString('zh-CN')}　格式：${DIGEST_FORMAT}（自设 / 玩家 / 其他 分块）`);
  L.push('');
  L.push(`玩家：${(save && save.nickname) || '（没设名字）'}`
    + `${save && save.gender === 'female' ? '（女）' : '（男）'}`);
  L.push('');
  L.push(`好友 ${data.friendCount} 位 · 共 ${data.memoryCount} 条记忆`
    + '（这个文件每次存档都会重写，手改请改 save/ddz_save.json）');
  L.push('');
  L.push('> 每位好友的记忆**分三块**：**自设**（我自己的设定）、**玩家**（关于玩家的事）、'
    + '**其他**（系统记的：对局 / 友圈 / 改名 / 关系）。三块分开写，就不会把"我自己的设定"'
    + '读成"玩家的事"，也不会把「友圈：说说…｜我评论…」当成玩家说过的话。');
  L.push('');
  L.push('> 存储格式也是照这个来的：`自设：方面=内容` = 它自己；`分类：内容` = 玩家；'
    + '`对局：` `友圈：` `改名：` `关系：` = 系统记录。');
  L.push('');
  L.push('> ⚠️ 这个文件由本地服务生成。**改了代码要重启服务**（关掉 start.bat 的黑窗口再开一次），'
    + `否则还会用旧格式重写；文件头「格式：${DIGEST_FORMAT}」就是用来确认这件事的。`);
  L.push('');

  if (!data.friends.length) {
    L.push('> 还没有好友，所以还没有任何 AI 记忆。加了好友、聊过天之后这里就会有内容。');
    L.push('');
  }

  for (const f of data.friends) {
    L.push('---');
    L.push('');
    L.push(`## ${f.name}（${f.personaId}）`);
    L.push('');
    L.push(`- 好感度：${f.affinity}/100${f.lover ? ' · 💞 恋人' : ''}`);
    L.push(`- 记忆：${f.memoryCount} 条 · 聊天记录 ${f.chatCount} 条`);
    L.push('');
    if (!f.memoryCount) {
      L.push('（还没有记忆：只有私聊里说过的稳定信息、以及一起打过的对局才会被记下来）');
      L.push('');
      continue;
    }
    /**
     * ★ 分三块写（用户要求）：自设 / 玩家 / 其他（系统记录）。
     *   以前平铺一列，`友圈：…我评论…` 这种"既有玩家又有它自己"的行会被当成玩家的话，
     *   `自设：午饭=…` 也容易和玩家的「偏好」混在一起（用户报的"还是没法区分"）。
     */
    for (const [title, list] of [
      ['自设（我自己的设定）', f.memory.filter((m) => m.label === '自设')],
      ['玩家（关于玩家的事）', f.memory.filter((m) => m.label !== '自设' && !m.system)],
      ['其他（系统记的：对局 / 友圈 / 改名 / 关系）', f.memory.filter((m) => m.label !== '自设' && m.system)],
    ]) {
      if (!list.length) continue;
      L.push(`**${title}**`);
      for (const m of list) {
        // 块标题已经说明归属，行内只留"分类 / 方面"
        const tag = m.label === '自设' ? (m.aspect || '自设') : m.label;
        L.push(`- ${m.icon} **${tag}**：${m.text}`);
      }
      L.push('');
    }
  }

  if (data.recentHands.length) {
    L.push('---');
    L.push('');
    L.push('## 最近几局（AI 聊天时会回忆这个）');
    L.push('');
    for (const h of data.recentHands) {
      const when = h.at ? new Date(h.at).toLocaleString('zh-CN') : '';
      L.push(`- ${when}　${h.summary || ''}`);
    }
    L.push('');
  }

  // 群聊：消息本体也在存档里，这里只列"有哪些群、多少人、最后说过什么"
  const groups = Array.isArray(save && save.groups) ? save.groups.filter(Boolean) : [];
  if (groups.length) {
    L.push('---');
    L.push('');
    L.push('## 群聊');
    L.push('');
    for (const g of groups) {
      const chat = Array.isArray(g.chat) ? g.chat : [];
      L.push(`### ${g.name}（${(Array.isArray(g.members) ? g.members.length : 0) + 1} 人 · ${chat.length} 条）`);
      L.push('');
      for (const m of chat.slice(-3)) {
        const who = m.role === 'me' ? ((save && save.nickname) || '玩家') : nameOf(m.by);
        L.push(`- ${who}：${m.text}`);
      }
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push('> 记忆只在**私聊**里沉淀（群聊、房间弹幕只读不写）；友圈的说说与你的评论由系统额外记最近 2 条；'
    + '每条记忆按分类来，称呼/性格/身份这类同类只保留最新一条。');
  L.push('');
  return L.join('\n');
}
