/**
 * 全局配置与数值基线（对应 PRD §2.4 / §6 / §8）
 * 改这里就能改数值，不需要动业务代码。
 */

export const CONFIG = {
  version: '1.0.0',

  /* ---------- DeepSeek（PRD Q8：当前写死在 config，后续可改代理） ---------- */
  /**
   * ★ 仓库里**默认留空**：API Key 属于个人凭据，不能提交进版本库
   *   （绿色版打包时也会把它清空，见 tools/pack-green.mjs）。
   *   自己用的时候在「⚙️ 设置」面板里粘贴一次即可；没填就先用本地语气兜底，游戏照常能玩。
   */
  apiKey: '',
  model: 'deepseek-flash', // 默认模型
  thinking: false, // 关闭思考模式（思考模式默认开启，会拖慢出牌节奏且忽略 temperature）
  apiBase: 'https://api.deepseek.com/chat/completions',
  /**
   * 是否走本地服务代理（默认 true）
   *  - 走代理：没有 CORS 预检（浏览器直连时每次调用都要多一次 OPTIONS 往返）、
   *    不会被浏览器插件拦、Key 不暴露在页面里、上游超时更宽（12s）
   *  - 代理不可用（直接用 file:// 打开、或没启动 server.js）会自动退回浏览器直连
   */
  useProxy: true,
  proxyPath: '/api/chat',

  /* ---------- 对局规则 ---------- */
  exitRule: 'void', // 'void' = 退出/刷新本局作废不结算（测试期，PRD Q4/§8-5）
  maxRob: 3, // 抢地主 + 反抢 最多 3 次（PRD §8-2）
  turnTimeout: { bid: 15, play: 30 }, // 秒
  bidTimeoutsToPlay: true, // 抢地主超时 = 不叫/不抢；出牌超时 = 过牌（首出则自动出最小牌）

  /* ---------- AI 对话 ---------- */
  ai: {
    /**
     * 单次请求超时（毫秒）。实测 deepseek-flash 在这个提示词体量下 0.4~1.1s 返回，
     * 但高峰时段/网络抖动会到 5s 以上 —— 之前写的 3000 会把正常请求判成"连接失败"，
     * 于是频繁闪回本地语气。AI 台词不阻塞出牌，宁可等久一点也别误判。
     */
    timeout: 8000,
    timeoutProxy: 12000, // 走本地代理时上游更宽松（server.js 自己还有 20s 兜底）
    retry: 1,
    /**
     * 出牌决策：★ 斗地主出牌**已经不经过大模型了** —— 一律走纯规则引擎
     * （core/bot.js 的 choosePlay，按人设的牌技档位 data/ddzLevels.js 打分选牌），
     * 大模型只负责说话。下面这几个值现在只服务于 ai/playBrain.js 自己的单测
     * （tools/test-play.mjs 还在跑 decidePlayWithLLM），对局流程里不再读取。
     */
    playTimeout: 15000,
    playRetry: 1,
    llmPlays: false, // 保留字段：false = 纯脚本/引擎出牌（斗地主现在恒为纯引擎）
    offlineAfter: 3, // 连续失败多少次才认为"离线"（避免一次抖动就翻脸）
    minGap: 2000, // 同一 AI 两次发言最小间隔
    playMinGap: 600, // 轮到 AI 出牌时的发言间隔（必说的场合要立刻能开口）
    fishMinGap: 700, // 小猫钓鱼：每次收牌都要说话，间隔同理放短
    playerReplyGap: 0, // 玩家发言被点名回应时：允许插队，不等任何间隔
    globalGap: 7000, // 全局间隔：任意两个 AI 发言之间至少隔这么久，避免刷屏
    idleGap: 15000, // 冷场阈值（PRD §2.8）
    /**
     * 发言概率（只决定"说不说"，"说什么"由牌型决定）
     *   · 叫 / 不叫地主：100% 表态（见 ai/scene.js 的 bid / rob / passBid，不走这里）
     *   · 炸弹、春天、被反杀：100%，而且是**桌上每个 AI 都开口**（见 ai/events.js）
     *   · 长牌型（连对 / 长顺子 / 飞机 / 四带二）：100%，出牌者必说
     *   · 普通牌（单张、对子、三带一…）：50% —— 脚本先掷骰子，
     *     **掷中了才真的向大模型发请求**，没中就直接闭嘴（省调用）
     *   · 过牌保持克制，避免刷屏
     */
    chance: { play: 0.5, bigPlay: 0.5, pass: 0.25, reactHuman: 0.5 },
    /** 大事件里两个 AI 先后开口的间隔（毫秒）：同一瞬间弹两条气泡很假 */
    eventStaggerMs: 900,
    /** 春天/被反杀时，结算面板最多等 AI 说完这么久（模型慢也不能让玩家干等） */
    springGateMs: 4000,
    // 只作为提示词里的「建议长度」写给模型看，不会用来截断它的输出
    maxChars: 18,
    maxTokens: 120,
    temperature: 1.1,
  },

  /* ---------- 交互 ---------- */
  chatMaxChars: 30, // PRD Q20
  toolPerHand: 3, // 每种道具每局最多用几次（PRD Q20）
  animSpeed: { slow: 1.5, normal: 1, fast: 0.6, off: 0 },
};

