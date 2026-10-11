/**
 * 头像图片处理（PRD §2.17）
 * 玩家头像是**上传的本地照片**，不是从预设里挑 —— 所以需要自己处理：
 *   读文件 → 画到 canvas（**居中裁剪成正方形**，cover）→ 压成 dataURL 存进存档。
 *
 * 尺寸刻意压到 256：存档写在 localStorage 里，原图动辄几 MB 会直接塞爆配额。
 * 任意尺寸 / 任意长宽比都能用，界面上再按圆形显示（CSS `border-radius: 50%`）。
 */

/** 存进存档的边长（正方形） */
export const AVATAR_SIZE = 256;
/** 压缩后的 dataURL 上限（约 40KB 的 base64），超了就再降一档质量 */
const MAX_DATA_URL = 60000;

/** 把一张图按"居中裁剪成正方形"画进 canvas，返回 dataURL */
export function cropToSquareDataUrl(img, size = AVATAR_SIZE, quality = 0.86) {
  const iw = img.naturalWidth || img.width || 0;
  const ih = img.naturalHeight || img.height || 0;
  if (!iw || !ih) return '';
  const side = Math.min(iw, ih);
  const sx = Math.round((iw - side) / 2);
  const sy = Math.round((ih - side) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // 先铺一层深色底：PNG 透明区域在圆形头像里会露出背景，看着像缺口
  ctx.fillStyle = '#1b1035';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  let out = canvas.toDataURL('image/jpeg', quality);
  if (out.length > MAX_DATA_URL) out = canvas.toDataURL('image/jpeg', 0.6);
  return out;
}

/**
 * 读一个 File → 居中裁剪的方形 dataURL
 * @returns {Promise<{ok:boolean, dataUrl?:string, error?:string}>}
 */
export function readAvatarFile(file, size = AVATAR_SIZE) {
  return new Promise((resolve) => {
    if (!file) return resolve({ ok: false, error: '没有选到文件' });
    if (!/^image\//.test(file.type || '')) return resolve({ ok: false, error: '请选一张图片（png / jpg / webp 都行）' });
    const reader = new FileReader();
    reader.onerror = () => resolve({ ok: false, error: '读文件失败' });
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve({ ok: false, error: '这张图打不开，换一张试试' });
      img.onload = () => {
        try {
          const dataUrl = cropToSquareDataUrl(img, size);
          if (!dataUrl) return resolve({ ok: false, error: '图片处理失败' });
          resolve({ ok: true, dataUrl });
        } catch (err) {
          resolve({ ok: false, error: `图片处理失败：${err && err.message}` });
        }
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** 清掉上传的头像，回到默认 */
export function clearAvatarUpload(save) {
  if (save) delete save.avatarUpload;
  return save;
}

/** 估算 dataURL 的字节数（存档配额提示用） */
export function dataUrlBytes(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  return i < 0 ? 0 : Math.round(((s.length - i - 1) * 3) / 4);
}
