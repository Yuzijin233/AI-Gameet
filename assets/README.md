# assets 贴图说明（PRD §7.8）

**换皮规则：替换同名文件即可生效，不要改文件名。** 全部路径集中在 `assets/manifest.js`；
贴图缺失时游戏会自动回退到内置渲染（牌面回退 emoji + HTML），不会出现裂图。

## 牌面：默认不用贴图

牌面默认走 **HTML + emoji 渲染**（点数用文字，花色用 ♠️♥️♣️♦️，大小王用 🤡），
所以 `assets/cards/front/` 目前是**空的**，这不影响游戏。

想换成自己的牌面美术时：

1. 把 54 张 PNG 放进 `assets/cards/front/`，命名严格如下（尺寸建议 240×336，2× 图）：
   - `{S,H,C,D}_{A,2,3,4,5,6,7,8,9,10,J,Q,K}.png` 共 52 张
   - `joker_s.png`（小王）、`joker_b.png`（大王）
2. 打开游戏 → 设置 → **牌面使用 PNG 贴图** → 选「贴图」。

任何一张缺失或是空图，那一张会自动回退成 emoji 版本，不会出现白块。

## 其他目录与规格

| 目录 | 文件 | 尺寸 | 说明 |
|------|------|------|------|
| `cards/back/` | `back_01.png` `back_02.png` `back_03.png` | 240×336 | 3 款牌背；在「点大厅左上角头像 → 我的形象」里切换（`back_01` 免费，另两款要买） |
| `ui/` | `logo.png` | 512×512 | 大厅与加载页徽标 |
| `ui/` | `icon_{chat,shop,sign,settings,sound,mic,flower,egg}.png` | 96×96 | 图标，按 contain 缩放，不会变形 |
| `fx/` | `bomb.png` | 512×512 | 炸弹特效 |
| `fx/` | `spring.png` | 1024×256 | 春天/反春横幅 |
| `fx/` | `particle_01.png` `particle_02.png` | 64×64 | 背景粒子（星点 / 花瓣） |

> **头像不在 `assets/` 里**：全部在项目根的 **`image/`** 目录（`avatar_01.png` … `avatar_30.png`），
> 因为那里就是"拿来替换成真实照片"的地方 —— 详见 `image/README.md`。
> 人设 p01–p28 依次用 01–28；**玩家头像是自己上传的本地照片**（在「我的形象」里选，
> 居中裁剪成正方形、再按圆形显示），不上传就用 `image/avatar_01.png`。

> **面板与按钮不用贴图**：它们的圆角、底色、描边全部由 `styles/base.css` 里的 CSS 决定。
> 之前用一张圆角 PNG 拉伸铺面板，圆角会被拉成椭圆、和 CSS 圆角对不上，所以去掉了。
> 想改面板外观，直接改 `styles/tokens.css` 里的 `--radius-panel`、`--glass*` 与 `.drawer` 的渐变即可。

## 重新生成占位贴图

```powershell
# 生成牌背 / 头像 / UI / 特效（默认不碰牌面）
powershell -ExecutionPolicy Bypass -File tools\export-assets.ps1

# 只生成某一组
powershell -ExecutionPolicy Bypass -File tools\export-assets.ps1 -Group avatars

# 确实需要占位牌面时才加这个开关
powershell -ExecutionPolicy Bypass -File tools\export-assets.ps1 -GenerateCards
```

脚本是幂等的，会覆盖同名文件。生成的都是占位图，可直接用你自己的美术覆盖。

## 注意

- 牌背/牌面保留 4px 安全边，圆角与描边直接画在图内（容器已有圆角裁切）。
- 头像按圆形裁切使用，主体建议居中并留 8% 边距。
- 所有贴图建议带透明通道（PNG-24），避免出现白底方框。
