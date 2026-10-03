/**
 * 玩家头像的来源（纯函数，无 DOM）
 *
 * 优先级：**上传的照片** > 预设 id（`save.avatar`，默认 `avatar_01`）。
 * 放在 data/ 而不是 ui/，是为了让 store 层（排行榜）也能算出一个可直接用的 src，
 * 这样排行榜的每一行仍然可以用**同一个**渲染函数（玩家和 AI 不分叉）。
 */
import { ASSETS } from '../../assets/manifest.js';

export const DEFAULT_AVATAR_ID = 'avatar_01';

/** 玩家头像的预设 id（没上传时用它） */
export const playerAvatarId = (save) => (save && save.avatar) || DEFAULT_AVATAR_ID;

/** 玩家头像最终要用的 src：上传的 dataURL，或预设图片路径 */
export function playerAvatarSrc(save) {
  const up = save && save.avatarUpload;
  if (typeof up === 'string' && up.startsWith('data:image/')) return up;
  return ASSETS.avatar(playerAvatarId(save));
}

/** 是不是用的自己上传的照片 */
export const hasUploadedAvatar = (save) => playerAvatarSrc(save).startsWith('data:image/');

/** AI / 好友头像的 src（走 image/ 目录） */
export const avatarSrcOf = (id) => ASSETS.avatar(id || DEFAULT_AVATAR_ID);
