/**
 * 里程碑面板（用户拍板）
 * =====================================================================
 * 布局（严格按用户要求）：
 *   ┌──────────────────────────────────────────────┐
 *   │ 标签：社交 / 对局 / 财富          ← 上面       │
 *   ├──────────────────────────────────────────────┤
 *   │ 成就列表：一行 2 个、固定高度、滚轮滚动        │
 *   ├──────────────────────────────────────────────┤
 *   │ 进度条：20 / 40 / 100 / 200 节点可点领奖       │  ← 最下方固定
 *   └──────────────────────────────────────────────┘
 *
 * 规则（用户拍板）：
 *   · **未达成时不告诉触发条件** —— 条件显示为 `？？？`，只有解锁后才写出来
 *   · 不显示"每条的进度百分比"，只显示 已达成 / 未达成
 *   · 达成时弹金框 toast：`解锁里程碑：<名字>`
 *   · 领奖 → **奖励进邮箱**（复用 store/rewards.js 的 pushMail）
 *
 * 样式沿用项目现有的抽屉 / 标签 / 卡片语言（见 styles/milestones.css）。
 */
import { openDrawer, closePanel } from './panels.js';
import { toast } from './fx.js';
import { audio } from './audio.js';
import { MILESTONE_GROUPS } from '../data/milestones.js';
import {
  milestoneState, claimTier, markMilestonesSeen,
} from '../store/milestones.js';
import { pushMail } from '../store/rewards.js';
import { titleById } from '../data/titles.js';
import { frameById, themeById } from '../data/cosmetics.js';
import { GIFTS, ITEMS } from '../config.js';

/** 奖励文案（和邮箱里那套口径一致，但这里更短） */
function rewardText(r) {
  if (!r || !r.kind) return '神秘奖励';
  switch (r.kind) {
    case 'beans': return `${Number(r.amount || 0).toLocaleString()} 开心豆`;
    case 'item': {
      const it = [...ITEMS, ...GIFTS].find((x) => x.id === r.id);
      return `${it ? it.name : r.id} ×${r.n || 1}`;
    }
    case 'renameCard': return `改名卡 ×${r.n || 1}`;
    case 'title': return `称号「${(titleById(r.id) || {}).name || '称号'}」`;
    case 'frame': return `头像框「${(frameById(r.id) || {}).name || '头像框'}」`;
    case 'theme': return `风格「${(themeById(r.id) || {}).name || '风格'}」`;
    default: return '奖励';
  }
}

const rewardLine = (tier) => (tier.rewards || []).map(rewardText).join(' + ');

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** 「9月29日 22:52」这种达成时间（复用私聊那套口径的简化版） */
function whenText(at) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const n = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * 打开里程碑面板
 * @param {object} app
 */
export function openMilestones(app) {
  let group = MILESTONE_GROUPS[0].id;

  const el = openDrawer(`
    <div class="drawer ms-drawer">
      <div class="drawer-head">
        <h3 class="drawer-title">里程碑</h3>
        <button class="drawer-close" data-close type="button">✕</button>
      </div>
      <div class="drawer-body">
        <nav class="ms-tabs" id="ms-tabs" role="tablist" aria-label="里程碑分类"></nav>
        <div class="ms-list" id="ms-list" role="tabpanel"></div>
      </div>
      <div class="ms-foot" id="ms-foot"></div>
    </div>
  `, { page: 'milestones' });

  const tabsBox = el.querySelector('#ms-tabs');
  const listBox = el.querySelector('#ms-list');
  const footBox = el.querySelector('#ms-foot');

  function renderTabs(state) {
    tabsBox.innerHTML = MILESTONE_GROUPS.map((g) => {
      const items = state.list.filter((x) => x.group === g.id);
      const done = items.filter((x) => x.unlocked).length;
      return `<button class="ms-tab ${g.id === group ? 'is-active' : ''}" data-ms-group="${g.id}"
        role="tab" aria-selected="${g.id === group}" type="button">
        ${g.name}<span class="ms-tab-count">${done}/${items.length}</span>
      </button>`;
    }).join('');
    tabsBox.querySelectorAll('[data-ms-group]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.dataset.msGroup === group) return;
      group = btn.dataset.msGroup;
      audio.play('select');
      render();
    }));
  }

  function renderList(state) {
    const items = state.list.filter((x) => x.group === group);
    listBox.innerHTML = items.map((it) => `
      <div class="ms-item ${it.unlocked ? 'is-done' : ''}">
        <div class="ms-item-head">
          <b>${escapeHtml(it.name)}</b>
          <span class="ms-points">${it.points}</span>
        </div>
        <div class="ms-cond">${escapeHtml(it.shownCondition)}</div>
        ${it.unlocked ? `<div class="ms-when">${escapeHtml(whenText(it.at))}</div>` : ''}
      </div>`).join('');
  }

  function renderFoot(state) {
    const pct = Math.min(100, Math.round((state.points / Math.max(1, state.total)) * 100));
    footBox.innerHTML = `
      <div class="ms-progress-head">
        <span>积分 <b id="ms-points">${state.points}</b> / ${state.total}</span>
        <span class="ms-progress-hint" id="ms-hint">${state.tiers.some((t) => t.claimable) ? '有可以领取的奖励' : ''}</span>
      </div>
      <div class="ms-track">
        <div class="ms-track-fill" style="width:${pct}%"></div>
        ${state.tiers.map((t) => {
    const left = Math.min(100, Math.round((t.at / Math.max(1, state.total)) * 100));
    const cls = t.claimed ? 'is-claimed' : (t.claimable ? 'is-ready' : (t.reached ? 'is-reached' : ''));
    return `<button class="ms-node ${cls}" style="left:${left}%" data-ms-claim="${t.at}" type="button"
        ${t.claimable ? '' : 'disabled'} title="${escapeHtml(t.label)}：${escapeHtml(rewardLine(t))}">
        <span class="ms-node-dot">${t.claimed ? '✓' : t.at}</span>
        <span class="ms-node-label">${escapeHtml(t.label)}</span>
      </button>`;
  }).join('')}
      </div>
      <div class="ms-tiers">
        ${state.tiers.map((t) => `
          <div class="ms-tier ${t.claimed ? 'is-claimed' : (t.claimable ? 'is-ready' : '')}">
            <b>${t.at}</b>
            <span>${escapeHtml(rewardLine(t))}</span>
          </div>`).join('')}
      </div>`;

    footBox.querySelectorAll('[data-ms-claim]').forEach((btn) => btn.addEventListener('click', () => {
      const at = Number(btn.dataset.msClaim);
      const res = claimTier(app.save, at, pushMail);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('milestoneClaim');
      audio.play('win');
      toast(`奖励已发送到邮箱：${res.tier.label}`, 'gold');
      app.updateMilestoneDot();
      render();
    }));
  }

  function render() {
    const state = milestoneState(app.save);
    renderTabs(state);
    renderList(state);
    renderFoot(state);
  }

  /** 面板内部重画（外部调用：解锁之后要立刻反映出来） */
  el._msRender = render;

  // 打开面板 = 把"新解锁"的红点清掉
  markMilestonesSeen(app.save);
  app.persist('milestoneSeen');
  app.updateMilestoneDot();
  render();
}

/** 关闭面板（给 app 用；面板自己已经绑了 data-close） */
export function closeMilestones() {
  closePanel();
}
