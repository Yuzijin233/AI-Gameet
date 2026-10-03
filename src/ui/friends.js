/**
 * 好友面板 + 房间模式面板（PRD §2.12 / §2.13）
 *  好友面板：左好友清单 / 右聊天窗口；「打招呼」认识对方后由对方先开口
 *  房间面板：邀请好友入座、踢出、人满才能开始
 */
import { PERSONAS, genderOf, genderSign, genderLabel, GENDER_SIGN, GENDER_TEXT } from '../data/personas.js';
import { signatureOf } from '../data/signatures.js';
import { ASSETS } from '../../assets/manifest.js';
import { FRIEND, DANMAKU, ROOMS, FISHING_ROOMS, GOMOKU_ROOMS, GIFT, NUDGE } from '../config.js';
import { toast } from './fx.js';
import { audio } from './audio.js';
import { openDrawer, closePanel } from './panels.js';
import {
  listFriends, findFriend, addFriend, removeFriend, appendChat,
  tierOf, isLover, canConfess,
  clearUnread, friendDisplay, callNameOf, bumpPendingPing, bumpUnread,
} from '../store/friends.js';
import { aiBeansOf, aiTitleOf } from '../store/aiBeans.js';
import { equippedTitle } from '../store/titles.js';
import { titleGradient } from '../data/titles.js';
import { beanLabel } from '../core/settle.js';
import { friendReply, localGreeting } from '../ai/friend.js';
import { buildNudgeLine, allowNudge, ensureNudgeStore, nudgeReply } from '../ai/nudge.js';
import { MODE_NAME } from '../ai/matchSummary.js';
import { typingDelayOf } from '../data/typing.js';
import { playerAvatarSrc } from '../data/avatar.js';
import { playerGenderLine, playerIdentityLines } from '../data/player.js';
import { renderGroups } from './groups.js';
import { createImeGuard } from './imeGuard.js';
import { renderMoments } from './moments.js';
import { groupUnreadTotal, clearGroupUnread as clearAllGroupUnread } from '../store/groups.js';
import { sendGiftToFriend, giftsLeftFor, giftStockRows } from '../store/gifts.js';
import { applyCheat } from '../store/cheats.js';
import { playerGiftLine } from '../data/giftLines.js';
import { momentUnreadTotal, markMomentsSeen } from '../store/moments.js';

const personaById = (id) => PERSONAS.find((p) => p.id === id) || null;

/** 等一会儿（拍一拍回复前的那点"打字"停顿） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ★ 拍一拍的"这一下算不算拍"纯判断（双击头像触发，见下面的 nudgeFriend）。
 *
 * 满足三条才算：
 *   ① 双击落在**头像**上（`.chat-face`；点气泡、点文字都不算）
 *   ② 这个头像在**当前聊天记录**里（防止别处的 .chat-face 串进来）
 *   ③ 不是**自己那一排**的头像（`.chat-row.self`）—— 自己拍自己没意义
 *
 * 抽成纯函数是为了能被 node 测试直接验（DOM 事件不好在无浏览器环境里造）。
 * @param {object} target 事件目标
 * @param {object} logBox 聊天记录容器
 * @returns {boolean}
 */
export function nudgeHit(target, logBox) {
  const face = target && target.closest ? target.closest('.chat-face') : null;
  if (!face) return false;
  if (logBox && logBox.contains && !logBox.contains(face)) return false;
  if (face.closest && face.closest('.chat-row.self')) return false;
  return true;
}

/**
 * 名字后面的性别小标（♂ 蓝 / ♀ 粉）
 * 每个 AI 都有明确性别，也是写进提示词的背景知识（见 data/personas.js 的 genderPromptLine）
 */
function genderTag(persona) {
  if (!persona) return '';
  const g = genderOf(persona);
  return `<span class="gender-tag is-${g}" title="${GENDER_TEXT[g]}">${GENDER_SIGN[g]}</span>`;
}

/** 「加好友」里一次推荐几个人（不够就用已加过的补齐） */
const PICKER_COUNT = 10;

/** 随机取 n 个（不改原数组；不洗满整副，Fisher–Yates 取前 n 个） */
function pickRandom(list, n, rnd = Math.random) {
  const pool = [...list];
  const out = [];
  const count = Math.max(0, Math.min(Number(n) || 0, pool.length));
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(rnd() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    out.push(pool[i]);
  }
  return out;
}

/** 只用文字表达关系：不暴露好感度数值与进度条（判断过程对玩家隐藏） */
function relationText(friend, save) {
  return tierOf(save, friend).label;
}

/** 恋人标记（全局只有 1 个，列表和标题上都带） */
function loverBadge(save, personaId) {
  return isLover(save, personaId) ? '<span class="lover-badge" title="你俩是恋人">💞</span>' : '';
}

/** 好友主动开口：刚加好友用「added」，之后的主动搭话用「opener」 */
function pickGreeting(persona, kind = 'opener') {
  return localGreeting(persona, kind);
}

/**
 * 默认的申请文案（用户拍板：**多预设几种、随机挑一条**）
 * 要求"模糊一点"：不提具体哪一局、不提谁赢谁输，就当是牌桌上碰到的。
 */
const REQUEST_POOL = [
  '牌桌上遇到的，加个好友吧。',
  '看你打牌挺稳的，交个朋友？',
  '刚才一起玩过，认识一下。',
  '在同一桌上打过，加个好友。',
  '感觉你打牌挺有意思，加一个？',
  '以后有空一起玩，先加个好友。',
  '牌友一枚，加个好友呗。',
  '看你牌品不错，加个好友。',
];

/** 随机挑一条默认申请（可注入 rnd，方便测试） */
export function defaultRequestText(rnd = Math.random) {
  return REQUEST_POOL[Math.min(REQUEST_POOL.length - 1, Math.floor(rnd() * REQUEST_POOL.length))];
}

/**
 * 加好友申请浮窗（用户拍板）：点一下先**编辑申请文案**再发送。
 * 样式复用群里那套 `.gc-overlay / .gc-dialog`，风格统一。
 * @param {{app:object, persona:object, host?:HTMLElement}} p
 * @returns {Promise<string|null>} 申请文案；null = 取消
 */
export function askFriendRequestOverlay({ app, persona, host = null }) {
  return new Promise((resolve) => {
    const guess = defaultRequestText();
    const overlay = document.createElement('div');
    overlay.className = 'gc-overlay';
    overlay.innerHTML = `
      <div class="gc-dialog">
        <h4 class="gc-dialog-title">加好友申请</h4>
        <div class="gc-hint">写给「${persona.name}」的申请 —— TA 看到这句话才会通过。</div>
        <textarea id="fr-note" rows="3" maxlength="${FRIEND.requestMaxChars}">${guess}</textarea>
        <div class="gc-dialog-actions">
          <button class="btn ghost" data-fr-cancel type="button">取消</button>
          <button class="btn primary" data-fr-ok type="button">发送申请</button>
        </div>
      </div>`;
    (host || document.querySelector('.panel-layer') || document.body).append(overlay);
    const finish = (v) => { overlay.remove(); resolve(v); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    overlay.querySelector('[data-fr-cancel]').addEventListener('click', () => finish(null));
    overlay.querySelector('[data-fr-ok]').addEventListener('click', () => {
      const ta = overlay.querySelector('#fr-note');
      const text = String(ta && ta.value ? ta.value : '').replace(/\s+/g, ' ').trim();
      finish(text || guess);
    });
    const ta = overlay.querySelector('#fr-note');
    if (ta) {
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* 忽略 */ }
    }
  });
}

