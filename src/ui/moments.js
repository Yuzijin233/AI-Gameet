/**
 * 友圈（社交面板里的第三个标签，"朋友圈"那种）
 *
 * 版式（用户拍板）：
 *   说说：**左侧头像**，右侧上面是名称、下面是内容
 *   评论：**只显示名称、不显示头像**，一行一条 `某某：XXXXXXXX`
 * 交互：
 *   · 右上角「+ 发布」→ 写内容 → 发出去
 *   · 点赞（❤）/ 评论（点一下在下面输入）；AI 的评论可以"回复"它
 *   · 发完之后 AI 会陆续来评论（10~30s 第一条，之后每条 2~30s，由 app 排期）
 */
import { ASSETS } from '../../assets/manifest.js';
import { playerAvatarSrc } from '../data/avatar.js';
import { playerAvatarHTML } from './avatarFrame.js';
import { PERSONAS } from '../data/personas.js';
import { toast } from './fx.js';
import { audio } from './audio.js';
import { MOMENTS } from '../config.js';
import {
  listMoments, addMoment, addMomentComment, toggleMomentLike, hasLiked, findMoment, momentStats,
  recentMomentComments, removeMoment,
} from '../store/moments.js';
import { listFriends, findFriend } from '../store/friends.js';
import { createImeGuard } from './imeGuard.js';
import { momentComment } from '../ai/moments.js';

