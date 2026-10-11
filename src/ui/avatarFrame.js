import { equippedFrame } from '../store/cosmetics.js';
import { playerAvatarSrc } from '../data/avatar.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function overlay(frame) {
  return frame ? `<span class="avatar-frame-art" aria-hidden="true" data-frame="${frame}"><svg viewBox="0 0 64 64"><use href="assets/ui/item-art.svg#art-${frame}" /></svg></span>` : '';
}

/** 玩家头像和头像框作为整体渲染，财富榜、聊天、匹配等共用。 */
export function playerAvatarHTML(save, className = '') {
  const frame = equippedFrame(save);
  return avatarHTML(playerAvatarSrc(save), className, frame, true);
}

export function avatarHTML(src, className = '', frame = '', player = false) {
  return `<span class="avatar-frame-host ${className}${frame ? ' has-avatar-frame' : ''}" ${player ? 'data-player-frame' : ''}><img src="${esc(src)}" alt="" />${overlay(frame)}</span>`;
}

/** 更新静态头像容器和当前已挂载的动态头像，不替换图片节点与其事件。 */
export function syncAvatarFrames(root, save) {
  const frame = equippedFrame(save);
  root.querySelectorAll('[data-player-frame]').forEach((host) => {
    let art = host.querySelector('.avatar-frame-art');
    host.classList.toggle('has-avatar-frame', !!frame);
    if (!frame) { if (art) art.remove(); return; }
    if (art?.dataset.frame === frame) return;
    if (art) art.remove();
    const box = document.createElement('span');
    box.innerHTML = overlay(frame);
    art = box.firstElementChild;
    if (art) host.append(art);
  });
}