/**
 * ★ 加好友的完整流程（用户拍板，所有"加好友"入口都走这一个）：
 *   ① 弹浮窗**编辑申请文案** → ② 发送后**延迟 1~5 秒**对方通过 →
 *   ③ 聊天里落下**我发的申请**，再让 TA **回这条申请**（于是是两条消息的样子）。
 *
 * @param {{app:object, persona:object, host?:HTMLElement, fromMatch?:boolean,
 *          onPending?:Function, onAdded?:Function}} p
 * @returns {Promise<boolean>} 真的加上了才 true
 */
export async function requestFriend({ app, persona, host = null, fromMatch = false, onPending = null, onAdded = null }) {
  const note = await askFriendRequestOverlay({ app, persona, host });
  if (note == null) return false;
  if (onPending) onPending();
  // 对方"看了一眼"再通过
  await new Promise((r) => setTimeout(r, FRIEND.acceptMinMs + Math.random() * Math.max(0, FRIEND.acceptMaxMs - FRIEND.acceptMinMs)));
  const res = addFriend(app.save, persona, fromMatch ? { fromMatch: true } : undefined);
  if (!res.ok) { toast(res.error, 'bad'); return false; }
  app.persist('friendAdd');
  audio.play('select');
  // 先落"我发的申请"，再让 TA 回这条（sendFriendMessage 正好是这套：插入我的话 → 正在输入 → 插入回复）
  await sendFriendMessage(app, persona.id, note, {
    onBusy: () => {},
    refresh: () => app.refreshFriendsPanel(),
    // ★ 我那句下面挂一行小灰字（用户要求）
    systemNote: '对方已经同意了你的好友申请',
  });
  app.updateFriendDot();
  if (onAdded) onAdded();
  return true;
}

/**
 * 在聊天窗口底部显示"正在输入…"
 * ★ 用户要求：这一条**必须带头像**（原来只有一条光秃秃的气泡，看着像换人了）
 * @param {string} [faceSrc] 说话人的头像（不传就用默认头像兜底）
 */
function showTyping(faceSrc) {
  const log = document.getElementById('friend-log');
  if (!log) return;
  // ★ 刚加好友时聊天框里是"打个招呼吧"那句占位（它带 margin:auto，会把后面的东西顶到最下面）——
  //   先把占位拿掉，否则"正在输入…"会跑到聊天框底部（用户报的 bug）
  const note = log.querySelector('.center-note');
  if (note) note.remove();
  const row = document.createElement('div');
  row.className = 'chat-row other';
  const face = document.createElement('img');
  face.className = 'chat-face';
  face.alt = '';
  face.src = faceSrc || ASSETS.avatar('avatar_01');
  const t = document.createElement('div');
  t.className = 'chat-msg other typing-bubble';
  t.textContent = '正在输入…';
  row.append(face, t);
  log.append(row);
  log.scrollTop = log.scrollHeight;
}

/**
 * 把文本插到 [start, end) 之间（纯函数，便于测试）
 * @returns {{value:string, pos:number}} 新内容与插入后的光标位置
 */
export function insertAt(value, start, end, text) {
  const v = String(value || '');
  const s = Math.max(0, Math.min(Number.isFinite(start) ? start : v.length, v.length));
  const e = Math.max(s, Math.min(Number.isFinite(end) ? end : v.length, v.length));
  return { value: v.slice(0, s) + text + v.slice(e), pos: s + String(text).length };
}

/* ---------------- 聊天记录的时间分隔 ---------------- */

/** 隔了这么久才在消息上方插一条时间（PRD §2.12） */
export const CHAT_TIME_GAP = 5 * 60 * 1000;

/**
 * ★ 真聊天的"合并显示"：同一个人连着发、且间隔很短 → 后一条不再重复头像，
 *   两条之间的间距也收紧一点（微信 / Telegram 都这样，一眼能看出"这是一串"）
 */
export const CHAT_CONT_GAP = 3 * 60 * 1000;

/** 时间戳 → 「14:32」/「昨天 14:32」/「3月5日 14:32」/「2025年3月5日 14:32」 */
export function chatTimeLabel(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === n.getFullYear()
    && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hm;
  const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) {
    return `昨天 ${hm}`;
  }
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * 会话列表右上角那行小字（真实聊天软件的样子）：
 * 今天给「14:32」，昨天给「昨天」，更早给「3月5日」/「2025/3/5」—— 一格放得下。
 */
export function listTimeLabel(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === n.getFullYear()
    && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hm;
  const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) {
    return '昨天';
  }
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 每条消息上面要不要插时间
 * 规则：**本窗口第一条**要插（刚加好友的第一句话就看得到时间），
 *       之后只有跟**上一条隔了 5 分钟以上**才再插一条 —— 不然每条都顶个时间太吵。
 * @param {{at?:number}[]} chat
 * @returns {boolean[]} 与 chat 等长
 */
export function chatTimeFlags(chat, gap = CHAT_TIME_GAP) {
  const list = Array.isArray(chat) ? chat : [];
  let prev = null;
  return list.map((m) => {
    const at = Number(m && m.at);
    if (!Number.isFinite(at) || at <= 0) return false; // 老存档没有 at：宁可不显示
    const show = prev === null || at - prev >= gap;
    prev = at;
    return show;
  });
}

/** 把表情插入到输入框的光标处（不是直接发一条表情消息） */
function insertAtCaret(input, text) {
  const r = insertAt(
    input.value,
    input.selectionStart == null ? input.value.length : input.selectionStart,
    input.selectionEnd == null ? input.value.length : input.selectionEnd,
    text,
  );
  input.value = r.value;
  try { input.setSelectionRange(r.pos, r.pos); } catch { /* 某些环境不支持，忽略 */ }
}

const EMOJIS = ['😀', '😂', '🤔', '😎', '😭', '👏', '👍', '🙏', '🔥', '❤️', '🌸', '🐱', '😴', '🤝', '🎉', '🀄'];

/* ===================================================================== */
/*                              好友面板                                  */
/* ===================================================================== */
/**
 * 社交面板（好友 / 群聊 / 友圈）
 * @param {object} app
 * @param {{personaId?:string}} [opts] personaId = 一进来就选中这位好友（友圈点名字跳过来用）
 */
