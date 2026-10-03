/**
 * 好友对话层（PRD §2.12）
 *  - 回复：注入人设 + 好感度 + memory，要求短、像真人
 *  - 分析：每次对话额外调一次 AI，判断这句是加好感还是掉好感、要不要写进 memory
 *  - 没有 Key / 断网时全部走本地兜底（关键词启发式），功能不缺失
 */
import { CONFIG, FRIEND, RENAME } from '../config.js';
import { cleanAiName, nameIsUsable } from '../store/aiNames.js';
import { callDeepSeek } from './chat.js';
import {
  affinityTier, sortedMemory, listSelfMemory, listPlayerMemory, selfDisclosureLine, isMatchMemory, memoryGroups,
  callNameOf,
} from '../store/friends.js';
import { ownedLines, OWNER_PLAYER, OWNER_SELF, OWNER_SYSTEM, mergeMemoryLocally, looksLikeSelfFact, selfAboutPlayer } from '../data/memory.js';
import { MEMORY_CATEGORIES, MEMORY_EXCLUDE, isSelfMemory } from '../data/memory.js';
import { pickChatLine, chatBucket } from '../data/chatLines.js';
import { styleRules, maxReplyCharsOf, decorateLine, personaReactionLine } from '../data/style.js';
import { genderPromptLine, agePromptLine, isTsundere } from '../data/personas.js';
import { timeContextLine, lastChatGapLine, stampText, sameDay } from '../data/clock.js';

function sanitize(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
}

/**
 * 把"最近这局"写进提示词，并且**严格区分参加没参加**
 *  - 参加了：可以聊这一局（提细节也没问题）
 *  - 没参加：**一个字都不给**，改聊别的（问候、自己的事、问近况、约下次），
 *    避免出现"明明没和他打，却发'还来吗'"这种穿帮
 */
/**
 * 「刚打完的那一局」怎么交给模型
 * @param {{lastMatch:object, joined:boolean, modeName:string, force?:boolean}} p
 *   force = 主动开口（一局刚打完）：这时候**必须**拿最新那局当话题（用户要求）
 */
function matchLines({ lastMatch, joined, modeName, force = false }) {
  if (!joined) return []; // 没参加 → 不提这局，连摘要都不给
  if (!lastMatch || !lastMatch.summary) return [];
  const out = force
    ? [`★ 你们刚一起打完的那一局（**这就是"刚刚那局"，开场就聊它**）：${lastMatch.summary}`]
    : [`你们刚一起打完的一局：${lastMatch.summary}`];
  out.push(force
    ? '开场第一句就围绕这一局说：比分、谁赢了、谁手气好、打得顺不顺；'
      + '**别聊更早的旧局**（记忆里更靠下的对局都不算"刚刚那局"），也别只说"刚打完一局"这种空话。'
    : '你可以自然地提这一局（提细节也没问题），但不要每句都提。');
  if (modeName) out.push(`那局玩的是「${modeName}」，别把模式说错了（斗地主/小猫钓鱼是两种玩法）。`);
  return out;
}

/* ------------------------------------------------------------------ */
/*                              回复                                    */
/* ------------------------------------------------------------------ */
/**
 * 「你自己的身家 + 称号」这一行 —— **所有对话场景共用同一份口径**
 * （私聊 / 群聊 / 房间弹幕 / 友圈都调它）
 *
 * ★ 实时注入（用户拍板）：每次调用都现算，所以 AI 的豆子被加减、
 *   或者称号档位变了（称号跟着身家走），下一句提示词里就是新的。
 * ★ 只是**背景知识**：别刻意提钱、别拿称号当话题。
 * @param {number|null} myBeans 这个 AI 自己的身家（null/undefined = 不注入）
 * @param {string} [myTitle] 它当前戴的称号名
 */
export function aiEconomyLine(myBeans, myTitle) {
  if (myBeans == null) return '';
  return `你自己的身家：💰${Number(myBeans).toLocaleString()}`
    + `${myTitle ? `（戴着称号「${myTitle}」）` : '（还没戴称号）'}`
    + '——这是背景知识：**别刻意提钱、也别拿称号当话题**，聊到了可以自然带一句。';
}

/**
 * 最近几句对话（给模型看的），**跨天的地方插一条日期小标**。
 *
 * ★ 用户报的问题：昨晚 23 点聊完、今天 11 点再来，AI 接着昨晚的场景说"怎么还没睡"。
 *   原因是历史里只有"朋友：…/你：…"，没有"这些是昨天说的"。
 *   所以第一天的那条前面挂上 `（9月23日 23:10）`，同一天内不重复挂。
 * @param {{role:string, text:string, at?:number}[]} chat
 * @param {Date} [now]
 */
export function historyLines(chat, now = new Date()) {
  // ★ 系统提示（"对方已经同意了你的好友申请"这种）不进对话历史 ——
  //   否则模型会把它当成自己说过的一句话
  const recent = (Array.isArray(chat) ? chat : []).filter((m) => m && m.role !== 'sys').slice(-FRIEND_RECENT);
  let prevDay = now;
  return recent.map((m) => {
    const at = Number(m && m.at) || 0;
    const d = at ? new Date(at) : null;
    let mark = '';
    if (d && Number.isFinite(d.getTime()) && !sameDay(d, prevDay)) {
      mark = sameDay(d, now) ? '（今天）' : `（${stampText(at, now)}）`;
    }
    if (d && Number.isFinite(d.getTime())) prevDay = d;
    return `${mark}${m && m.role === 'me' ? '朋友' : '你'}：${m ? m.text : ''}`;
  });
}

