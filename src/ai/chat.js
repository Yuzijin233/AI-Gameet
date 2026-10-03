/**
 * DeepSeek 对话层（PRD §2.8 / Q17 / Q18）
 * 信息权限：提示词只包含「自己的手牌 + 公开信息」，绝不包含他人手牌
 * 节流：同 AI 间隔 ≥2s、请求串行化、超时 3s、重试 1 次、失败降级本地语料
 */
import { CONFIG } from '../config.js';
import { pickSituationLine } from './lines.js';
import { pickGomokuLine } from '../data/gomokuLines.js';
import { pickFishingLine } from '../data/fishingLines.js';
import { genderPromptLine, agePromptLine } from '../data/personas.js';
import { timeContextLine } from '../data/clock.js';
import { styleRules, maxCharsOf, decorateLine, joinChatty, isTalky } from '../data/style.js';

/** 这些场景下，如果局势到了关键点，优先用局势台词而不是通用台词 */
const SITUATION_SCENES = new Set([
  'playBig', 'playSmall', 'suppress', 'suppressed', 'idle', 'passBid', 'bid', 'rob', 'bomb',
  'bombMate', 'bombFoe', 'longCombo', 'win', 'lose', 'greeting',
]);

const SCENE_HINT = {
  greeting: '刚开局，跟大家打个招呼',
  bid: '你刚叫了地主',
  rob: '你刚抢了地主 / 反抢',
  passBid: '你选择了不叫或不抢',
  playBig: '你刚出了一手很大的牌（2、王或炸弹级）',
  playSmall: '你刚出了一手小牌',
  longCombo: '你刚打出一手长牌型（连对 / 长顺子 / 飞机 / 四带二），挺得意',
  suppress: '你刚压住了上家的牌',
  suppressed: '你被上家压住 / 要不起',
  teammateFail: '你的搭档（另一个农民）出现了失误',
  win: '这一局你赢了',
  lose: '这一局你输了',
  idle: '场上有点冷场，主动说句话活跃气氛',
  praised: '有人给你送了鲜花、夸了你',
  egged: '有人朝你扔了鸡蛋、吐槽了你',
  bomb: '你刚打出了炸弹或王炸',
  bombMate: '你的搭档刚打出炸弹/王炸，你要替他叫好、夸他这手漂亮',
  bombFoe: '对手刚打出炸弹/王炸，你要表现出惊讶、压力或者不服气',
};

/**
 * 本地台词：话痨会把两句接起来说，爱用表情/颜文字的人会带上尾巴
 *
 * ★ mode 决定用哪套语料（用户报的 bug）：五子棋用 `data/gomokuLines.js`、
 *   小猫钓鱼用 `data/fishingLines.js`，**不再借用牌桌台词**
 *   （不然棋盘上会说"先出张小的探探路"）。默认还是斗地主，老调用不受影响。
 */
export function pickLocal(persona, scene, avoidSet = new Set(), mode = 'ddz') {
  const lines = (persona && persona.lines && persona.lines[scene]) || [];
  const pool = mode === 'gomoku' ? [pickGomokuLine(persona, scene, avoidSet)]
    : mode === 'fishing' ? [pickFishingLine(persona, scene, avoidSet)]
      : (lines.length ? lines : ['……', '这局有点意思']);
  const fresh = pool.filter((l) => !avoidSet.has(l));
  const list = fresh.length ? fresh : pool;
  let line = list[Math.floor(Math.random() * list.length)];
  // 话痨：有概率再抓一句接上（本地兜底也要有"话多"的区分度）
  if (isTalky(persona) && list.length > 1 && Math.random() < 0.4) {
    const other = list[Math.floor(Math.random() * list.length)];
    line = joinChatty(line, other);
  }
  return decorateLine(line, persona);
}

/**
 * 判断台词是不是在「报牌」——把自己的手牌念出来（PRD §2.8：只能就牌论牌）
 * 例：「4个2在手，不慌」「我手里还有王炸」→ 报牌
 *     「对2，你还能打过我？」「这手我接不住」→ 正常
 */