export function openFriends(app, opts = {}) {
  const list = listFriends(app.save);
  const want = opts && opts.personaId;
  let currentId = (want && list.some((f) => f.personaId === want)) ? want : (list[0]?.personaId || null);
  let picking = false;
  let busy = false;
  /** 搜索框里的字（真聊天软件左栏顶上那一条）：只过滤左栏，不动右边正在聊的人 */
  let query = '';
  let docClick = null;
  /** 当前这一批"推荐认识的人"：进面板时随机抽 10 个，点「换一批」再抽一次 */
  let candidates = [];
  /**
   * 已经发出申请、还在等对方通过的那些人（用户拍板：申请要延迟 1~5 秒才通过）
   * 列表上显示"等待通过…"，期间再点也不会重复发。
   */
  const pendingAdd = new Set();
  /** 输入法保护：组词期间不重画（否则中文输入法会被锁死，见 ui/imeGuard.js） */
  const ime = createImeGuard({ onFlush: () => renderMain() });

  const el = openDrawer(`
    <div class="drawer friends-drawer">
      <div class="drawer-head">
        <h3 class="drawer-title">社交</h3>
        <div class="friends-head-actions">
          <button class="mini-btn" id="btn-add-friend" type="button">+ 加好友</button>
          <button class="drawer-close" data-close type="button">✕</button>
        </div>
      </div>
      <div class="panel-tabs" id="friend-tabs">
        <button class="panel-tab is-active" data-ftab="friends" type="button">👤 好友</button>
        <button class="panel-tab" data-ftab="groups" type="button">👥 群聊<i class="dot" id="group-dot" hidden></i></button>
        <button class="panel-tab" data-ftab="moments" type="button">🌈 友圈<i class="dot" id="moment-dot" hidden></i></button>
      </div>
      <div class="friends-body" id="friends-body">
        <div class="friend-col">
          <div class="friend-search">
            <span class="fs-ico">🔍</span>
            <input type="text" id="friend-search" placeholder="搜索好友" maxlength="16" autocomplete="off" />
          </div>
          <aside class="friend-list" id="friend-list"></aside>
        </div>
        <section class="friend-main" id="friend-main"></section>
      </div>
      <div class="groups-body" id="groups-body" hidden></div>
      <div class="moments-body" id="moments-body" hidden></div>
    </div>`, {
    onClose: () => {
      if (docClick) document.removeEventListener('click', docClick);
      app.friendRenderers.delete(refreshAll);
      app.friendsActiveWith = ''; // 面板关了：谁都不算"正在聊"
    },
  });

  /* ---------------- 标签切换：好友 / 群聊 / 友圈 ---------------- */
  let tab = 'friends';
  const bodyBox = el.querySelector('#friends-body');
  const groupBox = el.querySelector('#groups-body');
  const momentBox = el.querySelector('#moments-body');
  let groupsView = null;
  let momentsView = null;
  const switchTab = (next) => {
    // 离开群聊就把挂机自动聊天停掉（它自己也会靠可见性停，这里是主动收尾）
    if (tab === 'groups' && next !== 'groups' && groupsView && groupsView.destroy) groupsView.destroy();
    tab = next;
    el.querySelectorAll('#friend-tabs .panel-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.ftab === tab));
    const onGroups = tab === 'groups';
    const onMoments = tab === 'moments';
    bodyBox.hidden = onGroups || onMoments;
    groupBox.hidden = !onGroups;
    momentBox.hidden = !onMoments;
    // 加好友只在好友页有意义
    el.querySelector('#btn-add-friend').style.display = (onGroups || onMoments) ? 'none' : '';
    if (onGroups) {
      clearAllGroupUnread(app.save);
      app.persist('groupRead');
      app.updateFriendDot();
      el.querySelector('#group-dot').hidden = true;
      groupsView = renderGroups(app, groupBox);
    } else if (onMoments) {
      // 打开就算看过了：之后好友再来评论才重新亮红点
      markMomentsSeen(app.save);
      app.persist('momentRead');
      el.querySelector('#moment-dot').hidden = true;
      momentsView = renderMoments(app, momentBox);
    }
  };
  el.querySelectorAll('#friend-tabs [data-ftab]').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.ftab)));
  el.querySelector('#group-dot').hidden = groupUnreadTotal(app.save) === 0;
  el.querySelector('#moment-dot').hidden = momentUnreadTotal(app.save) === 0;
  /**
   * ★ 告诉 app："玩家此刻正开着谁的聊天"（用户报的 bug：
   *   刚加好友时明明就停在聊天界面，对方那条消息还是亮红点）。
   *   主动搭话/补发消息那条路会先看这个值，正看着就不点红点。
   */
  app.friendsActiveWith = '';

  void groupsView;
  void momentsView;

  // 点别处收起表情面板
  docClick = (e) => {
    const pop = document.getElementById('friend-emoji-pop');
    if (!pop || pop.hidden) return;
    if (!e.target.closest || (!e.target.closest('#friend-emoji-pop') && !e.target.closest('#friend-emoji'))) {
      pop.hidden = true;
    }
  };
  document.addEventListener('click', docClick);

  // 好友主动发来消息时（每局结束会随机来 1~2 个）实时刷新；
  // 友圈那边好友来评论 / 点赞也走这里（正开着友圈才重画）
  const refreshAll = () => {
    renderList();
    renderMain();
    if (tab === 'moments' && momentsView) momentsView.render();
    el.querySelector('#moment-dot').hidden = momentUnreadTotal(app.save) === 0;
  };
  app.friendRenderers.add(refreshAll);

  const listBox = el.querySelector('#friend-list');
  const mainBox = el.querySelector('#friend-main');
  // ★ 搜索：只过滤左栏（像真聊天软件那样），不影响右边正在聊的人
  const searchInput = el.querySelector('#friend-search');
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    renderList();
  });
  ime.bind(searchInput);

  function renderList() {
    const friends = listFriends(app.save);
    const q = query.trim().toLowerCase();
    // 名字 / 个性签名 都能搜到（签名就是列表第二行那句话）
    const shown = q
      ? friends.filter((f) => {
        const p = personaById(f.personaId);
        const hay = `${friendDisplay(f).name} ${p ? signatureOf(p) : ''}`.toLowerCase();
        return hay.includes(q);
      })
      : friends;
    if (!friends.length) {
      listBox.innerHTML = '<p class="center-note" style="padding:16px 6px">还没有好友<br>去右边「加好友」看看有没有聊得来的</p>';
      return;
    }
    if (!shown.length) {
      listBox.innerHTML = '<p class="center-note" style="padding:16px 6px">没有找到这个人<br>换个名字再试试</p>';
      return;
    }
    listBox.innerHTML = shown.map((f) => {
      const d = friendDisplay(f);
      const p = personaById(f.personaId);
      // 列表第二行给的是**第一人称个性签名**（"话不多，手不软"）——
      // 关系档（点头之交 / 挚友…）留到右边聊天窗口的标题里看，列表上不重复。
      const sign = p ? signatureOf(p) : '';
      // 右侧一列：最后一条消息的时间 + 未读红点（真实聊天软件的会话行）
      const last = f.chat && f.chat.length ? f.chat[f.chat.length - 1] : null;
      const time = last ? listTimeLabel(last.at) : '';
      return `
      <div class="friend-item ${f.personaId === currentId ? 'is-active' : ''}" data-friend="${f.personaId}">
        <img class="friend-avatar" src="${ASSETS.avatar(d.avatar)}" alt="" />
        <div class="friend-meta">
          <div class="friend-name"><span class="fn-text">${d.name}</span>${genderTag(p)}${loverBadge(app.save, f.personaId)}</div>
          <div class="friend-sub">${sign}</div>
        </div>
        <div class="friend-side">
          ${time ? `<span class="friend-time">${time}</span>` : ''}
          ${f.unread ? `<span class="unread-badge">${f.unread > 9 ? '9+' : f.unread}</span>` : ''}
        </div>
      </div>`;
    }).join('');
    listBox.querySelectorAll('[data-friend]').forEach((node) => node.addEventListener('click', () => {
      currentId = node.dataset.friend;
      picking = false;
      clearUnread(app.save, currentId);
      app.persist('friendRead');
      app.updateFriendDot();
      renderList();
      renderMain();
    }));
  }

  /** 抽一批推荐：优先还没加过的，随机 10 个；不够就用已加过的补齐（会标"已是好友"） */
  function rollCandidates() {
    const friendIds = listFriends(app.save).map((f) => f.personaId);
    candidates = [...pickRandom(PERSONAS.filter((p) => !friendIds.includes(p.id)), PICKER_COUNT)];
    if (candidates.length < PICKER_COUNT) {
      const added = PERSONAS.filter((p) => friendIds.includes(p.id));
      candidates = candidates.concat(pickRandom(added, PICKER_COUNT - candidates.length));
    }
  }

  function renderPicker() {
    const friendIds = listFriends(app.save).map((f) => f.personaId);
    const items = candidates.map((p) => {
      const already = friendIds.includes(p.id);
      const waiting = pendingAdd.has(p.id);
      return `<div class="picker-item ${already || waiting ? 'is-added' : ''}" data-add="${p.id}">
        <img class="friend-avatar" src="${ASSETS.avatar(p.avatar)}" alt="" />
        <div class="friend-meta">
          <div class="friend-name"><span class="fn-text">${p.name}</span>${genderTag(p)}</div>
          <div class="friend-sub">${signatureOf(p)}</div>
        </div>
        <span class="picker-add">${already ? '已是好友' : (waiting ? '等待通过…' : '加好友')}</span>
      </div>`;
    }).join('');
    mainBox.innerHTML = `
      <div class="friend-head">
        <b>可能聊得来的人</b>
        <button class="mini-btn" id="btn-reroll" type="button" style="margin-left:auto">换一批</button>
      </div>
      <div class="friend-picker">${items}</div>`;
    mainBox.querySelector('#btn-reroll').addEventListener('click', () => {
      rollCandidates();
      audio.play('select');
      renderPicker();
    });
    /**
     * ★ 加好友改成"发申请"（用户拍板）：
     *   点一下 → 弹一层浮窗**编辑申请文案** → 发送 → **延迟 1~5 秒**对方通过 →
     *   聊天里先出现**我发的申请**，再让 TA **回这条申请**（这就是两条消息的样子）。
     *   原来是一点就直接成为好友、然后对方固定 0.8 秒后冒一句问候。
     */
    mainBox.querySelectorAll('[data-add]').forEach((node) => node.addEventListener('click', () => {
      if (node.classList.contains('is-added') || pendingAdd.has(node.dataset.add)) return;
      const p = personaById(node.dataset.add);
      if (!p) return;
      void askFriendRequest(p).then((note) => {
        if (note == null) return; // 取消
        pendingAdd.add(p.id);
        renderPicker();
        // 对方"看了一眼"再通过：1~5 秒
        const wait = FRIEND.acceptMinMs + Math.random() * Math.max(0, FRIEND.acceptMaxMs - FRIEND.acceptMinMs);
        setTimeout(() => {
          pendingAdd.delete(p.id);
          const res = addFriend(app.save, p);
          if (!res.ok) { toast(res.error, 'bad'); renderPicker(); return; }
          app.persist('friendAdd');
          audio.play('select');
          currentId = p.id;
          picking = false;
          renderList();
          // ★ 先落"我发的申请"，再让 TA 回这条 —— sendFriendMessage 正好就是这套流程
          //   （它会把我的话插进去、挂一行"对方已经同意了"、显示"正在输入…"、拿到回复再插进去）
          void sendFriendMessage(app, p.id, note, {
            onBusy: (v) => { busy = v; },
            refresh: () => { renderList(); renderMain(); },
            systemNote: '对方已经同意了你的好友申请',
          });
          renderMain();
        }, wait);
      });
    }));
  }

  /**
   * 加好友申请浮窗（编辑文案，返回 Promise<string|null> = 取消）
   * 复用群里那套 `.gc-overlay / .gc-dialog` 样式，风格统一。
   */
  function askFriendRequest(persona) {
    return askFriendRequestOverlay({ app, persona, host: el });
  }

  function renderMain() {
    /**
     * ★ 告诉 app"玩家此刻正开着谁的聊天"（用户报的 bug：刚加好友时明明就停在聊天界面，
     *   对方那条消息还是亮红点）。挑人界面不算"正在聊"。
     */
    app.friendsActiveWith = picking ? '' : (currentId || '');
    /**
     * ★ 输入法保护（用户报的 bug：AI 刷新时正在打字 → 中文输入法被锁死）
     *   组词期间一律不重画这个面板，等这一字上屏再补画（见 ui/imeGuard.js）
     */
    if (ime.shouldDefer()) return;
    if (picking) return renderPicker();
    const friend = currentId ? findFriend(app.save, currentId) : null;
    if (!friend) {
      mainBox.innerHTML = '<p class="center-note" style="margin:auto">左侧选择一位好友开始聊天</p>';
      return;
    }
    /**
     * ★ 保住"还没发出去的字"：AI 回消息时会整块重画这个面板，
     *   以前会把玩家正在输入的内容清空（用户报的 bug）。
     *   重画前记下草稿与光标，重画后装回去。
     */
    const prevInput = mainBox.querySelector('#friend-input');
    const draft = prevInput ? prevInput.value : '';
    const wasFocused = prevInput && document.activeElement === prevInput;
    const caret = prevInput && typeof prevInput.selectionStart === 'number' ? prevInput.selectionStart : null;
    const tier = tierOf(app.save, friend);
    const disp = friendDisplay(friend);
    // 好感度满了但还没定关系时给一句轻提示；已经是恋人就标一下
    const hint = canConfess(app.save, friend)
      ? '<div class="lover-hint">💗 好感度已满 —— 心里话可以直接说出来</div>'
      : (isLover(app.save, friend.personaId) ? '<div class="lover-hint is-lover">💞 你们是恋人</div>' : '');
    // 时间分隔：本窗口第一条一定有，之后隔 5 分钟以上才再插一条
    const timeFlags = chatTimeFlags(friend.chat);
    // ★ 每条消息配头像（对方用 TA 的、自己用玩家的），像真聊天软件那样左右各一排
    const meFace = playerAvatarSrc(app.save);
    const chat = friend.chat.length
      ? friend.chat.map((m, i) => {
        const stamp = timeFlags[i]
          ? `<div class="chat-time">${chatTimeLabel(m.at)}</div>`
          : '';
        // ★ 系统提示（"对方已经同意了你的好友申请"）：居中一行小灰字，不进气泡
        if (m.role === 'sys') return `${stamp}<div class="chat-sys">${m.text}</div>`;
        // ★ 赠礼消息单独渲染成"礼物卡"（金边 + 礼物 emoji + 名字），一眼认出这是礼物
        const giftChip = m.gift
          ? `<span class="chat-gift">${m.gift.emoji || '🎁'} ${m.gift.name}${m.role === 'me' ? '（已送出）' : '（已收下）'}</span>`
          : '';
        const mine = m.role === 'me';
        const face = `<img class="chat-face" src="${mine ? meFace : ASSETS.avatar(disp.avatar)}" alt="" />`;
        // 同一个人连着发的后几条：合并显示（不重复头像、间距收紧）
        const prev = i > 0 ? friend.chat[i - 1] : null;
        const cont = !!prev && prev.role === m.role && !timeFlags[i] && !m.gift && !prev.gift
          && Number(m.at) - Number(prev.at) < CHAT_CONT_GAP;
        return `${stamp}<div class="chat-row ${mine ? 'self' : 'other'}${cont ? ' is-cont' : ''}">${face}<div class="chat-msg ${mine ? 'self' : 'other'}${m.gift ? ' is-gift' : ''}">${m.text}${giftChip}</div></div>`;
      }).join('')
      : '<p class="center-note" style="margin:auto">打个招呼吧</p>';

    // 赠送礼物：每天每位好友最多 GIFT.dailyPerFriend 次（用户拍板）
    const giftLeft = giftsLeftFor(app.save, friend.personaId);
    const giftRows = giftStockRows(app.save);

    mainBox.innerHTML = `
      <div class="friend-head">
        <img class="friend-avatar" src="${ASSETS.avatar(disp.avatar)}" alt="" />
        <div class="friend-meta">
          <div class="friend-name">${disp.name}${genderTag(personaById(friend.personaId))}${loverBadge(app.save, friend.personaId)}</div>
          <div class="friend-sub"><i class="online-dot"></i>${tier.label}</div>
        </div>
        <button class="mini-btn" id="btn-gift-friend" type="button">🎁 赠送礼物${giftLeft > 0 ? '' : '（今天已满）'}</button>
        <button class="mini-btn${isLover(app.save, friend.personaId) ? ' is-locked' : ''}" id="btn-drop-friend" type="button"
          title="${isLover(app.save, friend.personaId) ? '恋人不允许直接删除好友：先跟 TA 分手' : '删除好友'}">删除好友</button>
      </div>
      <div class="gift-pop" id="gift-pop" hidden>
        <div class="gift-pop-head">
          <b>送 TA 一件礼物</b>
          <span class="gift-pop-left">今天还可以送 <b>${giftLeft}</b> 次</span>
        </div>
        <div class="gift-pop-list">
          ${giftRows.map((g) => `
            <button class="gift-opt" data-gift="${g.id}" type="button" ${g.count > 0 && giftLeft > 0 ? '' : 'disabled'}>
              <span class="gift-emoji">${g.emoji}</span>
              <span class="gift-name">${g.name}</span>
              <span class="gift-aff">好感 +${g.affinity}</span>
              <span class="gift-stock">${g.count > 0 ? `持有 ${g.count}` : '没有，去商城买'}</span>
            </button>`).join('')}
        </div>
        <div class="gift-pop-tip">礼物在商城「🎁 礼物」里买；送出去会写进 TA 的记忆，还会收到一句回应。</div>
      </div>
      ${hint}
      <div class="chat-log friend-log" id="friend-log">${chat}</div>
      <div class="friend-input-wrap">
        <div class="chat-input-row">
          <input type="text" id="friend-input" maxlength="60" placeholder="和 ${friend.name} 说点什么…" />
          <button class="icon-btn" id="friend-emoji" title="发表情" type="button">😀</button>
          <button class="btn primary" id="friend-send" type="button">发送</button>
        </div>
        <div class="emoji-pop" id="friend-emoji-pop" hidden>
          <div class="pop-row">
            ${EMOJIS.map((e) => `<button class="pop-item emoji" data-emoji="${e}" type="button">${e}</button>`).join('')}
          </div>
        </div>
      </div>`;

    mainBox.innerHTML = `
      <div class="friend-head">
        <img class="friend-avatar" src="${ASSETS.avatar(disp.avatar)}" alt="" />
        <div class="friend-meta">
          <div class="friend-name">${disp.name}${genderTag(personaById(friend.personaId))}${loverBadge(app.save, friend.personaId)}</div>
          <div class="friend-sub"><i class="online-dot"></i>${tier.label}</div>
        </div>
        <button class="mini-btn" id="btn-gift-friend" type="button">🎁 赠送礼物${giftLeft > 0 ? '' : '（今天已满）'}</button>
        <button class="mini-btn${isLover(app.save, friend.personaId) ? ' is-locked' : ''}" id="btn-drop-friend" type="button"
          title="${isLover(app.save, friend.personaId) ? '恋人不允许直接删除好友：先跟 TA 分手' : '删除好友'}">删除好友</button>
      </div>
      <div class="gift-pop" id="gift-pop" hidden>
        <div class="gift-pop-head">
          <b>送 TA 一件礼物</b>
          <span class="gift-pop-left">今天还可以送 <b>${giftLeft}</b> 次</span>
        </div>
        <div class="gift-pop-list">
          ${giftRows.map((g) => `
            <button class="gift-opt" data-gift="${g.id}" type="button" ${g.count > 0 && giftLeft > 0 ? '' : 'disabled'}>
              <span class="gift-emoji">${g.emoji}</span>
              <span class="gift-name">${g.name}</span>
              <span class="gift-aff">好感 +${g.affinity}</span>
              <span class="gift-stock">${g.count > 0 ? `持有 ${g.count}` : '没有，去商城买'}</span>
            </button>`).join('')}
        </div>
        <div class="gift-pop-tip">礼物在商城「🎁 礼物」里买；送出去会写进 TA 的记忆，还会收到一句回应。</div>
      </div>
      ${hint}
      <div class="chat-log friend-log" id="friend-log">${chat}</div>
      <div class="friend-input-wrap">
        <div class="chat-input-row">
          <input type="text" id="friend-input" maxlength="60" placeholder="和 ${friend.name} 说点什么…" />
          <button class="icon-btn" id="friend-emoji" title="发表情" type="button">😀</button>
          <button class="btn primary" id="friend-send" type="button">发送</button>
        </div>
        <div class="emoji-pop" id="friend-emoji-pop" hidden>
          <div class="pop-row">
            ${EMOJIS.map((e) => `<button class="pop-item emoji" data-emoji="${e}" type="button">${e}</button>`).join('')}
          </div>
        </div>
      </div>`;

    const log = mainBox.querySelector('#friend-log');
    log.scrollTop = log.scrollHeight;

    /**
     * ★ 拍一拍（用户拍板）：**双击头像** → 聊天里插一条居中系统提示 `你拍了拍「XX」的…`，
     *   然后对方回一句符合性格的短话（见 ai/nudge.js）。
     *
     *   为什么挂在聊天容器上做**事件委托**、而不是给每个头像单独绑：
     *     · 每次重画（AI 回一条就重画一次）都会换掉所有节点，逐个绑必然漏
     *     · 单节点绑定还容易和"单击"打架；委托 + 只认 `dblclick` 干净得多
     *   和现有单击交互的关系：私聊头像**本来没绑单击**，所以双击不会误触发任何东西。
     */
    log.addEventListener('dblclick', (e) => {
      if (!nudgeHit(e.target, log)) return;
      nudgeFriend(friend.personaId, disp.name);
    });

    // ★ 把重画前记下的草稿装回去（AI 回消息不再吃掉你打了一半的字）
    const newInput = mainBox.querySelector('#friend-input');
    if (newInput && draft) {
      newInput.value = draft;
      const pos = caret == null ? draft.length : Math.min(caret, draft.length);
      try { newInput.setSelectionRange(pos, pos); } catch { /* 忽略 */ }
    }
    if (newInput && wasFocused && !busy) newInput.focus();
    // 每次重画后都要重新挂组词监听（旧节点已经换掉了）
    ime.bind(newInput);

    /**
     * ★ 聊天头部那个头像也能拍（用户拍板：私聊里"头部与每条消息的头像"都能双击）。
     *   头部只有一个节点，直接绑就行。
     *   单击在这上面本来就没有绑定（不会和"点头像 @人 / 回复"那套冲突——那套在群聊里）。
     */
    const headFace = mainBox.querySelector('.friend-head .friend-avatar');
    if (headFace) headFace.addEventListener('dblclick', () => nudgeFriend(friend.personaId, disp.name));

    mainBox.querySelector('#btn-drop-friend').addEventListener('click', () => {
      const res = removeFriend(app.save, friend.personaId);
      /**
       * ★ 恋人保护（用户拍板）：恋人不允许直接删好友。
       *   这里除了报错，还多给一句"怎么才能删"的指路（分手），别让玩家卡住。
       */
      if (!res.ok) {
        return toast(res.needBreakup
          ? 'TA 是你的恋人 —— 想删好友，先在聊天里跟 TA 说分手'
          : res.error, 'bad');
      }
      app.persist('friendRemove');
      currentId = listFriends(app.save)[0]?.personaId || null;
      // 记忆不会被删掉：加回来时它还认得你（好感 -5，并且它会记得"你删过我"）
      toast(`已删除好友（好感 -${FRIEND.removeAffinityPenalty}，但它还记得你）`);
      renderList();
      renderMain();
    });

    const input = mainBox.querySelector('#friend-input');
    const pop = mainBox.querySelector('#friend-emoji-pop');
    const sendText = (text) => {
      const t = String(text || '').trim();
      if (!t || busy) return;
      void sendFriendMessage(app, friend.personaId, t, {
        onBusy: (v) => { busy = v; },
        refresh: () => { renderList(); renderMain(); },
      });
    };
    const send = () => {
      const t = input.value.trim();
      if (!t) return;
      /**
       * ★ 指令（用户拍板：给好友发 【/happy】 直接满好感度）
       *   指令**不发出去、不进聊天记录、也不调模型** —— 只改数据 + 弹一句提示。
       */
      const cheat = applyCheat(app.save, friend.personaId, t);
      if (cheat.handled) {
        input.value = '';
        app.persist('cheat');
        audio.play('coin');
        toast(`⚡ ${cheat.message}`, 'gold');
        renderList();
        renderMain();
        return;
      }
      input.value = '';
      sendText(t);
    };
    mainBox.querySelector('#friend-send').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    /* ---------------- 赠送礼物（用户拍板：每天每位好友最多 3 次） ---------------- */
    const giftPop = mainBox.querySelector('#gift-pop');
    mainBox.querySelector('#btn-gift-friend').addEventListener('click', (e) => {
      e.stopPropagation();
      if (giftsLeftFor(app.save, friend.personaId) <= 0) {
        toast(`今天已经给「${disp.name}」送过 ${GIFT.dailyPerFriend} 次了，明天再来`, 'bad');
        return;
      }
      giftPop.hidden = !giftPop.hidden;
    });
    giftPop.querySelectorAll('[data-gift]').forEach((btn) => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const giftId = btn.dataset.gift;
      const res = sendGiftToFriend(app.save, app.economy, friend.personaId, giftId);
      if (!res.ok) return toast(res.error, 'bad');
      giftPop.hidden = true;
      app.persist('gift');
      audio.play('coin');
      toast(`${res.gift.emoji} 送出 ${res.gift.name}，好感 +${res.affinity}（今天还能送 ${res.left} 次）`, 'gold');
      /**
       * ★ 赠礼消息发给好友 → 好友据此回应（用户要求）
       *   走的是**和普通私聊完全同一条链路**：赠礼消息带礼物卡 + 一句"刚收到礼物要先谢他"的提示，
       *   回复出来之后再走 settleFriendChat 的审查（好感/记忆/自设/表白/回赠礼物）。
       */
      void sendFriendMessage(app, friend.personaId, playerGiftLine(res.gift), {
        onBusy: (v) => { busy = v; },
        refresh: () => { renderList(); renderMain(); },
        gift: res.gift,
        giftNote: `${res.gift.emoji}${res.gift.name}（💰${res.gift.price.toLocaleString()}，好感 +${res.gift.affinity}）`,
      });
    }));

    /* 表情：插入到输入框里，跟文字一起发出去（不是直接发一条表情消息） */
    mainBox.querySelector('#friend-emoji').addEventListener('click', (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      if (!pop.hidden) input.focus();
    });
    pop.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      e.stopPropagation();
      insertAtCaret(input, btn.dataset.emoji);
      input.focus();
    });
    input.focus();
  }

  /**
   * 拍一拍（私聊）—— 用户拍板：双击好友头像触发。
   *
   * 流程（和真聊天软件一致）：
   *   ① 节流放行 → ② 插一条居中系统提示（`role:'sys'`，复用已有的 `.chat-sys` 样式）
   *   → ③ 显示"正在输入…" → ④ 对方回一句 → ⑤ 落进聊天记录。
   *
   * ★ 回应走**专用提示词**（ai/nudge.js 的 nudgeReply），不是普通私聊提示词 ——
   *   被戳一下只需要一句即时反应，不需要塞满记忆与对局那一大套。
   * ★ 模型不可用 / 断网 → nudgeReply 内部自动降到本地兜底，**一定有一句话**。
   * ★ 这条**不进记忆、不动好感度**（只是社交小动作，不该按聊天那套结算）。
   *
   * @param {string} personaId
   * @param {string} name 显示名（好友备注名优先）
   * @returns {Promise<boolean>} 真的拍到了（不是被节流拦下）才 true
   */
  async function nudgeFriend(personaId, name) {
    if (!personaId) return false;
    const persona = personaById(personaId);
    if (!persona) return false;
    // 节流：同一个人 4 秒内只生效一次（参数在 config 的 NUDGE.cooldownMs）
    if (!allowNudge(ensureNudgeStore(app), personaId)) {
      toast('刚拍过了，等一下下', 'bad');
      return false;
    }
    audio.play('select');
    appendChat(app.save, personaId, 'sys', buildNudgeLine(personaId, name || persona.name));
    renderList();
    renderMain();
    // 对方"愣了一下再看过来"：别让系统提示和回应同帧弹出来
    showTyping(ASSETS.avatar(persona.avatar));
    const started = Date.now();
    try {
      const { text } = await nudgeReply({
        persona,
        nudgeLine: buildNudgeLine(personaId, name || persona.name),
        myTitle: (aiTitleOf(app.save, personaId) || {}).name || '',
      });
      const wait = NUDGE.replyDelayMs - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      // 面板可能在等回复期间被关掉 / 换了人：那就别把消息插到别人那里
      if (!findFriend(app.save, personaId)) return false;
      if (!text) return false;
      appendChat(app.save, personaId, 'ai', text);
      app.persist('friendChat');
      renderList();
      renderMain();
      return true;
    } catch (err) {
      console.warn('[friend] 拍一拍失败：', err);
      return false;
    }
  }

  el.querySelector('#btn-add-friend').addEventListener('click', () => {
    picking = true;
    rollCandidates(); // 每次进来换一批新人，不是老面孔
    renderMain();
  });

  renderList();
  if (currentId) {
    clearUnread(app.save, currentId);
    app.updateFriendDot();
  }
  renderMain();
}

