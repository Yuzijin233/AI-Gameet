/**
 * 大厅渲染（PRD §2.1）
 */
import { ROOMS, FISHING_ROOMS, FISHING, GOMOKU_ROOMS, GOMOKU } from '../config.js';
import { ASSETS } from '../../assets/manifest.js';
import { playerAvatarSrc } from '../data/avatar.js';
import { formatBeans, beanLabel } from '../core/settle.js';
import { settleFishing } from '../games/fishing.js';
import { renderEquippedBadge } from './titles.js';

/** 新主页使用真实联系人/未读/存档，不创建假在线人数、聊天或朋友圈。 */
export function renderSocialLobby(app) {
  if (!app.save) return;
  const avatar = document.getElementById('social-lobby-avatar');
  if (avatar) avatar.src = playerAvatarSrc(app.save);
  const setText = (id, text) => { const node = document.getElementById(id); if (node) node.textContent = text; };
  setText('social-lobby-name', app.playerName);
  setText('social-lobby-beans', formatBeans(app.save.beans));
}

export function renderLobby(app) {
  const save = app.save;
  const game = app.lobbyGame || 'ddz';
  const fishing = game === 'fishing';
  const gomoku = game === 'gomoku';
  const roomMode = app.mode === 'room';

  document.getElementById('lobby-avatar').src = playerAvatarSrc(save);
  document.getElementById('lobby-name').textContent = app.playerName;
  document.getElementById('lobby-beans').textContent = beanLabel(save.beans);
  renderEquippedBadge(document.getElementById('lobby-title'), save);
  renderEquippedBadge(document.getElementById('social-lobby-title'), save);
  // 没佩戴称号时用占位文案顶着，保证左上角入口永远点得到
  const titleBadge = document.getElementById('lobby-title');
  const titleEmpty = document.getElementById('lobby-title-empty');
  if (titleEmpty) titleEmpty.hidden = !titleBadge.hidden;
  const titleEntry = document.getElementById('btn-lobby-titles');
  if (titleEntry) {
    titleEntry.title = titleBadge.hidden
      ? '我的称号（当前未佩戴）'
      : `我的称号：${titleBadge.textContent}`;
  }

  document.getElementById('game-ddz').classList.toggle('is-active', game === 'ddz');
  document.getElementById('game-fishing').classList.toggle('is-active', fishing);
  const gmkCard = document.getElementById('game-gomoku');
  if (gmkCard) gmkCard.classList.toggle('is-active', gomoku);
  // 发牌开关只对斗地主有意义（小猫钓鱼 / 五子棋不需要这个模式）
  const dealRow = document.getElementById('deal-row');
  if (dealRow) dealRow.hidden = fishing || gomoku;
  const blockTitle = document.getElementById('room-block-title');
  /**
   * ★ 这一块**永远显示**（用户报的 bug）：
   *   以前"五子棋 + 房间模式"会把整块藏掉（本意是"房间模式不用选难度"），
   *   但场次卡上的「开始游戏」正是**进房间的唯一入口** —— 藏了之后
   *   打完一局回到大厅，右侧空空一片，也没法再开一局。
   *   现在照常显示，房间模式下在标题和卡片上方各加一句说明：
   *   难度是跟着你邀请的那位好友走的（场次只决定房间本身）。
   */
  if (blockTitle) {
    blockTitle.textContent = gomoku && roomMode ? '开始房间（五子棋）'
      : fishing ? '选择场次（小猫钓鱼）'
        : gomoku ? '选择场次（五子棋）' : '选择场次（斗地主）';
  }

  /* 场次卡片：斗地主 / 小猫钓鱼 / 五子棋 各有一套 */
  const list = document.getElementById('room-list');
  if (gomoku) {
    // 房间模式：难度跟着邀请的好友走，这里只是入口（用一句金色小字交代清楚）
    const note = roomMode
      ? '<div class="room-note">房间模式：难度跟着你邀请的那位好友走，点下面任意一档进房间邀请</div>'
      : '';
    // ★ 五子棋的场次**没有底分/门槛**，只决定匹配难度（界面上不提难度档位）
    list.innerHTML = note + GOMOKU_ROOMS.map((room) => `
        <div class="room-card" style="--tone:${room.tone}" data-room="${room.id}">
          <div>
            <div class="room-name">${room.name}</div>
            <div class="room-desc">${room.desc}</div>
            <div class="room-stats">
              <span class="room-stat">玩法 <b>15×15 五子棋</b></span>
              <span class="room-stat">输赢 <b>不结算豆子</b></span>
              <span class="room-stat">每局 <b>好感度 +${GOMOKU.affinityPerGame}</b></span>
            </div>
            <div class="room-desc" style="margin-top:6px;color:var(--gold)">每局随机决定谁先手，横竖斜连成五子就赢</div>
          </div>
          <button class="room-go" data-room-go="${room.id}" type="button">开始游戏</button>
        </div>`).join('');
  } else if (fishing) {
    list.innerHTML = FISHING_ROOMS.map((room) => {
      const can = app.canEnterFishing(room);
      const pay = (d) => `±${Math.abs(settleFishing(26 + d, 26, room).delta).toLocaleString()}`;
      return `
        <div class="room-card ${can.ok ? '' : 'is-locked'}" style="--tone:${room.tone}" data-room="${room.id}">
          <div>
            <div class="room-name">${room.name}</div>
            <div class="room-desc">${room.desc}</div>
            <div class="room-stats">
              <span class="room-stat">差 5 张 <b>${pay(5)}</b></span>
              <span class="room-stat">差 10 张 <b>${pay(10)}</b></span>
              <span class="room-stat">差 20 张 <b>${pay(20)}</b></span>
              <span class="room-stat">门槛 <b>💰${formatBeans(room.minBeans)}</b></span>
            </div>
            <div class="room-desc" style="margin-top:6px;color:var(--gold)">一次钓到 ${FISHING.bigCatchMin} 张以上，本局倍数翻倍（上限 ×${FISHING.maxMultiplier}）</div>
            ${can.ok ? '' : `<div class="room-warn">${can.reason}</div>`}
          </div>
          <button class="room-go" data-room-go="${room.id}" type="button" ${can.ok ? '' : 'disabled'}>开始游戏</button>
        </div>`;
    }).join('');
  } else {
    list.innerHTML = ROOMS.map((room) => {
      const can = app.economy.canEnter(room);
      const space = Math.floor(room.cap / room.base);
      return `
        <div class="room-card ${can.ok ? '' : 'is-locked'}" style="--tone:${room.tone}" data-room="${room.id}">
          <div>
            <div class="room-name">${room.name}</div>
            <div class="room-desc">${room.desc}</div>
            <div class="room-stats">
              <span class="room-stat">底分 <b>${room.base}</b></span>
              <span class="room-stat">封顶 <b>💰${formatBeans(room.cap)}</b></span>
              <span class="room-stat">倍数空间 <b>×${space}</b></span>
              <span class="room-stat">门槛 <b>💰${formatBeans(room.minBeans)}</b></span>
            </div>
            ${can.ok ? '' : `<div class="room-warn">${can.reason}</div>`}
          </div>
          <button class="room-go" data-room-go="${room.id}" type="button" ${can.ok ? '' : 'disabled'}>开始游戏</button>
        </div>`;
    }).join('');
  }

  list.querySelectorAll('[data-room-go]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fishing) app.startFishing(btn.dataset.roomGo);
      else if (gomoku) app.startGomoku(btn.dataset.roomGo);
      else app.startGame(btn.dataset.roomGo);
    });
  });

  /* 救济金 */
  const relief = app.economy.reliefState();
  const row = document.getElementById('relief-row');
  if (relief.claimedToday) {
    row.className = 'relief-row is-done';
    row.innerHTML = `<span>今日救济金已领取，明天再来</span><span>身家 ${beanLabel(save.beans)}</span>`;
  } else if (relief.eligible) {
    row.className = 'relief-row';
    row.innerHTML = `<span>身家低于 💰${relief.amount.toLocaleString()}，可以领一份救济金</span>
      <button class="mini-btn" id="btn-relief" type="button">领取 💰${relief.amount.toLocaleString()}</button>`;
    document.getElementById('btn-relief').addEventListener('click', () => app.claimRelief());
  } else {
    row.className = 'relief-row is-done';
    row.innerHTML = `<span>身家充足，暂时不需要救济金</span><span>低于 ${relief.amount.toLocaleString()} 豆 时可领取</span>`;
  }

  /* 活动红点（签到收进了活动中心，红点跟着活动走） */
  app.updateActivityDot();
  renderSocialLobby(app);
}
