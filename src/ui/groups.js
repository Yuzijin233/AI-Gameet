/**
 * 群聊界面（PRD §2.20）—— 作为「好友」面板里的第二个标签
 *
 * 交互设计（尽量贴直觉）：
 *   · 左边群列表（名字 + 人数 + 未读），上面一个「+ 创建群聊」
 *   · 右边群窗口：点群名可以改名；成员头像横排，点「邀请好友」拉人
 *   · **点某条 AI 消息 = 回复它** —— 那条消息会挂上"回复 XX"的依据，
 *     而你下一条发出去之后，**被回复的那个人一定会回你**（输入框上方会显示"正在回复 XX"）；
 *     这条发出去之后回复状态就**自动取消**，不会一直黏着下一条
 *   · 引用条 / 回复条都**不换行**：人名最多 6 个字，引用正文最多 20 个字，多的用「……」收掉
 *   · 玩家发言后：AI 判断该谁接（点名的人必须接），然后按 2~3 秒的间隔一条条冒出来，
 *     每条前面先显示"XX 正在输入…"，像真人一样
 *   · **群聊不加好感度**，但群里聊到的内容仍会过一遍 AI 审查，决定要不要写进各自的记忆
 */
import { GROUP, FRIEND, GROUP_IDLE, NUDGE } from '../config.js';
import { ASSETS } from '../../assets/manifest.js';
import { PERSONAS, genderOf, GENDER_SIGN, GENDER_TEXT } from '../data/personas.js';
import { listFriends, findFriend, addMemory, setSelfMemories, callNameOf } from '../store/friends.js';
import {
  listGroups, findGroup, createGroup, renameGroup, addGroupMembers, removeGroupMember, deleteGroup,
  appendGroupChat, groupMembers, memberNameMap, groupChatLines, recentGroupChat,
  bumpGroupUnread, clearGroupUnread,
} from '../store/groups.js';
import { findMentioned, replyCountFor, chooseResponders, groupReply, analyzeGroupChat, chooseNextSpeaker } from '../ai/group.js';
import { buildNudgeLine, allowNudge, ensureNudgeStore, nudgeReply } from '../ai/nudge.js';
import { playerAvatarSrc } from '../data/avatar.js';
import { playerAvatarHTML } from './avatarFrame.js';
import { aiBeansOf, aiTitleOf } from '../store/aiBeans.js';
import { playerGenderLine, playerIdentityLines } from '../data/player.js';
import { toast } from './fx.js';
import { audio } from './audio.js';
import { closePanel } from './panels.js';
import { createImeGuard } from './imeGuard.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const personaById = (id) => PERSONAS.find((p) => p.id === id) || null;