/* ------------------------------------------------------------------ */
export function buildFriendMessages({
  persona, friend, text, myBeans, myTitle, lastMatch, joined, modeName, lover = false, playerGender = '',
  playerName = '', playerIdentity = '', giftNote = '',
}) {
  const tier = affinityTier(friend.affinity, lover);
  const history = historyLines(friend.chat);
  // 记忆分两组：关于玩家的 / **你自己**说过的设定（后者不能前后矛盾）
  // 用 memoryGroups：自带排序（对局/友圈按时间从新到旧，最上面那条才是"刚刚那局"）
  const grp = memoryGroups(friend);
  const mine = grp.self;
  const playerList = grp.player;
  const sysList = grp.system;
  // ★ 每条都标清楚归属：`- 【关于玩家】身份：山东临沂人` / `- 【你自己】自设：老家=南方小城`
  //   否则模型会把玩家的身份当成自己的（用户报的问题）
  const playerMemory = playerList.length
    ? ownedLines(playerList, OWNER_PLAYER).join('\n')
    : '（还没有特别的记忆）';
  // ★ 系统记录单独一块：对局 / 友圈 / 改名 / 关系（不是"玩家说过的话"）
  const sysMemory = sysList.length
    ? '【系统记录】你经历过的（对局 / 友圈 / 改名 / 关系）——**这些不是"玩家说过的话"**，'
      + `是系统替你记的事件：\n${ownedLines(sysList, OWNER_SYSTEM).join('\n')}`
    : '';
  const limit = maxReplyCharsOf(persona, FRIEND.maxReplyChars);
  const style = styleRules(persona, { maxChars: limit, scene: 'chat' });

  const system = [
    '你在一个卡牌游戏 App 里，扮演玩家的好友，两人正在**私聊**（像微信那样）。',
    `你是「${persona.name}」。你的人设：${persona.prompt || (persona.tags || []).join('、')}`,
    genderPromptLine(persona),
    agePromptLine(persona),
    // ★ 玩家是谁：一段明确的背景知识（昵称 + 性别 + 该怎么叫他）——**放在靠前的位置**，
    //   免得模型在长提示词里漏看，回头问"你叫什么"（用户报的问题）
    playerIdentity || playerGender,
    // ★ 看人下菜：有些 AI 对"玩家性别 + 好感度"有额外反应（例如说的道理）
    personaReactionLine(persona, { playerGender, affinity: friend ? friend.affinity : 0, lover }),
    (!playerIdentity && playerName) ? `玩家的昵称是「${playerName}」。` : '',
    timeContextLine(),
    lastChatGapLine(friend.chat),
    ...style,
    `当前好感度：${friend.affinity}/100（${tier.label}）`,
    mine.length
      ? '**你自己**在聊天里说过的设定（**必须保持一致，不能前后矛盾**）：\n'
        + ownedLines(mine, OWNER_SELF).join('\n')
      : '',
    lover
      ? '**你和玩家已经是恋人了** —— 语气可以亲近、可以撒娇或护着他，'
        + '但保持你的人设，别变成另一个人；也别每句都强调关系。'
      : '',
    // ★ 归属写清楚：这一组是**玩家的**，别当成自己的
    `你记得【关于玩家】的事：\n${playerMemory}`,
    sysMemory,
    // ★ 前缀说明：三块记忆长得像，必须讲清楚谁是谁
    '（记忆分三块：【关于玩家】= **他**的事，例如「称呼：小徐」＝你该叫他小徐；'
      + '【你自己】= **你**自己说过的事，例如「自设：称呼=卡片」＝他该叫你卡片；'
      + '【系统记录】= 对局 / 友圈 / 改名这类系统记的事件，**别当成玩家说的话**。'
      + '**读的时候别弄反，说的时候更别弄反。**）',
    // ★ 玩家是谁：只告知昵称就够（用户明确说不要"别认错人"那套说教）
    (!playerIdentity && playerName) ? `玩家的昵称是「${playerName}」。` : '',
    // ★ 对局记忆的顺序：最新那条才是"刚刚那局"
    sysList.some(isMatchMemory)
      ? '（对局记忆**按时间从新到旧**列在上面，带 [月/日 时:分] 的是对局；'
        + '只有**最上面那条**才是"刚刚那局"，别把更早的一局当成刚打完的。）'
      : '',
    // ★ 一局刚打完：要聊牌局就聊**最新那一局**，别翻旧账
    joined && lastMatch && lastMatch.summary
      ? '★ 如果聊到牌局，只聊**最新那局**（时间最晚的那条「对局：」）——别把更早的旧局当成刚打完的。'
      : '',
    // ★ 刚收到礼物（用户要求：赠礼之后好友要据此回应）
    giftNote
      ? `★ 玩家刚刚送了你一件礼物（${giftNote}）—— **先谢他**，然后按你们的关系说话：`
        + '关系生分就客气道谢，关系亲密可以随便一点、甚至调侃他破费；别装没看见、也别只说"谢谢"两个字。'
      : '',
    /**
     * ★ 玩家像在表白（用户口径：**别动不动婉拒**）
     *   系统那边按"异性 + 单身 + 没有明确拒绝 → 就会同意"来判，
     *   所以回复也要顺着这个口径来，避免"嘴上拒绝、系统却判定成功"的割裂感。
     */
    isConfession(text)
      ? '★ 玩家这句话像是在跟你表白 —— **除非你有明确的理由**（已经有喜欢的人、你们真的走不到一起），'
        + '否则别故意拒绝、别装傻打岔；愿意就自然一点答应下来（傲娇可以嘴硬，但别编假理由）。'
      : '',
    // ★ 关系到哪一档，决定你能说多少自己的事
    selfDisclosureLine(friend, { isLover: lover }),
    ...matchLines({ lastMatch, joined, modeName }),
    // 自己的身家 + 称号是"背景知识"（实时现算，见 aiEconomyLine）
    aiEconomyLine(myBeans, myTitle),
    '【重要：场景】这是好友私聊，**不是在牌桌上**：',
    '  · 不要用"开局""出牌""叫地主""抢地主""要不起""管上"这类牌桌喊话的口气',
    // ★ 有没有一起打刚才那局，决定了"能不能聊那局牌"。
    //   这里必须跟着 joined 走：之前写死了"可以聊你们刚才打的那局"，
    //   结果用「添加好友」随便加的人也会说"刚刚那局你…"（用户报的 bug）
    joined
      ? '  · 可以聊生活、心情、工作学习，也可以聊你们刚才打的那局牌，但要像朋友闲聊'
      : '  · **你和他没有一起打过刚才那局**，所以别提牌局、别提"刚刚那局""上一把"，'
        + '也别说牌桌上的事；聊生活、心情、最近在忙什么就行',
    '【要求】',
    `1) 像真人微信聊天一样回一句，不超过 ${limit} 个字，可以用口语和语气词。`,
    '2) 好感度低就冷淡敷衍，好感度高就热情亲近，但都要保持你的人设说话风格。',
    '3) 不要客服腔、不要解释、不要引号、不要颜文字堆砌。'
      + '**除了下面说的分隔行，整条回复里不要出现任何换行。**',
    /**
     * ★ 用户拍板：长回复**拆不拆由你自己判断**（不许多发，也不许一口气堆一大段）。
     *   用户明确否掉了"程序按标点硬拆"的做法（会拆坏语气），所以判断权在模型这边：
     *   觉得是两段话就写分隔行，觉得一口气说完就一条 —— 程序只认你自己写的那个记号。
     */
    `3.5) **要不要分两条发，你自己看着办**（这是你的判断，不是格式任务）：`
      + '  · 如果这一句里其实装着**两段不同的意思**——先惊讶再转折、先回应再提要求、'
      + '先感慨再嘱咐、"…倒是…/不过…/话说回来…"这种拐弯——那就分两条：'
      + '**第一段写完后单独一行写 ---，再写第二段**。'
      + `  · 如果就是一口气说完的一句话，哪怕有 ${Math.round(limit * 0.6)} 个字，也就一条，**别写 ---**。`
      + '  · 最多两条；两条加起来仍然不超过上面说的字数；'
      + '**每条都得是能单独看懂的完整话**，绝对不许把一句话从中间劈开（不许拆在"的/了/吗/啊"这种地方）。'
      + '  · 例子（想分两条时就这样写）：\n'
      + '    哎哟，闹了半天你才二十三\n'
      + '    ---\n'
      + '    那阿姨可不能由着你喊宝宝了，差着辈儿呢',
    '4) 记忆里有「称呼：X」就用 X 称呼他，可以自然提到你记得的事，但不要生硬复述。',
    '5) 好感度低时话短、爱答不理；好感度高时主动关心、语气亲近。',
    '6) ★ 你**一直就知道**玩家是谁（见上面「玩家是谁」），所以**绝不要问"你叫什么""怎么称呼你"**，'
      + '也不要让他自我介绍。',
  ].filter(Boolean).join('\n');

  const user = [
    history.length ? `最近的对话：\n${history.join('\n')}` : '',
    `朋友刚说：${text}`,
    '请回一句。',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/* ------------------------------------------------------------------ */
/*                              分析                                    */
/* ------------------------------------------------------------------ */
/**
 * 分析提示词
 * @param {{allowConfess?:boolean, askBreakup?:boolean}} opts
 *   allowConfess = 好感满且还没有恋人 → 顺便审查"是不是在表白"
 *   askBreakup   = 已经是恋人 → 顺便审查"是不是在提分手"
 */
export function buildAnalyzeMessages({
  persona, friend, text, reply, allowConfess = false, askBreakup = false, playerName = '',
  giftOptions = [], giftLeft = 0, myBeans = 0,
}) {
  const catLines = MEMORY_CATEGORIES.map((c) => `  · ${c.label}（${c.hint}）：例「${c.label}：${EXAMPLE[c.key] || '…'}」`);
  const extra = [];
  if (allowConfess) extra.push('"confess": true/false');
  if (askBreakup) extra.push('"breakup": true/false');
  extra.push('"rename": "字符串"');
  extra.push('"gift": "礼物 id 或空字符串"');
  const system = [
    '你在做一段好友对话的分析，只输出 JSON，不要任何解释、不要代码块。',
    '★ 你拿到的是**一来一回的整段对话**（玩家说了什么 + 你回了什么），'
      + '要**两行一起看**、看懂前因后果，再决定：该不该写记忆、写谁的、好感度加减多少。',
    `格式：{"delta": 整数, "memory": "字符串", "self": {"方面": "内容"}${extra.length ? `, ${extra.join(', ')}` : ''}}`,
    `delta（好感度变化，范围 ${-FRIEND.maxDelta}~${FRIEND.maxDelta}）：`,
    '  · 夸奖、关心、道谢、送礼、示好 → 正数（+1~+3，特别真诚可到 +4/+5）',
    '  · 普通闲聊、打招呼 → 0 或 ±1',
    '  · 冒犯、辱骂、命令、嫌弃 → 负数',
    'memory（要不要长期记住**玩家**的事）：按下面几类判断，写成「分类：内容」',
    ...catLines,
    `  · 一次只写一条最重要的，不超过 ${FRIEND.maxMemoryChars} 个字，写成短语不要整句。`,
    '  · 没有值得长期记住的内容就填空字符串 ""。',
    '  ★ ★ 这里**只能写关于玩家（对方）的事**：写之前先问自己"这句话说的是**他**，还是**我**？"',
    '    · 说的是**他** → 写进 memory（例：玩家说"叫我小徐" → `称呼：小徐`＝你该叫他小徐）',
    '    · 说的是**我** → 写进 self（例：你说"叫我卡片就好" → `{"称呼":"卡片"}`＝他该叫你卡片）',
    '    · **memory 里绝对不要出现"我"字**（"我"永远指你自己，会让人分不清）。',
    '不要写入 memory 的内容：',
    ...MEMORY_EXCLUDE.map((x) => `  · ${x}`),
    '',
    'self（**你自己**在聊天里临时补充的设定）：',
    '  · 你的固定设定在下面的人设里；如果聊到了**人设里没写**的事（老家在哪、什么职业、'
      + '爱吃什么、养没养宠物、几点睡…），而你**顺口给了个回答**，就必须写进 self，',
    '    否则下次再问你就可能说出另一个答案，前后矛盾。',
    '  · 写成 {"方面": "内容"}，方面用 2~4 个字的短词（老家 / 职业 / 爱好 / 宠物 / 作息 …），',
    `    内容不超过 ${FRIEND.maxMemoryChars} 个字。例：{"老家":"杭州"}、{"职业":"大学生","宠物":"养了只橘猫"}`,
    '  · **只写你这次新说的**；这次没说新的就写 {}。',
    '  · 如果这次说的和「你已经说过的设定」里某条**冲突**，就按新说法写（系统会按"方面"覆盖旧的）。',
    '  · 玩家的事不要写进 self（那是 memory 的职责）。',
    // ★ 用户报的 bug：玩家昵称叫"汽水偶像"，模型就写了 `自设：称呼对方=管对方叫汽水偶像`
    //   —— 你叫玩家他自己的名字，怎么可能是"你的设定"？"对方"永远不是你。
    '  · ★ "方面"必须是**你自己的属性**（老家 / 职业 / 爱好 / 作息 / 宠物 / 说话风格…）。',
    '    凡是**关于怎么称呼他、他在你眼里是什么人**这类，**一律不许写进 self**：',
    '      · 玩家让你改口叫他什么 → 写进 **memory** 的 `称呼：XXX`（这是"你该怎么叫他"）',
    '      · 他只是用自己的昵称 / 名字 → **什么都不用记**（你叫他名字是理所当然的）',
    '      · 反例（绝对不要这样写）：`{"称呼对方":"管对方叫汽水偶像"}`、`{"玩家":"他叫小徐"}`',
    '        —— "对方/玩家"指的都是他，不是你，写进 self 就会变成"你自己叫汽水偶像"。',
    '  · 你自己说过的话、你自己的习惯也算 self。例：',
    '      玩家说：来打游戏吗',
    '      你（卡片）回答：好呀哈哈哈，我睡前都会刷会儿手机再睡',
    '      → self：{"讲话风格":"被拉来打游戏时爱用哈哈哈","作息":"睡前刷手机，睡得晚"}',
    '      （这两句说的都是**你**，绝不能写进 memory）',
    '',
    '★★★ 最容易错的地方：**别把两个人的话记反了** ★★★',
    '  · memory 只认「玩家说：」那一行；self 只认「你（……）回答：」那一行。',
    '  · 尤其是**两边都在说同一个话题**（都说了老家 / 都说了职业）的时候，特别容易串。',
    '  · 例子（照着这个来）：',
    '      玩家说：我是南京人',
    '      你（冷面棋手）回答：我是溧阳的，离你那儿不远',
    '      → memory 记**玩家**的： "身份：南京人"',
    '      → self   记**你自己**的： {"老家":"溧阳"}',
    '    **反过来写就是错的**，会导致你下次把自己的老家说成南京。',
  ];
  if (allowConfess) {
    system.push(
      '',
      'confess（**玩家是不是在明确表白**）：',
      '  · 只有**明确的表白**才算：说"我喜欢你""喜欢你很久了""我们在一起吧""做我女朋友/男朋友""我想和你谈恋爱"这类',
      '  · **不算**的情况：普通夸奖（你真厉害）、玩笑（我宣布我爱你）、说喜欢某样东西、暧昧但没说破、只是舍不得走',
      '  · 没表白就填 false',
      '  · **这里只判断"有没有表白"**，答不答应由系统按规则来判（不用你决定），你别在这上面纠结。',
    );
  }
  if (askBreakup) {
    system.push(
      '',
      'breakup（**玩家是不是在明确提出分手**）：',
      '  · 只有**明确提分手**才算：说"我们分手吧""分手""我们还是做朋友吧""别在一起了"这类',
      '  · **不算**的情况：闹脾气（我生气了）、撒娇（你不理我就分手）、开玩笑、只是抱怨、'
        + '说"再这样下去要分手了"这种假设',
      '  · 这一项只判断"有没有提分手"，**不要去判断要不要挽留** —— 你会同意（虽然难过）',
      '  · 没提就填 false',
    );
  }
  system.push(
    '',
    'rename（★ 你这次**要不要改名**）：',
    '  · 只有**这一来一回里真的在聊改名**（玩家说"给你起个新名字""以后叫你X吧""你改名叫X好不好"，'
      + '或者你主动说"我想换个名字"），**而且你（AI）那句话里明确接受了这个新名字**，才填。',
    '  · 填"你答应下来的那个新名字"，**只填名字本身**，不要引号、不要"叫"、不要解释。',
    `  · 名字不超过 ${RENAME.maxChars} 个字。`,
    '  · **不算**的情况（一律填空字符串 ""）：玩家只是夸你名字好听、开玩笑随口一提，'
      + '你没答应；玩家说"我叫X"（那是玩家自己的名字）；玩家给别人改名；'
      + '你自己顺口提了一句"想改名"但玩家没接、你也没定下来。',
    '  · 你自己就是这个名字了 —— 以后所有场合都用它自称。别频繁改名，一次对话最多改一次。',
  );

  /**
   * ★ gift（用户要求：审查 AI 多判一层"这次要不要送点什么"，送礼是 AI 可执行的操作）
   *   三个约束必须同时满足才会走到这里：**关系够**（门槛由系统筛过）、
   *   **今天还有次数**（每天每人最多 3 次）、**它自己买得起**（身家约束）。
   *   所以这里给的清单就是"它现在真的能送的东西"，不在清单里的一律不许送。
   */
  if (giftOptions.length && giftLeft > 0) {
    system.push(
      '',
      `gift（★ 你这次**要不要送玩家一件礼物**，今天还能送 ${giftLeft} 次）：`,
      '  你现在能送的（只许从这份清单里挑，别的都不行）：',
      ...giftOptions.map((g) => `    · ${g.id} = ${g.emoji}${g.name}（💰${g.price}，好感 +${g.affinity}）`),
      '  · **大多数时候应该填 ""（不送）** —— 不是每句话都送礼，那样很假。',
      '  · 值得送的时刻：玩家刚送了东西给你、聊得特别投缘、道谢/道歉、节日或纪念、'
        + '他心情不好你想哄一下、关系刚好有进展。',
      '  · **不要**为了讨好就送最贵的：按你现在的身家和你们的关系挑，'
        + `你现在身家 💰${Number(myBeans || 0).toLocaleString()}，贵的东西送了你自己就紧了。`,
      '  · 玩家冒犯你、冷淡敷衍时**不要送**（填 ""）。',
      '  · 一次最多送一件；不送就填空字符串 ""。',
    );
  }

  const mine = listSelfMemory(friend);
  const call = callNameOf(friend);
  const user = [
    `角色：${persona.name}（当前好感度 ${friend.affinity}/100${askBreakup ? '，是玩家的**恋人**' : ''}）`,
    `你的人设（固定设定）：${persona.prompt || (persona.tags || []).join('、')}`,
    playerName ? `玩家的昵称是「${playerName}」—— 你叫他这个名字是理所当然的，**不算你的设定**。` : '',
    call ? `玩家让你叫他「${call}」（这条已经在 memory 里了，别重复记）。` : '',
    `你现在的名字是「${persona.name}」；如果这次真改了名，rename 里填新名字。`,
    mine.length ? `你已经说过的设定（不要和这些矛盾）：${mine.join('；')}` : '你已经说过的设定：（还没有）',
    friend.memory && friend.memory.length ? `你记得关于玩家的事：${sortedMemory(friend).filter((m) => !isSelfMemory(m)).join('；')}` : '你记得关于玩家的事：（无）',
    // ★ 一来一回一起给：只看玩家那一句会不懂前因后果（用户要求）
    '【这段对话（两行要一起看）】',
    `玩家说：${text}`,
    reply ? `你（${persona.name}）回答：${reply}` : '（你这次没有回复）',
    '请结合这两行判断：该记什么（记谁）、好感度加减多少。只输出 JSON。',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: user },
  ];
}

/* ------------------------------------------------------------------ */
/*         ★ 防"记反"：一条信息必须来自"对的那个人"才收下                  */
/* ------------------------------------------------------------------ */
/**
 * 真实出现过的 bug：
 *   玩家：「我是南京人」    AI：「我是溧阳的，离你那儿不远」
 *   → 模型把两边记反了：self 写成 {"老家":"南京"}、memory 写成「身份：溧阳人」
 *   → 之后再问它哪儿人，它答"我是南京人，离溧阳不远"，彻底窜了
 *
 * 光靠提示词叮嘱不够（模型就是会串），所以这里加一道**硬校验**：
 *   一条自设必须能在 **AI 自己那句话** 里找到；只出现在 **玩家那句话** 里 → 判定记反，丢掉。
 *   一条玩家记忆必须能在 **玩家那句话** 里找到；只出现在 **AI 那句话** 里 → 一样丢掉。
 * 只有当"能证明它来自对方的话"时才丢，模型合理改写的说法（两边都没原样出现）一律保留 ——
 * 宁可多记一条，也不误删。
 */

/** 去掉标点空白，便于比对 */
const PUNCT = /[\s，。！？,.!?；;、:：""''「」『』（）()【】\[\]…~～-]/g;
const bare = (s) => String(s || '').replace(PUNCT, '');

/**
 * value 有没有出现在 text 里
 * 先整串比；再去掉"人 / 的 / 了"这类虚词比；最后退化成 2 字滑窗
 * （模型常把"溧阳人"写成"江苏省溧阳市"，整串比不上，但"溧阳"能比上）
 */
export function appearsIn(value, text) {
  const v = bare(value);
  const t = bare(text);
  if (!v || !t) return false;
  if (t.includes(v)) return true;
  const slim = v.replace(/[人了的]/g, '');
  if (slim.length < 2) return false;
  if (t.includes(slim)) return true;
  for (let i = 0; i + 2 <= slim.length; i += 1) {
    if (t.includes(slim.slice(i, i + 2))) return true;
  }
  return false;
}

/**
 * ★ 这一条"自设"其实是在说**玩家**吗？（用户报的 bug）
 * 实现在 data/memory.js（store 层的存档修复也要用，避免 store ↔ ai 互相 import）
 */
export { selfAboutPlayer };

/**
 * 过滤"自设"：只留**它自己那句话**里说过的
 * @param {object} self { 方面: 内容 }
 * @param {string} replyText AI 自己那句
 * @param {string} playerText 玩家那句
 * @param {string} [playerMemory] 已经收下的"玩家记忆"——同一条信息不能同时算两个人的
 * @param {string} [playerName] 玩家昵称（用来挡"称呼对方=玩家的名字"这类假自设）
 */
export function guardSelfFacts(self, replyText, playerText, playerMemory = '', playerName = '') {
  const out = {};
  for (const [aspect, value] of Object.entries(self || {})) {
    const v = String(value || '').trim();
    if (!v) continue;
    // 已经算成"玩家的事"了 → 不能同时算成你的设定（这是记反的另一种形态）
    if (playerMemory && appearsIn(v, playerMemory)) continue;
    // ★ 这条其实是在说玩家（怎么称呼他 / 就是他的名字）→ 不是你的自设
    if (selfAboutPlayer(aspect, v, playerName).hit) continue;
    if (appearsIn(v, replyText)) { out[aspect] = v; continue; } // 确实是它自己说的
    if (appearsIn(v, playerText)) continue; // 只在玩家的话里 → 记反了，丢掉
    out[aspect] = v; // 两边都没原样出现（模型合理改写）→ 保留
  }
  return out;
}

/** 私聊提示词里给 AI 看最近多少条聊天（用户拍板 15 条；改动只需动 config 的 FRIEND.recent） */
const FRIEND_RECENT = FRIEND.recent || 15;

/**
 * 这句话看起来是不是**在说 AI 自己**（而不是玩家）？
 * 实现在 data/memory.js（store 层也要用，避免 store ↔ ai 互相 import）
 */
export { looksLikeSelfFact };

/**
 * 归属路由（★ 用户报的"分不清是谁的"就靠这个）：
 * 模型经常把**自己说的话**填进"关于玩家"那一栏，或者反过来。
 * 与其把这条信息丢掉，不如**挪到正确的栏里**：
 *   · 只出现在 AI 那句话里 → 那是它自己的设定（自设）
 *   · 只出现在玩家那句话里 → 那是关于玩家的
 *   · 两边都出现 → 算玩家的（宁可记玩家的，也别让 AI 冒领）
 *   · 两边都没出现（模型自己总结/改写的）→ 留在原来那一栏
 *
 * 例子：玩家说"我是南京人"，AI 回"我是溧阳的"；
 *   模型给 memory=`身份：溧阳人`、self={老家:南京} → 两边正好记反，
 *   这里会把 `身份：溧阳人` 挪进自设（方面=身份），把 `老家=南京` 挪成玩家的 `身份：南京`。
 *
 * @returns {{memory:string, self:object, movedToSelf:string[], movedToPlayer:string[]}}
 */
export function routeFacts({
  memory = '', self = {}, playerText = '', replyText = '', playerMemory = '', playerName = '',
} = {}) {
  const labelOf = (raw) => {
    const cut = Math.max(raw.indexOf('：'), raw.indexOf(':'));
    return cut > 0 ? String(raw).slice(0, cut).trim() : '';
  };
  const contentOf = (raw) => {
    const cut = Math.max(raw.indexOf('：'), raw.indexOf(':'));
    return String(cut >= 0 ? String(raw).slice(cut + 1) : raw).trim();
  };

  let mem = String(memory || '').trim();
  const selfOut = {};
  const movedToSelf = [];
  const movedToPlayer = [];

  // ① "关于玩家"栏里、其实只有 AI 说过的 → 挪进自设
  if (mem) {
    const content = contentOf(mem);
    const inMe = appearsIn(content, playerText) || (playerMemory && appearsIn(content, playerMemory));
    const inAi = appearsIn(content, replyText);
    /**
     * 什么情况下判定"这条其实是在说 AI 自己"：
     *   · 只出现在 AI 那句话里（inAi，且玩家没说过）
     *   · 或者：这条记忆里出现了第一人称「我」，而**玩家那句话里压根没说"我"** ——
     *     那这个"我"只可能是指 AI 自己。例：
     *       `习惯：玩家拉我打游戏时用哈哈哈`（是它的说话习惯）
     *     反过来，玩家说过"我爱喝奶茶"，模型写成 `偏好：我爱喝奶茶` 时，
     *     因为玩家话里有"我"，就不会被误搬。
     */
    const playerSpokeFirst = /我|俺/.test(String(playerText || ''));
    const selfish = looksLikeSelfFact(content) && !playerSpokeFirst;
    if ((!inMe && inAi) || selfish) {
      const aspect = labelOf(mem) || '自述';
      selfOut[aspect] = content.slice(0, FRIEND.maxMemoryChars);
      movedToSelf.push(mem);
      mem = '';
    }
  }

  // ② 自设里、其实只有玩家说过的 → 挪成"关于玩家"
  for (const [aspect, value] of Object.entries(self || {})) {
    const v = String(value || '').trim();
    if (!v) continue;
    const inMe = appearsIn(v, playerText) || (playerMemory && appearsIn(v, playerMemory));
    const inAi = appearsIn(v, replyText);
    if (!inAi && inMe) {
      const label = (MEMORY_CATEGORIES.find((c) => c.label === aspect) || {}).label || '身份';
      if (!mem) {
        mem = `${label}：${v}`.slice(0, FRIEND.maxMemoryChars);
        movedToPlayer.push(`${aspect}=${v}`);
      }
      continue;
    }
    selfOut[aspect] = v;
  }

  /**
   * ③ 自设里"其实是在说玩家"的（用户报的：
   *    `自设：称呼对方=管对方叫汽水偶像`，而"汽水偶像"就是玩家的昵称）
   *    → 从自设里拿掉；如果抠得出一个称呼，就补一条 memory 的 `称呼：X`
   *      （"你该怎么叫他"本来就是玩家的事，不该变成"你自己叫什么"）。
   */
  for (const [aspect, value] of Object.entries(selfOut)) {
    const hit = selfAboutPlayer(aspect, value, playerName);
    if (!hit.hit) continue;
    delete selfOut[aspect];
    movedToPlayer.push(`${aspect}=${value}`);
    if (!mem && hit.name) mem = `称呼：${hit.name}`.slice(0, FRIEND.maxMemoryChars);
  }

  return { memory: mem, self: selfOut, movedToSelf, movedToPlayer };
}

/**
 * 过滤"玩家记忆"：只出现在 AI 那句话里的，说明那是 AI 自己的事，不该记成玩家的
 * @param {string} memory 「分类：内容」或一整句
 */
export function guardPlayerMemory(memory, playerText, replyText) {
  const raw = String(memory || '').trim();
  if (!raw) return '';
  const cut = Math.max(raw.indexOf('：'), raw.indexOf(':'));
  const content = cut >= 0 ? raw.slice(cut + 1) : raw;
  if (appearsIn(content, playerText)) return raw; // 玩家自己说过
  if (appearsIn(content, replyText)) return ''; // 只在 AI 的话里 → 记反了
  return raw; // 两边都没提（模型总结出来的）→ 保留
}

/** 从模型输出里抠出 JSON（容忍 ```json 包裹与前后废话） */
export function parseAnalysis(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    const deltaRaw = Number(obj.delta);
    const delta = Number.isFinite(deltaRaw)
      ? Math.max(-FRIEND.maxDelta, Math.min(FRIEND.maxDelta, Math.round(deltaRaw)))
      : 0;
    const memory = typeof obj.memory === 'string' ? sanitize(obj.memory).slice(0, FRIEND.maxMemoryChars) : '';
    const confess = obj.confess === true || obj.confess === 'true';
    const breakup = obj.breakup === true || obj.breakup === 'true';
    const rename = typeof obj.rename === 'string' ? cleanAiName(obj.rename) : '';
    // gift：只认字符串；具体是不是"现在能送的"由 analyzeMessage 用清单再校一次
    const gift = typeof obj.gift === 'string' ? obj.gift.trim() : '';
    // self：{ 方面: 内容 } —— 只留合法条目，方面限 10 字、内容限 maxMemoryChars
    const self = {};
    const rawSelf = obj.self && typeof obj.self === 'object' ? obj.self : null;
    if (rawSelf) {
      for (const [k, v] of Object.entries(rawSelf)) {
        const aspect = sanitize(k).slice(0, 10);
        const value = sanitize(v).slice(0, FRIEND.maxMemoryChars);
        if (aspect && value) self[aspect] = value;
      }
    }
    return { delta, memory, self, confess, breakup, rename, gift };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*                          本地兜底                                    */
/* ------------------------------------------------------------------ */
const POSITIVE = ['谢谢', '谢啦', '厉害', '好棒', '喜欢', '可爱', '牛', '佩服', '辛苦', '爱你', '抱抱', '加油', '真好', '可爱', '帅', '漂亮', '靠谱', '开心'];
const NEGATIVE = ['笨', '滚', '讨厌', '闭嘴', '垃圾', '菜', '蠢', '烦人', '闭嘴', '差劲', '废物', '嫌弃', '恶心'];
/** 分析提示词里给每个分类配一个例子 */
const EXAMPLE = {
  call: '阿伟（对方让你这么叫他）',
  like: '爱喝奶茶 / 讨厌等人',
  plan: '答应下次带他上分',
  trait: '说自己有点社恐',
  ident: '大学生 / 在杭州',
  habit: '每天十点就睡',
};

/** 本地兜底：从一句话里抓「称呼 / 偏好 / 约定 / 性格 / 身份 / 习惯」 */
const TAIL = '([^\\s，。！？,.!?；;]{1,10})';
const MEMORY_PATTERNS = [
  { label: '称呼', re: new RegExp(`(?:你可以)?叫我\\s*${TAIL}`) },
  { label: '称呼', re: new RegExp(`我的名字(?:是|叫)\\s*${TAIL}`) },
  { label: '称呼', re: new RegExp(`我叫\\s*${TAIL}`) },
  { label: '偏好', re: new RegExp(`我(?:比较|很|超|挺|最)?(?:喜欢|爱|迷上?|常玩|经常玩|平时玩)\\s*${TAIL}`) },
  { label: '偏好', re: new RegExp(`我(?:最|很|比较)?讨厌\\s*${TAIL}`) },
  { label: '约定', re: new RegExp(`(?:下次|以后|明天|改天)\\s*${TAIL}`) },
  { label: '性格', re: new RegExp(`我(?:这个人|性格|脾气)\\s*${TAIL}`) },
  { label: '性格', re: new RegExp(`我(?:比较|有点|挺|特别)\\s*${TAIL}`) },
  { label: '身份', re: new RegExp(`我是\\s*${TAIL}`) },
  { label: '习惯', re: new RegExp(`我(?:每天|通常|一般|习惯|经常|晚上|早上)\\s*${TAIL}`) },
];

export function extractMemory(text) {
  const t = String(text || '');
  for (const { label, re } of MEMORY_PATTERNS) {
    const m = t.match(re);
    if (m) return `${label}：${m[1]}`.slice(0, FRIEND.maxMemoryChars);
  }
  return '';
}

/** 没有模型时的启发式判断 */
export function localAnalyze(text, { allowConfess = false, askBreakup = false, reply = '', persona = null } = {}) {
  const t = String(text || '');
  let delta = 0;
  for (const w of POSITIVE) if (t.includes(w)) { delta += 2; break; }
  for (const w of NEGATIVE) if (t.includes(w)) { delta -= 2; break; }
  const confess = allowConfess ? isConfession(t) : false;
  return {
    delta,
    memory: extractMemory(t),
    self: extractSelfMemory(reply),
    confess,
    breakup: askBreakup ? isBreakup(t) : false,
    gift: '', // 本地兜底不送礼（送礼由审查 AI 决定，模型不可用时宁可不送）
    local: true,
  };
}

/**
 * ★ 表白审查（用户拍板：**不让 AI 自由婉拒**，改成三条硬规则）
 *
 *   1) **必须异性** —— 同性之间走不到那一步
 *   2) **它必须单身** —— 依据是"之前聊过的内容里有没有涉及有对象"：
 *      提到过（自设 / 记忆 / 它自己说过的话）→ 不算单身；**从没提过 → 视为单身**
 *   3) **它没有明确拒绝** —— 回复里出现真实的拒绝理由才算拒；
 *      傲娇的"嘴硬式否认"（才不是 / 谁要跟你在一起 / 笨蛋）**不算拒绝**，按同意处理
 *
 * 三条都过 → **同意**（好感满 + 表白 → 成为恋人）。
 * 这条规则是纯函数，模型只负责"玩家这句是不是在表白"。
 *
 * @param {{persona:object, playerGender?:string, friend:object, reply?:string}} p
 *   playerGender: 'male' | 'female'（存档里的 save.gender）
 * @returns {{accept:boolean, reason:'ok'|'same-gender'|'has-partner'|'refused', evidence?:string}}
 */
export function reviewConfess({ persona, playerGender = '', friend = null, reply = '' } = {}) {
  // ① 异性
  const myGender = persona && persona.gender === 'f' ? 'f' : 'm';
  const hisGender = playerGender === 'female' ? 'f' : 'm';
  if (myGender === hisGender) return { accept: false, reason: 'same-gender' };
  // ② 单身（没提过有对象 = 单身）
  const evidence = partnerEvidenceOf(friend);
  if (evidence) return { accept: false, reason: 'has-partner', evidence };
  // ③ 没有明确拒绝（傲娇的嘴硬不算拒绝）
  if (isExplicitRefuse(reply, persona)) return { accept: false, reason: 'refused' };
  return { accept: true, reason: 'ok' };
}

/**
 * "之前聊过的内容"里有没有"它已经有对象"的证据
 * 看三处：它的记忆（含自设）、它自己说过的聊天记录
 * ★ 用户口径：**从没提过就视为单身**
 * @returns {string} 命中的那句话（没有就是空串）
 */
export const PARTNER_RE = new RegExp([
  '有(对象|男朋友|女朋友|男友|女友|老公|老婆|未婚夫|未婚妻|伴侣|家室|心上人|暗恋的人|喜欢的人)',
  '喜欢的人', '心里有(人|别人)', '已经有人了', '有人了',
  '已婚', '结婚了', '订婚', '在谈恋爱', '谈着',
].join('|'));

export function partnerEvidenceOf(friend) {
  if (!friend) return '';
  const lines = [];
  for (const m of (friend.memory || [])) lines.push(String(m || ''));
  for (const m of (friend.chat || [])) {
    if (m && m.role !== 'me') lines.push(String(m.text || ''));
  }
  return lines.find((l) => PARTNER_RE.test(l)) || '';
}

/**
 * 回复里是不是**明确拒绝**（真的给出理由的那种）
 *   · 傲娇：只有"真实理由"才算拒绝（"才不是""谁要跟你在一起"这类嘴硬不算）
 *   · 其它人设：出现拒绝词就算
 */
const REFUSE_PHRASES = ['对不起', '抱歉', '不好意思', '有喜欢的人', '心里有人', '心里有别人', '有对象',
  '不可能', '做朋友', '还是朋友', '只当朋友', '只把你当', '不合适', '不愿意', '算了吧', '拒绝', '别想了'];
/** 傲娇的"真拒绝"：给出真实理由的才拦得住她 */
const TSUNDERE_REAL_REFUSE = ['有喜欢的人', '心里有人', '心里有别人', '有对象', '不可能', '只把你当朋友',
  '只当朋友', '真的不行', '别想了'];
export function isExplicitRefuse(reply, persona = null) {
  const t = String(reply || '');
  if (!t) return false;
  const words = isTsundere(persona) ? TSUNDERE_REAL_REFUSE : REFUSE_PHRASES;
  return words.some((w) => t.includes(w));
}

/**
 * 本地兜底：从 AI 那句回复里判断它答没答应（没有模型时用）
 * 现在和"规则审查"口径一致：**没有明确拒绝就算答应**（傲娇的嘴硬不算拒绝）。
 */
export function localAcceptConfess(reply, { persona = null } = {}) {
  return !isExplicitRefuse(reply, persona);
}

/**
 * 本地兜底：从**AI 自己那句回复**里抠出"临时补充的设定"
 * 例：「我是杭州人」→ { 老家: '杭州' }；「我养了只橘猫」→ { 宠物: '一只橘猫' }
 * 宁可漏，不要误抓（抓到的会一直影响后续对话）
 */
const SELF_PATTERNS = [
  { aspect: '老家', re: /我(?:是|老家在|老家是|来自)([^\s，。！？,.!?；;]{2,8}?)(?:人|的)/ },
  { aspect: '老家', re: /我老家([^\s，。！？,.!?；;]{2,8})/ },
  { aspect: '职业', re: /我是(?:个|一名|做)?([^\s，。！？,.!?；;]{2,8}?)(?:的|工作|上班)/ },
  { aspect: '职业', re: /我(?:在|做)([^\s，。！？,.!?；;]{2,8}?)(?:工作|上班|公司)/ },
  { aspect: '爱好', re: /我(?:平时)?(?:喜欢|爱)([^\s，。！？,.!?；;]{2,10})/ },
  { aspect: '宠物', re: /我(?:家)?养了([^\s，。！？,.!?；;]{1,10})/ },
  { aspect: '作息', re: /我(?:一般|通常|每天)?([0-9一二三四五六七八九十]+点(?:就)?(?:睡|起))([^\s，。！？,.!?；;]{0,4})/ },
];

export function extractSelfMemory(replyText) {
  const t = String(replyText || '');
  const out = {};
  if (!t) return out;
  for (const { aspect, re } of SELF_PATTERNS) {
    const m = t.match(re);
    if (m && m[1] && !out[aspect]) out[aspect] = m[1].trim();
  }
  return out;
}

/**
 * 本地兜底判断"是不是在明确表白"
 * 宁可漏判也不误判：只有出现明确的表白句式才算（"你真厉害""我爱打牌"不算）
 */
const CONFESS_RE = [
  /(我|俺)(真的|一直|早就|好)?(很|挺|超|非常)?(喜欢|爱)(你|上你)(了|啦|呀|哦|的)?/,
  /(我们)?(在|交|处)(一起|往)(吧|好不好|行吗|好吗)/,
  /做(我|俺)(的)?(女朋友|男朋友|对象|老婆|老公|恋人|女友|男友)/,
  /(当我|做我)(女|男)朋友/,
  /(想|要)和?你?(谈恋爱|处对象|在一起)/,
  /(嫁|娶)给我/,
  /你就是我的(唯一|全部)/,
];
/** 玩笑标记：出现这些基本就不是真表白（除非前面有否定，"不是开玩笑的"） */
const JOKE_RE = /(开玩笑|别当真|逗你|闹着玩|耍你)/;
const NOT_JOKE_RE = /(不是|没(有)?|别)(在)?(开玩笑|逗你|闹着玩)/;

export function isConfession(text) {
  const t = String(text || '');
  if (!t) return false;
  if (JOKE_RE.test(t) && !NOT_JOKE_RE.test(t)) return false;
  return CONFESS_RE.some((re) => re.test(t));
}

/**
 * 本地兜底判断"是不是在明确提分手"
 * 同样宁可漏判也不误判：闹脾气（"你不理我就分手"）不算
 */
const BREAKUP_RE = [
  /我们?(还是)?(分手|散了吧|算了吧)/,
  /(分手|分开|分开吧)吧/,
  /(还是)?做(回)?(普通)?朋友吧/,
  /别(在一起|谈)了/,
  /(不想|不要)(和|跟)你(在一起|谈)(了)?/,
  /(结束|算了)(吧|这段关系)/,
];
export function isBreakup(text) {
  const t = String(text || '');
  if (!t) return false;
  // 假设句 / 赌气先排掉
  if (/(再|要是|如果|不然)[^，。！？]{0,8}(就|要)(分手|分开)/.test(t)) return false;
  if (/(不理我|不陪我|惹我生气)/.test(t) && !/^我们?(分手|分开)/.test(t)) return false;
  return BREAKUP_RE.some((re) => re.test(t));
}

/**
 * 没有模型时的兜底回复：用**私聊语料**（不碰牌桌台词）
 * @param {{joined?:boolean}} opts joined=false 时过滤掉"刚那局…"这类语料，
 *   免得没一起打过那局的 AI 也说"刚那局我打得不怎么样"（用户报的 bug）
 */
export function localReply(persona, text, { joined = true } = {}) {
  const bucket = chatBucket(text);
  const style = (persona && persona.style) || 'balanced';
  // 没一起打过那局 → 把"刚那局…"这类语料过滤掉
  const filter = joined ? null : (l) => !/局|上一?把/.test(l);
  return decorateLine(pickChatLine(bucket, style, undefined, filter), persona);
}

/**
 * 本地兜底的开场白：用**私聊语料**（绝不能用牌桌台词，否则会穿帮成"我来了，直接开局"）
 * @param {object} persona
 * @param {'opener'|'added'|'lover'} kind added = 刚通过好友申请时的第一句；
 *   lover = ★ 恋人专属（离线回来时模型不可用，不能还是那句通用问候 —— 用户拍板）
 */
export function localGreeting(persona, kind = 'opener') {
  const style = (persona && persona.style) || 'balanced';
  /**
   * ★ 恋人兜底：走 `lover` 语料桶（"想你了 / 今天有点累，想跟你说说话"这种）。
   *   万一那桶取不到（语料被改没了），pickChatLine 自己会退回通用回应池，不会哑巴。
   */
  if (kind === 'lover') return decorateLine(pickChatLine('lover', style), persona);
  return decorateLine(pickChatLine(kind, style), persona);
}

/**
 * 好友主动搭话的提示词：结合 memory 与好感度，开启一个话题
 *
 * @param {boolean} loverTone ★ 恋人这一次可以**表达想念 / 倾诉**（用户拍板）：
 *   由"离线回来主动发消息"这条路径传进来（见 ui/app.js 的 scheduleReturnPing），
 *   而且**只有真恋人**才拿得到这一行 —— 否则全员撒娇就崩了（见 proactiveMessage 的过滤）。
 */
export function buildProactiveMessages({
  persona, friend, myBeans, myTitle, lastMatch, joined, modeName, lover = false, loverTone = false, playerGender = '',
  playerName = '', selfMatch = false, playerIdentity = '', now = new Date(),
}) {
  const tier = affinityTier(friend.affinity, lover);
  // 排序 + 分组（对局最新的排最前）——玩家 / 系统记录 / 它自己的设定，分三块
  const grp2 = memoryGroups(friend);
  const playerOnly = grp2.player;
  const mine = grp2.self;
  const sys = grp2.system;
  const limit = maxReplyCharsOf(persona, FRIEND.maxReplyChars);
  const style = styleRules(persona, { maxChars: limit, scene: 'chat' });
  const system = [
    `你是「${persona.name}」，在卡牌游戏 App 里主动给好友（玩家）发**私聊消息**。`,
    `你的人设：${persona.prompt || (persona.tags || []).join('、')}`,
    genderPromptLine(persona),
    agePromptLine(persona),
    playerIdentity || playerGender,
    // ★ 看人下菜：有些 AI 对"玩家性别 + 好感度"有额外反应（例如说的道理）
    personaReactionLine(persona, { playerGender, affinity: friend ? friend.affinity : 0, lover }),
    // ★ now 可注入：离线补发的招呼要用"模拟出来的发送时刻"，
    //   这样它会说"这点还没睡？"或"中午吃了吗"，而不是按玩家上线的时刻说话
    timeContextLine(now),
    lastChatGapLine(friend.chat, now),
    ...style,
    `你和玩家的关系：${tier.label}（好感度 ${friend.affinity}/100）`,
    mine.length
      ? '**你自己**在聊天里说过的设定（不能矛盾）：\n' + ownedLines(mine, OWNER_SELF).join('\n')
      : '',
    lover ? '**你和玩家已经是恋人了** —— 主动找他说句话时，可以带点恋人之间的关心，但别腻。' : '',
    /**
     * ★ 恋人的这一句可以"表达想念 / 倾诉"（用户拍板）：只在 loverTone 时多注入这一行，
     *   普通好友拿不到（调用方已用 isLover 过滤一道，这里再用 lover 兜一道）。
     */
    (lover && loverTone)
      ? '★ 这次可以**说想他**（"想你了""有点想你了"），或者跟他讲讲你今天的心事'
        + '（累了、烦了、碰到什么事）—— 像真的恋人发消息那样自然。'
        + '但**别腻**：不要每句都提关系、不要一堆"宝贝/亲爱的"叠在一起，也别写成小作文，一两句就够。'
      : '',
    `你记得【关于玩家】的事：\n${playerOnly.length ? ownedLines(playerOnly, OWNER_PLAYER).join('\n') : '（还不太了解他）'}`,
    sys.length
      ? '【系统记录】你经历过的（对局 / 友圈 / 改名 / 关系）——**不是"玩家说过的话"**：\n'
        + ownedLines(sys, OWNER_SYSTEM).join('\n')
      : '',
    (!playerIdentity && playerName) ? `玩家的昵称是「${playerName}」。` : '',
    selfDisclosureLine(friend, { isLover: lover }),
    ...matchLines({ lastMatch, joined, modeName, force: joined }),
    aiEconomyLine(myBeans, myTitle),
    '【重要：场景】这是好友私聊，**不是在牌桌上**：',
    '  · 不要用"开局""出牌""叫地主""要不起"这类牌桌喊话的口气',
    '【要求】',
    joined
      ? '1) 你们刚一起打完一局：**开场就聊这条最新对局**（上面 ★ 那句给的就是它），'
        + '说点具体的（比分/谁赢/谁手气好/打得顺不顺），聊完可以顺口约他再来一局。'
        + '**不要**聊更早的旧局、也不要只说"刚打完一局"这种空话。'
      : (selfMatch
        ? '1) 你**刚刚自己打了一局**（玩家**不在场**）：可以随口提一嘴你自己那局（赢了输了、手气怎么样、'
          + '碰到什么对手），也可以完全聊别的话题（打招呼、吐槽、说说你今天在忙什么、问他最近怎么样）。'
          + '★ **绝对不能提玩家**：不能说"你打得怎么样""刚才那局你…"，就当玩家跟那局无关（事实也是如此）。'
        : '1) 你**没有**和他一起打刚才那局，所以**不要提牌局、不要问"还来吗"**。'
          + '随便起个话题：打个招呼、说说你自己的事（今天手气、刚跟别人打得怎么样、在忙什么）、'
          + '问他最近怎么样，或约他改天一起玩。'),
    `2) 不超过 ${limit} 个字，像真人发微信：可以问他忙不忙、提一件你记得的事、或约他改天一起玩。`,
    '3) 不要客服腔、不要引号、不要换行；好感度低就随口搭一句，好感度高可以亲昵、可以调侃。',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: '发一句开场话。' },
  ];
}

/** 好友主动搭话（失败就用本地问候语） */
export async function proactiveMessage({
  persona, friend, myBeans, myTitle, lastMatch, joined, modeName, lover = false, loverTone = false, playerGender = '',
  playerName = '', selfMatch = false, playerIdentity = '', now = new Date(),
}) {
  /**
   * ★ 兜底也要分人（用户拍板）：非恋人**永远**拿不到 loverTone 这一行 / 这句兜底，
   *   哪怕调用方传错了也不会全员撒娇（过滤器放在最前面，两条路都吃它）。
   */
  const tone = !!lover && !!loverTone;
  try {
    const raw = await callDeepSeek(buildProactiveMessages({
      persona, friend, myBeans, myTitle, lastMatch, joined, modeName, lover, loverTone: tone, playerGender, playerName, selfMatch, playerIdentity, now,
    }));
    const out = sanitize(raw);
    if (out) return { text: out.slice(0, maxReplyCharsOf(persona, FRIEND.maxReplyChars) + 10), offline: false };
    throw new Error('空回复');
  } catch {
    // 模型不可用：恋人给一句专属的（"想你了"），普通好友仍是通用开场白
    return { text: localGreeting(persona, tone ? 'lover' : 'opener'), offline: true };
  }
}

/* ------------------------------------------------------------------ */
/*                          对外接口                                    */
/* ------------------------------------------------------------------ */
/**
 * 好友回复一句
 * @param {{persona:object, friend:object, text:string, myBeans?:number, myTitle?:string}} p
 *   myBeans / myTitle = 这个 AI **自己**的身家与称号（背景知识，聊天时会自然带出）
 * @returns {Promise<{text:string, offline:boolean}>}
 */
export async function friendReply({
  persona, friend, text, myBeans, myTitle, lastMatch, joined, modeName, lover = false, playerGender = '',
  playerName = '', playerIdentity = '', giftNote = '',
}) {
  try {
    const raw = await callDeepSeek(buildFriendMessages({
      persona, friend, text, myBeans, myTitle, lastMatch, joined, modeName, lover, playerGender, playerName, playerIdentity, giftNote,
    }));
    const out = sanitize(raw);
    const limit = maxReplyCharsOf(persona, FRIEND.maxReplyChars);
    /**
     * ★ 修复（用户报的 bug：很长的一段话没有分成两条发）：
     *   旧写法是 `splitReply(sanitize(raw))` —— 而 `sanitize()` 会把**所有换行换成空格**，
     *   模型辛苦写的"单独一行 ---"早就被抹平成 "… --- …"，分隔正则**永远匹配不上**，
     *   于是 `second` 恒为空 —— 拆两条的功能从来没真正生效过。
     *   现在改成**先按原样拆，再逐段 sanitize**。
     */
    if (out) {
      const parts = splitAndSanitize(raw, limit);
      if (parts.length) return { text: parts[0], second: parts[1] || '', offline: false };
    }
    throw new Error('空回复');
  } catch {
    return { text: localReply(persona, text, { joined }), second: '', offline: true };
  }
}

/**
 * 拆两条用的分隔行：**模型自己写的一整行记号**。
 *   用户明确要求"让 AI 自己判断，不要规则引擎硬拆"，所以这里**只认模型写下的这个记号**——
 *   标点、字数一概不参与判断，AI 不写记号就永远是一条。
 *   容错：横线（- / — / 一）/ 等号 3 个以上、前后带空格、写在句尾没换行，都算。
 */
export const REPLY_SPLIT_RE = /\n[ \t]*(?:-{3,}|—{3,}|={3,})[ \t]*(?=\n|$)/;

/** 模型没换行、把记号写在同一行里（"第一段 --- 第二段"）时的兜底 */
const REPLY_SPLIT_INLINE_RE = /[ \t]+(?:-{3,}|—{3,}|={3,})[ \t]+/;

/**
 * 把一条回复按分隔行拆成最多两段（模型没写记号就原样返回一条）
 *   · 只认模型写的分隔记号，不按标点/字数硬拆
 *   · 段内换行压成空格（单条气泡里不该有换行）
 *   · 万一模型写了 3 段以上，多出来的**并进第二段**，绝不丢字
 * @returns {string[]} 1~2 条
 */
export function splitReply(raw) {
  const src = String(raw || '').replace(/\r\n?/g, '\n');
  let parts = src.split(REPLY_SPLIT_RE);
  if (parts.length < 2) parts = src.split(REPLY_SPLIT_INLINE_RE);
  parts = parts.map((s) => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  // 只有分隔记号、没有正文的段丢掉（模型偶尔只吐一个 ---）
  parts = parts.filter((s) => !/^[-—=]{3,}$/.test(s));
  if (parts.length < 2) return parts.length ? [parts[0]] : [];
  return [parts[0], parts.slice(1).join(' ')];
}

/**
 * 先拆、再逐段 sanitize（顺序很关键，见 friendReply 里的注释）
 *   · 每段按 length + 10 的宽松口径裁一下（沿用老口径）
 * @returns {string[]} 0~2 条
 */
export function splitAndSanitize(raw, limit = FRIEND.maxReplyChars) {
  return splitReply(raw)
    .map((s) => sanitize(s).slice(0, limit + 10))
    .filter(Boolean);
}

/**
 * ★ 送礼的硬校验（用户要求：AI 送礼要看财力和关系，**不可能强行送最贵的东西给玩家**）
 *
 * 提示词里已经把"现在能送的清单"给了模型，但模型偶尔还是会硬送最贵的，
 * 所以这里以**系统清单**为准：不在清单里的一律作废；今天没次数了也不送。
 * @param {string} requested 模型回的礼物 id
 * @param {Array<{id:string}>} options 系统筛过的可送清单
 * @param {number} left 今天还剩几次
 * @returns {string} 合法的礼物 id，或 ''
 */
export function pickAllowedGift(requested, options = [], left = 0) {
  const id = String(requested || '').trim();
  if (!id || left <= 0) return '';
  return options.some((g) => g && g.id === id) ? id : '';
}

/**
 * 分析这句对话（★ 给的是**一来一回**：玩家那句话 + AI 回的那句，一起看前因后果）
 *  - 好感度变化 + 是否写入 memory（关于玩家的）
 *  - **self**：AI 自己临时补充的设定（人设里没写的那些），用来保证下次不矛盾
 *  - **confess**：好感满且还没有恋人时，顺便审查玩家是不是在表白
 *  - **breakup**：已经是恋人时，顺便审查玩家是不是在提分手
 * @param {{allowConfess?:boolean, askBreakup?:boolean, playerName?:string}} opts
 * @returns {Promise<{delta:number, memory:string, self:object, confess:boolean, breakup:boolean, offline:boolean}>}
 */
export async function analyzeMessage({
  persona, friend, text, reply, allowConfess = false, askBreakup = false, playerName = '',
  giftOptions = [], giftLeft = 0, myBeans = 0,
}) {
  let res;
  try {
    const raw = await callDeepSeek(buildAnalyzeMessages({
      persona, friend, text, reply, allowConfess, askBreakup, playerName, giftOptions, giftLeft, myBeans,
    }));
    const parsed = parseAnalysis(raw);
    if (!parsed) throw new Error('解析失败');
    res = { ...parsed, offline: false };
  } catch {
    res = localAnalyze(text, { allowConfess, askBreakup, reply, persona });
  }
  // ★ 最后统一过一遍"归属路由"：模型路径和本地兜底都走这里
  //   记反的（AI 说的填进了玩家栏 / 玩家说的填进了自设）会被**挪到正确的栏**，
  //   而不是简单丢掉 —— 信息是真的，只是站错了队（用户报的"分不清是谁的"）
  const routed = routeFacts({
    memory: res.memory,
    self: res.self,
    playerText: text,
    replyText: reply,
    playerName,
  });
  // ★ 改名：再走一道硬校验（必须在"聊到改名 + 它自己说了这个名字"时才认）
  const renamed = guardRename(res.rename, {
    playerText: text, replyText: reply, playerName, currentName: persona.name,
  });
  /**
   * ★ 送礼：**只认清单里有的**（清单是"关系够 + 今天还有次数 + 自己买得起"筛出来的）。
   *   模型偶尔会硬送最贵的（用户明确说"不可能强行送最贵的东西给玩家"），
   *   所以这里以系统清单为准：不在清单里的一律作废。
   */
  const gift = pickAllowedGift(res.gift, giftOptions, giftLeft);
  return {
    ...res,
    memory: routed.memory,
    self: routed.self,
    movedToSelf: routed.movedToSelf,
    movedToPlayer: routed.movedToPlayer,
    rename: renamed,
    gift,
  };
}

/* ------------------------------------------------------------------ */
/*                     记忆满了 → 让 AI 合并"相似的"                    */
/* ------------------------------------------------------------------ */
/**
 * 记忆超过上限（16 条）时，与其把最旧的丢掉，不如**把相似的并成一条**：
 *   偏好：喝奶茶 + 偏好：爱吃辣      → 偏好：喝奶茶、爱吃辣
 *   身份：山东临沂人 + 身份：学生 + 身份：大一 → 身份：山东临沂人、学生、大一
 * **对局记忆原样保留**（用户明确要求），自设（`自设：方面=内容`）也不合并。
 */
export function buildCompressMessages({ persona, friend, memory = [], limit = FRIEND.maxMemory, maxChars = FRIEND.maxMemoryChars }) {
  const list = (Array.isArray(memory) ? memory : []).map((m, i) => `${i + 1}. ${m}`).join('\n');
  const system = [
    '你在帮忙整理一份"人设记忆"清单（这些是某个 AI 记住的事，分两类：关于玩家的、以及它自己的设定）。',
    persona ? `这个 AI 是「${persona.name}」，人设：${persona.prompt || ''}` : '',
    '【要做的事】把**相似的记忆合并成一条**，让它更紧凑、但信息不丢。',
    '· 同一类（偏好 / 身份 / 习惯 / 约定…）的，用「、」并成一条：',
    '  `偏好：喝奶茶` + `偏好：爱吃辣` → `偏好：喝奶茶、爱吃辣`',
    '· 明显属于同一件事、只是分类名不同的，也可以并到一起（挑一个合适的分类名）：',
    '  `自设：爱好=看书` 和 `偏好：喝奶茶` 是同类信息 → 可以并成 `偏好：看书、喝奶茶`',
    '· 别硬凑：不同类、不相关的（例如"身份：学生"和"偏好：喝奶茶"）就分开留着。',
    '【硬性规则】',
    `1) 合并后**最多 ${limit} 条**，每条不超过 ${maxChars} 个字。`,
    '2) **以「对局：」「友圈：」开头的记忆原样照抄，不许合并、不许改写、不许删。**'
      + '（这两类是系统记的：谁赢了、友圈里聊过什么。）',
    '3) 「自设：方面=内容」这类不许合并（不同方面是不同的事），原样照抄。',
    '4) 不许编造清单里没有的信息；不许丢掉具体细节（名字、地名、职业、爱好都要留着）。',
    '5) 只输出一个 JSON 数组，元素是字符串，不要解释、不要代码块。',
    '   例如：["称呼：小徐","偏好：看书、喝奶茶","身份：山东临沂人、学生、大一","对局：…"]',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `现在的记忆（共 ${Array.isArray(memory) ? memory.length : 0} 条）：\n${list}\n\n请输出合并后的 JSON 数组。` },
  ];
}

/** 解析合并结果：只接受字符串数组，并且做最基本的"没丢东西"校验 */
export function parseCompressed(raw, { maxLines = FRIEND.maxMemory, maxChars = FRIEND.maxMemoryChars } = {}) {
  const s = String(raw || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let arr;
  try {
    arr = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = arr
    .map((m) => sanitize(m).slice(0, FRIEND.maxMatchChars))
    .filter((m) => m && /^[^：:]{1,6}[：:]/.test(m) || isSelfMemory(m)); // 必须是「分类：内容」或自设
  return out.length ? out.slice(0, maxLines) : null;
}

/**
 * 合并一个好友的记忆：AI 优先，失败/不可用时用本地合并兜底
 * @returns {Promise<{memory:string[], source:'llm'|'local', before:number, after:number}>}
 */
export async function compressMemory({ persona, friend }) {
  const before = (friend && friend.memory) || [];
  const local = () => {
    const merged = mergeMemoryLocally(before, {
      maxChars: FRIEND.maxMemoryChars, maxLines: FRIEND.maxMemory,
    });
    return { memory: merged, source: 'local', before: before.length, after: merged.length };
  };
  if (!before.length) return { memory: [], source: 'local', before: 0, after: 0 };
  try {
    const raw = await callDeepSeek(buildCompressMessages({ persona, friend, memory: before }));
    const parsed = parseCompressed(raw);
    // 校验：对局 / 友圈那几条必须还在（不许被模型吞掉）
    const keepKeys = ['对局：', '友圈：'];
    const beforeAuto = before.filter((m) => keepKeys.some((k) => String(m).startsWith(k)));
    const afterAuto = (parsed || []).filter((m) => keepKeys.some((k) => String(m).startsWith(k)));
    if (parsed && parsed.length && beforeAuto.length === afterAuto.length) {
      return { memory: parsed, source: 'llm', before: before.length, after: parsed.length };
    }
    return local();
  } catch {
    return local();
  }
}

/**
 * ★ 改名校验（用户拍板）：光靠提示词叮嘱不够，这里再加一道硬门槛。
 *
 * 必须同时满足才认：
 *   1. 这一来一回**真的在聊改名**（玩家那句或 AI 那句里出现改名/取名字这类字眼）
 *   2. 新名字**出现在 AI 自己那句话里**（它真的说出口了，不是模型凭空编的）
 *   3. 名字合法：不超过 8 个字、不是玩家的昵称、和现在这个名字不一样
 *
 * 任何一条不满足 → 视作"没改名"（返回空串），原样不动。
 * @returns {string} 可用的新名字；没有就返回空串
 */
export function guardRename(name, { playerText = '', replyText = '', playerName = '', currentName = '' } = {}) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const TALK = /(改名|改个名|换个名|取个名|起个名|名字|叫你|叫你什么|新名字|称呼)/;
  if (!TALK.test(String(playerText || '')) && !TALK.test(String(replyText || ''))) return '';
  // 它得真的把新名字说出口（"好呀，那你以后叫我星野吧"）
  if (!appearsIn(raw, replyText)) return '';
  const check = nameIsUsable(raw, { playerName, currentName });
  return check.ok ? check.name : '';
}

/** 供设置面板显示模型状态用 */
export { CONFIG };
