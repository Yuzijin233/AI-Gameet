/**
 * 存档（PRD Q9 / §5-Q9）
 * localStorage + version 迁移；读取失败自动重建，绝不白屏
 */
import { DEFAULT_SETTINGS, ECON, FRIEND } from '../config.js';
import { DEFAULT_GENDER, genderById } from '../data/player.js';
import { memoryDigest, memoryJson } from '../data/memoryDigest.js';
import { ensureModeInSummary, ensureModeInMatchLine } from '../data/summaryText.js';
import { listFriends } from './friends.js';

export const SAVE_KEY = 'ddz_save_v1';
export const SAVE_VERSION = 1;
/** 最近保留几局的概括（PRD §2.12：保留上 3 局） */
export const RECENT_HANDS = 3;

export function defaultSave() {
  return {
    version: SAVE_VERSION,
    nickname: '',
    // 玩家性别（默认男）：会影响 AI 的称呼，见 data/player.js
    gender: DEFAULT_GENDER,
    /**
     * 有没有走过"首次进入"的档案设置（性别 + 姓名）。
     * false = 下次进来先弹设置那一屏（新手存档、以及刚重置过存档时都是 false）
     */
    profileSet: false,
    avatar: 'avatar_01',
    // 玩家自己上传的头像照片（data URL，居中裁剪成正方形）。没有就用 image/avatar_01.png
    avatarUpload: '',
    beans: ECON.newPlayerBeans,
    isNewbie: true,
    signIn: { lastDate: '', streak: 0 },
    relief: { lastDate: '' },
    settings: { ...DEFAULT_SETTINGS },
    stats: { hands: 0, wins: 0, losses: 0, maxMultiplier: 0, maxWin: 0 },
    friends: [], // 好友（AI）：重置存档时会被清空，最多 FRIEND.maxFriends 个
    // “遇见”独立场次历史；从这里迁移为好友聊天后仍保留原始记录。
    encounters: { days: {}, records: {}, recent: [] },
    /**
     * AI 改过的名字：`{ [personaId]: { name, history: [出厂名, …] } }`（见 store/aiNames.js）
     * 只记"不是出厂名"的那些；**重置存档 → 清空 → 名字回到人设默认**。
     */
    aiNames: {},
    // 唯一的恋人（personaId）：好感满 100 且明确表白才会确立，见 PRD §2.12.1
    loverId: '',
    // 群聊（PRD §2.20）：群成员只能是好友；群聊不加好感度
    groups: [],
    // 友圈（社交里的"朋友圈"）：只有玩家能发说说，AI 只点赞 + 评论（见 store/moments.js）
    moments: [],
    // 上次看友圈的时间：之后好友来评论 / 点赞就亮小红点
    momentsSeenAt: 0,
    /**
     * 最后一次"人在"的时间：关页面/切后台时写一次。
     * 下次进来如果离这次超过 2 分钟，就随机 1~3 位好友主动来打招呼
     * （见 ui/app.js 的 scheduleReturnPing）。
     */
    lastSeenAt: 0,
    /** 赠礼账本：{ d: '日期', sent: {好友: 次数}, aiSent: {AI: 次数} }（每天每种上限 3 次） */
    gifts: { d: '', sent: {}, aiSent: {} },
    // 最近的 3 局（每局一条 50~100 字概括）：AI 聊天时用来回忆"那局怎么样"
    recentHands: [],
    // AI 身家：全局共享，跨局变化（首次读取时按幂律随机分配）
    aiEcon: { v: 1, beans: {}, relief: {} },
    // 道具库存（新手礼包给了几个，其余去商城买）
    items: { flower: 3, tomato: 3, egg: 3, cappuccino: 1 },
    // 装扮拥有状态（头像框 / 牌背 / 风格 / 改名卡）：只影响外观，不影响出牌
    cosmetics: { frames: [], cardBacks: ['back_01'], themes: [], frame: '', theme: '', renameCards: 0 },
    // 活动中心状态（免费礼包 / 首充 / 限时礼包 / 累计充值 / 折扣 / 转盘）
    activity: {
      daily: '', weekly: '', firstPay: false,
      // 今日限时礼包每天**两款**（档位不同）：只记今天买过哪几个 id
      packDate: '', packsBought: [],
      discountDate: '', discountCount: 0,
      tiers: [],
      spins: 0, bestWin: 0,
    },
    // 模拟充值记录（累计充值礼包看 totalYuan）
    wallet: { totalYuan: 0, orders: [] },
    // 邮箱：目前只有首充礼包的奖励发到这里（其余活动直接到账）
    mail: [],
    flags: { firstGiftShown: false },
    /** AI 邀请：玩家点过 ✗ 之后先安静，等他主动玩一局再恢复（见 store/invite.js） */
    inviteMuted: false,
    createdAt: Date.now(),
    // 最后一次写入时间：用来和 save/ddz_save.json 比新旧，决定启动时用哪一份
    savedAt: '',
  };
}