/** 场次：底分 / 封顶豆 / 入场门槛（PRD §2.4.1） */
export const ROOMS = [
  { id: 'low', name: '低级场', base: 10, cap: 256, minBeans: 1000, tone: '#6FD6FF', desc: '新手练习，轻松上手' },
  { id: 'mid', name: '中级场', base: 100, cap: 8192, minBeans: 10000, tone: '#FFD166', desc: '常规对局，倍数有空间' },
  { id: 'high', name: '高级场', base: 2000, cap: 100000, minBeans: 100000, tone: '#FF7BAC', desc: '高手过招，一局定输赢' },
];

/** 经济系统（PRD §2.2 / §2.3 / §2.4.4） */
export const ECON = {
  // 新手豆：20,000（够在低级场玩很多局、又进不去中级场的门槛，形成"先攒豆"的动机）
  newPlayerBeans: 20000,
  reliefBeans: 5000,
  reliefThreshold: 1000,
  signInRewards: [1000, 2000, 3000, 5000, 8000, 10000, 20000],
};

/** 商城汇率：1 元 = 1000 开心豆 */
export const BEANS_PER_YUAN = 1000;

/** 商城商品（PRD Q13：保持标价 + 模拟支付流程，不接真实支付） */
export const SHOP_ITEMS = [
  { id: 'bean_6k', price: 6, name: '开心豆 · 小袋', tag: '' },
  { id: 'bean_30k', price: 30, name: '开心豆 · 中袋', tag: '热销' },
  { id: 'bean_128k', price: 128, name: '开心豆 · 大袋', tag: '' },
  { id: 'bean_648k', price: 648, name: '开心豆 · 巨袋', tag: '顶配' },
].map((it) => ({ ...it, beans: it.price * BEANS_PER_YUAN }));

/** 小猫钓鱼结算系数（三个场次共用这一对不对称系数，保证期望略微大于 0） */
export const FISHING = {
  winFactor: 1.03,
  loseFactor: 0.97,
  /**
   * 一次收 ≥N 张 → 本局倍数翻倍（"5 张以上"就是 N=6）
   * 实测：N=6 时每局平均有 3~4 次大丰收，87% 的对局直接顶到上限，倍数等于常数；
   *       N=8 时顶上限只有 13%，×1/×2/×4/×8 都会出现，才像"大丰收"。
   * 想改回严格按 5 张以上触发，把这里改成 6 即可。
   */
  bigCatchMin: 8,
  maxMultiplier: 8, // 倍数上限，避免一路翻到失控
};

/**
 * 小猫钓鱼场次：按鱼篓差距结算，曲线越悬殊越陡
 *   base = perCard × d + quad × d² + cube × d³
 *   低级场 = 原来的手感；中级场 = 低级 ×10；高级场 = 低级 ×15 且曲线升到三次方
 * 参考（差 10 张 / 差 20 张）：低级 ≈ 420 / 1440，中级 ≈ 4200 / 14400，高级 ≈ 10800 / 57600
 */
export const FISHING_ROOMS = [
  { id: 'low', name: '低级场', perCard: 12, quad: 3, cube: 0, minBeans: 1000, tone: '#6FD6FF', desc: '就是现在的手感，小打小闹' },
  { id: 'mid', name: '中级场', perCard: 120, quad: 30, cube: 0, minBeans: 10000, tone: '#FFD166', desc: '低级场 ×10，差距一大就肉疼' },
  { id: 'high', name: '高级场', perCard: 180, quad: 45, cube: 4.5, minBeans: 100000, tone: '#FF7BAC', desc: '低级场 ×15，且曲线升到三次方' },
];

/**
 * 五子棋（用户拍板：替代原来占位的"掼蛋"）
 *
 *   · 15×15、无禁手、五连即胜；**每局随机决定谁先手**；下满=平局
 *   · **不涉及豆子**：输赢不算钱，只给参战好友加好感度
 *   · 难度**不可自选**（界面上完全不提），由对手人设决定，内部五档：
 *     新手 / 入门 / 熟练 / 精通 / 大师（分配见 data/gomokuLevels.js）
 *   · "场次"只决定**匹配到哪个难度池**（低级/中级/高级），不检查入场门槛
 *   · 落子由**本地引擎**算（ai/gomoku 的 core/gomoku.js），大模型只负责说话
 */
