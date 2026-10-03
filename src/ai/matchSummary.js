/**
 * 对局概括（PRD §2.12「对局」记忆）
 * ------------------------------------------------------------------
 * 每打完一局（正常结算，退出不算），把这局浓缩成 50~100 字的局面概括。
 *
 * ★ 视角（用户报的 bug，已按此重写）：
 *   记忆是**存进 AI 脑子里**的，所以必须**站在那个 AI 的角度**写：
 *     · AI 自己 → 用「你」（"你赢了 11,244 豆"）
 *     · 玩家   → 写「玩家（昵称）」或昵称（"佛系少年手气差、接不上"）
 *     · 另一个 AI → 写名字
 *   以前是把"跟玩家说话"的那份（"你最后输了…"）直接存给 AI，
 *   结果 AI 以为输的是它自己。
 *   一局里两个 AI 可能一个赢一个输（地主 vs 农民），所以**每个参战 AI 各写一份**。
 *
 * 另外还有一份**第三人称**的概括进 `save.recentHands`（不针对某个 AI 读者，
 * 见 data/summaryText.js 的 neutralizeSummary）。
 *
 * 没网 / 没 Key 时用本地模板生成，长度同样落在 50~100 字，功能不缺失。
 */
import { callDeepSeek } from './chat.js';
import { neutralizeSummary } from '../data/summaryText.js';
import { movePhase } from '../core/gomoku.js';

// 方便别处直接用（store/friends.js 修老存档时也用它）
export { neutralizeSummary, hasSecondPerson } from '../data/summaryText.js';
export const MODE_NAME = { ddz: '斗地主', fishing: '小猫钓鱼', gomoku: '五子棋' };

/** 座位的名字（AI 用真名，玩家用昵称） */
function nameOf(names, seat) {
  return (names && names[seat]) || (seat === 0 ? '玩家' : `对手${seat}`);
}

function sanitize(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .trim();
}

/** 把长度掐到 50~100 字之间（长了截到句号处，且保证不超过上限） */
export function fitSummary(text, min = 50, max = 100) {
  let t = sanitize(text);
  if (!t) return t;
  if (t.length > max) {
    const cut = t.slice(0, max);
    const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('；'));
    t = lastPunct >= min - 10
      ? `${cut.slice(0, lastPunct)}。`
      : `${cut.slice(0, max - 1)}。`;
  }
  // 收尾：超长时保证末位是句号
  if (t.length > max) t = `${t.slice(0, max - 1)}。`;
  return t;
}

/**
 * 提示词：给模型足够的事实，让它写一段"像人回忆"的概括
 * @param {{kind?:string, room?:object, facts:string, names?:string[],
 *          selfName?:string, perspective?:'ai'|'neutral'}} opts
 *   perspective = 'ai'（默认）：站在 selfName 这个 AI 的角度写（它自己 = "你"）
 *   perspective = 'neutral'   ：第三人称、不许出现"你"（进 recentHands 用）
 */
