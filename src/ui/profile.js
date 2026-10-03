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
  equipFrame, equippedFrame, renameCardCount, ownedCardBacks, ownsCardBack, equipTheme, equippedTheme, ownsTheme,
} from '../store/cosmetics.js';
import { playerAvatarSrc, hasUploadedAvatar } from '../data/avatar.js';
import { GENDERS, playerGenderOf } from '../data/player.js';
import { readAvatarFile, clearAvatarUpload, dataUrlBytes, AVATAR_SIZE } from './avatarUpload.js';

export function openProfile(app) {
  const el = openDrawer(drawerShell('我的形象', '<div id="profile-body"></div>'));
  const body = el.querySelector('#profile-body');
  let busy = false;

  function render() {
    const cur = equippedFrame(app.save);
    const owned = new Set(app.save.cosmetics.frames || []);
    const avatarSrc = playerAvatarSrc(app.save);
    const uploaded = hasUploadedAvatar(app.save);
    const backs = ownedCardBacks(app.save);
    const using = app.save.settings.cardBack;
    const theme = equippedTheme(app.save);
    const gender = playerGenderOf(app.save);

    body.innerHTML = `
      <div class="prof-preview">
        <span class="prof-preview-face">
          <img id="prof-preview-img" class="${cur ? `frame-${cur.replace(/^f_/, '')}` : ''}" src="${avatarSrc}" alt="" />
        </span>
        <div class="prof-preview-meta">
          <div class="prof-preview-name">${app.playerName}</div>
          <div class="prof-preview-sub">${cur ? `${(FRAMES.find((f) => f.id === cur) || {}).name} · 已佩戴` : '还没戴头像框'}</div>
          <div class="prof-preview-row">
            <button class="mini-btn" id="prof-upload" type="button">${uploaded ? '换一张照片' : '上传头像照片'}</button>
            ${uploaded ? '<button class="mini-btn" id="prof-reset-avatar" type="button">恢复默认</button>' : ''}
            <button class="mini-btn" id="prof-rename" type="button">改名（🪪 ${renameCardCount(app.save)}）</button>
          </div>
        </div>
      </div>
      <input type="file" id="prof-file" accept="image/*" hidden />

      <h4 class="shop-sec">性别<small class="prof-hint">影响 AI 怎么称呼你（牌桌、私聊、群聊都算）</small></h4>
      <div class="prof-genders">
        ${GENDERS.map((g) => `
          <button class="prof-gender ${g.id === gender ? 'is-active' : ''}" data-gender="${g.id}" type="button">
            ${g.sign} ${g.label}
          </button>`).join('')}
      </div>

      <h4 class="shop-sec">风格<small class="prof-hint">默认是深色的「霓虹夜」；浅色的「奶油晴空」去「商城 · 装扮」买</small></h4>
      <div class="prof-themes">
        ${THEMES.map((t) => {
    const has = ownsTheme(app.save, t.id);
    const on = theme === t.id || (!theme && t.tone === 'dark');
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

      <h4 class="shop-sec">头像<small class="prof-hint">从本地选一张照片就行：任意尺寸、任意长宽比，
        会自动**居中裁剪成正方形**、再按圆形显示</small></h4>
      <div class="prof-upload-box">
        <div class="pub-face">
          <img src="${avatarSrc}" alt="" class="${cur ? `frame-${cur.replace(/^f_/, '')}` : ''}" />
        </div>
        <div class="pub-text">
          <div>当前${uploaded ? '：你上传的照片' : '：默认头像'}</div>
          <div class="prof-hint">${uploaded
    ? `已保存为 ${AVATAR_SIZE}×${AVATAR_SIZE}，约 ${Math.round(dataUrlBytes(app.save.avatarUpload) / 1024)} KB`
    : '点右边的按钮，从手机或电脑里挑一张照片'}</div>
        </div>
        <button class="act-btn go" id="prof-upload2" type="button">选择照片</button>
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
            <img src="${avatarSrc}" class="${has ? `frame-${f.id.replace(/^f_/, '')}` : 'is-dim'}" alt="" />
            ${has ? '' : '<i class="prof-lock">🔒</i>'}
          </span>
          <b>${f.name}</b>
          <i>${has ? f.desc : `💰${f.price.toLocaleString()}`}</i>
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
            <b>${b.name}</b>
            <i>${on ? '使用中' : has ? '点击使用' : `💰${b.price.toLocaleString()}`}</i>
          </button>`;
  }).join('')}
      </div>
      <div class="act-note">装扮只影响外观，**不影响出牌与结算**。</div>
    `;

    /* 上传头像 */
    const file = body.querySelector('#prof-file');
    const pick = () => file.click();
    body.querySelector('#prof-upload').addEventListener('click', pick);
    body.querySelector('#prof-upload2').addEventListener('click', pick);
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

    /* 风格（整体配色） */
    body.querySelectorAll('[data-theme]').forEach((btn) => btn.addEventListener('click', () => {
      const res = equipTheme(app.save, btn.dataset.theme);
      if (!res.ok) return toast(res.error, 'bad');
      app.persist('cosmetic');
      app.applyTheme();
      audio.play('select');
      toast(app.save.cosmetics.theme ? '已切换风格' : '已回到默认风格（霓虹夜）');
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
      closePanel();
      setTimeout(() => app.openRename(), 180);
    });
    const goShop = body.querySelector('#prof-go-shop');
    if (goShop) goShop.addEventListener('click', () => { closePanel(); setTimeout(() => openShop(app), 180); });
  }

  render();
}