export const GOMOKU = {
  size: 15, // 15×15
  levels: ['新手', '入门', '熟练', '精通', '大师'], // 内部难度（不显示给玩家）
  affinityPerGame: 2, // ★ 一局 +2 好感度（无论输赢，只给参战好友）
  maxMoves: 225, // 下满就是平局
  /** 对手"思考"的停顿：太快像机器，太慢等得烦 */
  thinkMinMs: 500,
  thinkMaxMs: 1500,
  /** 开局后玩家先手时，AI 的第一手也该有个小停顿 */
  openDelayMs: 700,
  maxHistory: 60, // 保留最近多少手（够悔棋/复盘展示用；当前只用来显示手数）
};

/**
 * 五子棋场次：**只决定匹配难度池**，没有任何门槛、也不显示底分
 *   · 低级场 → 新手 / 入门
 *   · 中级场 → 入门 / 熟练 / 精通
 *   · 高级场 → 精通 / 大师
 * 机器模式与 AI 模式都能选场次；房间模式隐藏场次（用被邀请好友自己的难度）。
 */
export const GOMOKU_ROOMS = [
  { id: 'low', name: '低级场', levels: ['新手', '入门'], tone: '#6FD6FF', desc: '随便下下' },
  { id: 'mid', name: '中级场', levels: ['入门', '熟练', '精通'], tone: '#FFD166', desc: '有来有回' },
  { id: 'high', name: '高级场', levels: ['精通', '大师'], tone: '#FF7BAC', desc: '硬碰硬' },
];

/** 房间模式的弹幕 */
export const DANMAKU = {
  minGap: 3000, // 聊天中两条之间的最短间隔 3s
  maxGap: 5000, // 最长间隔 5s
  kickoffGap: 5000, // 进房后玩家 5s 不说话 → 由 AI 主动开场（1 个好友时也会开口）
  replyMin: 3000, // 玩家发弹幕之后，AI "打字" 3~5s 才回复（模拟真人）
  replyMax: 5000,
  maxChars: 20, // 单条长度上限
  life: 11000, // 飘过屏幕后清理的时间上限（毫秒）
  speed: 130, // 每秒移动多少像素
  lanes: 4, // 弹幕轨道数
  recent: 6, // 提示词里带上最近几条弹幕，便于互相接话
};

/**
 * AI 模式的「匹配」界面（纯包装，不联网，也不画动画）
 * 三人斗地主：一行提示从"正在匹配…"报到"已找到 3/3"，每报一个数"叮"一声。
 * 机器模式直接开局不做这一步（PRD 里机器模式就是"安静快速"）。
 * 过程中点一下可以跳过，不等完。
 */
export const MATCH = {
  needs: 3, // 三人斗地主
  introMs: 420, // 先"正在匹配…"晃一下
  seatMs: 820, // 每报一个数的间隔
  settleMs: 620, // 人齐了再停一下才进桌
};

/** 语音输入（PRD §2.7 / Q10）：点一下进入持续收音模式 */
export const VOICE = {
  lang: 'zh-CN',
  // 说话人一停就发：0.25s 的静音就算"说完了"（不再等 1 秒多）
  // 太短会被句中的换气切断，太长又像卡住；0.2~0.3 是"说完就发"的舒适区
  silenceMs: 250,
  pollMs: 80, // 静音检测 / 音量柱刷新间隔（要密一点才抓得住 0.25s）
  restartMs: 250, // 浏览器掐断连续识别后，隔多久自动续上
  levelThreshold: 0.02, // 麦克风音量阈值（RMS 0~1）：低于它算"没说话"
  useVolume: true, // 用音量辅助判断静音（拿不到权限时自动退回"识别结果超时"判定）
  // 屏幕下方的"正在听…"提示只闪一下（3~5 秒后自动消失，不常驻）
  hintMinMs: 3000,
  hintMaxMs: 5000,
  hintText: '🎤 正在听…说完停一下会自动发出，再点麦克风结束',
  bars: 4, // 麦克风按钮里的音量柱数量
};

/**
 * AI 邀请玩家打牌（用户拍板）
 *   · 玩家停在**主界面**（大厅，不含商城等面板）不动超过 idleMs → 开始"可能被邀请"
 *   · 之后每隔 minGapMs~maxGapMs 随机出现一次邀请（画面**上部**）
 *   · 好友 **少于 minFriends 位就不邀请**（人少了没意思）
 *   · 接受后等同于房间模式：AI 是房主，另带一位好友；startMinMs~startMaxMs 后自动开局，
 *     这段时间内退出就不开始
 *   · 点 ✗ → 之后不再打扰，直到玩家**主动玩一局**为止
 */