export function isHandReport(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/在手/.test(t)) return true; // "4个2在手"
  const mine = /(我(的)?手(里|上|中)|我(手里|手上|手中)?(还)?(捏|攥|拿|留|藏)着|我剩|我这(手|把)?牌|我兜里)/;
  const cards = /([3-9](?![0-9])|10|J|Q|K|A|2(?![0-9])|二|王|炸|对[3-9]|顺子|连对|飞机)/;
  return mine.test(t) && cards.test(t);
}

/** 五子棋的场景提示（棋盘上只有棋，没有牌） */
const GOMOKU_SCENE_HINT = {
  greeting: '刚开局，打个招呼',
  playBig: '你刚下了一手好棋（做成活三 / 冲四）',
  playSmall: '你刚下了一手普通的棋（占点、试应手）',
  suppress: '你刚才那一手是拦玩家的（挡住了他的活三 / 冲四）',
  praised: '玩家刚下了一手棋，你可以点评或夸一句',
  idle: '棋局有点安静，主动说句话',
  win: '这盘棋你赢了',
  lose: '这盘棋你输了',
  draw: '这盘棋下成平局了',
  egged: '有人朝你扔了鸡蛋、吐槽了你',
};

/** 小猫钓鱼的场景提示 */
const FISHING_SCENE_HINT = {
  greeting: '刚开局，打个招呼',
  idle: '你刚翻了一张牌 / 场上有点安静，说句话',
  win: '这局你鱼篓更多，你赢了',
  lose: '这局你鱼篓更少，你输了',
  praised: '有人给你送了鲜花、夸了你',
  egged: '有人朝你扔了鸡蛋、吐槽了你',
};

/** 玩家信息：谁在跟你玩（三种玩法共用这一句口径） */
function playerLine(mode) {
  if (mode === 'gomoku') return '你在和玩家下五子棋（15×15，横竖斜连成五子就赢）。';
  if (mode === 'fishing') return '你在和玩家玩小猫钓鱼（休闲玩法，比谁鱼篓里的牌多）。';
  return '你在玩三人斗地主，扮演玩家';
}

/** 玩法专属的硬性规则（不许串台：下棋的不提牌，钓鱼的不提地主） */
function modeRules(mode, { limit, persona }) {
  if (mode === 'gomoku') {
    return [
      '【硬性规则】',
      `1) 尽量只输出一句中文台词，控制在 ${limit} 个字以内，不要引号、不要换行、不要解释。`,
      '2) **这是五子棋，不是打牌**：只能聊棋盘上的事（落子、线路、活三、冲四、连成五子、堵与让），'
        + '**绝对不许出现"出牌""手牌""要不起""叫地主""抢地主""炸弹""倍数""豆子"这类牌桌词**。',
      '3) 你可以吹自己、可以损对手、可以只说心情，但**别把意图直说**'
        + '（不要讲"我要拦你""我在做四"），说得像人随口一句就行。',
      '4) 台词要贴合人设与当前局面，可以傲娇、毒舌、吐槽，但不要脏话、人身攻击、政治与宗教内容。',
    ].join('\n');
  }
  if (mode === 'fishing') {
    return [
      '【硬性规则】',
      `1) 尽量只输出一句中文台词，控制在 ${limit} 个字以内，不要引号、不要换行、不要解释。`,
      '2) **这是小猫钓鱼，不是斗地主**：只能聊翻牌、中央那叠、鱼篓、收还是不收，'
        + '**绝对不许出现"叫地主""抢地主""要不起""手牌""炸弹""倍数"这类斗地主术语**。',
      '3) 不要念自己翻出过什么具体牌（中央和鱼篓的张数可以说）。',
      '4) 台词要贴合人设与当前局面，可以傲娇、毒舌、吐槽，但不要脏话、人身攻击、政治与宗教内容。',
    ].join('\n');
  }
  return [
    '【硬性规则】',
    `1) 尽量只输出一句中文台词，控制在 ${limit} 个字以内，不要引号、不要换行、不要解释。`,
    '2) **就牌论牌**：针对刚刚打出的那一手说话（比如刚出了对 2，就说"对2，你还打得过？"），'
      + '或者针对场面说（谁快走完了、倍数多高了、自己要不要得起）。',
    '3) **绝对不要报牌**：不要说自己手里具体有什么牌，也不要报自己的牌型细节。'
      + '禁止出现"我手里有 4 个 2""王炸在我这""我剩一对 A"这类话。',
    '4) 你只能看到自己的手牌和公开信息（各家剩余张数、已经打出的牌、当前倍数）；'
      + '绝对看不到别人的手牌，只能根据公开信息推测，不要说"我看到你的牌"。',
    '5) 台词要贴合人设与当前局势，可以傲娇、毒舌、吐槽，但不要脏话、人身攻击、政治与宗教内容。',
  ].join('\n');
}

