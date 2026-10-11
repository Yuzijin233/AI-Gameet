/**
 * 邮箱面板（PRD §2.18）
 * 活动奖励的发放出口：首充礼包 / 今日限时礼包 / 累计充值礼包都会发到这里。
 * 打开即标记已读；未领取的邮件带"领取"按钮，过期的只能看不能领。
 */
import { openDrawer, drawerShell } from './panels.js';
import { toast } from './fx.js';
import { audio } from './audio.js';
import { rewardLabel } from '../data/activities.js';
import { listMailWithState, claimMail, claimAllMail, markAllMailRead, MAIL_TTL_MS } from '../store/rewards.js';

function timeText(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

const rewardChips = (list) => (list || []).map((r) => {
  const { emoji, text } = rewardLabel(r);
  return `<span class="act-reward"><i>${emoji}</i>${text}</span>`;
}).join('');

export function openMail(app) {
  const el = openDrawer(drawerShell('邮箱', '<div id="mail-body"></div>'), { page: 'mail' });
  const body = el.querySelector('#mail-body');

  function render() {
    const list = listMailWithState(app.save);
    const canClaim = list.filter((m) => m.canClaim).length;
    body.innerHTML = `
      <div class="mail-hero">
        <span class="mail-hero-ico">📧</span>
        <div>
          <div class="mail-hero-title">奖励都发到这里</div>
          <div class="mail-hero-sub">邮件保留 ${Math.round(MAIL_TTL_MS / 86400000)} 天，过期就领不了了</div>
        </div>
        <button class="act-btn ${canClaim ? 'go' : ''}" id="mail-all" type="button" ${canClaim ? '' : 'disabled'}>
          ${canClaim ? `一键领取 (${canClaim})` : '没有可领的'}
        </button>
      </div>
      ${list.length ? `<div class="mail-list">${list.map((m) => `
        <div class="mail-item ${m.claimed ? 'is-claimed' : ''} ${m.expired ? 'is-expired' : ''}">
          <div class="mail-head">
            <span class="mail-from">${m.from}</span>
            <span class="mail-time">${timeText(m.at)}</span>
          </div>
          <div class="mail-title">${m.title}</div>
          ${m.body ? `<div class="mail-body">${m.body}</div>` : ''}
          <div class="act-rewards">${rewardChips(m.rewards)}</div>
          <div class="mail-foot">
            ${m.claimed ? '<span class="mail-state">✓ 已领取</span>'
    : m.expired ? '<span class="mail-state is-bad">已过期</span>'
      : `<button class="act-btn tiny go" data-claim-mail="${m.id}" type="button">领 取</button>`}
          </div>
        </div>`).join('')}</div>`
    : '<p class="center-note" style="margin:26px 0">邮箱是空的。<br>目前只有「首充礼包」的奖励发到邮箱，其余活动都是点了直接到账。</p>'}
    `;
    body.querySelector('#mail-all')?.addEventListener('click', () => {
      const res = claimAllMail(app.save);
      if (!res.ok) return toast('没有可领取的邮件');
      app.persist('mail');
      audio.play('coin');
      toast(`一键领取 ${res.count} 封：${res.got.join('  ')}`, 'gold');
      app.refreshLobby();
      app.updateMailDot();
      render();
    });
    body.querySelectorAll('[data-claim-mail]').forEach((btn) => btn.addEventListener('click', () => {
      const res = claimMail(app.save, btn.dataset.claimMail);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('mail');
      audio.play('coin');
      toast(`领取成功：${res.got.join('  ')}`, 'gold');
      app.refreshLobby();
      app.updateMailDot();
      render();
    }));
  }

  markAllMailRead(app.save);
  app.persist('mailRead');
  app.updateMailDot();
  render();
}