const migrations = {
  // 版本升级时在此追加：1: (save) => { ...; save.version = 2; return save; }
};

export function migrate(save) {
  let s = save;
  while (s.version < SAVE_VERSION) {
    const key = s.version;
    const fn = migrations[key];
    if (!fn) { s.version = SAVE_VERSION; break; }
    s = fn(s);
  }
  return s;
}

export function normalize(save) {
  const base = defaultSave();
  const s = { ...base, ...(save || {}) };
  s.settings = { ...base.settings, ...((save && save.settings) || {}) };
  s.signIn = { ...base.signIn, ...((save && save.signIn) || {}) };
  s.relief = { ...base.relief, ...((save && save.relief) || {}) };
  s.stats = { ...base.stats, ...((save && save.stats) || {}) };
  s.flags = { ...base.flags, ...((save && save.flags) || {}) };
  s.aiEcon = { ...base.aiEcon, ...((save && save.aiEcon) || {}) };
  if (!s.aiEcon.beans || typeof s.aiEcon.beans !== 'object') s.aiEcon.beans = {};
  if (!s.aiEcon.relief || typeof s.aiEcon.relief !== 'object') s.aiEcon.relief = {};
  s.items = { ...base.items, ...((save && save.items) || {}) };
  // 性别：非法值落回默认（男）
  if (!genderById(s.gender)) s.gender = DEFAULT_GENDER;
  /**
   * 档案设置标记：
   *   · 新存档（defaultSave）= false → 进来先设置性别 + 姓名
   *   · **老存档**没有这个字段，但已经有昵称了 → 视为早就设过，别把老玩家拦在门外
   * 注意：必须看**原始存档**，因为 base 里已经有 profileSet: false 兜底了
   */
  s.profileSet = typeof (save && save.profileSet) === 'boolean'
    ? save.profileSet
    : !!(save && save.nickname);
  if (typeof s.nickname !== 'string') s.nickname = '';
  if (typeof s.savedAt !== 'string') s.savedAt = '';
  if (typeof s.inviteMuted !== 'boolean') s.inviteMuted = false;
  if (typeof s.beans !== 'number' || !Number.isFinite(s.beans) || s.beans < 0) s.beans = base.beans;
  // 装扮 / 活动 / 钱包 / 邮箱：老存档缺字段时补齐默认值（store 里还会再兜一次底）
  s.cosmetics = { ...base.cosmetics, ...((save && save.cosmetics) || {}) };
  if (typeof s.avatarUpload !== 'string' || !s.avatarUpload.startsWith('data:image/')) s.avatarUpload = '';
  s.activity = { ...base.activity, ...((save && save.activity) || {}) };
  s.wallet = { ...base.wallet, ...((save && save.wallet) || {}) };
  if (!Array.isArray(s.mail)) s.mail = [];
  if (!Array.isArray(s.friends)) s.friends = [];
  // “遇见”数据保持纯存档结构；详细修复由 store/encounters.js 的 ensureEncounters 完成。
  if (!s.encounters || typeof s.encounters !== 'object' || Array.isArray(s.encounters)) s.encounters = { days: {}, records: {}, recent: [] };
  if (!s.encounters.days || typeof s.encounters.days !== 'object' || Array.isArray(s.encounters.days)) s.encounters.days = {};
  if (!s.encounters.records || typeof s.encounters.records !== 'object' || Array.isArray(s.encounters.records)) s.encounters.records = {};
  if (!Array.isArray(s.encounters.recent)) s.encounters.recent = [];
  // AI 改过的名字（形状不对的条目由 store/aiNames.js 的 ensureAiNames 收拾）
  if (!s.aiNames || typeof s.aiNames !== 'object' || Array.isArray(s.aiNames)) s.aiNames = {};
  // 老存档里这个字段叫 cpId（当时叫 CP），迁移过来
  if (!s.loverId && typeof (save && save.cpId) === 'string') s.loverId = save.cpId;
  if (typeof s.loverId !== 'string') s.loverId = '';
  delete s.cpId;
  // 恋人必须还是好友，否则清掉（删好友 / 重置后不该留一个幽灵恋人）
  if (s.loverId && !s.friends.some((f) => f && f.personaId === s.loverId)) s.loverId = '';
  if (!Array.isArray(s.groups)) s.groups = [];
  if (!Array.isArray(s.moments)) s.moments = [];
  if (!Number.isFinite(s.momentsSeenAt)) s.momentsSeenAt = 0;
  if (!Number.isFinite(s.lastSeenAt) || s.lastSeenAt < 0) s.lastSeenAt = 0;
  if (!s.gifts || typeof s.gifts !== 'object') s.gifts = { d: '', sent: {}, aiSent: {} };
  if (!Array.isArray(s.recentHands)) s.recentHands = [];
  s.recentHands = s.recentHands.filter((h) => h && typeof h.summary === 'string').slice(0, RECENT_HANDS);
  /**
   * ★ 老存档自愈：对局记忆里没点明玩法的补上（用户报的"不知道上一局打的是什么"）。
   *   新写的由 ai/matchSummary.js 的 ensureModeNamed 保证；这里是给已经存在的记录兜底，
   *   按内容猜（执黑/棋盘 → 五子棋，鱼篓/翻牌 → 小猫钓鱼，地主/倍数 → 斗地主）。
   */
  for (const h of s.recentHands) h.summary = ensureModeInSummary(h.summary, FRIEND.maxMatchChars);
  for (const f of s.friends) {
    if (!f || !Array.isArray(f.memory)) continue;
    f.memory = f.memory.map((m) => ensureModeInMatchLine(m, FRIEND.maxMatchChars));
  }
  if (!s.titles || typeof s.titles !== 'object') s.titles = { unlocked: [], equipped: '', manual: false };
  return s;
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { save: defaultSave(), fresh: true };
    const parsed = JSON.parse(raw);
    return { save: normalize(migrate(parsed)), fresh: false };
  } catch (err) {
    console.warn('[save] 存档损坏，已重建：', err);
    return { save: defaultSave(), fresh: true, corrupted: true };
  }
}