function timeText(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return same ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

const genderTag = (p) => (p ? `<span class="gender-tag is-${genderOf(p)}">${GENDER_SIGN[genderOf(p)]}</span>` : '');

/**
 * 回复条（引用 + 输入框上方那条"正在回复"）**都必须撑不破一行**：
 *   · 人名最多 6 个字 —— 再长的昵称也只占 6 个字的位置
 *   · 引用正文最多 20 个字，多出来的部分用「……」收掉
 * 长度按**字**数（用展开数组数码点），所以一个 emoji 只算一个字，不会被截成半个。
 */
export const QUOTE_NAME_MAX = 6;
export const QUOTE_TEXT_MAX = 20;
export const QUOTE_ELLIPSIS = '……';

/** 按"字"截断：超出就用省略号收尾（emoji 算一个字） */
export function clipChars(text, max) {
  const chars = [...String(text == null ? '' : text)];
  if (!(max > 0)) return '';
  return chars.length > max ? `${chars.slice(0, max).join('')}${QUOTE_ELLIPSIS}` : chars.join('');
}

/** 人名：最多 6 个字 */
export const clipName = (name) => clipChars(name, QUOTE_NAME_MAX);

/** 引用正文：换行/连续空白先压成空格，再按 20 个字截断 */
export const clipQuote = (text) => clipChars(String(text == null ? '' : text).replace(/\s+/g, ' ').trim(), QUOTE_TEXT_MAX);

/** 面板内的小浮层（不用 openDrawer，免得把好友面板整个换掉） */
function showOverlay(host, html) {
  const el = document.createElement('div');
  el.className = 'gc-overlay';
  el.innerHTML = `<div class="gc-dialog">${html}</div>`;
  host.append(el);
  el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
  return el;
}

/**
 * 渲染群聊标签页
 * @param {object} app
 * @param {HTMLElement} box 承载容器（好友面板里那个 groups-body）
 */
export function renderGroups(app, box) {
  let currentId = listGroups(app.save)[0]?.id || null;
  let busy = false;
  let replyTo = null; // { id, by, name, text }
  let typing = null; // 正在输入的名字
  /** 输入法保护：组词期间不重画（挂机自动聊天每 5~15 秒画一次，正在打字时会被打断） */
  const ime = createImeGuard({ onFlush: () => render() });

  /* ---------------- 建群 / 改名 / 邀请 的弹窗 ---------------- */
  function openCreate() {
    const friends = listFriends(app.save);
    if (friends.length < GROUP.minMembers) {
      return toast(`先加够 ${GROUP.minMembers} 位好友才能建群`, 'bad');
    }
    if (listGroups(app.save).length >= GROUP.maxGroups) {
      return toast(`最多建 ${GROUP.maxGroups} 个群`, 'bad');
    }
    const el = showOverlay(box, `
      <h4 class="gc-dialog-title">创建群聊</h4>
      <input type="text" id="gc-name" maxlength="12" placeholder="群名称（不填就随机一个）" />
      <div class="gc-hint">拉谁进群（至少 ${GROUP.minMembers} 位，最多 ${GROUP.maxMembers} 位）</div>
      <div class="gc-picker" id="gc-picker">
        ${friends.map((f) => {
    const p = personaById(f.personaId);
    if (!p) return '';
    return `<label class="gc-pick"><input type="checkbox" value="${p.id}" />
            <img src="${ASSETS.avatar(p.avatar)}" alt="" />
            <span>${p.name}${genderTag(p)}</span></label>`;
  }).join('')}
      </div>
      <div class="gc-dialog-actions">
        <button class="btn ghost" data-gc-cancel type="button">取消</button>
        <button class="btn primary" data-gc-ok type="button">创建</button>
      </div>`);
    el.querySelector('[data-gc-cancel]').addEventListener('click', () => el.remove());
    el.querySelector('[data-gc-ok]').addEventListener('click', () => {
      const ids = [...el.querySelectorAll('#gc-picker input:checked')].map((n) => n.value);
      const name = el.querySelector('#gc-name').value;
      const res = createGroup(app.save, name, ids);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('groupCreate');
      currentId = res.group.id;
      el.remove();
      audio.play('select');
      toast(`群聊「${res.group.name}」建好了`, 'gold');
      render();
      void kickoff(app, res.group.id, render);
    });
  }

  function openRename(group) {
    const el = showOverlay(box, `
      <h4 class="gc-dialog-title">修改群名称</h4>
      <input type="text" id="gc-rename" maxlength="12" value="${group.name}" />
      <div class="gc-dialog-actions">
        <button class="btn ghost" data-gc-cancel type="button">取消</button>
        <button class="btn primary" data-gc-ok type="button">保存</button>
      </div>`);
    const input = el.querySelector('#gc-rename');
    input.focus();
    input.select();
    el.querySelector('[data-gc-cancel]').addEventListener('click', () => el.remove());
    el.querySelector('[data-gc-ok]').addEventListener('click', () => {
      const res = renameGroup(app.save, group.id, input.value);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('groupRename');
      el.remove();
      toast('群名称已改');
      render();
    });
  }

  function openInvite(group) {
    const friends = listFriends(app.save).filter((f) => !group.members.includes(f.personaId));
    if (!friends.length) return toast('好友都已经在群里了');
    if (group.members.length >= GROUP.maxMembers) return toast(`群成员上限 ${GROUP.maxMembers} 位`, 'bad');
    const el = showOverlay(box, `
      <h4 class="gc-dialog-title">拉好友进群</h4>
      <div class="gc-hint">还能拉 ${GROUP.maxMembers - group.members.length} 位</div>
      <div class="gc-picker" id="gc-invite">
        ${friends.map((f) => {
    const p = personaById(f.personaId);
    if (!p) return '';
    return `<label class="gc-pick"><input type="checkbox" value="${p.id}" />
            <img src="${ASSETS.avatar(p.avatar)}" alt="" />
            <span>${p.name}${genderTag(p)}</span></label>`;
  }).join('')}
      </div>
      <div class="gc-dialog-actions">
        <button class="btn ghost" data-gc-cancel type="button">取消</button>
        <button class="btn primary" data-gc-ok type="button">拉进群</button>
      </div>`);
    el.querySelector('[data-gc-cancel]').addEventListener('click', () => el.remove());
    el.querySelector('[data-gc-ok]').addEventListener('click', () => {
      const ids = [...el.querySelectorAll('#gc-invite input:checked')].map((n) => n.value);
      if (!ids.length) return toast('先勾几个人吧', 'bad');
      const res = addGroupMembers(app.save, group.id, ids);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('groupInvite');
      el.remove();
      audio.play('select');
      toast(`已拉 ${res.added.map((id) => (personaById(id) || {}).name).join('、')} 进群`);
      render();
    });
  }

  /* ---------------- 群列表 ---------------- */
  function renderList(groups, group) {
    return `
      <aside class="group-list">
        <button class="mini-btn gc-new" id="gc-new" type="button">+ 创建群聊</button>
        ${groups.length ? groups.map((g) => `
          <button class="group-item ${g.id === currentId ? 'is-active' : ''}" data-group="${g.id}" type="button">
            <span class="gi-emoji">👥</span>
            <span class="gi-meta">
              <span class="gi-name">${g.name}</span>
              <span class="gi-sub">${g.members.length + 1} 人 · ${g.chat.length} 条</span>
            </span>
            ${g.unread ? `<span class="unread-badge">${g.unread > 9 ? '9+' : g.unread}</span>` : ''}
          </button>`).join('')
    : '<p class="center-note" style="padding:14px 6px">还没有群聊<br>创建一个群聊，和好友一起聊天</p>'}
      </aside>
      <section class="group-main" id="gc-main">${group ? mainHtml(group) : '<p class="center-note" style="margin:auto">从左侧选择一个群聊，或创建新群聊</p>'}</section>`;
  }

  /* ---------------- 群窗口 ---------------- */
  function mainHtml(group) {
    const members = groupMembers(group);
    const names = memberNameMap(group);
    const mySrc = playerAvatarSrc(app.save);

    const rows = group.chat.map((m) => {
      const mine = m.role === 'me';
      /**
       * ★ 系统行（拍一拍那类）：**居中一行小灰字**，不带头像也不带气泡 ——
       *   它不属于任何一个人（说"你拍了拍「XX」"的是界面，不是某个成员）。
       *   和私聊那边 `role: 'sys'` + `.chat-sys` 是同一套口径，只是群聊有自己的容器。
       */
      if (m.role === 'sys' || m.sys) {
        return `<div class="gc-msg is-sys"><div class="gc-sys">${m.text}</div></div>`;
      }
      const p = mine ? null : personaById(m.by);
      const name = mine ? app.playerName : (p ? p.name : (names[m.by] || '有人'));
      const src = mine ? mySrc : (p ? ASSETS.avatar(p.avatar) : '');
      return `
        <div class="gc-msg ${mine ? 'is-me' : 'is-ai'}" data-msg="${m.id}">
          ${mine ? playerAvatarHTML(app.save, 'gc-avatar') : `<img class="gc-avatar" src="${src}" alt="" />`}
          <div class="gc-body">
            <div class="gc-who">${clipName(name)}${mine ? '' : genderTag(p)}<span class="gc-time">${timeText(m.at)}</span></div>
            ${m.replyTo ? `<div class="gc-quote">回复 ${clipName(m.replyTo.name)}：${clipQuote(m.replyTo.text)}</div>` : ''}
            <div class="gc-bubble">${m.text}</div>
          </div>
          ${mine ? '' : '<span class="gc-reply-hint">回复</span>'}
        </div>`;
    }).join('');

    const typingRow = typing
      ? `<div class="gc-msg is-ai is-typing"><img class="gc-avatar" src="${typing.src}" alt="" />
          <div class="gc-body"><div class="gc-who">${typing.name}</div>
          <div class="gc-bubble typing-bubble">正在输入…</div></div></div>`
      : '';

    return `
      <div class="gc-head">
        <div class="gc-head-left">
          <button class="gc-title" id="gc-title" type="button" title="点一下改名">${group.name}</button>
          <span class="gc-count">${members.length + 1} 人</span>
        </div>
        <div class="gc-head-right">
          <button class="mini-btn" id="gc-invite" type="button">邀请好友</button>
          <button class="mini-btn" id="gc-del" type="button">解散</button>
        </div>
      </div>
      <div class="gc-members">
        <span class="gc-member is-me" title="这是你自己"><img src="${mySrc}" alt="" /><i>你</i></span>
        ${members.map((p) => `
          <span class="gc-member" data-at="${p.name}" data-nudge="${p.id}" role="button" tabindex="0"
            title="点一下 @${p.name}，双击拍一拍（${GENDER_TEXT[genderOf(p)]}）">
            <img src="${ASSETS.avatar(p.avatar)}" alt="" /><i>${p.name}</i>
            <button class="gc-kick" data-kick="${p.id}" type="button" title="移出群聊">✕</button>
          </span>`).join('')}
      </div>
      <div class="chat-log gc-log" id="gc-log">${rows}${typingRow}</div>
      <div class="friend-input-wrap">
        ${replyTo ? `<div class="gc-replying"><span class="gc-replying-text">正在回复 <b>${clipName(replyTo.name)}</b>：${clipQuote(replyTo.text)}</span>
          <button class="gc-cancel-reply" id="gc-cancel-reply" type="button">取消</button></div>` : ''}
        <div class="chat-input-row">
          <input type="text" id="gc-input" maxlength="${GROUP.maxChars}" placeholder="在「${group.name}」里说点什么…" ${busy ? 'disabled' : ''} />
          <button class="icon-btn" id="gc-emoji" title="发表情" type="button">😀</button>
          <button class="btn primary" id="gc-send" type="button" ${busy ? 'disabled' : ''}>发送</button>
        </div>
        <div class="emoji-pop" id="gc-emoji-pop" hidden>
          <div class="pop-row">
            ${['😀', '😂', '🤔', '😎', '😭', '👏', '👍', '🙏', '🔥', '🌸', '☕', '🃏'].map((e) => `<button class="pop-item emoji" data-emoji="${e}" type="button">${e}</button>`).join('')}
          </div>
        </div>
      </div>`;
  }



  /* ---------------- 拍一拍（双击成员头像，用户拍板） ---------------- */
  /**
   * 拍一拍（群聊）—— 双击群成员头像触发。
   *
   *   ① 节流放行 → ② 群里插一条**居中系统行**（`role:'sys'`，渲染成 `.gc-sys`）
   *   → ③ 那人回一句符合性格的短话（群聊走专用的 nudgeReply，**不发布"正在输入…"**，
   *      避免和挂机自动聊天 / 多人回复抢同一个 typing 状态）→ ④ 落进群消息。
   *
   * ★ 系统行不进提示词（见 store/groups.js 的 recentGroupChat），所以别人不会莫名其妙接一句。
   * ★ 群聊本来有"点成员头像 = @他"的单击交互，双击那一下**不会**把它打乱（见 bind 里的说明）。
   *
   * @param {string} personaId
   * @returns {Promise<boolean>} 真的拍到了才 true
   */
  async function nudgeMember(personaId) {
    const persona = personaById(personaId);
    if (!persona) return false;
    const g = currentId ? findGroup(app.save, currentId) : null;
    if (!g) return false;
    if (!allowNudge(ensureNudgeStore(app), personaId)) {
      toast('刚拍过了，等一下下', 'bad');
      return false;
    }
    audio.play('select');
    const line = buildNudgeLine(personaId, persona.name);
    appendGroupChat(app.save, g.id, { role: 'sys', by: personaId, text: line });
    app.persist('groupChat');
    render();
    const started = Date.now();
    try {
      const { text } = await nudgeReply({
        persona,
        nudgeLine: line,
        myTitle: (aiTitleOf(app.save, personaId) || {}).name || '',
      });
      const wait = NUDGE.replyDelayMs - (Date.now() - started);
      if (wait > 0) await sleep(wait);
      // 等回复期间可能切了群 / 解散了群：那就别把消息插到别的群里
      const cur = findGroup(app.save, g.id);
      if (!cur || !text) return false;
      appendGroupChat(app.save, g.id, { role: 'ai', by: personaId, text });
      bumpGroupUnread(app.save, g.id);
      clearGroupUnread(app.save, g.id); // 玩家正看着，不算未读
      app.persist('groupChat');
      render();
      return true;
    } catch (err) {
      console.warn('[group] 拍一拍失败：', err);
      return false;
    }
  }

  /* ---------------- 绑定 ---------------- */
  function bind(group) {
    box.querySelector('#gc-new')?.addEventListener('click', openCreate);
    box.querySelectorAll('[data-group]').forEach((n) => n.addEventListener('click', () => {
      currentId = n.dataset.group;
      replyTo = null;
      clearGroupUnread(app.save, currentId);
      app.persist('groupRead');
      app.updateFriendDot();
      render();
    }));
    if (!group) return;

    box.querySelector('#gc-title')?.addEventListener('click', () => openRename(group));
    box.querySelector('#gc-invite')?.addEventListener('click', () => openInvite(group));
    box.querySelector('#gc-del')?.addEventListener('click', () => {
      if (busy) return;
      deleteGroup(app.save, group.id);
      app.persist('groupDelete');
      currentId = listGroups(app.save)[0]?.id || null;
      toast('已解散该群聊');
      render();
    });
    box.querySelectorAll('[data-kick]').forEach((n) => n.addEventListener('click', (e) => {
      e.stopPropagation(); // 别把"移出群聊"当成"点头像 @ 他"
      const res = removeGroupMember(app.save, group.id, n.dataset.kick);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('groupKick');
      toast('已移出群聊');
      render();
    }));

    /**
     * 点群成员头像 = 快捷 @他（用户要的）：往输入框里补一个 `@名字 `
     * 已经 @ 过就不重复加；输入框里原本打了一半的字保持不动。
     */
    const atMember = (name) => {
      const input = box.querySelector('#gc-input');
      if (!input || !name) return;
      const token = `@${name}`;
      if (!input.value.includes(token)) {
        const sep = input.value && !/\s$/.test(input.value) ? ' ' : '';
        input.value = `${input.value}${sep}${token} `;
      }
      input.focus();
      const end = input.value.length;
      try { input.setSelectionRange(end, end); } catch { /* 老浏览器没有这个方法 */ }
      audio.play('select');
    };
    box.querySelectorAll('[data-at]').forEach((n) => {
      n.addEventListener('click', () => atMember(n.dataset.at));
      n.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); atMember(n.dataset.at); }
      });
      /**
       * ★ 拍一拍（用户拍板）：**双击成员头像**触发。
       *
       * 单击 = 快捷 @他（上面那套，**必须保留**）；双击 = 拍一拍 —— 两者怎么区分：
       *   · `dblclick` 是独立事件，浏览器先发 click 再发 dblclick，
       *     所以双击时那一下"单击 @人"**会先发生**（输入框里多一个 `@名字 `）；
       *   · 这里额外用 `e.detail` 做**单击延迟判断**：detail ≥ 2 说明这是连击的第二下，
       *     不重复触发；真正的 @ 只在"确实单击"时才补（见下面的 click 分支）。
       *   · 结果：单击 → 只 @；双击 → 先补一次 @（无害，正是"拍他"的语义），再拍一拍。
       *     不会出现"双击拍完把 @ 吞掉"或"点一下就被拍"这种串味。
       */
      n.addEventListener('dblclick', (e) => {
        e.preventDefault();
        nudgeMember(n.dataset.nudge);
      });
    });

    // 点 AI 消息 = 回复它（被回复的人一定会回你）
    box.querySelectorAll('.gc-msg.is-ai').forEach((n) => n.addEventListener('click', () => {
      const msg = group.chat.find((m) => m.id === n.dataset.msg);
      if (!msg) return;
      replyTo = { id: msg.id, by: msg.by, name: (personaById(msg.by) || {}).name || '有人', text: msg.text };
      audio.play('select');
      render();
      box.querySelector('#gc-input')?.focus();
    }));
    box.querySelector('#gc-cancel-reply')?.addEventListener('click', () => { replyTo = null; render(); });

    const input = box.querySelector('#gc-input');
    const pop = box.querySelector('#gc-emoji-pop');
    box.querySelector('#gc-emoji')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop) pop.hidden = !pop.hidden;
    });
    pop?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-emoji]');
      if (!b || !input) return;
      input.value += b.dataset.emoji;
      input.focus();
    });
    const send = () => {
      const t = (input?.value || '').trim();
      if (!t || busy) return;
      input.value = '';
      // 选中的回复对象**只对下一条生效**：发出去就自动取消，
      // 免得后面每一条都还挂着"正在回复 XX"（那是上一轮的选择）
      const quoted = replyTo;
      replyTo = null;
      void sendGroupMessage(app, group, t, quoted, {
        setBusy: (v) => { busy = v; },
        setTyping: (v) => { typing = v; },
        render,
      });
      // 玩家发话了 → 挂机聊天立刻停，然后重新数 10 秒（用户要求：直到玩家发话为止）
      scheduleIdle();
    };
    box.querySelector('#gc-send')?.addEventListener('click', send);
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    const log = box.querySelector('#gc-log');
    if (log) log.scrollTop = log.scrollHeight;
    // 每次重画后重新挂组词监听（旧 input 节点已经换掉了）
    ime.bind(box.querySelector('#gc-input'));
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    /**
     * ★ 输入法保护（用户报的 bug：刷新时正在打字 → 中文输入法被锁死）
     *   群聊尤其要命：挂机时每 5~15 秒就会重画一次，正在组词时被打断就再也唤不起输入法。
     *   组词期间一律不重画，等这一字上屏再补（见 ui/imeGuard.js）。
     */
    if (ime.shouldDefer()) return;
    const groups = listGroups(app.save);
    if (currentId && !groups.some((g) => g.id === currentId)) currentId = groups[0]?.id || null;
    const group = currentId ? findGroup(app.save, currentId) : null;
    /**
     * ★ 保住"还没发出去的字"：AI 每回一条就整块重画一次，
     *   以前会把玩家正在输入的内容清空（用户报的 bug）。
     *   重画前把草稿记下来，重画后装回去（并尽量保持光标在末尾/焦点不变）。
     */
    const prevInput = box.querySelector('#gc-input');
    const draft = prevInput ? prevInput.value : '';
    const wasFocused = prevInput && document.activeElement === prevInput;
    const caret = prevInput && typeof prevInput.selectionStart === 'number' ? prevInput.selectionStart : null;
    box.innerHTML = renderList(groups, group);
    bind(group);
    const nextInput = box.querySelector('#gc-input');
    if (nextInput && draft) {
      nextInput.value = draft;
      const pos = caret == null ? draft.length : Math.min(caret, draft.length);
      try { nextInput.setSelectionRange(pos, pos); } catch { /* 忽略 */ }
    }
    if (nextInput && wasFocused && !busy) nextInput.focus();
  }

  /* ================================================================== */
  /*   挂机自动聊天（用户拍板）                                           */
  /*     · 玩家在这个界面静默 10s，且群里 AI **多于 2 人**（≥3）→ AI 自己聊起来 */
  /*     · 每 5~15s 随机让一个人发一句；它们看得到上下文、带自己的记忆      */
  /*     · 下一句由 AI 判断该谁接（保持连续）；话题不必和玩家有关            */
  /*     · 玩家一发话立刻停，再静默 10s 才重新开始                          */
  /* ================================================================== */
  let idleTimer = null;
  let idleRound = 0;
  let idleRunning = false;
  let alive = true;

  function stopIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    idleRound = 0;
  }

  /** 面板被关掉 / 切到别的标签页 → 自己停（不依赖外部调用 destroy） */
  function stillVisible() {
    return alive && box.isConnected && !box.hidden && !busy;
  }

  function scheduleIdle() {
    stopIdle();
    if (!alive) return;
    idleTimer = setTimeout(() => { void idleRoundOnce(); }, GROUP_IDLE.idleMs);
  }

  async function idleRoundOnce() {
    idleTimer = null;
    if (!stillVisible()) return stopIdle();
    const group = currentId ? findGroup(app.save, currentId) : null;
    if (!group) return scheduleIdle();
    const members = groupMembers(group).filter((p) => p.id !== 'me');
    // 用户要求：AI 多于 2 人（也就是至少 3 位 AI 成员）才自己聊
    if (members.length < GROUP_IDLE.minAi) return scheduleIdle();
    if (idleRunning) return;
    if (idleRound >= GROUP_IDLE.maxRounds) return; // 防跑飞
    idleRunning = true;
    try {
      const chat = findGroup(app.save, currentId);
      const recent = groupChatLines(chat, app);
      const lastLine = recent[recent.length - 1] || '';
      const lastSpeaker = lastLine.includes('：') ? lastLine.split('：')[0] : '';
      /**
       * ★ 先定"这一句谁说"，**再**显示"正在输入…"
       *   用户报的 bug：以前是先塞一个 `{ name: '…', src: '' }` 的空壳再挑人，
       *   于是群里先闪出一行**空头像 + 空名字**，随后才被真名替换 —— 看起来就是"加载不出来"。
       *   现在挑完人再显示，头像和名字一次到位（和玩家发言那条链路同一套做法）。
       */
      const who = await chooseNextSpeaker({ group, members, recentLines: recent, lastSpeaker });
      if (!who || !stillVisible()) { render(); return scheduleIdle(); }
      const persona = members.find((x) => x.id === who.id) || personaById(who.id);
      if (!persona) return scheduleIdle();
      typing = { name: persona.name, src: ASSETS.avatar(persona.avatar) };
      render();
      const { text: line } = await groupReply({
        persona,
        group,
        members,
        recentLines: recent,
        playerText: '',
        replyTo: null,
        friends: [findFriend(app.save, who.id)].filter(Boolean),
        playerName: app.playerName,
        playerGender: playerGenderLine(app.save),
        playerIdentity: playerIdentityLines(app.save, { callName: callNameOf(findFriend(app.save, who.id)), selfId: who.id }),
        // ★ 它自己的身家与称号（实时现算：群聊里也要知道自己有多少豆子、戴着什么称号）
        myBeans: aiBeansOf(app.save, who.id),
        myTitle: (aiTitleOf(app.save, who.id) || {}).name || '',
        mingle: true,
        lastSpeaker,
      });
      if (!stillVisible()) return stopIdle();
      // 挂机闲聊**不写长期记忆**（那是玩家参与的对话才沉淀），但"看得到上下文 + 各自的记忆"
      typing = null;
      appendGroupChat(app.save, currentId, { role: 'ai', by: who.id, text: line });
      bumpGroupUnread(app.save, currentId);
      clearGroupUnread(app.save, currentId); // 玩家正看着，不算未读
      app.persist('groupIdle');
      idleRound += 1;
      render();
      // 5~15 秒后再来一句
      const wait = GROUP_IDLE.minGapMs + Math.random() * (GROUP_IDLE.maxGapMs - GROUP_IDLE.minGapMs);
      idleTimer = setTimeout(() => { void idleRoundOnce(); }, wait);
    } catch (err) {
      console.warn('[group] 挂机聊天失败：', err);
      scheduleIdle();
    } finally {
      idleRunning = false;
      typing = null;
    }
  }

  render();
  // 进群就开始数"静默 10 秒"：玩家什么都不做的话，AI 会自己聊起来（用户要求）
  scheduleIdle();
  /**
   * 返回给外面（好友面板）用的把手：
   *   · destroy：面板关掉时叫一声（其实它自己也会靠 box 的可见性停掉，双保险）
   *   · poke：玩家发话后重置"静默 10 秒"的计时
   */
  return {
    render,
    get currentId() { return currentId; },
    destroy() { alive = false; stopIdle(); },
    poke() { if (alive) scheduleIdle(); },
  };
}

