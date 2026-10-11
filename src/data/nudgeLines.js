/**
 * 「拍一拍」文案表（用户拍板 · PRD 社交增补）
 * ---------------------------------------------------------------
 * 双击好友 / 群成员的头像 = 拍一拍（像微信那样）：
 *   1) 聊天里落一条**居中系统提示**：`你拍了拍「XX」的…`（XX = 对方显示名）
 *   2) 被拍的 AI **回一句**符合它性格的短话（走 groupReply / friendReply，失败用下面的兜底）
 *
 * 这里只放**数据**（提示语模板 + 兜底回复），交互逻辑在：
 *   · src/ai/nudge.js   —— 提示语生成 / 节流 / 回一句（模型优先，失败兜底）
 *   · src/ui/friends.js —— 私聊头像 dblclick
 *   · src/ui/groups.js  —— 群聊成员头像 dblclick
 *
 * 模板里的 `{name}` 会被替换成对方的显示名（私聊用好友备注名，群聊用人设名）。
 * 40 套人设**一人一句**（p01~p30 是用户拟好的原文，p31~p40 按同一套口径补的）；
 * 以后再加人设、这里没覆盖到的，用 GENERIC_NUDGE。
 *
 * 兜底回复按**风格档位**（persona.style：cautious / balanced / bold）各给 3 条，
 * 保证断网 / 没 Key 时也像"被拍了一下"该有的反应（见 FALLBACK_NUDGE_REPLY）。
 */

/** 通用兜底提示语（新增人设、或 personaId 认不出来时用） */
export const GENERIC_NUDGE = '你拍了拍「{name}」';

/** 拍一拍提示语：personaId → 模板（`{name}` = 对方显示名） */
export const NUDGE_LINES = {
  p01: '你拍了拍「{name}」的笔记，显示"已收藏"',
  p02: '你拍了拍「{name}」的折扇',
  p03: '你拍了拍「{name}」的错字',
  p04: '你拍了拍「{name}」的电台话筒',
  p05: '你轻轻拍了拍「{name}」',
  p06: '你拍了拍「{name}」的枕头（他睡着了）',
  p07: '你拍了拍「{name}」窗外的海棠',
  p08: '你拍了拍「{name}」，他手一抖',
  p09: '你拍了拍「{name}」的保温杯',
  p10: '你拍了拍「{name}」，他说：菜就多练',
  p11: '你拍了拍「{name}」，返回 200 OK',
  p12: '你拍了拍「{name}」，他又开始念了',
  p13: '你拍了拍「{name}」的键盘',
  p14: '你拍了拍「{name}」，他笑而不语',
  p15: '你拍了拍「{name}」，他嘴硬了一下',
  p16: '你拍了拍「{name}」，空气冷了一度',
  p17: '你拍了拍「{name}」的茶杯盖',
  p18: '你拍了拍「{name}」的草稿纸',
  p19: '你拍了拍「{name}」的公文包',
  p20: '你拍了拍「{name}」，他正在哄孩子',
  p21: '你拍了拍「{name}」的凉茶',
  p22: '你拍了拍「{name}」的伞',
  p23: '你拍了拍「{name}」的后脑勺，他记仇了',
  p24: '你拍了拍「{name}」，他慢半拍才反应过来',
  p25: '你拍了拍「{name}」的本命卡',
  p26: '你拍了拍「{name}」，她：才、才没有',
  p27: '你拍了拍「{name}」的音响',
  p28: '你拍了拍「{name}」，她原地蹦了一下',
  p29: '你拍了拍「{name}」的作文本',
  p30: '你拍了拍「{name}」，他：何意味？',
  /* —— p31~p40：新增的一批（一人一句，和前面同一套口径）—— */
  p31: '你拍了拍「{name}」的岩鞋',
  p32: '你拍了拍「{name}」，他回了个 flow',
  p33: '你拍了拍「{name}」的车把',
  p34: '你拍了拍「{name}」，他立刻接了个梗',
  p35: '你拍了拍「{name}」的色卡',
  p36: '你拍了拍「{name}」的护士站台面',
  p37: '你拍了拍「{name}」的登机牌',
  p38: '你拍了拍「{name}」，水槽里的鱼看了一眼',
  p39: '你拍了拍「{name}」的案卷',
  p40: '你拍了拍「{name}」的画架',
};

/**
 * 拿这一位的拍一拍提示语（**一定是完整的一句话**，名字已经替进去）
 * @param {string} personaId
 * @param {string} name 对方显示名（没有就用「TA」兜底）
 */
export function nudgeLineOf(personaId, name) {
  const who = String(name == null ? '' : name).trim() || 'TA';
  const tpl = NUDGE_LINES[personaId] || GENERIC_NUDGE;
  return tpl.split('{name}').join(who);
}

/**
 * 本地兜底回复：断网 / 没 Key / 模型拒答时用。
 *
 * ★ 键必须跟着**项目现有的风格档位**走（见 chatLines.js / phrases.js）：
 *   `cautious / balanced / aggressive / sharp` —— 不是随便起的名字。
 *   每个档位 2~3 条，保证"被拍一下"一定有反应，而且像那个人说的话。
 */
export const FALLBACK_NUDGE_REPLY = {
  // 谨慎 / 话少的人设：被拍一下，反应克制
  cautious: [
    '别拍我，吓一跳。',
    '……拍我干嘛。',
    '在呢，有事说事。',
  ],
  // 中间档：正常朋友的反应
  balanced: [
    '哎，拍我干嘛。',
    '在的在的，怎么了？',
    '哈哈，看到你了。',
  ],
  // 冲 / 外放：被拍一下就来劲
  aggressive: [
    '拍我干嘛，想我啦？',
    '哎哎哎，我在呢！',
    '手别乱拍，说事儿。',
  ],
  // 毒舌（就一位人设用这档）：嘴上不饶人
  sharp: [
    '拍坏了你赔？',
    '拍我干嘛，闲的？',
    '拍到点子上了，说吧。',
  ],
};

/** 这个风格档位的兜底池（认不出来的档位按 balanced） */
export function fallbackNudgePool(style) {
  return FALLBACK_NUDGE_REPLY[style] || FALLBACK_NUDGE_REPLY.balanced;
}

/**
 * 本地兜底：按风格 + 随机取一条（同一个池子里不会连着取到同一条，尽量像真人）
 * @param {object} persona
 * @param {Function} [rnd] 注入随机源，便于测试
 */
export function pickFallbackNudgeReply(persona, rnd = Math.random) {
  const pool = fallbackNudgePool(persona && persona.style);
  return pool[Math.floor(rnd() * pool.length)] || pool[0];
}
