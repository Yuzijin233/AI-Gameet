/**
 * 贴图清单（PRD §7.8）
 * 替换 assets 下的同名 PNG 即可换皮，不需要改任何逻辑代码。
 * 牌面贴图缺失时自动回退 emoji 渲染，不会裂图。
 * 注意：面板与按钮的底色/圆角由 styles/ 里的 CSS 控制（不叠拉伸的圆角贴图，避免弧度对不上）。
 */
export const ASSETS = {
  logo: 'assets/ui/logo.png',
  icons: {
    chat: 'assets/ui/icon_chat.png',
    shop: 'assets/ui/icon_shop.png',
    sign: 'assets/ui/icon_sign.png',
    settings: 'assets/ui/icon_settings.png',
    sound: 'assets/ui/icon_sound.png',
    mic: 'assets/ui/icon_mic.png',
    flower: 'assets/ui/icon_flower.png',
    egg: 'assets/ui/icon_egg.png',
  },
  fx: {
    bomb: 'assets/fx/bomb.png',
    spring: 'assets/fx/spring.png',
    particle1: 'assets/fx/particle_01.png',
    particle2: 'assets/fx/particle_02.png',
  },
  cardBacks: ['back_01', 'back_02', 'back_03'],
  cardBack: (id) => `assets/cards/back/${id}.png`,
  cardFront: (file) => `assets/cards/front/${file}.png`,
  /**
   * 头像：**放在项目根的 image/ 里**（不放 assets/），因为这里就是"拿来替换成真实头像"的。
   * 任意尺寸/任意长宽比都行，界面按"居中裁剪成正方形 → CSS 裁成圆形"显示。
   * 详见 image/README.md。
   */
  avatarDir: 'image',
  avatars: Array.from({ length: 30 }, (_, i) => `image/avatar_${String(i + 1).padStart(2, '0')}.png`),
  /**
   * 头像路径：给**预设 id**（`avatar_02`）就补成 `image/avatar_02.png`；
   * 如果传进来的已经是路径 / dataURL（比如玩家**上传的照片**），原样返回 ——
   * 幂等，重复套一层也不会坏（匹配动画与座位都拿它兜底）。
   */
  avatar: (id) => {
    const s = String(id == null ? '' : id);
    if (!s) return 'image/avatar_01.png';
    return /^(data:|blob:|https?:|\/|\.{1,2}\/|image\/|assets\/)/.test(s) ? s : `image/${s}.png`;
  },
};