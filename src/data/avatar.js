/**
 * 玩家头像的来源（纯函数，无 DOM）
 *
 * 优先级：**上传的照片** > `image/001.png`（注册默认头像，见下）。
 *
 * ★ 用户拍板（第二次）：**没上传头像时，游戏里也用 `image/001.png`** ——
 *   一开始只在注册界面用了它，进大厅还是老默认 `avatar_01`，看着像"没生效"。
 *   现在大厅 / 桌位 / 结算 / 排行榜 / 聊天 / 群聊 / 遇见 / 钓鱼 / 五子棋全部统一到这一份，
 *   所以要改默认头像只改 `SIGNUP_AVATAR_SRC` 一处。
 *
 *   为什么保留 `playerAvatarId`：AI 头像池那套（`ASSETS.avatar('avatar_02')` → `image/avatar_02.png`）
 *   还要继续用 id，玩家的 `save.avatar` 字段也留着（老存档里可能记着某个预设），
 *   只是**没上传照片时不再拿它当默认**。
 */
import { ASSETS } from '../../assets/manifest.js';

/** AI 头像池里的默认 id（好友 / AI 自己的头像兜底用） */
export const DEFAULT_AVATAR_ID = 'avatar_01';

/**
 * ★ 玩家（注册账号）的默认头像：项目根的 `image/001.png`。
 *   它不在 AI 头像池（`avatar_01`~`avatar_40`）里，所以直接给完整路径。
 */
export const SIGNUP_AVATAR_SRC = 'image/001.png';

/** 玩家头像的预设 id（老存档里记着的那个，只作参考） */
export const playerAvatarId = (save) => (save && save.avatar) || DEFAULT_AVATAR_ID;

/**
 * 玩家头像最终要用的 src：
 *   上传的 dataURL > `image/001.png`
 */
export function playerAvatarSrc(save) {
  const up = save && save.avatarUpload;
  if (typeof up === 'string' && up.startsWith('data:image/')) return up;
  return SIGNUP_AVATAR_SRC;
}

/** 注册界面（设置性别 + 姓名）里显示的头像：和上面同一份口径 */
export function signupAvatarSrc(save) {
  const up = save && save.avatarUpload;
  if (typeof up === 'string' && up.startsWith('data:image/')) return up;
  return SIGNUP_AVATAR_SRC;
}

/** 是不是用的自己上传的照片 */
export const hasUploadedAvatar = (save) => playerAvatarSrc(save).startsWith('data:image/');

/** AI / 好友头像的 src（走 image/ 目录） */
export const avatarSrcOf = (id) => ASSETS.avatar(id || DEFAULT_AVATAR_ID);