/* ===================================================================== */
/*                              发一条                                  */
/* ===================================================================== */
/**
 * 玩家发言 → AI 挑人 → 一条条回 → 审查记忆
 * @param {object} ctx { setBusy, setTyping, render }
 *
 * ★ 导出是为了让测试能真跑这条路（用户报过 `callNameOf is not defined`：
 *   群里一发消息就 ReferenceError，静态语法检查查不出来，只有"真调一次"能抓到）
 */
export async function sendGroupMessage(app, group, text, replyTo, ctx) {
  const { setBusy, setTyping, render } = ctx;
  const gid = group.id;
  setBusy(true);
  try {
    appendGroupChat(app.save, gid, {
      role: 'me', by: 'me', text, replyTo: replyTo ? { by: replyTo.by, name: replyTo.name, text: replyTo.text } : null,
    });
    app.persist('groupChat');
    render();

    const members = groupMembers(findGroup(app.save, gid));
    if (!members.length) {
      toast('群里还没有好友，先拉几个人进来', 'bad');
      return;
    }
    // 1) 该谁回答：被回复的人 / 被点名的人**必须**回；其余交给 AI 挑
    const forced = replyTo && members.some((p) => p.id === replyTo.by)
      ? [replyTo.by]
      : findMentioned(text, members);
    const want = replyCountFor(members.length);
    const pick = await chooseResponders({
      group,
      members,
      recentLines: groupChatLines(findGroup(app.save, gid), app),
      playerText: text,
      replyToName: replyTo ? replyTo.name : '',
      forceIds: forced,
      want,
    });
    const ids = orderResponders(pick.ids, forced, members, Math.max(forced.length, want));
    if (!ids.length) return;
    /**
     * ★ 里程碑「一呼百应」：玩家 @（或点消息回复）了某个人，而且**那个人真的回了**。
     *   判定放在"挑完回复人"这一步：`forced` 就是被点名/被回复的必须回的那几位。
     */
    if (forced.length && ids.some((id) => forced.includes(id)) && typeof app.flagMilestone === 'function') {
      app.flagMilestone('groupMentioned');
    }

    // 2) 一条条回：每条之间隔 2~3 秒，先显示"正在输入…"
    const replies = [];
    for (let i = 0; i < ids.length; i += 1) {
      const p = members.find((x) => x.id === ids[i]);
      if (!p) continue;
      const wait = GROUP.replyMin + Math.random() * (GROUP.replyMax - GROUP.replyMin);
      await sleep(wait);
      setTyping({ name: p.name, src: ASSETS.avatar(p.avatar) });
      render();

      const g = findGroup(app.save, gid);
      const { text: line } = await groupReply({
        persona: p,
        group: g,
        members,
        recentLines: groupChatLines(g, app),
        playerText: text,
        replyTo: replyTo && replyTo.by === p.id ? { name: replyTo.name, text: replyTo.text } : null,
        friends: [findFriend(app.save, p.id)].filter(Boolean),
        playerName: app.playerName,
        playerGender: playerGenderLine(app.save),
        playerIdentity: playerIdentityLines(app.save, { callName: callNameOf(findFriend(app.save, p.id)), selfId: p.id }),
        myBeans: aiBeansOf(app.save, p.id),
        myTitle: (aiTitleOf(app.save, p.id) || {}).name || '',
      });
      setTyping(null);
      appendGroupChat(app.save, gid, { role: 'ai', by: p.id, text: line });
      replies.push({ name: p.name, text: line });
      bumpGroupUnread(app.save, gid); // 未读先记上，等玩家切走再清（当前正在看，下面会清）
      clearGroupUnread(app.save, gid);
      app.persist('groupChat');
      render();
    }

    // 3) 审查：群聊**不动好感度**，只看要不要写进各自 memory / 各自的自设
    const g = findGroup(app.save, gid);
    const { memory: byName, self: selfByName } = await analyzeGroupChat({
      responders: ids.map((id) => members.find((x) => x.id === id)).filter(Boolean),
      playerText: text,
      replies,
      recentLines: groupChatLines(g, app, GROUP.recent),
      // 玩家昵称：挡住"自设：称呼对方=玩家的名字"这类假自设（私聊那边也这么做）
      playerName: app.playerName,
    });
    for (const [name, mem] of Object.entries(byName)) {
      const p = members.find((x) => x.name === name);
      if (p && mem) addMemory(app.save, p.id, mem);
    }
    // 谁顺口补充了"人设里没写的设定"，就记在谁名下（下次不能再矛盾）
    for (const [name, facts] of Object.entries(selfByName)) {
      const p = members.find((x) => x.name === name);
      if (p) setSelfMemories(app.save, p.id, facts);
    }
    app.persist('groupMemory');
    app.updateFriendDot();
    // 群里记多了也一样：让 AI 把相似的合并（对局记忆不动）
    for (const id of ids) void app.compressMemoryIfNeeded(id);
  } catch (err) {
    console.warn('[group] 发送失败：', err);
    toast('发送失败，稍后再试', 'bad');
  } finally {
    setTyping(null);
    setBusy(false);
    render();
  }
}