/**
 * 发一条消息
 * 流程：回复 → 再单独调用一次 AI 判断好感度变化与是否写入 memory
 * 注意：①判断结果**只落库、不告诉玩家**；②无论成功失败都要复位 busy，否则后续消息会被卡住
 *
 * ★ 这个函数在 `openFriends` **外面**（模块级）——**只能用参数里的东西**，
 *   千万别引用面板里的闭包变量（`currentId` 那种），否则一发送就 ReferenceError。
 *   导出是为了让冒烟测试能真跑一遍这条路径。
 */
export async function sendFriendMessage(app, personaId, text, { onBusy, refresh, gift = null, giftNote = '', systemNote = '' }) {
  const persona = personaById(personaId);
  if (!persona) return;
  onBusy(true);
  try {
    // gift 有值 = 这条是**赠礼消息**：聊天里渲染成礼物卡，并让 AI 先谢他
    appendChat(app.save, personaId, 'me', text, gift ? { gift } : null);
    /**
     * ★ 系统提示（用户要求）：加好友时在我那句申请**下面**显示一行小灰字，
     *   「对方已经同意了你的好友申请」—— 正好夹在"我发的申请"和"TA 的回复"中间。
     */
    if (systemNote) {
      appendChat(app.save, personaId, 'sys', systemNote);
      app.persist('friendAdd');
    }
    refresh();
    // ★ "正在输入…"也带头像（用户要求：不然一条光气泡看着像换了个人）
    showTyping(ASSETS.avatar(persona.avatar));

    const started = Date.now();
    const friend = findFriend(app.save, personaId);
    const myTitle = aiTitleOf(app.save, personaId);
    // 最近一局：参加了才能聊细节，没参加只能"问问"
    const lastMatch = (app.save.recentHands || [])[0] || null;
    const { text: reply, second = '' } = await friendReply({
      persona,
      friend,
      text,
      // AI 自己的身家与称号：当作背景知识交给模型（不刻意提钱）
      myBeans: aiBeansOf(app.save, personaId),
      myTitle: myTitle ? myTitle.name : '',
      lastMatch,
      joined: app.matchJoinedBy(lastMatch, personaId),
      modeName: lastMatch ? MODE_NAME[lastMatch.kind] || '' : '',
      // 玩家性别：别把称呼叫错（见 data/player.js）
      playerGender: playerGenderLine(app.save),
      // ★ 玩家是谁：整段背景知识（昵称 + 性别 + 该怎么叫他）——
      //   这里用的是这个人设**自己**记得的称呼（personaId 对应的好友记录）
      playerIdentity: playerIdentityLines(app.save, { callName: callNameOf(friend), selfId: personaId }),
      // 玩家是谁：对局概括里出现他的昵称，要认得出来（用户报过认成第三个人）
      playerName: app.playerName,
      giftNote,
    });

    // 打字慢的人设：先"正在输入…"一会儿再发出来
    const wantDelay = typingDelayOf(persona);
    const wait = Math.max(0, wantDelay - (Date.now() - started));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    appendChat(app.save, personaId, 'ai', reply);
    refresh();
    /**
     * ★ 用户拍板：长回复可以**拆成两条**发 —— 隔 1~2 秒再来第二条，
     *   中间照样显示"正在输入…"，像真人分两段打字。
     */
    if (second) {
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
      if (findFriend(app.save, personaId)) {
        showTyping(ASSETS.avatar(persona.avatar));
        appendChat(app.save, personaId, 'ai', second);
        refresh();
      }
    }

    /**
     * ★ 走 app 上那份**私聊与房间弹幕共用**的沉淀逻辑：
     *   好感度 / memory / 自设 / 表白 / 分手 都在这一个方法里
     * ★ 拆成两条发的时候，**两条都算它说的话**（合成一段交给审查），
     *   不然审查只看第一条，"它到底答没答应"这种判断就会看不全。
     */
    await app.settleFriendChat(personaId, { text, reply: second ? `${reply} ${second}` : reply });

    app.persist('friendChat');
    refresh();
  } catch (err) {
    console.warn('[friend] 发送失败：', err);
    toast('发送失败，稍后再试', 'bad');
  } finally {
    onBusy(false);
  }
}

