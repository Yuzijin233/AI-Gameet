/**
 * 我的形象面板（PRD §2.17）
 * 入口是**大厅左上角的头像**（点头像就进来）。
 * 这里一次能换：**头像（上传本地照片）**、**头像框**、**风格（整体配色）**、**牌背**、**性别**。
 * 设置里已经不放这些东西了 —— 设置只留系统设置。
 */
import { openDrawer, drawerShell, closePanel, openShop } from './panels.js';
import { toast } from './fx.js';
import { audio } from './audio.js';
import { ASSETS } from '../../assets/manifest.js';
import { FRAMES, RENAME_CARD, CARD_BACKS, THEMES } from '../data/cosmetics.js';
import {
  equipFrame, equippedFrame, renameCardCount, useRenameCard, ownedCardBacks, ownsCardBack, equipTheme, equippedTheme, ownsTheme,
} from '../store/cosmetics.js';
import { playerAvatarSrc, hasUploadedAvatar } from '../data/avatar.js';
import { GENDERS, playerGenderOf } from '../data/player.js';
import { readAvatarFile, clearAvatarUpload } from './avatarUpload.js';
import { titleList, equipTitle, equippedTitle } from '../store/titles.js';
import { titleBadgeHTML } from './titleBadge.js';
import { syncAvatarFrames } from './avatarFrame.js';
import { syncPlayerRename } from '../store/friends.js';
import { ITEMS, GIFTS, CONFIG } from '../config.js';
import { itemCount } from '../store/items.js';

