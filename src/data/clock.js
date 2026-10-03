/**
 * 聊天/台词的"当前时间"背景知识（PRD §2.8 / §2.12）
 *
 * 为什么需要：AI 不知道现在几点，就会**时间错位** ——
 * 半夜两点祝你"早安"、早上十点问"这么晚还不睡"、刚聊完就说"好久不见"。
 * 所以每次调用都把"现在是什么时候 + 距上次聊天多久"写进提示词，
 * 并明确要求：符合时间，但**别把时间当话题**（不要每句都报时间）。
 *
 * 全部是纯函数（`now` 可注入），node 里能直接测。
 */

/**
 * 一天里的时段：**从晚到早倒序**，取第一个 `h >= from` 的
 * （顺序很重要：正序扫会让 `from: 0` 的"凌晨"永远命中）
 */
const PERIODS = [
  { from: 23, label: '深夜' },
  { from: 19, label: '晚上' },
  { from: 17, label: '傍晚' },
  { from: 14, label: '下午' },
  { from: 12, label: '中午' },
  { from: 11, label: '上午' },
  { from: 8, label: '早上' },
  { from: 5, label: '清晨' },
  { from: 0, label: '凌晨' },
];

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 时段（凌晨 / 早上 / 晚上 / 深夜 …） */
export function periodOf(now = new Date()) {
  const h = now.getHours();
  for (const p of PERIODS) if (h >= p.from) return p.label;
  return '凌晨';
}