export function buildSummaryMessages({
  kind = 'ddz', room, facts, names = ['玩家', '下家', '上家'], selfName = '', perspective = 'ai',
}) {
  const mode = MODE_NAME[kind] || '斗地主';
  const player = nameOf(names, 0);
  const isAiView = perspective === 'ai' && !!selfName;
  const system = isAiView
    ? [
      `这段记忆是写给「${selfName}」的（它是一起打这局的 AI 好友之一），以后聊天时它会读到自己这段回忆。`,
      `模式：${mode}；场次：${room ? room.name : '未知'}。`,
      '【视角：必须站在「' + selfName + '」的角度写】',
      `· **它自己** 用「你」："你赢了 11,244 豆""你鱼篓更多"。`,
      `· **玩家** 写「玩家（${player}）」或直接写「${player}」，不要用"你"指玩家。`,
      '· 另外的 AI / 对手写各自的名字。',
      '· 必须让读者一眼看出：**"你"这局是赢还是输、输赢多少豆**。',
      '【要求】',
      '1) 写一段 50~100 字的中文概括，口语、像人回忆一盘牌。',
      `2) **开头就要点明这是「${mode}」那局**（不能只写"上一局"，否则以后读这条记忆会分不清是哪种玩法）。`,
      '3) 要提到谁赢得干脆、有没有关键点（炸弹/倍数翻高/春天/一边倒/五五开）。',
      `4) 要提到玩家的表现（打得好 / 犹豫 / 手气差），可以带一点评价，但别刻薄。`,
      '5) 只写事实，不要编造没给你的牌；不要换行、不要引号、不要写"总结："之类的前缀。',
      '6) **不要写具体手数 / 步数 / 第几手**（谁记得住），要用"没几手就见分晓""中盘缠斗""磨了很久"'
        + '这种模糊说法；里面已经给了分档说法，照它的意思说就行。',
    ].join('\n')
    : [
      '你在帮一个牌局助手写"这一局的记忆"，供以后回忆。',
      `模式：${mode}；场次：${room ? room.name : '未知'}。`,
      '【最重要的规则：不许用"你"】',
      `· 一律用名字：玩家写「玩家（${player}）」或「${player}」，AI 写各自的名字。`,
      '· **绝对不要出现"你""你们""你的"**（这份文本没有固定读者，用"你"会让人认错主角）。',
      '【要求】',
      '1) 写一段 50~100 字的中文概括，第三人称、口语、像人回忆一盘牌。',
      `2) **开头就要点明这是「${mode}」那局**（不能只写"上一局"，否则以后读这条记忆会分不清是哪种玩法）。`,
      '3) 必须写清楚：**谁赢了、谁输了、输赢多少豆**（五子棋不涉及豆子，就写谁连成五子）。',
      '4) 要提到玩家的表现（打得好 / 犹豫 / 手气差），可以带一点评价，但别刻薄。',
      '5) 只写事实，不要编造没给你的牌；不要换行、不要引号、不要写"总结："之类的前缀。',
      '6) **不要写具体手数 / 步数 / 第几手**（谁记得住），要用"没几手就见分晓""中盘缠斗""磨了很久"'
        + '这种模糊说法；里面已经给了分档说法，照它的意思说就行。',
    ].join('\n');
  const user = [
    `对局信息：\n${facts}`,
    `称呼约定：玩家是「${player}」，另外两家是「${nameOf(names, 1)}」「${nameOf(names, 2)}」。`,
    isAiView
      ? `请站在「${selfName}」的角度写：它自己用"你"，玩家写名字，必须写清"你"这局是赢还是输。`
      : '请用第三人称写这段概括（不许出现"你"）。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 保证概括里**点明玩法**（用户报的 bug）
 *
 * 这条记忆是存进 AI 脑子里、以后聊天时读的。模型经常写成
 * "这局你执黑先手，和玩家下了 24 手，最后你输了" —— 一个字都没提这是**五子棋**，
 * 于是它下次只会说"上一局"，玩家问"我上一局玩的啥"它也答不上来。
 * 这里做一道硬兜底：文本里没有玩法名就补上（长度照旧压在 100 字内）。
 */
export function ensureModeNamed(text, kind) {
  const mode = MODE_NAME[kind] || '';
  const t = String(text || '').trim();
  if (!mode || !t) return t;
  if (t.includes(mode)) return t;
  return fitSummary(`${mode}：${t}`);
}

/** 本地兜底：用结算数据拼一段 50~100 字的概括（第三人称） */
export function localSummary({ kind = 'ddz', roomName = '', facts = '' }) {
  const mode = MODE_NAME[kind] || '斗地主';
  const head = `在${roomName || ''}${mode}那局，`;
  const body = String(facts || '').replace(/\n/g, '；').replace(/；+/g, '；');
  const tail = '这局记下了，下次可以拿它来调侃或者翻旧账。';
  return fitSummary(neutralizeSummary(`${head}${body}。${tail}`));
}

/**
 * 本地兜底的"AI 视角"版本：先把事实（本来就带名字）说清楚，
 * 再把"你（这个 AI）这局是赢还是输"点在开头，保证读者不会认错主角。
 */
export function localSummaryForAi({ kind = 'ddz', roomName = '', facts = '', selfName = '', selfWon = null }) {
  const mode = MODE_NAME[kind] || '斗地主';
  const head = `在${roomName || ''}${mode}那局，`;
  const mine = selfWon === true ? `你（${selfName}）赢了这局，`
    : selfWon === false ? `你（${selfName}）输了这局，`
      : '';
  const body = String(facts || '').replace(/\n/g, '；').replace(/；+/g, '；');
  return fitSummary(`${head}${mine}${body}。这局你记下了。`);
}

/**
 * 生成一局概括
 * @param {{kind:string, room:object, facts:string, names:string[],
 *          selfName?:string, selfWon?:boolean, perspective?:'ai'|'neutral'}} p
 * @returns {Promise<{text:string, offline:boolean}>}
 */
export async function summarizeMatch({
  kind, room, facts, names, selfName = '', selfWon = null, perspective = 'ai',
}) {
  const roomName = room ? room.name : '';
  const isAiView = perspective === 'ai' && !!selfName;
  const fallback = isAiView
    ? localSummaryForAi({ kind, roomName, facts, selfName, selfWon })
    : localSummary({ kind, roomName, facts });
  try {
    const raw = await callDeepSeek(buildSummaryMessages({
      kind, room, facts, names, selfName, perspective,
    }));
    // AI 视角那份**保留"你"**（= 这个 AI 自己）；中立那份硬换掉第二人称
    const out = fitSummary(isAiView ? raw : neutralizeSummary(raw));
    // 模型偶尔只回几个字：太短就用本地兜底，保证长度达标
    if (out && out.length >= 30) return { text: out, offline: false };
    throw new Error('太短');
  } catch {
    return { text: fallback, offline: true };
  }
}

/** 把斗地主结算结果整理成给模型/模板看的事实清单（写清名字，写清谁赢谁输） */
export function ddzFacts(result, { room, names, seatPersonas }) {
  const humanWin = (result.landlordSeat === 0) === result.landlordWin;
  const role = result.landlordSeat === 0 ? '地主' : '农民';
  const player = nameOf(names, 0);
  const landlordName = nameOf(names, result.landlordSeat);
  const winSide = result.landlordWin ? '地主' : '农民';
  const delta = result.deltas[0];
  const others = [0, 1, 2].filter((s) => s !== result.landlordSeat).map((s) => nameOf(names, s)).join('和');
  const caps = [];
  if (result.spring) caps.push('春天');
  if (result.antiSpring) caps.push('反春');
  if (result.bombs) caps.push(`${result.bombs} 个炸弹`);
  if (result.rockets) caps.push('王炸');
  if (result.robs) caps.push(`抢地主 ${result.robs} 次`);
  // 每个座位的输赢（两个 AI 可能一个赢一个输，概括要分得清）
  const seatResult = [0, 1, 2]
    .map((s) => `${nameOf(names, s)}${(result.deltas && result.deltas[s] > 0) ? '赢' : (result.deltas && result.deltas[s] < 0) ? '输' : '平'}`
      + `${result.deltas ? Math.abs(result.deltas[s] || 0).toLocaleString() : '?'} 豆`)
    .join('；');
  const personaNames = (seatPersonas || []).filter(Boolean).map((p) => p.name);
  return [
    `地主是「${landlordName}」，农民是「${others}」`,
    `玩家叫「${player}」，这局他是${role}`,
    `${winSide}赢了；玩家「${player}」${humanWin ? '赢了' : '输了'} ${Math.abs(delta).toLocaleString()} 豆`,
    `各家输赢：${seatResult}`,
    `本局倍数 ×${result.multiplier}${caps.length ? `（${caps.join('、')}）` : ''}`,
    `底分 ${room ? room.base : '?'}`,
    personaNames.length ? `陪玩的是「${personaNames.join('」「')}」` : '',
  ].filter(Boolean).join('；');
}

/** 小猫钓鱼的事实清单（写清名字，写清谁赢谁输） */
export function fishingFacts({ pay, score, multiplier, room, personaName, playerName = '玩家' }) {
  const diff = pay.diff;
  const who = personaName ? `对手「${personaName}」` : '对手';
  const relation = diff === 0 ? '五五开' : diff > 0 ? `玩家「${playerName}」鱼篓更多` : `${who}鱼篓更多`;
  return [
    `鱼篓 玩家「${playerName}」 ${score[0]} : ${score[1]} ${who}（${relation}${diff ? `，差 ${Math.abs(diff)} 张` : ''}）`,
    `本局倍数 ×${multiplier || 1}`,
    pay.delta > 0 ? `玩家「${playerName}」赢了 ${pay.delta.toLocaleString()} 豆，${who}输了`
      : pay.delta < 0 ? `玩家「${playerName}」输了 ${Math.abs(pay.delta).toLocaleString()} 豆，${who}赢了`
        : `玩家「${playerName}」和${who}不输不赢`,
    `场次 ${room ? room.name : '?'}`,
  ].filter(Boolean).join('；');
}

/**
 * 手数的"分档说法"（用户拍板：**复盘不要报具体多少手**，谁记得住）
 *
 * 记忆是给 AI 以后聊天用的，写"一共下了 24 手"既没人记得住、也没有画面感；
 * 换成"没几手就见分晓 / 中盘缠斗 / 磨了很久"这种分档，更像人在回忆。
 * 分档边界由 `core/gomoku.js` 的 `movePhase()` 统一决定（和场上形势一个口径）。
 */
const BAND_TEXT = {
  opening: '没几手就分出了胜负',
  mid: '中盘缠斗了一阵',
  late: '下了挺久、来回拉锯',
  endgame: '一路磨到最后，几乎快把棋盘下满了',
};
export const moveCountBand = (moves) => BAND_TEXT[movePhase(moves)] || '';

/**
 * 五子棋的事实清单（写清名字、谁先手、谁赢、大概下了多久、怎么赢的）
 * ★ 不涉及豆子（用户拍板：输赢不算钱）
 * ★ 不报具体手数，只用分档说法（用户拍板）
 * @param {{winner:'player'|'ai'|'draw', first:'player'|'ai', moves:number,
 *          room?:object, personaName?:string, playerName?:string, lineLen?:number}} p
 */
export function gomokuFacts({
  winner, first, moves, room, personaName = '', playerName = '玩家', lineLen = 5,
}) {
  const who = personaName ? `对手「${personaName}」` : '对手';
  const firstText = first === 'player' ? `玩家「${playerName}」执黑先手` : `${who}执黑先手`;
  const result = winner === 'draw'
    ? `棋盘下满，玩家「${playerName}」和${who}下成平局`
    : winner === 'player'
      ? `玩家「${playerName}」连成 ${lineLen} 子获胜，${who}输了`
      : `${who}连成 ${lineLen} 子获胜，玩家「${playerName}」输了`;
  return [
    `${firstText}`,
    `下了${moveCountBand(moves)}（**别写具体手数**）`,
    result,
    `场次 ${room ? room.name : '?'}`,
    '这局不涉及开心豆',
  ].filter(Boolean).join('；');
}