const assetArt = (id, label = '') => `<svg class="asset-art" viewBox="0 0 64 64" role="img" aria-label="${label}"><use href="assets/ui/item-art.svg#art-${id}" /></svg>`;
const escapeProfile = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openProfile(app) {
  const el = openDrawer(drawerShell('我的主页', '<div id="profile-body"></div>'), { page: 'profile' });
  const body = el.querySelector('#profile-body');
  let busy = false;
  let tab = 'basic';
  let editingName = false;

  function render() {
    const cur = equippedFrame(app.save);
    const owned = new Set(app.save.cosmetics.frames || []);
    const avatarSrc = playerAvatarSrc(app.save);
    const uploaded = hasUploadedAvatar(app.save);
    const backs = ownedCardBacks(app.save);
    const using = app.save.settings.cardBack;
    const theme = equippedTheme(app.save);
    const gender = playerGenderOf(app.save);
    const titles = titleList(app.save);
    const currentTitle = equippedTitle(app.save);

    body.innerHTML = `
      <div class="prof-tabs" role="tablist" aria-label="我的主页分类">
        <button class="${tab === 'basic' ? 'is-active' : ''}" data-prof-tab="basic" role="tab" aria-selected="${tab === 'basic'}" type="button">基础信息</button>
        <button class="${tab === 'decor' ? 'is-active' : ''}" data-prof-tab="decor" role="tab" aria-selected="${tab === 'decor'}" type="button">装饰</button>
        <button class="${tab === 'bag' ? 'is-active' : ''}" data-prof-tab="bag" role="tab" aria-selected="${tab === 'bag'}" type="button">背包</button>
      </div>
      <section class="prof-pane" data-prof-pane="basic" ${tab === 'basic' ? '' : 'hidden'}>
      <div class="prof-preview">
        <span class="prof-preview-face" data-player-frame>
          <img id="prof-preview-img" src="${avatarSrc}" alt="" />
        </span>
        <div class="prof-preview-meta">
          <div class="prof-preview-name">${escapeProfile(app.playerName)}</div>
          <div class="prof-preview-sub">${currentTitle ? titleBadgeHTML(currentTitle) : '未佩戴称号'}</div>
          <div class="prof-preview-row">
            <button class="mini-btn" id="prof-upload" type="button">${uploaded ? '换一张照片' : '上传头像照片'}</button>
            ${uploaded ? '<button class="mini-btn" id="prof-reset-avatar" type="button">恢复默认</button>' : ''}
            <button class="mini-btn" id="prof-rename" type="button" ${renameCardCount(app.save) ? '' : 'disabled'}
              title="${renameCardCount(app.save) ? '修改一次消耗 1 张改名卡' : '没有改名卡，去商城 · 道具里买'}">改名</button>
          </div>
        </div>
      </div>
      ${editingName ? `<form class="prof-name-editor" id="prof-name-editor">
        <label for="prof-name-input">修改昵称</label><input id="prof-name-input" maxlength="12" value="${escapeProfile(app.playerName)}" required />
        <button class="mini-btn" type="submit" ${renameCardCount(app.save) ? '' : 'disabled'}>保存</button><button class="mini-btn" type="button" id="prof-name-cancel">取消</button>
        <small>${renameCardCount(app.save) ? '修改一次消耗 1 张改名卡' : '没有改名卡，请在商城的道具分类购买'}</small>
      </form>` : ''}
      <input type="file" id="prof-file" accept="image/*" hidden />

      <h4 class="shop-sec">性别<small class="prof-hint">用于个人资料及对话称呼</small></h4>
      <div class="prof-genders">
        ${GENDERS.map((g) => `
          <button class="prof-gender ${g.id === gender ? 'is-active' : ''}" data-gender="${g.id}" type="button">
            ${g.sign} ${g.label}
          </button>`).join('')}
      </div>

      <h4 class="shop-sec">称号<small class="prof-hint">选择一个展示在头像与牌桌旁</small></h4>
      <div class="prof-title-current">
        <span><small>佩戴效果</small>${currentTitle ? titleBadgeHTML(currentTitle, true) : '<b>未佩戴称号</b>'}</span>
        ${currentTitle ? '<button class="mini-btn" data-title="" type="button">卸下</button>' : ''}
      </div>
      <div class="prof-titles" aria-label="称号列表">
        ${[...titles].sort((a, b) => Number(b.unlocked) - Number(a.unlocked)).map((t) => `<div class="prof-title ${t.equipped ? 'is-active' : ''} ${t.unlocked ? '' : 'is-locked'}">
          <span class="prof-title-badge-preview">${titleBadgeHTML(t)}</span><span><small>${t.desc}</small></span>
          <span class="prof-title-condition">${t.unlocked ? '已拥有' : (t.kind === 'signin' ? `连续签到 ${t.progress}/${t.days} 天` : t.kind === 'beans' ? `身家 ${t.beans.toLocaleString()}` : t.kind === 'shop' ? '商城获取' : t.kind === 'lover' ? '关系达成' : '活动获取')}</span>
          <button class="mini-btn" data-title="${t.equipped ? '' : t.id}" type="button" ${t.unlocked ? '' : 'disabled'}>${t.equipped ? '卸下' : t.unlocked ? '佩戴' : '未解锁'}</button>
        </div>`).join('')}
      </div>
      </section>

      <section class="prof-pane" data-prof-pane="decor" ${tab === 'decor' ? '' : 'hidden'}>

      <h4 class="shop-sec">风格<small class="prof-hint">「午后会客厅」为全新默认；经典主题保留，随时切换</small></h4>
      <div class="prof-themes">
        ${THEMES.map((t) => {
    const has = ownsTheme(app.save, t.id);
    const on = theme === t.id;
    return `<button class="prof-theme ${on ? 'is-active' : ''} ${has ? '' : 'is-locked'}" data-theme="${t.id}"
            type="button" ${has ? '' : 'disabled'} title="${has ? t.desc || '' : '还没拥有'}">
            <span class="prof-theme-face is-${t.tone}">
              <span class="ptf-bg"></span><span class="ptf-chip"></span>
              ${has ? '' : '<i class="prof-lock-badge">🔒</i>'}
            </span>
            <b>${t.name}</b>
            <i>${has ? (on ? '使用中' : '点击切换') : `💰${t.price.toLocaleString()}`}</i>
          </button>`;
  }).join('')}
      </div>

      <h4 class="shop-sec">头像框<small class="prof-hint">🔒 的还没拥有 —— 商城能买，转盘 / 首充礼包也会给</small></h4>
      <div class="prof-frames">
        <button class="prof-frame ${cur ? '' : 'is-active'}" data-frame="" type="button">
          <span class="prof-frame-face"><img src="${avatarSrc}" alt="" /></span>
          <b>不戴</b>
        </button>
        ${FRAMES.map((f) => {
    const has = owned.has(f.id);
    const on = cur === f.id;
    return `<button class="prof-frame ${on ? 'is-active' : ''} ${has ? '' : 'is-locked'}" data-frame="${f.id}"
          type="button" ${has ? '' : 'disabled'} title="${has ? f.desc || '' : '还没拥有'}">
          <span class="prof-frame-face">
            ${assetArt(f.id, f.name)}
            <img src="${avatarSrc}" class="${has ? `frame-${f.id.replace(/^f_/, '')}` : 'is-dim'}" alt="" />
            ${has ? '' : '<i class="prof-lock">🔒</i>'}
          </span>
          <b>${f.name}</b>
           <i>${has ? (on ? '佩戴中' : '已拥有') : f.price ? `${f.price.toLocaleString()} 开心豆` : f.only === 'wheel' ? '转盘获取' : '首充礼包获取'}</i>
        </button>`;
  }).join('')}
      </div>

      <h4 class="shop-sec">牌背<small class="prof-hint">🔒 的还没拥有 —— 去「商城 · 装扮」买</small></h4>
      <div class="prof-backs">
        ${CARD_BACKS.map((b) => {
    const has = backs.includes(b.id);
    const on = using === b.id;
    return `<button class="prof-back ${on ? 'is-active' : ''} ${has ? '' : 'is-locked'}" data-back="${b.id}"
            type="button" ${has ? '' : 'disabled'} title="${has ? b.desc || '' : '还没拥有'}">
            <span class="prof-back-face" style="background-image:url('${ASSETS.cardBack(b.id)}')">
              ${has ? '' : '<i class="prof-lock">🔒</i>'}
            </span>
            <b>${b.id === 'back_01' && document.documentElement.dataset.theme === 'social' ? '松影纹章' : b.name}</b>
            <i>${on ? '使用中' : has ? '点击使用' : `💰${b.price.toLocaleString()}`}</i>
          </button>`;
  }).join('')}
      </div>
      <div class="act-note">装扮只影响外观，不影响出牌与结算。</div>
      </section>

      <section class="prof-pane" data-prof-pane="bag" ${tab === 'bag' ? '' : 'hidden'}>
      <h4 class="shop-sec">牌桌道具<small class="prof-hint">牌桌上用，每种每局最多 ${CONFIG.toolPerHand} 次，只表达情绪</small></h4>
      <div class="bag-grid">
        ${ITEMS.map((it) => `
          <div class="bag-item ${itemCount(app.save, it.id) > 0 ? '' : 'is-empty'}">
            <span class="bag-face">${assetArt(it.id, it.name)}</span>
            <b>${it.name}</b>
            <i>持有 ${itemCount(app.save, it.id)}</i>
          </div>`).join('')}
      </div>

      <h4 class="shop-sec">礼物<small class="prof-hint">在好友界面赠送（每位好友每天最多 3 次）</small></h4>
      <div class="bag-grid">
        ${GIFTS.map((g) => `
          <div class="bag-item ${itemCount(app.save, g.id) > 0 ? '' : 'is-empty'}">
            <span class="bag-face">${assetArt(g.id, g.name)}</span>
            <b>${g.name}</b>
            <i>持有 ${itemCount(app.save, g.id)}</i>
          </div>`).join('')}
      </div>

      <h4 class="shop-sec">改名卡<small class="prof-hint">改一次昵称消耗 1 张</small></h4>
      <div class="bag-grid">
        <div class="bag-item ${renameCardCount(app.save) > 0 ? '' : 'is-empty'}">
          <span class="bag-face">${assetArt(RENAME_CARD.id, RENAME_CARD.name)}</span>
          <b>${RENAME_CARD.name}</b>
          <i>持有 ${renameCardCount(app.save)}</i>
        </div>
      </div>
      <div class="act-note">背包里的东西都在「商城」买；装扮（头像框 / 牌背 / 风格）看「装饰」那一栏。</div>
      </section>
    `;
    syncAvatarFrames(body, app.save);

    /* 上传头像 */
    const file = body.querySelector('#prof-file');
    const pick = () => file.click();
    body.querySelector('#prof-upload').addEventListener('click', pick);
    body.querySelector('#prof-upload2')?.addEventListener('click', pick);
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f || busy) return;
      busy = true;
      const res = await readAvatarFile(f);
      busy = false;
      if (!res.ok) return toast(res.error, 'bad');
      app.save.avatarUpload = res.dataUrl;
      // 上传的是本地图片，不再依赖 image/ 里的预设
      app.persist('avatarUpload');
      audio.play('select');
      app.refreshLobby();
      app.refreshFriendsPanel();
      toast('头像已更新');
      render();
    });
    const reset = body.querySelector('#prof-reset-avatar');
    if (reset) reset.addEventListener('click', () => {
      clearAvatarUpload(app.save);
      app.persist('avatarUpload');
      audio.play('select');
      app.refreshLobby();
      app.refreshFriendsPanel();
      toast('已恢复默认头像');
      render();
    });

    /* 头像框 */
    body.querySelectorAll('[data-frame]').forEach((btn) => btn.addEventListener('click', () => {
      const res = equipFrame(app.save, btn.dataset.frame);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('cosmetic');
      audio.play('select');
      toast(res.frame ? '已佩戴头像框' : '已卸下头像框');
      app.refreshLobby();
      render();
    }));

    body.querySelectorAll('[data-prof-tab]').forEach((btn) => btn.addEventListener('click', () => {
      tab = btn.dataset.profTab;
      render();
      body.querySelector(`[data-prof-tab="${tab}"]`).focus();
    }));

    body.querySelectorAll('[data-title]').forEach((btn) => btn.addEventListener('click', () => {
      const res = equipTitle(app.save, btn.dataset.title);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('title');
      app.refreshTitles();
      audio.play('select');
      toast(btn.dataset.title ? '称号已佩戴' : '已卸下称号');
      render();
    }));

    /* 风格（整体配色） */
    body.querySelectorAll('[data-theme]').forEach((btn) => btn.addEventListener('click', () => {
      const res = equipTheme(app.save, btn.dataset.theme);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('cosmetic');
      app.applyTheme();
      audio.play('select');
      toast(app.save.cosmetics.theme ? '已切换风格' : '已回到默认风格（午后会客厅）');
      render();
    }));

    /* 性别：随时能改（免得第一次手滑选错就没法救了） */
    body.querySelectorAll('[data-gender]').forEach((btn) => btn.addEventListener('click', () => {
      app.save.gender = btn.dataset.gender;
      app.persist('profile');
      audio.play('select');
      toast(`性别已改为「${btn.textContent.trim()}」，AI 之后的称呼会跟着变`);
      render();
    }));

    /* 牌背 */
    body.querySelectorAll('[data-back]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.back;
      if (!ownsCardBack(app.save, id)) return toast('还没有这个牌背，去商城 · 装扮里买', 'bad');
      app.save.settings.cardBack = id;
      app.persist('settings');
      app.applySettings();
      audio.play('select');
      toast('已切换牌背');
      render();
    }));

    body.querySelector('#prof-rename').addEventListener('click', () => {
      editingName = true;
      render();
      body.querySelector('#prof-name-input').focus();
    });
    body.querySelector('#prof-name-cancel')?.addEventListener('click', () => { editingName = false; render(); });
    body.querySelector('#prof-name-editor')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = body.querySelector('#prof-name-input').value.trim().slice(0, 12);
      if (!name) return toast('昵称不能为空', 'bad');
      if (name === app.playerName) { editingName = false; render(); return; }
      if (!useRenameCard(app.save)) return toast('没有改名卡了，请先到商城购买', 'bad');
      const before = app.playerName;
      app.save.nickname = name;
      syncPlayerRename(app.save, before, name);
      app.persist('rename'); app.refreshLobby(); app.refreshFriendsPanel();
      editingName = false; render(); toast('昵称已更新');
    });
    const goShop = body.querySelector('#prof-go-shop');
    if (goShop) goShop.addEventListener('click', () => { closePanel(); setTimeout(() => openShop(app), 180); });
  }

  render();
}