/** 玩法专属的"当前局势"行（各玩法的 view 字段不一样，这里分开拼） */
function modeUserLines(mode, view) {
  if (mode === 'gomoku') {
    return [
      `当前局势：${GOMOKU_SCENE_HINT[view.sceneKey] || view.sceneHint || '轮到你说话'}`,
      view.situationText ? `棋盘上的情况：${view.situationText}` : '',
      view.turnText ? `现在轮到谁：${view.turnText}` : '',
      view.playerText ? `玩家刚才在聊天里说：「${view.playerText}」，请针对这句话回应他。` : '',
      '请说一句符合人设的台词（聊棋盘上的事，别说牌桌上的话）。',
    ].filter(Boolean);
  }
  if (mode === 'fishing') {
    return [
      `当前局势：${FISHING_SCENE_HINT[view.sceneKey] || view.sceneHint || '轮到你说话'}`,
      view.countsText ? `场上情况：${view.countsText}` : '',
      view.lastText ? `上一步：${view.lastText}` : '',
      view.historyText ? `${view.historyLabel || '最近几步操作'}：${view.historyText}` : '',
      view.situationText ? `当前局势：${view.situationText}` : '',
      view.playerText ? `玩家刚才在聊天里说：「${view.playerText}」，请针对这句话回应他。` : '',
      '请说一句符合人设的台词（聊翻牌、鱼篓和收不收，别说斗地主的话）。',
    ].filter(Boolean);
  }
  return [
    `当前局势：${SCENE_HINT[view.sceneKey] || view.sceneHint || '轮到你说话'}`,
    // 大事件（炸弹 / 春天 / 碰到熟人）单独说清楚"发生了什么、你该什么态度"
    view.eventText ? `刚刚发生：${view.eventText}` : '',
    `你的身份：${view.isLandlord ? '地主' : '农民'}`,
    `上一手出牌：${view.lastText || '你是本轮首出'}`,
    view.handReportLine,
    `各家剩余张数：${view.countsText}`,
    `当前倍数：${view.multiplier}${view.bombs ? `（炸弹 ${view.bombs} 个）` : ''}`,
    view.situationText ? `当前局势：${view.situationText}` : '',
    view.historyText ? `${view.historyLabel || '最近的出牌记录'}：${view.historyText}` : '',
    view.playerText ? `玩家刚才在聊天里说：「${view.playerText}」，请针对这句话回应他。` : '',
    '请说一句符合人设的台词（就刚出的这一手或当前场面说，不要报自己的牌）。',
  ].filter(Boolean);
}