/** 被点名/被回复的人排在最前面，不足的用 AI 挑的补上 */
export function orderResponders(picked, forced, members, want) {
  const has = (id) => members.some((p) => p.id === id);
  const out = [];
  for (const id of forced || []) if (has(id) && !out.includes(id)) out.push(id);
  for (const id of picked || []) {
    if (out.length >= Math.max(want, (forced || []).length)) break;
    if (has(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, GROUP.maxMentions);
}

/** 刚建好群：让 1~2 个人先打个招呼，别让群冷着 */
export async function kickoff(app, groupId, render) {
  const g = findGroup(app.save, groupId);
  if (!g) return;
  const members = groupMembers(g);
  if (!members.length) return;
  const n = Math.max(0, Math.min(members.length, GROUP.kickoff));
  for (let i = 0; i < n; i += 1) {
    const p = members[i];
    await sleep(GROUP.replyMin + Math.random() * (GROUP.replyMax - GROUP.replyMin));
    const cur = findGroup(app.save, groupId);
    const { text } = await groupReply({
      persona: p,
      group: cur,
      members,
      recentLines: groupChatLines(cur, app),
      playerText: '（你们刚被拉进这个新群）',
      replyTo: null,
      friends: [findFriend(app.save, p.id)].filter(Boolean),
      playerName: app.playerName,
      playerGender: playerGenderLine(app.save),
      playerIdentity: playerIdentityLines(app.save, { callName: callNameOf(findFriend(app.save, p.id)), selfId: p.id }),
      myBeans: aiBeansOf(app.save, p.id),
      myTitle: (aiTitleOf(app.save, p.id) || {}).name || '',
    });
    appendGroupChat(app.save, groupId, { role: 'ai', by: p.id, text });
    app.persist('groupKickoff');
    if (render) render();
  }
}

void closePanel;
void FRIEND;
