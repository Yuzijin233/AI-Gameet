/**
 * 「AI 邀请你打牌」那张卡片（画面上部）
 *
 * 纯界面：头像 + 名字 + 邀请你进入 XX 模式 + 倒计时 + ✓ / ✗
 * 谁邀请、什么模式、接受后干什么，都由 ui/app.js 决定（见 store/invite.js 的规则）。
 */
import { ASSETS } from '../../assets/manifest.js';
import { audio } from './audio.js';

/** 当前展示中的邀请（同一时间只允许一张） */
let current = null;

export const hasInviteShowing = () => !!current;

/**
 * 弹出一张邀请卡
 * @param {{persona:object, targetText:string, seconds:number,
 *          onAccept:Function, onDecline:Function, onTimeout?:Function}} opts
 * @returns {{close:Function}}
 */
export function showInvite({
  persona, targetText, seconds = 15, onAccept, onDecline, onTimeout,
}) {
  const host = document.getElementById('invite-layer');
  if (!host) return { close() {} };
  if (current) current.close('replaced');

  const avatar = persona && persona.avatar ? ASSETS.avatar(persona.avatar) : '';
  const name = (persona && persona.name) || '好友';
  host.hidden = false;
  host.innerHTML = `
    <div class="invite-card" id="invite-card">
      <img class="invite-avatar" src="${avatar}" alt="" />
      <div class="invite-body">
        <div class="invite-line"><b>${name}</b> 邀请你进入「${targetText}」</div>
        <div class="invite-sub">接受就马上开局 · <span id="invite-left">${seconds}</span> 秒后自动消失</div>
      </div>
      <button class="invite-btn ok" id="invite-ok" type="button" title="接受">√</button>
      <button class="invite-btn no" id="invite-no" type="button" title="拒绝（之后不再打扰）">×</button>
    </div>`;

  let left = seconds;
  let closed = false;
  const leftEl = host.querySelector('#invite-left');
  const timer = setInterval(() => {
    left -= 1;
    if (leftEl) leftEl.textContent = String(Math.max(0, left));
    if (left <= 0) close('timeout');
  }, 1000);

  function close(reason = 'closed') {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (current === handle) current = null;
    host.hidden = true;
    host.innerHTML = '';
    if (reason === 'accept') onAccept && onAccept();
    else if (reason === 'decline') onDecline && onDecline();
    else if (reason === 'timeout') onTimeout && onTimeout();
  }

  const handle = { close, get open() { return !closed; } };
  current = handle;
  host.querySelector('#invite-ok').addEventListener('click', () => { audio.play('select'); close('accept'); });
  host.querySelector('#invite-no').addEventListener('click', () => { audio.play('select'); close('decline'); });
  audio.play('coin');
  return handle;
}