/** 组装提示词（信息边界在这里把关；mode 决定"这是哪种玩法"） */
export function buildMessages({ persona, scene, view = {}, mode = 'ddz' }) {
  const game = view.mode || mode || 'ddz';
  const limit = maxCharsOf(persona);
  const style = styleRules(persona, { maxChars: limit });
  const opening = playerLine(game);
  const system = [
    opening === '你在玩三人斗地主，扮演玩家' ? `${opening}「${persona.name}」。` : `${opening}你扮演玩家「${persona.name}」。`,
    `人设：${persona.prompt || persona.tags.join('、')}`,
    genderPromptLine(persona),
    agePromptLine(persona),
    // 牌桌台词也要知道时间：不然半夜会说"早上好"
    timeContextLine(new Date(), { short: true }),
    // ★ 和玩家的关系（好感度 / 关系 / 称呼 / 记忆）：牌桌上也照这个口气说话
    ...(view.friendLines || []),
    // 玩家是男是女：牌桌上最容易叫错称呼，这里明确一句
    view.playerGender || '',
    ...style,
    modeRules(game, { limit, persona }),
  ].join('\n');

  const lines = modeUserLines(game, { ...view, sceneKey: scene });
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** 一次请求（带超时），失败抛错并附带可诊断的原因 */
async function requestOnce(messages, { url, key, timeout, proxy = false }) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  const body = {
    model: CONFIG.model,
    messages,
    max_tokens: CONFIG.ai.maxTokens,
    stream: false,
    // 思考模式开关：默认关闭（开启会先输出思维链，明显拖慢出牌节奏）
    thinking: { type: CONFIG.thinking ? 'enabled' : 'disabled' },
  };
  if (CONFIG.thinking) body.reasoning_effort = 'high';
  else body.temperature = CONFIG.ai.temperature; // 思考模式下该参数会被忽略

  /**
   * ★ 走本地代理时，也把**玩家自己填的 Key** 带上（`X-Api-Key`）。
   * 为什么：分发的"绿色版"用 PowerShell 起服务，服务端并不知道 Key；
   * 由页面把设置里的 Key 传给它，它再转发给 DeepSeek（Key 不会写进任何文件）。
   * Node 版兼容：优先用这个头，没有才退回服务器自己 config 里的 Key。
   */
  if (proxy && CONFIG.apiKey) headers['X-Api-Key'] = CONFIG.apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${String(detail).slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error(`timeout>${timeout}ms`);
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用大模型：**优先走本地代理，失败自动退回浏览器直连**
 * 为什么这么改：浏览器直连每次调用都要先发一次 CORS 预检（OPTIONS），
 * 还会被广告拦截插件、企业网络策略盯上；代理路径没有这些坑，超时也能放宽。
 * 两条路都失败才真的算失败，并把原因写进 console 方便排查。
 * @param {{timeoutMs?:number}} [opts] 覆盖超时（出牌决策用 15 秒预算，会按剩余时间传进来）
 */
export async function callDeepSeek(messages, opts = {}) {
  const cap = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
  const withCap = (t) => ({ ...t, timeout: cap ? Math.min(t.timeout, cap) : t.timeout });
  const inBrowser = typeof window !== 'undefined';
  const direct = { url: CONFIG.apiBase, key: CONFIG.apiKey, timeout: CONFIG.ai.timeout, name: 'direct' };
  // 代理这条路：key 走 X-Api-Key 头（见 requestOnce），服务器那边自己决定用不用
  const proxy = { url: CONFIG.proxyPath, key: '', timeout: CONFIG.ai.timeoutProxy, name: 'proxy', proxy: true };
  // 只有浏览器里才有"本地代理"这条路（相对路径）；Node（测试/脚本）直接走直连
  const targets = (inBrowser && CONFIG.useProxy ? [proxy, direct] : [direct]).map(withCap);

  let lastErr = null;
  for (const t of targets) {
    try {
      return await requestOnce(messages, t);
    } catch (e) {
      lastErr = e;
      // 401/402/403 这类是账号/额度问题，换条路也没用，直接抛
      if (e && (e.status === 401 || e.status === 402 || e.status === 403)) throw e;
      console.warn(`[ai] ${t.name} 调用失败：${e && e.message}`);
    }
  }
  throw lastErr || new Error('no route');
}

function sanitize(text) {
  // 只做格式清理（换行会让气泡排版乱掉），不截断内容：
  // 提示词里已经要求 AI 说短句，但它真写多了也要完整显示出来
  const t = String(text || '').replace(/[\r\n]+/g, ' ').trim();
  return t.replace(/^["'「『]+|["'」』]+$/g, '').trim();
}

export class ChatBrain {
  constructor({ getView, onLine, onMode }) {
    this.getView = getView; // (seat, scene) => view object
    this.onLine = onLine || (() => {});
    this.onMode = onMode || (() => {});
    this.lastSpoke = new Map();
    this.lastSpokeAny = 0;
    this.usedLines = new Map();
    this.queue = Promise.resolve();
    this.offline = false;
    this.failStreak = 0; // 连续失败次数：够多才认为离线，避免一次抖动就翻脸
  }

  /** 记一次失败/成功，稳定后才切换在线离线状态（不再来回弹提示） */
  noteResult(ok) {
    if (ok) {
      this.failStreak = 0;
      if (this.offline) { this.offline = false; this.onMode('online'); }
      return;
    }
    this.failStreak += 1;
    if (!this.offline && this.failStreak >= (CONFIG.ai.offlineAfter || 3)) {
      this.offline = true;
      this.onMode('offline');
    }
  }

  canSpeak(seat, priority = false, now = Date.now(), minGap = CONFIG.ai.minGap) {
    if (now - (this.lastSpoke.get(seat) || 0) < minGap) return false;
    // 玩家主动搭话时允许插队；否则全局节流，避免两个 AI 抢着自说自话
    if (!priority && now - this.lastSpokeAny < CONFIG.ai.globalGap) return false;
    return true;
  }

  localLine(persona, scene, extra) {
    const key = persona?.id || 'unknown';
    if (!this.usedLines.has(key)) this.usedLines.set(key, new Set());
    const used = this.usedLines.get(key);
    let line = null;
    const sit = extra && extra.situation;
    /**
     * ★ 局势台词（lines.js）全是**斗地主**的局势（地主快走完了、被炸弹炸了…），
     *   所以只在斗地主里用。五子棋 / 小猫钓鱼各有自己的语料（见 pickLocal 的 mode）。
     */
    const mode = (extra && extra.mode) || 'ddz';
    const sitKey = mode !== 'ddz' ? null
      : (scene === 'bomb' ? 'bombed' : null)
        || (extra && extra.situationKey)
        || (sit && sit.key && sit.key !== 'normal' ? sit.key : null)
        || (scene === 'suppressed' ? 'pressured' : null);
    const useSituation = !!sitKey && (
      !!(extra && extra.forceSituation)
      || !!(sit && sit.urgent && SITUATION_SCENES.has(scene))
      || sitKey === 'pressured'
    );
    if (useSituation) line = pickSituationLine(sitKey, persona?.style || 'balanced', used);
    if (!line) line = pickLocal(persona, scene, used, mode);
    used.add(line);
    if (used.size > 14) used.clear();
    return line;
  }

  /** AI 说话：串行化 + 超时降级；返回台词文本 */
  async speak(seat, scene, persona, extra = {}) {
    if (!persona) return null;
    if (!this.canSpeak(seat, !!extra.priority, Date.now(), extra.minGap || CONFIG.ai.minGap)) return null;
    const now = Date.now();
    this.lastSpoke.set(seat, now);
    this.lastSpokeAny = now;

    const run = async () => {
      const view = this.getView(seat, scene, extra) || {};
      // ★ 玩法从 view 里来（gomokuView / fishingView 都带 mode），extra 可以覆盖
      const mode = extra.mode || view.mode || 'ddz';
      const messages = buildMessages({ persona, scene, view, mode });
      let attempt = 0;
      while (attempt <= CONFIG.ai.retry) {
        try {
          const raw = await callDeepSeek(messages);
          const text = sanitize(raw).slice(0, maxCharsOf(persona) + 12);
          // 报了手牌就当作无效回复：重试一次，再不行用本地语料兜底（牌桌规则，只对斗地主）
          if (text && !(mode === 'ddz' && isHandReport(text))) {
            this.noteResult(true);
            return text;
          }
          throw new Error(text ? '报了手牌' : '空回复');
        } catch (err) {
          attempt += 1;
          if (attempt > CONFIG.ai.retry) {
            this.noteResult(false);
            return this.localLine(persona, scene, { ...extra, mode });
          }
        }
      }
      return this.localLine(persona, scene, { ...extra, mode });
    };

    const task = this.queue.then(run, run);
    this.queue = task.catch(() => {});
    try {
      const line = await task;
      if (line) this.onLine(seat, line, scene);
      return line;
    } catch {
      const line = this.localLine(persona, scene, extra);
      this.onLine(seat, line, scene);
      return line;
    }
  }

  /** 设置面板：测试连通性 */
  async testConnection() {
    const t0 = Date.now();
    try {
      const raw = await callDeepSeek([
        { role: 'system', content: '你是斗地主桌上的玩家，只回一句不超过 10 个字的中文台词。' },
        { role: 'user', content: '开局了，说句话。' },
      ]);
      const text = sanitize(raw);
      if (!text) throw new Error('返回内容为空');
      return { ok: true, ms: Date.now() - t0, text };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: err?.name === 'AbortError' ? '请求超时' : String(err?.message || err) };
    }
  }
}