const personaById = (id) => PERSONAS.find((p) => p.id === id) || null;
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function timeText(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return same ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 评论显示名：玩家 = 你，AI = 名字 */
const nameOfComment = (app, by) => (by === 'me' ? app.playerName : ((personaById(by) || {}).name || '有人'));

/**
 * 渲染友圈标签页
 * @param {object} app
 * @param {HTMLElement} box 承载容器
 */
export function renderMoments(app, box) {
  let replyTarget = null; // { momentId, commentId, name }
  let pendingRender = false;
  /** 没发出去的评论草稿：AI 来评论时界面要刷新，不能把玩家正在打的字冲掉 */
  const drafts = new Map();
  /** 输入法保护：组词期间不重画（评论框是 textarea，一样会被冲掉） */
  const ime = createImeGuard({ onFlush: () => render() });

  function captureDrafts() {
    box.querySelectorAll('.moment-input').forEach((input) => {
      const id = input.dataset ? input.dataset.input : '';
      if (id) drafts.set(id, input.value || '');
    });
  }

  function restoreDrafts() {
    box.querySelectorAll('.moment-input').forEach((input) => {
      const id = input.dataset ? input.dataset.input : '';
      if (id && drafts.has(id)) input.value = drafts.get(id);
      autoGrow(input);
    });
  }

  /**
   * 评论框随内容长高：**没有滚动条**（用户不要上下箭头），
   * 一行写满了就自然折到下一行，整体跟着变高。
   */
  function autoGrow(el) {
    if (!el || !el.style) return;
    el.style.height = 'auto';
    const h = Number(el.scrollHeight) || 0;
    if (h > 0) el.style.height = `${h}px`;
  }

  function postsHtml() {
    const posts = listMoments(app.save);
    if (!posts.length) {
      return '<p class="center-note" style="margin:auto">还没有动态<br>点击右上角「+ 发布」记录这一刻</p>';
    }
    const myAvatar = playerAvatarSrc(app.save);
    return posts.map((m) => {
      const liked = hasLiked(app.save, m.id, 'me');
      const st = momentStats(m);
      // ★ 说说可能是**好友发的**（离线期间 AI 会自己发，用户要求）：
      //   名字与头像都要用它自己的，删除按钮只给自己的说说
      const mine = !m.by || m.by === 'me';
      const author = mine ? null : personaById(m.by);
      const authorAvatar = mine ? myAvatar : ASSETS.avatar((author && author.avatar) || 'avatar_01');
      const authorName = mine ? app.playerName : ((author && author.name) || '有人');
      const comments = m.comments.map((c) => {
        const replyTo = c.replyTo ? m.comments.find((x) => x.id === c.replyTo) : null;
        // 「回复 某某 内容」——"某某"后面**留一个空格**（用户要求，不然挤在一起看不清）
        const quote = replyTo ? `<span class="mc-quote">回复 ${esc(nameOfComment(app, replyTo.by))}</span> ` : '';
        const canReply = c.by !== 'me';
        // 名字是**蓝色可点**的：点一下直接跳到和那个人的私聊（用户要求）
        const nameHtml = c.by === 'me'
          ? `<b class="mc-name is-me">${esc(nameOfComment(app, c.by))}</b>`
          : `<button class="mc-name" data-chat="${esc(c.by)}" type="button">${esc(nameOfComment(app, c.by))}</button>`;
        return `
          <div class="mc-row" data-comment="${c.id}">
            <span class="mc-text">${nameHtml}：${quote}${esc(c.text)}</span>
            ${canReply ? `<button class="mc-reply" data-reply="${m.id}:${c.id}" type="button">回复</button>` : ''}
          </div>`;
      }).join('');
      return `
        <article class="moment" data-moment="${m.id}">
          ${mine ? playerAvatarHTML(app.save, 'moment-avatar') : `<img class="moment-avatar" src="${authorAvatar}" alt="" />`}
          <div class="moment-main">
            <div class="moment-name">${esc(authorName)}</div>
            <div class="moment-text">${esc(m.text)}</div>
            <div class="moment-meta">
              <span class="mm-time">${timeText(m.at)}</span>
              <button class="mm-btn ${liked ? 'is-on' : ''}" data-like="${m.id}" type="button">
                ${liked ? '❤' : '🤍'} ${st.likes || ''}
              </button>
              <button class="mm-btn" data-comment-focus="${m.id}" type="button">💬 ${st.comments || ''}</button>
            </div>
            ${comments ? `<div class="moment-comments">${comments}</div>` : ''}
            <div class="moment-input-row">
              <textarea class="moment-input" data-input="${m.id}" rows="1" maxlength="${MOMENTS.maxChars}"
                placeholder="${replyTarget && replyTarget.momentId === m.id ? `回复 ${esc(replyTarget.name)}…` : '说点什么…'}"></textarea>
              <button class="mini-btn" data-send="${m.id}" type="button">发送</button>
            </div>
          </div>
          <button class="moment-del" data-del="${m.id}" type="button" title="${mine ? '删除这条说说' : '别人发的说说不能删'}"${mine ? '' : ' hidden'}>✕</button>
        </article>`;
    }).join('');
  }

  function render() {
    // 正在写发布内容 / 正开着浮层时不要重画（会把没发出去的东西冲掉），
    // 先记一笔，等浮层关掉再补一次
    if (box.querySelector('.gc-overlay')) { pendingRender = true; return; }
    /**
     * ★ 输入法保护（用户报的 bug：AI 刷新时正在打字 → 中文输入法被锁死）
     *   友圈评论框是 textarea，一样会被整块重画冲掉；组词期间先别画（见 ui/imeGuard.js）
     */
    if (ime.shouldDefer()) return;
    pendingRender = false;
    captureDrafts();
    box.innerHTML = `
      <div class="moments-wrap">
        <div class="moments-head">
          <span class="moments-title">朋友圈</span>
          <button class="mini-btn" id="moment-new" type="button">+ 发布</button>
        </div>
        <div class="moments-list" id="moments-list">${postsHtml()}</div>
      </div>`;
    bind();
    restoreDrafts();
    // 每次重画后重新挂组词监听（旧节点已经换掉）
    box.querySelectorAll('.moment-input').forEach((el2) => ime.bind(el2));
  }

  /** 关掉发布浮层（取消 / 发布都走这里），该补画就补画 */
  function closeComposer(el) {
    el.remove();
    if (pendingRender) render();
  }

  /** 发布浮层 */
  function openComposer() {
    const el = document.createElement('div');
    el.className = 'gc-overlay';
    el.innerHTML = `
      <div class="gc-dialog">
        <h4 class="gc-dialog-title">发布说说</h4>
        <textarea id="moment-text" maxlength="${MOMENTS.maxChars}" rows="5"
          placeholder="这一刻的想法…（最多 ${MOMENTS.maxChars} 字）"></textarea>
        <div class="gc-dialog-actions">
          <button class="btn ghost" data-cancel type="button">取消</button>
          <button class="btn primary" data-ok type="button">发布</button>
        </div>
      </div>`;
    box.append(el);
    const ta = el.querySelector('#moment-text');
    ta.focus();
    el.addEventListener('click', (e) => { if (e.target === el) closeComposer(el); });
    el.querySelector('[data-cancel]').addEventListener('click', () => closeComposer(el));
    el.querySelector('[data-ok]').addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) return toast('写点什么再发吧', 'bad');
      const res = addMoment(app.save, text);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('moment');
      audio.play('select');
      closeComposer(el);
      toast('已发布，好友们马上就来～', 'good');
      render();
      // 交给 app 排期：审查 AI 挑人 → 10~30s 后第一条评论
      void app.scheduleMomentCommenters(res.moment.id, text);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) el.querySelector('[data-ok]').click();
    });
  }

  /** 发一条评论（玩家）；如果是回复 AI 的，让那位 AI 接着回 */
  async function sendComment(momentId, text) {
    const t = String(text || '').trim();
    if (!t) return;
    const target = replyTarget && replyTarget.momentId === momentId ? replyTarget : null;
    const res = addMomentComment(app.save, momentId, {
      by: 'me', text: t, replyTo: target ? target.commentId : '',
    });
    if (!res.ok) return toast(res.error, 'bad');
    app.persist('momentComment');
    audio.play('select');
    replyTarget = null;
    drafts.delete(momentId); // 发出去了，草稿不用留
    render();

    // 回复了某位 AI 的评论 → 它接着针对玩家的话再回一条
    // （走 app：回复同样要写进记忆，只留一个出口。
    //   把**玩家这条评论的 id** 一起给它 —— 它要挂在玩家这句下面，不是挂在自己那句下面）
    if (target && app.replyToMomentComment) {
      await app.replyToMomentComment(momentId, target.commentId, t, { playerCommentId: res.comment.id });
    }
  }

  /**
   * 面板里的确认弹窗（不用浏览器原生 confirm：那是系统脸，和游戏界面不搭）
   * @param {{title:string, text?:string, okText?:string}} opts
   * @returns {Promise<boolean>}
   */
  function askConfirm({ title, text = '', okText = '确定' }) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'gc-overlay';
      el.innerHTML = `
        <div class="gc-dialog ask-dialog">
          <h4 class="gc-dialog-title">${esc(title)}</h4>
          ${text ? `<p class="ask-text">${esc(text)}</p>` : ''}
          <div class="gc-dialog-actions">
            <button class="btn ghost" data-no type="button">取消</button>
            <button class="btn primary" data-yes type="button">${esc(okText)}</button>
          </div>
        </div>`;
      box.append(el);
      const done = (val) => { el.remove(); resolve(val); };
      el.querySelector('[data-no]').addEventListener('click', () => done(false));
      el.querySelector('[data-yes]').addEventListener('click', () => done(true));
      el.addEventListener('click', (e) => { if (e.target === el) done(false); });
      el.querySelector('[data-yes]').focus();
    });
  }

  function bind() {
    box.querySelector('#moment-new')?.addEventListener('click', openComposer);
    // 删除：只删这一条说说，确认走面板里的弹窗
    box.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.del;
      const moment = findMoment(app.save, id);
      if (!moment) return;
      const sure = await askConfirm({ title: '删除这条说说？', okText: '删除' });
      if (!sure) return;
      const res = removeMoment(app.save, id);
      if (!res.ok) return toast('这条说说已经没了', 'bad');
      drafts.delete(id);
      app.persist('momentDelete');
      audio.play('select');
      toast('已删除');
      render();
    }));
    // 点评论里蓝色的名字 → 跳到和那个人的私聊
    box.querySelectorAll('[data-chat]').forEach((btn) => btn.addEventListener('click', () => {
      const personaId = btn.dataset.chat;
      if (!personaId) return;
      audio.play('select');
      if (app.openFriendChat) app.openFriendChat(personaId);
    }));
    box.querySelectorAll('[data-like]').forEach((btn) => btn.addEventListener('click', () => {
      const res = toggleMomentLike(app.save, btn.dataset.like, 'me');
      if (!res.ok) return;
      app.persist('momentLike');
      audio.play('select');
      render();
    }));
    box.querySelectorAll('[data-comment-focus]').forEach((btn) => btn.addEventListener('click', () => {
      const input = box.querySelector(`[data-input="${btn.dataset.commentFocus}"]`);
      if (input) input.focus();
    }));
    box.querySelectorAll('[data-reply]').forEach((btn) => btn.addEventListener('click', () => {
      const [momentId, commentId] = btn.dataset.reply.split(':');
      const moment = findMoment(app.save, momentId);
      const c = moment && moment.comments.find((x) => x.id === commentId);
      if (!c) return;
      replyTarget = { momentId, commentId, personaId: c.by, name: nameOfComment(app, c.by) };
      render();
      const input = box.querySelector(`[data-input="${momentId}"]`);
      if (input) input.focus();
    }));
    box.querySelectorAll('[data-send]').forEach((btn) => btn.addEventListener('click', () => {
      const input = box.querySelector(`[data-input="${btn.dataset.send}"]`);
      if (!input) return;
      const t = input.value;
      input.value = '';
      void sendComment(btn.dataset.send, t);
    }));
    box.querySelectorAll('.moment-input').forEach((input) => {
      // 边打边长高
      input.addEventListener('input', () => autoGrow(input));
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        // Shift+Enter（或 Ctrl/Cmd+Enter 之外的组合键）→ 换行；直接回车 → 发送
        if (e.shiftKey) { autoGrow(input); return; }
        e.preventDefault();
        const t = input.value;
        input.value = '';
        autoGrow(input);
        void sendComment(input.dataset.input, t);
      });
    });
  }

  render();
  return { render };
}