/* ===================================================================== */
/*                              房间模式                                  */
/* ===================================================================== */
export function openRoom(app, roomId) {
  const game = app.lobbyGame || 'ddz';
  const gomoku = game === 'gomoku';
  // 五子棋只要 1 位对手；钓鱼也是 1 位；斗地主 2 位
  const need = (game === 'fishing' || gomoku) ? 1 : 2;
  const roomsOf = gomoku ? GOMOKU_ROOMS : (game === 'fishing' ? FISHING_ROOMS : ROOMS);
  const room = roomsOf.find((r) => r.id === roomId) || null;
  const seats = []; // 已入座的好友 personaId
  app.roomNeedFriends = need; // 弹幕提示词里要告诉 AI "现在几个人、还缺几个"

  /** 座位卡片：第二行是「称号 + 关系 · 身家」（身家压缩成"1.2万"这种） */
  const aiCard = (personaId, { mine = false } = {}) => {
    const title = mine ? equippedTitle(app.save) : aiTitleOf(app.save, personaId);
    const beans = mine ? app.save.beans : aiBeansOf(app.save, personaId);
    const f = mine ? null : findFriend(app.save, personaId);
    const persona = mine ? null : PERSONAS.find((p) => p.id === personaId);
    const name = mine ? `${app.playerName}（你）` : ((persona && persona.name) || (f && f.name) || '好友');
    const avatarSrc = mine
      ? playerAvatarSrc(app.save)
      : ASSETS.avatar((persona && persona.avatar) || (f && f.avatar) || 'avatar_01');
    const gender = mine ? '' : genderTag(persona);
    // ★ 恋人标志（💞）在房间里也要看得见（用户要求）—— 座位卡和左侧列表都挂上
    const lover = mine ? '' : loverBadge(app.save, personaId);
    const short = room && !mine && beans < room.minBeans;
    const meta = `${mine ? '房主' : (f ? relationText(f, app.save) : '')} · ${beanLabel(beans)}${short ? ' · 补足入场' : ''}`;
    return `<div class="room-seat is-filled ${mine ? 'is-me' : ''}">
      <img src="${avatarSrc}" alt="" />
      <div class="room-seat-main">
        <div class="friend-name">${name}${gender}${lover}</div>
        <div class="seat-row">
          ${title
    ? `<span class="title-badge" style="background:${titleGradient(title)}">${title.name}</span>`
    : '<span class="seat-title-none">未佩戴称号</span>'}
          <span class="seat-meta">${meta}</span>
        </div>
      </div>
      ${mine ? '' : `<button class="mini-btn" data-kick="${personaId}" type="button">踢出</button>`}
    </div>`;
  };

  const el = openDrawer(`
    <div class="drawer wide">
      <div class="drawer-head">
        <h3 class="drawer-title">房间模式 · ${room ? room.name : ''}</h3>
        <button class="drawer-close" data-close type="button">✕</button>
      </div>
      <p class="center-note" style="margin-top:0">
        从左侧点好友入座，人满才能开始（本局对手就是你邀请的好友${(room && room.minBeans) ? `，门槛 ${beanLabel(room.minBeans)}` : ''}）
      </p>
      <div class="room-danmaku" id="room-danmaku-stage">
        <div class="danmaku-layer" id="danmaku-room"></div>
        <div class="room-dm-tip" id="room-dm-tip">好友进房后会在这里聊起来，你也可以发一条</div>
      </div>
      <div class="room-body">
        <div class="room-friends">
          <div class="room-friends-head">我的好友<span id="room-friend-count"></span></div>
          <div class="room-friends-list" id="room-friends-list"></div>
        </div>
        <div class="room-side">
          <div class="room-seats" id="room-seats"></div>
          <div class="room-actions">
            <button class="act-btn go" id="room-start" type="button" disabled>开始游戏</button>
          </div>
        </div>
      </div>
      <div class="room-chat-row">
        <input type="text" id="room-chat-input" maxlength="${DANMAKU.maxChars}" placeholder="发条弹幕…（最多 ${DANMAKU.maxChars} 字）" />
        <button class="btn primary" id="room-chat-send" type="button">发送</button>
      </div>
    </div>`, { onClose: () => app.stopDanmaku() });

  const seatsBox = el.querySelector('#room-seats');
  const listBox = el.querySelector('#room-friends-list');
  const countBox = el.querySelector('#room-friend-count');
  const startBtn = el.querySelector('#room-start');
  const dmTip = el.querySelector('#room-dm-tip');

  /**
   * 弹幕的说话人 = 已邀请的好友（按邀请顺序给座位色）。
   * 房间人数变化时同步给 app，并重排自动发弹幕的定时器。
   */
  function syncDanmaku() {
    app.roomDanmakuSeats = seats.slice();
    dmTip.hidden = seats.length > 0;
    if (app.danmakuActive) app.refreshDanmakuTimer();
  }

  function renderSeats() {
    const slots = [{ me: true }, ...Array.from({ length: need }, (_, i) => ({ id: seats[i] || null }))];
    seatsBox.innerHTML = slots.map((slot) => {
      if (slot.me) return aiCard(null, { mine: true });
      if (!slot.id) {
        return `<div class="room-seat is-empty">
          <div class="room-empty">空位</div>
          <div class="room-seat-main"><div class="friend-name">等待好友</div>
          <div class="friend-sub">从左边点一位好友入座</div></div>
        </div>`;
      }
      return aiCard(slot.id);
    }).join('');
    seatsBox.querySelectorAll('[data-kick]').forEach((btn) => btn.addEventListener('click', () => {
      const i = seats.indexOf(btn.dataset.kick);
      if (i >= 0) seats.splice(i, 1);
      audio.play('select');
      toast('已踢出房间');
      renderSeats();
      renderFriends();
    }));
    startBtn.disabled = seats.length < need;
    startBtn.textContent = seats.length < need ? `还差 ${need - seats.length} 人` : '开始游戏';
    syncDanmaku();
  }

  /** 左侧常驻好友列表：点一下就入座，再点一下移出 */
  function renderFriends() {
    const friends = listFriends(app.save);
    countBox.textContent = friends.length ? `（${friends.length}/${FRIEND.maxFriends}）` : '';
    if (!friends.length) {
      listBox.innerHTML = '<p class="center-note" style="font-size:12px">还没有好友，先去「好友」面板加几个</p>';
      return;
    }
    const full = seats.length >= need;
    listBox.innerHTML = friends.map((f) => {
      const inRoom = seats.includes(f.personaId);
      const title = aiTitleOf(app.save, f.personaId);
      const beans = aiBeansOf(app.save, f.personaId);
      const disabled = !inRoom && full;
      return `<button class="room-friend ${inRoom ? 'is-in' : ''} ${disabled ? 'is-full' : ''}"
        data-invite="${f.personaId}" type="button" ${disabled ? 'disabled' : ''}>
        <img class="friend-avatar" src="${ASSETS.avatar(f.avatar)}" alt="" />
        <span class="rf-meta">
          <span class="rf-name">${f.name}${loverBadge(app.save, f.personaId)}${title ? `<span class="title-badge" style="background:${titleGradient(title)}">${title.name}</span>` : ''}</span>
          <span class="rf-sub">${relationText(f, app.save)} · ${beanLabel(beans)}</span>
        </span>
        <span class="rf-act">${inRoom ? '已入座' : (disabled ? '已满' : '邀请')}</span>
      </button>`;
    }).join('');
    listBox.querySelectorAll('[data-invite]').forEach((node) => node.addEventListener('click', () => {
      const id = node.dataset.invite;
      const i = seats.indexOf(id);
      if (i >= 0) {
        seats.splice(i, 1); // 再点一次就移出
        toast('已移出房间');
      } else {
        if (seats.length >= need) { toast('座位已经满了', 'bad'); return; }
        seats.push(id);
        audio.play('select');
      }
      renderSeats();
      renderFriends();
    }));
  }

  startBtn.addEventListener('click', () => {
    if (seats.length < need) return;
    closePanel();
    if (gomoku) app.startGomoku(roomId, seats.slice());
    else if (game === 'fishing') app.startFishing(roomId, seats.slice());
    else app.startGame(roomId, seats.slice());
  });

  /* 玩家在房间里发弹幕（3~5 秒一条的自动弹幕之外，随时可以插话） */
  const chatInput = el.querySelector('#room-chat-input');
  const sendDanmaku = () => {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    app.sendRoomDanmaku(text);
  };
  el.querySelector('#room-chat-send').addEventListener('click', sendDanmaku);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDanmaku(); });

  renderSeats();
  renderFriends();
  app.startDanmaku('danmaku-room');
}