export const INVITE = {
  idleMs: 30000, // 主界面静止多久之后才可能被邀请
  minGapMs: 20000, // 两次邀请之间最短间隔
  maxGapMs: 60000, // 最长间隔
  minFriends: 3, // 好友少于这个数就不邀请
  countdownMs: 15000, // 邀请卡片上的倒计时（到点自动消失，不算拒绝）
  startMinMs: 3000, // 接受后多久自动开局
  startMaxMs: 5000,
  /** 邀请的玩法池（按权重随机） */
  games: [
    { kind: 'ddz', weight: 3 },
    { kind: 'fishing', weight: 1 },
    // ★ 五子棋和斗地主并列（用户拍板）：好友拉你下盘棋
    { kind: 'gomoku', weight: 3 },
  ],
};

/**
 * 离线回来打招呼（用户拍板）
 *   · 退出到下次进来 **超过 2 分钟**（例如 9:10 退出、9:13 进来）→ 随机 1~3 位好友主动发消息
 *   · 聊日常，或者编一局**它自己**的游戏（**不许提和玩家一起玩**）
 *   · 前提：玩家至少 2 位好友；仍然受"连发 2 条没人回就不再打扰"的节流约束
 */
export const RETURN_PING = {
  minAwayMs: 2 * 60 * 1000, // 离线超过 2 分钟才算"回来"
  minFriends: 2, // 至少 2 位好友才会有人来打招呼
  maxPing: 3, // 一次最多 3 位
  firstMinMs: 1500, // 第一位隔多久来（别和开屏动画撞一起）
  firstMaxMs: 3500,
  gapMs: 2800, // 两位之间错开的时间
  /**
   * ★ 恋人优先（用户拍板）：如果有恋人，这次挑人时**恋人被选中的概率明显更大**
   *   —— 但不是 100%（每次都是它就假了），所以用两道叠加：
   *
   *   · `loverSureChance`：先掷一次骰子，中了就直接给恋人**保送**一个名额（其余名额再随机）
   *   · `loverWeight`：没保送时，恋人在随机池里的权重 —— 普通好友 = 1，恋人 = 3
   *
   *   两个参数一起看效果（3 位好友、挑 2 位）：恋人被挑中的概率约 96%；
   *   只有 1 个名额、10 位好友时约 62% —— 是"一眼看出偏爱"，但别的好友偶尔也能来。
   *   恋人必须是**还在好友列表里、且没被"连发 2 条没人回"挡住**的人；否则按普通好友挑。
   */
  loverSureChance: 0.5,
  loverWeight: 3,
};

/**
 * 离线期间群里自己聊（用户拍板）
 *   · 离线 **超过 20 分钟** → 随机挑 **一个群**，让群里的 AI **连着聊 5~10 条**
 *     （AI 之间互相接话：谁接下一句由 chooseNextSpeaker 判断，和挂机那套同一份实现）
 *   · 玩家回来时，群里是一串"我不在的时候他们聊的"，**计入未读**（群聊上有红点）
 *   · 每条的时间都落在"玩家不在线"的那段时间里，而且**按时间递增**
 *     （见 data/clock.js 的 offlineGroupSendTimes —— 别倒着，点进去要像一段有序的历史）
 *
 * ★ 和 GROUP_IDLE 的关系（用户明确要求"别打架"）：
 *   · GROUP_IDLE   = 玩家**在线**、停在群聊界面静默 10s → AI 在他眼前聊起来
 *   · GROUP_OFFLINE = 玩家**离线**超过 20 分钟 → 回来时补一批"他们那会儿聊的"
 *   两条路径分别独立（不同函数、不同配置），互不影响。
 */
export const GROUP_OFFLINE = {
  minAwayMs: 20 * 60 * 1000, // 和"离线补友圈"同一个门槛（MOMENT_FEED.minAwayMs）
  minAi: 2, // 群里至少 2 位 AI 才叫"AI 之间互相接话"（只有 1 位就是自言自语，跳过）
  minLines: 5, // 至少聊 5 条
  maxLines: 10, // 最多聊 10 条（条数在 5~10 之间随机）
  minGapMs: 20 * 1000, // 相邻两条**至少**隔 20 秒（保证时间递增，也像人聊出来的）
  staggerMs: 1200, // 真实投递的错开间隔：别让 5~10 条同时去打大模型
};