export function writeSave(save) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...save, version: SAVE_VERSION }));
  } catch (err) {
    console.warn('[save] 写入失败：', err);
  }
  // 顺手镜像成本地文件（save/ddz_save.json + AI记忆.md）—— 失败不影响游戏
  queueServerPush(save);
  return true;
}

/* ===================================================================== */
/*                 存档 / 记忆 的本地文件镜像（save/ 目录）               */
/* ===================================================================== */
/**
 * 浏览器 localStorage 是唯一主副本，但它"看不见摸不着"：
 * 清一次浏览器数据就全没了，想看 AI 到底记住了什么也没法翻。
 * 所以每次存档都顺手推给本地服务一份，落在项目根的 save/ 目录：
 *
 *   save/ddz_save.json  完整存档（可直接看 / 备份 / 手改）
 *   save/AI记忆.md      每个好友记住了什么（**给人读的**）
 *   save/AI记忆.json    只有记忆部分（好搜索、好 diff）
 *
 * 全部是"尽力而为"：没有服务（比如用 file:// 直接打开）就安静跳过。
 */
const SAVE_API = '/api/save';
const MEMORY_API = '/api/memory';
let pushTimer = null;
let pushing = false;

/**
 * 记忆清单的两份文本（Markdown / JSON）——由**页面**算好一起推给服务端。
 *
 * 为什么不在服务端算：分发的"绿色版"用 PowerShell 起服务，那边没有 JS 运行时；
 * 而这份渲染逻辑本来就在前端（`data/memoryDigest.js`），算好再发最省事，
 * 两种服务端（Node / PowerShell）也就完全一致了。
 * 失败就算了（存档本身才是主副本）。
 */
