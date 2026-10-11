/**
 * memory 分类（PRD §2.12）
 *
 * 判断标准：稳定（下一条消息不会变）、可复用（能影响未来的对话）、值得占用提示词空间
 * 唯一类（unique）指同一分类只保留最新一条 —— 比如称呼从"小明"改成"阿伟"必须覆盖，
 * 否则提示词里会同时出现两个称呼，AI 会自相矛盾。
 */
export const MEMORY_CATEGORIES = [
  { key: 'call', label: '称呼', icon: '🏷️', priority: 1, unique: true, hint: '玩家希望你怎么称呼他' },
  { key: 'like', label: '偏好', icon: '❤️', priority: 2, unique: false, hint: '爱好、喜欢的东西、雷区' },
  { key: 'plan', label: '约定', icon: '🤝', priority: 3, unique: false, hint: '约定、待办、重要经历' },
  { key: 'trait', label: '性格', icon: '🎭', priority: 4, unique: true, hint: '玩家自我描述的性格' },
  { key: 'ident', label: '身份', icon: '🎓', priority: 5, unique: true, hint: '职业、学生、地区等背景' },
  { key: 'habit', label: '习惯', icon: '⏰', priority: 6, unique: false, hint: '作息与行为习惯' },
  // 对局记忆：每打完一局自动写入一条 50~100 字的局面概括，只留最近 3 局
  {
    key: 'match',
    label: '对局',
    icon: '🃏',
    priority: 7,
    unique: false,
    long: true, // 允许超过 maxMemoryChars（局面概括本来就长）
    keep: 3, // 同类最多保留 3 条，超出淘汰最旧的
    auto: true, // 玩家不用开口，由系统在每局结束时写入
    hint: '和玩家一起打完的那一局：模式、谁赢、关键倍数、玩家的表现（50~100 字）',
  },
  // 友圈记忆：玩家发说说、AI 在下面评论之后自动写一条，只留最近 2 条
  // （用户拍板：和对局一样"额外加入记忆"，**不占用常规的那 16 条**）
  {
    key: 'moment',
    label: '友圈',
    icon: '🌈',
    priority: 6.5, // 排在「对局」之后、「自设」之前
    unique: false,
    long: true,
    keep: 2,
    /**
     * 这条比「对局」还长：要说清**说说内容 + 我的评论 + 评论区最后 3 轮对话**
     * （用户要求），所以单独给个上限。
     */
    limit: 210,
    auto: true,
    hint: '玩家在友圈发的说说 + 你在下面评论的内容 + 评论区里你和他最后 3 轮对话（只留最近 2 条）'
      + '—— 由系统在评论后自动写入',
  },
  // 改名：AI 在聊天里明确改了名字时由系统写一条（累积成"旧名→新名，又改名…"）
  {
    key: 'rename',
    label: '改名',
    icon: '✏️',
    priority: 3.5,
    unique: true,
    auto: true,
    hint: '你改过名字：从旧名改成新名（多次改名就接着写「又改名…」）—— 由系统在改名时自动写入',
  },
  /**
   * 礼物：赠礼/收礼时由系统写一条（用户要求"写入单独一条记忆：对方赠送了我哪些东西"）
   *   · 玩家送来的：`礼物：玩家送过我 🌹玫瑰花×2、💎钻石×1`
   *   · 我送出去的：`礼物：我送过玩家 🎁礼盒×1`
   * 两个方向各占一条（所以 keep: 2），同类累加不会越堆越多。
   */
  {
    key: 'gift',
    label: '礼物',
    icon: '🎁',
    priority: 6.8,
    unique: false,
    keep: 2,
    limit: 120,
    auto: true,
    hint: '玩家送过你什么礼物 / 你送过玩家什么（含件数，同类累加）—— 由系统在赠礼时自动写入',
  },
  // 关系：确立/结束恋人关系时系统自动写一条（priority 0 让它排在提示词最前面）
  {
    key: 'rel',
    label: '关系',
    icon: '💞',
    priority: 0,
    unique: true,
    auto: true,
    hint: '你和玩家的关系（例如"和玩家成了恋人""和玩家分开了，还是朋友"）—— 由系统在关系变化时自动写入',
  },
  // 自设：AI **自己在聊天里临时补充**的设定（提示词里没写过的那些）
  // 例：玩家问"你哪儿人"，AI 顺口答"杭州的" → 记下来，以后不能又说是成都的
  {
    key: 'self',
    label: '自设',
    icon: '🧬',
    priority: 8,
    unique: false,
    hint: '你（AI）自己在聊天里临时补充的设定：老家、职业、爱好、养了什么… 写成「方面=内容」，例如「老家=杭州」',
  },
];