/**
 * 群聊挂机自动聊天（用户拍板）
 *   · 玩家在群聊界面**静默 10s** 且群里 AI **多于 2 人**（≥3）→ AI 之间自己聊起来
 *   · 每 **8~20s** 随机让一个人发一句（用户反馈"太快了"，从 5~15s 放慢）
 *   · 它们看得到上下文、带自己的记忆
 *   · 话题不一定和玩家有关；**下一句由 AI 判断该谁接**（保持连续）
 *   · 玩家一发话就立刻停，之后再静默 10s 才会重新开始
 */
export const GROUP_IDLE = {
  idleMs: 10000, // 玩家静默多久后开始
  minAi: 3, // 群里 AI 多于 2 人（即 ≥3）才自动聊
  minGapMs: 8000,
  maxGapMs: 20000,
  maxRounds: 40, // 防跑飞：一轮挂机最多自动发多少条
};

/**
 * 友圈（社交里的"朋友圈"）
 *   · **玩家**能发说说；**AI 好友也会发**（离线超过 20 分钟补一批，见 MOMENT_FEED）
 *   · 由审查 AI 决定**哪些 AI 来评论**：没明确指向 → 随机 2~4 个；
 *     明确 @ 了谁 → 被指的那位 + 另外随机 1 位；好友 < 3 位 → 全部好友都来
 *   · 评论的 AI **默认点赞**
 *   · 节奏（用户拍板）：发完 10~30s 出第一条；之后每条之间 2~30s，直到该评的都评完
 */
export const MOMENTS = {
  maxPosts: 30, // 最多留多少条说说
  maxChars: 200, // 说说长度上限
  /**
   * 单条评论长度上限（用户拍板：**别截断**自己写的话）。
   * 只做一个很宽的安全上限，正常长度的评论（哪怕写成两三行）都不会被切。
   */
  commentMaxChars: 160,
  /** 评论最多几行（换行是允许的，但也别真写成小作文） */
  commentMaxLines: 4,
  maxComments: 40, // 每条说说最多留多少条评论
  minCommenters: 2, // 没明确指向时，最少几个人来评
  maxCommenters: 4, // 最多几个人
  mentionExtra: 1, // 明确 @ 了谁时，额外再来 1 个人
  firstMinMs: 10000, // 第一条评论：10~30s
  firstMaxMs: 30000,
  gapMinMs: 2000, // 后续每条之间：2~30s
  gapMaxMs: 30000,
  /**
   * ★ 玩家**回复了某位 AI 的评论**之后，它隔多久再回（用户拍板 1~5s）：
   * 太快像机器人，太慢玩家以为它不理人。
   */
  replyMinMs: 1000,
  replyMaxMs: 5000,
};

/**
 * 离线期间 AI 自己发友圈（用户拍板）
 *   · 离线 **超过 20 分钟** → 随机挑 **1~2 位**好友，各发 **1~2 条**说说
 *   · 说说时间同样落在"玩家不在线"的那段时间里（按人设作息模拟，见 clock.js）
 *   · 每条随机 **0~10 个赞**；评论 **1~3 条**，**只由玩家的好友来发**
 *     （绝不出现非好友评论 —— 用户明确要求）
 */
export const MOMENT_FEED = {
  minAwayMs: 20 * 60 * 1000,
  minFriends: 2, // 好友太少就没人评论，跳过
  maxAuthors: 2,
  maxPostsEach: 2,
  maxLikes: 10,
  maxComments: 3,
  /** 评论之间的间隔（相对上一条）：2~40 分钟，都落在离线窗口内 */
  commentGapMinMs: 2 * 60 * 1000,
  commentGapMaxMs: 40 * 60 * 1000,
  /** 每条说说之间错开多久发出去（真实时间，避免一次性刷屏） */
  staggerMs: 1500,
};

/**
 * 在线期间 AI 自己发友圈（用户拍板）
 *   · 玩家**在线**（停在大厅、没开着面板、也没在打牌）时定时触发
 *   · 前提：好友 **多于 2 人**（≥3，人太少没人来评）
 *   · 间隔 **10~30 分钟**随机（刚进来第一次 2~5 分钟，不然玩家永远看不到）
 *   · 内容三类随机：**吐槽游戏**（牌桌 / 运气 / 队友，但**绝不许暴露"我是 AI"**）、
 *     **吐槽生活**、**分享心情** —— 提示词与本地兜底都覆盖这三类（见 ai/moments.js）
 *   · 同样：随机点赞（≤10，只从玩家好友里挑）+ 1~3 条共同好友评论（不含作者），
 *     评论之间**只错开 1~3 秒真实时间**（不像离线补发那样隔几十分钟）
 *   · **上限保护**：MOMENTS.maxPosts 是 30 条，定时发**不能把玩家自己的说说挤掉** ——
 *     剩 minFreeSlots 条以内就跳过这一次（宁可少发也不挤），见 app.js 的 maybeOnlineMoment
 */