function memoryFilesOf(save) {
  try {
    const personas = listFriends(save).map((f) => ({ id: f.personaId, name: f.name || f.personaId }));
    const now = new Date();
    return {
      memoryMd: memoryDigest(save, { personas, now }),
      memoryJson: JSON.stringify(memoryJson(save, { personas, now }), null, 2),
    };
  } catch {
    return {};
  }
}

/** 返回 true 表示"这次真的推上去了"（测试/调试用得上） */
export async function pushSaveNow(save) {
  if (typeof fetch !== 'function' || typeof location === 'undefined') return false;
  if (!/^https?:$/.test(location.protocol || '')) return false;
  pushing = true;
  try {
    // 缩进过的 JSON：服务端原样落盘（不重新序列化），人打开就能读
    const res = await fetch(SAVE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...save, savedAt: new Date().toISOString() }, null, 2),
    });
    // 记忆清单走单独的接口：存档文件里就不会混进这两个大字段
    const mem = memoryFilesOf(save);
    if (mem.memoryMd) {
      try {
        await fetch(MEMORY_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ md: mem.memoryMd, json: mem.memoryJson }),
        });
      } catch { /* 记忆清单只是附带产物，失败不影响存档 */ }
    }
    return res.ok;
  } catch {
    return false; // 没有本地服务 / 服务挂了：不影响游戏
  } finally {
    pushing = false;
  }
}

/** 合并写入：短时间内连续存档只推最后一次（出牌、聊天都会触发 persist） */
export function queueServerPush(save, waitMs = 600) {
  if (typeof fetch !== 'function' || typeof location === 'undefined') return;
  if (!/^https?:$/.test(location.protocol || '')) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushSaveNow(save);
  }, waitMs);
  if (typeof pushTimer.unref === 'function') pushTimer.unref();
}

/**
 * 启动时"用文件还是用浏览器里的"判断（纯函数，方便测试）
 *   · 浏览器里压根没有存档（换了浏览器 / 清了数据）→ 用文件恢复
 *   · 浏览器里的存档**没有时间戳**（这个功能之前留下的老存档）→ 以浏览器为准，
 *     绝不把人家手上正在玩的进度冲掉；这次启动会把它重新推成文件
 *   · 双方都有时间戳 → 文件更新（手改过文件）就用文件
 */
export function shouldRestoreFromFile({ localAt = 0, fileAt = 0, localFresh = false, graceMs = 1500 } = {}) {
  if (localFresh) return true;
  if (!localAt) return false;
  return fileAt > localAt + graceMs;
}

/**
 * 问本地服务要一份存档，用来在"浏览器存档没了"或"文件更新"时恢复
 * @param {object} localSave 当前浏览器里的存档
 * @param {{localFresh?:boolean, graceMs?:number}} opts localFresh = localStorage 里压根没有存档
 * @returns {Promise<{ok:boolean, restored:boolean, save?:object, reason?:string}>}
 */
export async function pullSaveFromServer(localSave, { localFresh = false, graceMs = 1500 } = {}) {
  if (typeof fetch !== 'function' || typeof location === 'undefined') return { ok: false, restored: false };
  if (!/^https?:$/.test(location.protocol || '')) return { ok: false, restored: false };
  try {
    const res = await fetch(SAVE_API, { cache: 'no-store' });
    if (!res.ok) return { ok: false, restored: false };
    const data = await res.json();
    if (!data || !data.ok || !data.save || !Array.isArray(data.save.friends)) {
      return { ok: true, restored: false, reason: data && data.reason };
    }
    const fileAt = Math.max(Number(data.mtime) || 0, Date.parse(data.save.savedAt || '') || 0);
    const localAt = Date.parse((localSave && localSave.savedAt) || '') || 0;
    if (!shouldRestoreFromFile({ localAt, fileAt, localFresh, graceMs })) {
      return { ok: true, restored: false, fileAt, localAt };
    }
    return { ok: true, restored: true, save: normalize(data.save), fileAt, localAt };
  } catch {
    return { ok: false, restored: false };
  }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}