/** `23:41` */
export function clockText(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** `2026年3月5日 周四` */
export function dateText(now = new Date()) {
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}`;
}

/**
 * `9月24日 11:05`（往年才写年份，省字数）—— 用来给"上一条消息"打时间戳
 * ★ 用户报的问题：昨晚 23 点聊完，今天 11 点再来，AI 还问"怎么还没睡" ——
 *   因为它只知道"现在几点"，不知道**那天是昨天**。所以时间锚点里要写清月日。
 */
export function stampText(at, now = new Date()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 同一天（按本地日历） */
export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * 写进提示词的那一行
 * @param {Date} now
 * @param {{short?:boolean}} [opts] short = 牌桌台词用，少说两句
 */
export function timeContextLine(now = new Date(), opts = {}) {
  const period = periodOf(now);
  // ★ 月日必须写全（用户报的问题：AI 知道几点、但不知道"今天是哪天"，
  //   于是把昨晚的深夜当成现在，白天还问"怎么还没睡"）
  const base = `现在的时间：${dateText(now)} ${clockText(now)}（${period}）。**先看清今天是几月几号、现在是几点**。`;
  if (opts.short) {
    return `${base}说话要符合这个时间（别在${period === '深夜' || period === '凌晨' ? '这个点祝人"早安"' : '大白天问人"怎么还不睡"'}），但别主动报时间。`;
  }
  const tail = {
    凌晨: '这个点了，语气可以带点困、熬夜、或者"早点睡"的意思',
    清晨: '刚天亮，别问人"怎么还不睡"',
    早上: '早上，适合"早啊"这类打招呼',
    上午: '上午，正常干活的时段',
    中午: '中午，可以聊吃没吃饭',
    下午: '下午，容易犯困的时段',
    傍晚: '傍晚，下班/放学的时间',
    晚上: '晚上，一天里最放松、牌桌上人最多的时候',
    深夜: '深夜了，别祝人"早安"，适合"还不睡？""最后一局"这种',
  }[period] || '';
  return `${base}${tail ? `${tail}。` : ''}`
    + '**这是背景知识，不要主动报时间、也不要每句都提**，只要别说和当前时间矛盾的话就行。';
}

/** 时间差 → `刚刚` / `12 分钟前` / `3 小时前` / `昨天` / `4 天前` */export function gapText(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return '很久以前';
}

/**
 * "距上次聊天多久"那一行（没有历史就返回空串）
 * ★ 除了"多久"，还要给出**上次那句话的月日与时间**：
 *   跨天时明确告诉它"那是另一天的事"，否则它会接着昨晚深夜的场景说话
 *   （用户报的问题：昨天 23 点聊完，今天 11 点问"怎么还没睡"）。
 * @param {{role:string, at?:number}[]} chat 聊天记录
 * @param {number|Date} [now]
 */
export function lastChatGapLine(chat, now = Date.now()) {
  const list = Array.isArray(chat) ? chat : [];
  let last = 0;
  for (const m of list) {
    const at = Number(m && m.at);
    if (Number.isFinite(at) && at > last) last = at;
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!last || last > nowMs) return '';
  const nowDate = new Date(nowMs);
  const head = `距上次说话：${gapText(nowMs - last)}（上次是 ${stampText(last, nowDate)}）。`;
  if (!sameDay(new Date(last), nowDate)) {
    // 跨天：这是最容易翻车的一种 —— 把"昨天深夜"当成"现在"
    return `${head}**注意：上次说话是「另一天」（${stampText(last, nowDate)}），`
      + `而现在是 ${stampText(nowMs, nowDate)}（${periodOf(nowDate)}）。`
      + '昨晚的对话已经过去一夜了，别再接着那个时间点的场景说话 —— '
      + '比如昨晚聊到"还不睡"，今天白天就不要再问"怎么还没睡"，可以自然地说"早啊""昨晚睡得怎么样"。**';
  }
  return `${head}`
    + '**如果只是几分钟，别说"好久不见""想你了"这类话；真的隔了很久才可以提一句。**';
}

/* =====================================================================
 *  离线期间"模拟发送时刻"（用户拍板）
 * ---------------------------------------------------------------------
 *  问题：玩家下线一段时间再上来，AI 的招呼**全都显示成"玩家上线的时刻"**，
 *        一看就是假的（凌晨 2 点不在线，上来却显示 "刚刚"）。
 *  要求：AI 会在**玩家不在线的那段时间里**挑一个自己会发消息的时刻 ——
 *        熬夜型可能在凌晨 2:23，大学生型可能在中午 12:47。
 *        这个时间是**按人设模拟**出来的，不是真实发生的时间。
 * ===================================================================== */

/** 人设的作息档：按标签 / 提示词里的关键词认，认不出来用"普通作息" */
const CHRONOTYPE = [
  { id: 'night', re: /熬夜|夜猫|失眠|通宵|夜班|夜行动物/, hours: [0, 1, 2, 3, 23] },
  { id: 'student', re: /大学生|学生|宿舍|考研|高中|上课|校园/, hours: [11, 12, 13, 21, 22, 23] },
  { id: 'worker', re: /上班|打工|社畜|加班|白领|职员|老板|工作党/, hours: [8, 12, 13, 18, 19, 20, 21] },
  { id: 'early', re: /早起|早睡|晨跑|广场舞|退休|阿姨|大爷|养生/, hours: [6, 7, 8, 19, 20] },
];

/** 认不出作息档时用的时间段（正常人白天到晚上） */
export const DEFAULT_ACTIVE_HOURS = [9, 10, 12, 13, 15, 18, 20, 21, 22];

/** 这个人设习惯在哪些小时冒泡（0~23） */
export function activeHoursOf(persona) {
  const tags = (persona && persona.tags) || [];
  const text = `${Array.isArray(tags) ? tags.join(' ') : ''} ${(persona && persona.prompt) || ''}`;
  for (const c of CHRONOTYPE) if (c.re.test(text)) return c.hours;
  return DEFAULT_ACTIVE_HOURS;
}

/**
 * 在 [from, to) 这段"玩家不在线"的时间里，挑一个像这个人设会发消息的时刻
 * @param {object} persona 人设（决定作息档）
 * @param {number} from 玩家离开的时刻（ms）
 * @param {number} to 玩家回来的时刻（ms）
 * @param {() => number} [rnd] 注入随机数（便于测试）
 * @returns {number} 模拟出来的发送时刻（ms）
 */
export function simulatedSendAt(persona, from, to, rnd = Math.random) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(b)) return Date.now();
  if (!Number.isFinite(a) || b - a < 60 * 1000) return Math.round(b - 1000);
  const hours = activeHoursOf(persona);
  // 把窗口按整点切开，收集"命中作息档"的那些小时段
  const slots = [];
  const start = new Date(a);
  let t = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()).getTime();
  for (; t < b; t += 3600000) {
    const hour = new Date(t).getHours();
    if (!hours.includes(hour)) continue;
    const s = Math.max(a, t);
    const e = Math.min(b, t + 3600000);
    if (e - s > 60 * 1000) slots.push([s, e]);
  }
  const pick = slots.length
    ? slots[Math.min(slots.length - 1, Math.floor(rnd() * slots.length))]
    : [a, b];
  const raw = pick[0] + rnd() * (pick[1] - pick[0]);
  // 别正好卡在窗口两端（免得跟"离开 / 回来"同一分钟）
  const lo = Math.min(a + 60 * 1000, b);
  const hi = Math.max(lo, b - 60 * 1000);
  return Math.round(Math.max(lo, Math.min(hi, raw)));
}

/**
 * 给模型看的"这句是什么时候发的"（离线补发用）：
 * 让它知道自己这句是**在那个时间点**写的，语气要跟那个时间对得上
 */
export function simulatedStampLine(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return '';
  return `（这条消息是你 ${stampText(t, new Date(now))} 发的 —— 那会儿玩家不在，现在他才看到。）`;
}

/**
 * ★ 离线期间"群里连着聊的那几条"分别显示成几点（用户拍板）
 *
 * 要求：
 *   · 这 N 条的时间都要落在**玩家离线的窗口 [leftAt, backAt]** 里
 *     （玩家回来看到的是"我不在的时候他们聊的"，不是"我刚上线那一刻"）
 *   · **按时间递增**，别倒着 —— 点进去要像一段有序的历史
 *   · 时间仍然带人设作息的味道（熬夜的人凌晨冒泡、学生党中午冒泡）
 *
 * 做法：把窗口**均分成 N 段**，每段里用 simulatedSendAt 挑一个时刻。
 * 段与段本身是先后关系（第 i+1 段的起点 = 第 i 段的终点），所以结果天然递增；
 * 再兜一层"相邻至少隔 minGapMs"，并用 [leftAt, backAt] 夹住，
 * 保证**任何情况下都不会倒着、也不会跑到窗口外**。
 *
 * 注意：这里只用 personas 当**作息档的提示**（第 i 条用第 i % len 位），
 * 真正的发言人由 AI 挑（chooseNextSpeaker），两者不必是同一个。
 *
 * @param {{leftAt:number, backAt:number, count:number, personas?:object[],
 *          minGapMs?:number, rnd?:Function}} p
 * @returns {number[]} 长度 = count 的时刻数组（都落在窗口内、单调不减）
 */
export function offlineGroupSendTimes({
  leftAt, backAt, count, personas = [], minGapMs = 0, rnd = Math.random,
} = {}) {
  const a = Number(leftAt);
  const b = Number(backAt);
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return [];
  if (!Number.isFinite(b)) return [];
  // 窗口不合法（没离线过 / 时钟回拨）：全部落在"现在"附近，至少不会崩
  if (!Number.isFinite(a) || b - a <= 0) return new Array(n).fill(Math.round(b));
  const list = Array.isArray(personas) ? personas : [];
  const gap = Math.max(0, Number(minGapMs) || 0);
  const hi = Math.max(a, b - 1000);
  const step = Math.max(1, (b - a) / n);
  const out = [];
  let prev = a - 1;
  for (let i = 0; i < n; i += 1) {
    const s = Math.min(hi, a + step * i);
    const e = Math.min(hi, Math.max(s + 1000, a + step * (i + 1)));
    const persona = list.length ? list[i % list.length] : null;
    let at = simulatedSendAt(persona, s, e, rnd);
    if (!Number.isFinite(at) || at < s || at > e) at = e; // 越界就退回本段末尾
    // 相邻至少隔 gap（只有在窗口还放得下时才推，免得把结果顶出窗口）
    const want = prev + gap;
    if (gap > 0 && want > at && want <= hi) at = want;
    if (at <= prev) at = Math.min(hi, Math.max(at, prev + 1)); // 兜底：绝不倒着
    out.push(Math.round(at));
    prev = at;
  }
  return out;
}