export const ONLINE_MOMENT = {
  minFriends: 2, // 好友数**大于**这个值（≥3）才触发
  minGapMs: 10 * 60 * 1000, // 每 10~30 分钟随机来一条
  maxGapMs: 30 * 60 * 1000,
  firstMinMs: 2 * 60 * 1000, // 进游戏后第一次：2~5 分钟
  firstMaxMs: 5 * 60 * 1000,
  maxPostsEach: 1, // 一次只发 1 条（不刷屏）
  maxLikes: 10, // 点赞最多 10 个（和离线那套一个口径）
  maxComments: 3, // 1~3 条评论
  commentMinMs: 1000, // 每条评论之间错开 1~3 秒（真实时间）
  commentMaxMs: 3000,
  likeLeadMinMs: 600, // 点赞比第一条评论早 0.6~1.8 秒（"先划到、后留言"）
  likeLeadMaxMs: 1800,
  /** 说说条数保护：剩这么几条以内就跳过（别把玩家的说说挤出 30 条上限） */
  minFreeSlots: 6,
  /** 一直不满足条件（在打牌 / 开着面板）时，最多连着跳过几次就收手，不空转 */
  maxSkips: 24,
  /** 允许的三类话题（随机挑一类，三类都会出现） */
  kinds: ['game', 'life', 'mood'],
};

/**
 * AI 改名（用户拍板）：
 *   · 只有**聊天里明确聊到改名、而且它自己答应了**才会改（审查时额外判一次）
 *   · 名字不超过 8 个字；改过之后写进记忆：`改名：旧名→新名，又改名更新的名`
 *   · 重置存档 → 名字回到人设里的默认名
 */
export const RENAME = {
  maxChars: 8, // 名字长度上限
  maxHistory: 6, // 记忆里最多记几次改名（旧名 + 后面几次）
  cooldownMs: 60000, // 刚改过名一分钟内不再改（免得聊着聊着反复换）
};

/** 群聊（PRD §2.20） */export const GROUP = {
  maxGroups: 5, // 最多建几个群
  minMembers: 2, // 至少拉 2 位好友才能建群（加上你 = 3 人群）
  maxMembers: 10, // 群成员上限（和好友上限一致）
  recent: 15, // ★ 把最近 15 条群消息作为提示词交给发言的 AI（用户拍板）
  /** 两条回复之间的间隔：2~3 秒，模拟真人在群里一条条回 */
  replyMin: 2000,
  replyMax: 3000,
  /** 建群后主动打招呼的条数（0 = 不主动说） */
  kickoff: 2,
  maxChars: 60, // 单条群消息长度上限（比私聊宽一点，群里话可以多说两句）
  maxReplyChars: 40, // AI 群消息的建议长度
  maxHistory: 60, // 每个群保留最近多少条消息
  chooseTimeout: 8000, // "该谁回答" 那一次调用的超时
  maxMentions: 4, // 点名最多让几个人回答（防止刷屏）
  /** 群人数 → 大概几个人回（人会挑，最少 1 个、最多 4 个） */
  replyRange: [
    { min: 8, lo: 2, hi: 4 },
    { min: 5, lo: 2, hi: 3 },
    { min: 3, lo: 1, hi: 2 },
    { min: 0, lo: 1, hi: 1 },
  ],
};

/**
 * 拍一拍（用户拍板）
 *   · **双击**好友 / 群成员的头像触发（私聊与群聊都有），像微信那样
 *   · 聊天里插一条居中系统提示（文案见 data/nudgeLines.js，一人一句）
 *   · 被拍的 AI 回一句符合性格的短话（模型优先，失败用本地兜底）
 *   · **防刷屏**：同一个人短时间内重复拍只生效一次（双击本来就快，很容易连点）
 */
export const NUDGE = {
  /** 节流窗口：同一个 AI 在这个时间内被重复拍，只生效一次（毫秒） */
  cooldownMs: 4000,
  /** 系统提示与 AI 回复之间的"打字"停顿（毫秒），太快像机器 */
  replyDelayMs: 600,
  /** 被拍之后的回应长度上限（1 句、不超过 18 字 —— 用户拍板） */
  maxChars: 18,
};