/* ---------------- 自设（AI 自己的临时设定） ---------------- */

/** 自设记忆的固定前缀，用来和"关于玩家的事"区分开 */
export const SELF_PREFIX = '自设：';

/** 这条是不是"AI 自己的设定" */
export const isSelfMemory = (text) => String(text || '').startsWith(SELF_PREFIX);

/**
 * 自设写成 `自设：方面=内容`
 * 这样同一个"方面"（老家 / 职业…）可以**按方面覆盖**，不会出现"老家既是杭州又是成都"
 *
 * ★ 方面里如果模型自己又带了「自设：」（例如把 `{"自设：作息":"…"}` 当方面返回），
 *   会拼出 `自设：自设：作息=…` 这种双层前缀（用户存档里真出现过）—— 这里统一剥掉。
 */
export const cleanSelfAspect = (aspect) => String(aspect == null ? '' : aspect)
  .trim()
  .replace(/^(?:自设[：:]|\s)+/, '')
  .slice(0, 10);

export const selfLine = (aspect, value) => (
  `${SELF_PREFIX}${cleanSelfAspect(aspect)}=${String(value || '').trim()}`
);

/** 从自设里取出"方面"（取不到返回空串） */
export function selfAspectOf(text) {
  const m = /^自设：([^=＝]{1,10})[=＝]/.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

/** 从自设里取出"内容" */
export function selfValueOf(text) {
  const m = /^自设：[^=＝]{1,10}[=＝](.+)$/.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

/** 明确不写入 memory 的东西（写进提示词告诉模型别记） */
export const MEMORY_EXCLUDE = [
  '一时的情绪或状态（今天好累、我现在很烦）——下次就变了',
  '对 AI 的夸奖或抱怨——那是好感度的职责，重复记录会互相矛盾',
  '隐私信息（密码、住址、证件号、联系方式）',
  '本局牌局的临时细节——牌局系统已经记录了（「对局」这条由系统自动写）',
];

export function categoryByKey(key) {
  return MEMORY_CATEGORIES.find((c) => c.key === key) || null;
}

/* ---------------- 记忆的"归属"：这条是玩家的，还是 AI 自己的 ---------------- */

/**
 * 写进提示词时，每条记忆都要**标清楚是谁的**。
 *
 * 为什么：两类记忆长得几乎一样 —— `身份：山东临沂人`（关于玩家）
 * 和 `自设：老家=南方小城`（AI 自己）。以前只靠分组标题区分，
 * 模型经常把"山东临沂人"当成自己的老家（用户报的问题）。
 * 所以每条都带上【关于玩家】/【你自己】的前缀，一眼看清归属。
 */
export const OWNER_PLAYER = '关于玩家';
export const OWNER_SELF = '你自己';
export const OWNER_SYSTEM = '系统记录';

/** 给一组记忆行加上归属前缀 */
export function ownedLines(lines, owner) {
  return (Array.isArray(lines) ? lines : []).map((m) => `- 【${owner}】${m}`);
}

/** 一条记忆的归属文案（自设 = AI 自己，其余 = 关于玩家） */
export const ownerOf = (text) => (isSelfMemory(text) ? OWNER_SELF : OWNER_PLAYER);

/* ---------------- 近似重复检测 / 合并（写入时先看有没有能合到一起的） ---------------- */

/** 去掉标点与空白，只留下"实义字符"，用来比相似度 */
export function normText(text) {
  return String(text == null ? '' : text)
    .replace(/[\s，。、；：！？,.!?;:（）()「」『』【】"'`~～\-—_/\\|]+/g, '')
    .trim();
}

/** 字符二元组 */
function bigrams(s) {
  const t = normText(s);
  const out = [];
  for (let i = 0; i + 2 <= t.length; i += 1) out.push(t.slice(i, i + 2));
  if (!out.length && t) out.push(t);
  return out;
}

/**
 * 两句内容像不像（0~1）：取"二元组 Dice"和"最长公共子序列占比"里更大的那个。
 * 为什么要两种：Dice 对"多插了几个字"很敏感（睡前**会**刷**会儿**手机），
 * LCS 则能容忍插入删除。两个取大，重复才抓得住。
 * 例：「睡前会刷会儿手机，睡得比较晚」vs「睡前刷手机，睡得晚」≈ 0.76
 *     「睡前刷手机，睡得晚」vs「睡前刷手机停不下来」≈ 0.59
 *     「喜欢美食」vs「喜欢做饭」≈ 0.50（不够像，不会硬合）
 */
export function textSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const setB = new Set(B);
  let hit = 0;
  for (const g of A) if (setB.has(g)) hit += 1;
  const dice = (2 * hit) / (A.length + B.length);
  return Math.max(dice, lcsRatio(normText(a), normText(b)));
}

/** 最长公共子序列占比：2*LCS/(lenA+lenB)（串很短，直接 DP） */
export function lcsRatio(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (!s.length || !t.length) return 0;
  let prev = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = new Array(t.length + 1).fill(0);
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = s[i - 1] === t[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return (2 * prev[t.length]) / (s.length + t.length);
}

/** 判定"重复"的阈值：低一点没关系——合并是"两条并一条"，信息不会丢 */
export const DUP_THRESHOLD = 0.45;

/**
 * 合并两句近似的内容：
 *   · 一句包含另一句（去标点后）→ 取更全的那句
 *   · 高度相似（≥0.7）→ 同一件事换了个说法，取更详细的那句
 *   · 中等相似 → 取更详细的那句，再把另一句里"没说过的尾巴"用「、」接上
 *     例：睡前会刷会儿手机，睡得比较晚 ＋ 睡前刷手机停不下来
 *       → 睡前会刷会儿手机，睡得比较晚、睡前刷手机停不下来（信息一条不丢）
 */
export function mergeSimilarText(a, b, maxChars = 40) {
  const A = String(a || '').trim();
  const B = String(b || '').trim();
  if (!A) return B;
  if (!B) return A;
  const na = normText(A);
  const nb = normText(B);
  if (na === nb) return A.length >= B.length ? A : B;
  if (na.includes(nb)) return A.slice(0, maxChars); // 一句包含另一句 → 取更全的
  if (nb.includes(na)) return B.slice(0, maxChars);

  const longer = (A.length >= B.length ? A : B).slice(0, maxChars);
  const shorter = (A.length >= B.length ? B : A);
  if (textSimilarity(A, B) >= 0.7) return longer; // 换了个说法而已，留更详细的

  // 中等相似：把短句里"较长句没提过"的**那截尾巴**接在后面
  const segs = (s) => String(s).split(/[，,、；;。]/).map((x) => x.trim()).filter(Boolean);
  const longSegs = segs(longer);
  const extra = [];
  for (const seg of segs(shorter)) {
    if (longer.includes(seg)) continue;
    // 先找最像的长句片段，把共同开头切掉，只看"多出来的那截"
    let bestSeg = '';
    let bestScore = 0;
    for (const ls of longSegs) {
      const sc = textSimilarity(seg, ls);
      if (sc > bestScore) { bestScore = sc; bestSeg = ls; }
    }
    let rest = seg;
    if (bestScore >= 0.5 && bestSeg) {
      const a = normText(seg);
      const b = normText(bestSeg);
      let i = 0;
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
      rest = seg.slice(Math.min(i, seg.length)).replace(/^[，、；：\s]+/, '');
    }
    const covered = rest.length < 2
      || longSegs.some((ls) => textSimilarity(rest, ls) >= 0.6 || ls.includes(rest));
    if (!covered) extra.push(rest);
  }
  if (!extra.length) return longer;
  const merged = `${longer.replace(/[，、；\s]+$/, '')}、${extra.join('、')}`;
  return (merged.length <= maxChars ? merged : longer);
}

/** 最长公共**连续**子串的长度（用来确认"真的是同一件事"） */
export function longestCommonSubstring(a, b) {
  const s = normText(a);
  const t = normText(b);
  if (!s || !t) return 0;
  let best = 0;
  const dp = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= t.length; j += 1) {
      const cur = dp[j];
      dp[j] = s[i - 1] === t[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = cur;
    }
  }
  return best;
}

/**
 * 在一组记忆里找和新内容最像的那条
 * @returns {{index:number, line:string, score:number}|null}
 */
export function findSimilarMemory(list, content, { threshold = DUP_THRESHOLD, skip = () => false } = {}) {
  let best = null;
  (Array.isArray(list) ? list : []).forEach((line, index) => {
    const raw = String(line || '');
    if (!raw || skip(raw)) return;
    const other = contentOf(raw);
    const score = textSimilarity(content, other);
    if (score < threshold) return;
    // 除分数外，还要求"有一截连续的重合"（≥2 字）：避免只是碰巧同词就被并掉
    if (score < 0.7 && longestCommonSubstring(content, other) < 2) return;
    if (!best || score > best.score) best = { index, line: raw, score };
  });
  return best;
}

/** 「分类：内容」或「自设：方面=内容」→ 只取内容（内部用；store 那边有同名导出版） */
function contentOf(line) {
  return isSelfMemory(line) ? selfValueOf(line) : String(line || '').replace(/^[^：:]{1,6}[：:]/, '').trim();
}

/**
 * 这句话看起来是不是**在说 AI 自己**（而不是玩家）？
 *
 * 为什么需要：模型经常把 AI 自己的事写进"关于玩家"那一栏，比如
 *   `习惯：玩家拉我打游戏时用哈哈哈`（这是**它自己**的说话习惯）
 *   `身份：我是萌新`（它自己说的）
 * 判断依据：句子里出现第一人称「我」（在 AI 的记忆里，"我"只能指它自己），
 * 或出现"玩家…我 / 让我 / 叫我 / 拉我 / 陪我"这类句式。
 * 调用方必须自己再确认"玩家那句话里没有对应证据"才搬，别硬猜。
 */
export function looksLikeSelfFact(content) {
  const s = String(content || '');
  if (!s || !s.includes('我')) return false;
  return /(我(的|也|平时|一般|经常|习惯|睡|是|叫|被|比较|不|会|爱|喜欢|养|住|在|刚|想|要|玩|刷|用))|(玩家.*我)|(让我|叫我|拉我|陪我)/.test(s);
}

/**
 * ★ 这一条"自设"其实是在说**玩家**吗？（用户报的 bug）
 *
 * 真实案例：玩家的昵称就叫「汽水偶像」，模型却输出了
 *   `self: {"称呼对方": "管对方叫汽水偶像"}`
 * → 存进去变成「自设：称呼对方=管对方叫汽水偶像」，看着像它给自己起了个名叫"汽水偶像"。
 *   这根本不是它的设定：**"对方"永远是玩家**，它叫玩家的名字是理所当然的。
 *
 * 判据（只认这几种，别硬猜）：
 *   · 方面里同时出现"对方/玩家/他"和一个"称呼"类字眼（称呼对方 / 怎么叫他 / 喊他什么…）
 *   · 方面是称呼类，而内容里出现"对方/玩家"
 *   · 内容**就是**玩家的昵称（一字不差）
 *   · 方面是称呼类，而且内容里带着玩家的昵称（在说"管他叫这个"）
 *
 * 放在 data 层（不碰 store / ai）是为了两边都能用：ai 的审查用它，
 * store 启动时的老存档修复也用它（避免 store ↔ ai 互相 import）。
 *
 * @returns {{hit:boolean, name:string}} name = 能抠出来的称呼（用来补一条 `称呼：X`）
 */
export function selfAboutPlayer(aspect, value, playerName = '') {
  const a = String(aspect || '').trim();
  const v = String(value || '').trim();
  if (!a && !v) return { hit: false, name: '' };
  const NAMING = /(称呼|叫|喊|昵称|名字)/;
  const OTHER = /(对方|玩家|他|她|您)/;
  const bare = (s) => String(s || '').replace(/[\s，。！？,.!?；;、:：""''「」『』（）()【】\[\]…~～-]/g, '');
  const n = bare(playerName);
  const bv = bare(v);
  // 内容里"叫 / 喊"后面的那个名字（`管对方叫汽水偶像` → 汽水偶像）
  const picked = (/(?:叫|喊|称呼)([^\s，。！？,.!?；;、]{1,12})$/.exec(v) || [])[1] || '';
  const hit = (OTHER.test(a) && NAMING.test(a))
    || (NAMING.test(a) && OTHER.test(bv))
    || (!!n && bv === n)
    || (!!n && NAMING.test(a) && bv.includes(n));
  return { hit, name: (n && bv.includes(n) ? playerName : picked) };
}

/* ---------------- 记忆合并（超上限时"把相似的并成一条"） ---------------- */

/** 不参与合并的分类：对局/友圈/改名各自成条、关系是系统写的、自设按方面唯一 */
export const MERGE_SKIP_KEYS = ['match', 'moment', 'rename', 'rel'];

/**
 * 「额外记忆」：系统自动写入、**不占用常规记忆条数**的分类（用户要求）。
 *   · 对局（match）：每打完一局一条，只留最近 3 局
 *   · 友圈（moment）：玩家发说说 + 你评论，只留最近 2 条
 *   · 改名（rename）：改过名就一条（累积写"旧名→新名，又改名…"）
 * 上限由各自的 keep 管，常规的 16 条由 maxMemory 管，两者互不挤占。
 */
export const EXTRA_MEMORY_KEYS = ['match', 'moment', 'rename'];

/** 这条记忆是不是"额外记忆"（对局 / 友圈 / 改名） */
export function isExtraMemory(text) {
  const c = categoryOf(text);
  return !!(c && EXTRA_MEMORY_KEYS.includes(c.key));
}

/** 改名记忆的前缀（系统自动写，累积成一条） */
export const RENAME_PREFIX = '改名：';

/** 这条记忆是不是「改名」 */
export const isRenameMemory = (text) => String(text || '').startsWith(RENAME_PREFIX);

/**
 * 「系统记录」这一类：由系统写、不是"玩家说过的话"，也不是 AI 的设定。
 * 提示词和记忆文件里都单独分一块放（用户要求"分块划分，别混在一起"），
 * 因为像「友圈：说说「…」｜我评论：…」这种一行里既有玩家又有它自己，
 * 混进"关于玩家"那栏就会被读成"玩家说过的话"。
 */
export const SYSTEM_MEMORY_KEYS = ['match', 'moment', 'rename', 'rel'];

/** 这条记忆是不是"系统记录"（对局 / 友圈 / 改名 / 关系） */
export function isSystemMemory(text) {
  const c = categoryOf(text);
  return !isSelfMemory(text) && !!(c && SYSTEM_MEMORY_KEYS.includes(c.key));
}

/** 这条记忆能不能参与合并 */
export function canMerge(text) {
  const line = String(text || '').trim();
  if (!line || isSelfMemory(line)) return false;
  const cat = categoryOf(line);
  return !!(cat && !MERGE_SKIP_KEYS.includes(cat.key));
}

/**
 * 本地合并（不联网也能用，也是 AI 合并失败时的兜底）：
 * 把**同一个分类**的多条并成一条，用「、」连接。
 *   例：['偏好：喝奶茶', '偏好：爱吃辣'] → ['偏好：喝奶茶、爱吃辣']
 * 对局 / 关系 / 自设原样保留（用户明确要求"对局记忆不动"）。
 * 一条装不下就多分几条（信息不丢），每条不超过 maxChars。
 *
 * @param {string[]} memory
 * @param {{maxChars?:number, maxLines?:number}} opts
 * @returns {string[]}
 */
export function mergeMemoryLocally(memory, { maxChars = 40, maxLines = 16 } = {}) {
  const list = (Array.isArray(memory) ? memory : []).map((m) => String(m || '').trim()).filter(Boolean);
  const kept = [];
  const groups = new Map();
  const order = [];
  for (const line of list) {
    if (!canMerge(line)) { kept.push(line); continue; }
    const cat = categoryOf(line);
    const value = line.slice(cat.label.length + 1).trim();
    if (!value) continue;
    if (!groups.has(cat.key)) { groups.set(cat.key, { label: cat.label, values: [] }); order.push(cat.key); }
    const g = groups.get(cat.key);
    if (!g.values.includes(value)) g.values.push(value);
  }

  const merged = [];
  for (const key of order) {
    const g = groups.get(key);
    let bucket = [];
    const flush = () => {
      if (bucket.length) { merged.push(`${g.label}：${bucket.join('、')}`); bucket = []; }
    };
    for (const v of g.values) {
      const next = bucket.length ? `${bucket.join('、')}、${v}` : v;
      // 一个分类的字数（含标签）不能超过上限；装不下就另起一条，别把信息丢了
      if (bucket.length && `${g.label}：${next}`.length > maxChars) flush();
      bucket.push(v);
    }
    flush();
  }

  // 顺序：不合并的（对局/关系/自设）在前，合并后的按分类出现顺序跟在后面
  const out = [...kept, ...merged];
  if (out.length <= maxLines) return out;
  /**
   * 还是超了（比如一堆没有分类的零碎记忆，根本没得合）：
   * 按分类优先级保留；**同优先级保留新的**（和以前"最旧的先淘汰"一致的手感），
   * 绝不能把刚记住的新信息丢掉。
   */
  const scored = out.map((m, i) => ({ m, i, p: memoryPriority(m) }));
  scored.sort((a, b) => (a.p - b.p) || (b.i - a.i));
  const keep = new Set(scored.slice(0, maxLines).map((x) => x.i));
  return out.filter((_, i) => keep.has(i));
}

export function categoryByLabel(label) {
  return MEMORY_CATEGORIES.find((c) => c.label === label) || null;
}

/** 从「分类：内容」里解析出分类 */
export function categoryOf(text) {
  const m = String(text || '').match(/^(.{1,4})[：:]/);
  return m ? categoryByLabel(m[1]) : null;
}

export function memoryIcon(text) {
  const c = categoryOf(text);
  return c ? c.icon : '📝';
}

export function memoryLabel(text) {
  const c = categoryOf(text);
  return c ? c.label : '其他';
}

export function memoryPriority(text) {
  const c = categoryOf(text);
  return c ? c.priority : 99;
}

export function isUniqueCategory(text) {
  const c = categoryOf(text);
  return !!(c && c.unique);
}

/** 这一类允许更长（不按 maxMemoryChars 截断） */
export function isLongCategory(text) {
  const c = categoryOf(text);
  return !!(c && c.long);
}

/** 这一类最多保留几条（未配置则不限） */
export function keepCountOf(text) {
  const c = categoryOf(text);
  return c && c.keep ? c.keep : 0;
}

/** 是否是系统自动写入的记忆（如每局结束的「对局」概括） */
export function isAutoCategory(text) {
  const c = categoryOf(text);
  return !!(c && c.auto);
}