/** 好友系统（好感度 + memory） */export const FRIEND = {
  /**
   * 初始好感度 = **0（陌生）**（用户拍板）。
   * 档位：0~20 陌生 / 20~40 点头之交 / 40~60 朋友 / 60~80 密友 / 80~100 挚友
   */
  startAffinity: 0,
  maxAffinity: 100,
  maxMemory: 16, // 每个好友最多记多少条 memory（超了就把相似的合并，见 ai/friend.js 的 compressMemory）
  maxMatchChars: 120, // 「对局」这条记忆的长度上限（50~100 字概括，留点余量）
  /**
   * 「友圈」记忆里各留多少个字：玩家说说的开头 + 我评论的内容。
   * 太长会把提示词撑满，太短又对不上号（还要用它认"同一条说说"）
   */
  momentEchoChars: 24,
  /** 友圈记忆里，"我和玩家最后 3 轮对话"每句留多少字（整条上限见分类的 limit） */
  momentThreadChars: 14,
  momentRounds: 3,
  maxHistory: 40, // 每个好友保留最近多少条聊天
  /** ★ 私聊提示词里给 AI 看最近多少条聊天（用户拍板：15 条） */
  recent: 15,
  maxReplyChars: 25, // 好友回复长度上限（要短、要像真人）
  maxMemoryChars: 40, // 单条 memory 长度上限（合并后可能稍长，40 字够放"身份：山东临沂人、学生、大一"）
  /** 合并时的硬上限：万一 AI 一直合不动，超过这个数就先淘汰最旧的，别无限涨 */
  maxMemoryHardCap: 24,
  maxDelta: 5, // 单次对话好感度变化上限
  /** 删好友的惩罚：好感 -5（记忆留着，加回来时它还认得你） */
  removeAffinityPenalty: 5,
  maxFriends: 10, // 好友上限（PRD §2.12）
  // 一起打一局也加好感：自己邀请的好友 +3，随机匹配正好碰上 +1（没加好友的不算）
  playAffinityInvited: 3,
  playAffinityMatched: 1,
  /** ★ 五子棋：一局 +2（无论输赢，见 GOMOKU.affinityPerGame） */
  playAffinityGomoku: 2,
  /**
   * ★ AI 主动发消息的上限（用户拍板）：
   *   同一个 AI **连着发满 2 条、玩家一句都没回** → 它就不再主动发了；
   *   所有好友都被这条规则挡住时，谁都不再主动发，直到玩家回一句。
   *   （玩家加新好友不受影响：新好友的计数从 0 开始。）
   */
  maxUnansweredPings: 2,
  /**
   * 恋人关系（PRD §2.12.1）：
   *   · 只有好感度**满 100**、而且**当前还没有恋人**时，才会去审查"玩家是不是在表白"
   *   · 全局**只能有 1 个恋人**；已经有了就跳过表白审查（不再调用、也不会换人）
   *   · 已经是恋人之后，审查的是**有没有明确提出分手**；分了就把好感度落回「朋友」
   */
  loverAffinity: 100,
  // 分手后掉到 40（落在「朋友」区间 40~60 里 —— 分手了但还是朋友，和记忆里那句话对得上）
  breakupAffinity: 40,
  /**
   * ★ 表白被拒的代价（用户拍板）：**好感 -10**。
   *
   *   · 好感退回 90 → 不再是"满"，所以想再表白必须**重新刷满 100**（聊天 / 送礼 / 一起打牌）
   *     —— 这就是"如果再满可以再次表白"，不需要额外的时间冷却
   *   · 傲娇人设例外：她嘴上拒绝、心里答应 → 判定为**成功**，不扣好感
   *     （见 data/personas.js 的 isTsundere）
   */
  confessRefusePenalty: 10,

  /**
   * ★ 加好友改成"发申请"（用户拍板）：
   *   点「加好友」→ 弹浮窗**编辑申请文案** → 发送 → **延迟 1~5 秒**对方通过 →
   *   聊天里先出现"我发的申请"，再让 TA **回这条申请**（两条消息的样子）。
   */
  requestMaxChars: 40, // 申请文案长度上限
  acceptMinMs: 1000, // 对方"看了一眼"再通过：最快 1 秒
  acceptMaxMs: 5000, // 最慢 5 秒
};

/**
 * AI 身家（PRD §2.14）：全局共享、跨局变化，AI 按身家决定称号与能不能进场
 * 初始分配偏小（幂律），避免开局满地都是"富可敌国"
 */
export const AI_ECON = {
  minStart: 1000,
  maxStart: 2000000,
  startSkew: 3, // 幂律指数：越大越集中在 minStart 附近
  maxBeans: 999999999, // 身家上限，防手动改档溢出

  // 每局结束（玩家正常打完，不含中途退出）：没参战的 AI 按当前身家浮动
  idleGainRate: 0.2, // 最多 +20%
  idleLoseRate: 0.1, // 最多 -10%
  idleGainChance: 0.5, // 涨 / 跌各一半

  // 身家过低领低保（每个 AI 每日一次）
  reliefThreshold: 1000,
  reliefBeans: 5000,

  // 极端兜底：某场次一个能打的 AI 都没有时，给 6 个非好友 AI 输血
  rescueMidCount: 3,
  rescueMidMin: 10000,
  rescueMidMax: 100000,
  rescueHighCount: 3,
  rescueHighMin: 100000,
  rescueHighMax: 2000000,
};

/** 道具（商城的第三类，牌桌上用来表达情绪，不影响出牌） */
export const ITEMS = [
  { id: 'flower', name: '鲜花', emoji: '🌸', price: 500, desc: '送对手一朵花，夸他打得好', tone: '#FF9EC4' },
  { id: 'tomato', name: '番茄', emoji: '🍅', price: 500, desc: '往对手脸上扔番茄', tone: '#FF5C5C' },
  { id: 'egg', name: '鸡蛋', emoji: '🥚', price: 500, desc: '经典的抗议方式', tone: '#FFD166' },
  { id: 'cappuccino', name: '卡布奇诺', emoji: '☕', price: 2000, desc: '给阿姨倒一杯卡布奇诺', tone: '#C89B6A' },
];

export const itemById = (id) => ITEMS.find((i) => i.id === id) || null;

/**
 * 礼物（商城的第四类商品，专门用来送给好友）
 *
 * 和"道具"分开是有意的：道具是**牌桌上**扔给对手表达情绪的（鲜花/番茄/鸡蛋），
 * 礼物是**好友界面**送出去的（玫瑰/礼盒/钻石/戒指）——两套库存、两套上限，
 * 所以这里单独一个列表，`ensureItems` 会把两边都初始化（都存在 save.items 里）。
 *
 * 好感度加成由用户拍板：玫瑰 +1 / 礼盒 +3 / 钻石 +10 / 戒指 +20。
 * `minAffinity` 是**AI 回赠**时的门槛（关系不到位，它不会送贵的东西）；
 * 玩家自己送不受这个限制（想送什么是玩家自己的事）。
 */
export const GIFTS = [
  { id: 'g_rose', name: '玫瑰花', emoji: '🌹', price: 1000, affinity: 1, minAffinity: 0, desc: '一支玫瑰，随口一句喜欢', tone: '#FF7BAC' },
  { id: 'g_box', name: '礼盒', emoji: '🎁', price: 9999, affinity: 3, minAffinity: 20, desc: '包了个礼盒，认真挑的', tone: '#FFD166' },
  { id: 'g_diamond', name: '钻石', emoji: '💎', price: 88888, affinity: 10, minAffinity: 60, desc: '一颗钻石，分量不轻', tone: '#6FD6FF' },
  { id: 'g_ring', name: '戒指', emoji: '💍', price: 520000, affinity: 30, minAffinity: 80, desc: '一枚戒指，520 的意思不用多说', tone: '#E0B3FF' },
];

export const giftById = (id) => GIFTS.find((g) => g.id === id) || null;

/** 赠礼规则（用户拍板：每天每人最多 3 次） */
export const GIFT = {
  /** 玩家送给**同一位好友**的每日上限 */
  dailyPerFriend: 3,
  /** AI 送给玩家的每日上限（每个 AI 各算） */
  aiDailyMax: 3,
  /**
   * AI 回赠的财力约束：
   *   · 礼物价格 ≤ 自己身家的 `beanRatio`（不会为了送礼把自己掏空）
   *   · 送完不能低于 `beanFloor`（低于这个数它自己都进不了场）
   */
  beanRatio: 0.25,
  beanFloor: 5000,
  /** 「礼物」这条记忆的长度上限 */
  memoryLimit: 120,
};

/** 设置默认值（PRD §2.9 / §8-9） */
export const DEFAULT_SETTINGS = {
  bgmVolume: 70,
  sfxVolume: 70,
  animSpeed: 'normal',
  cardBack: 'back_01',
  model: 'deepseek-flash',
  thinking: false,
  useTextures: false, // 牌面默认用 emoji + HTML 渲染；放入自己的 PNG 美术后再打开
  shuffle: true, // 每局重新洗牌；关掉则每局发同一副牌（复盘 / 教学用）
  nickname: '',
  /**
   * ★ 玩家自己的 DeepSeek API Key：**存在本机存档里**（localStorage + save/ddz_save.json），
   *   两者都不会进版本库（见 .gitignore 的 save/*）。
   *   优先级：存档里填了就用存档的，没填才回落到上面 CONFIG.apiKey（源码默认，仓库里是空的）。
   *   这样"仓库干净"和"本机不用每次重贴"两件事就不打架了。
   */
  apiKey: '',
};
