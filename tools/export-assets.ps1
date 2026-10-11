#Requires -Version 5.1
<#
================================================================================
 export-assets.ps1  --  斗地主 H5 占位贴图批量生成脚本
================================================================================
 用途   : 用 PowerShell + System.Drawing 生成全套 PNG 占位贴图（全部带透明通道）
 特性   : 幂等 / 可重复执行（每次运行都覆盖同名文件），零第三方依赖
 运行   : powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\export-assets.ps1
          （pwsh 7 亦可；本脚本只用 System.Drawing 通用 API）
 输出   : assets/cards/front (54)  assets/cards/back (3)  image (30 头像)
          assets/ui (13)           assets/fx (4)           合计 104 张 PNG
 注意   : 本脚本不生成也不修改任何 .js / .html / .css / package.json
 说明   : 文件名必须以 UTF-8 with BOM 保存，否则 Windows PowerShell 5.1
          会按 ANSI 解码中文注释而报语法错误。
================================================================================
#>

[CmdletBinding()]
param(
    # 资源根目录（留空 = 脚本所在目录的上一级 + assets；也可用 -Root 传相对/绝对路径）
    [string]$Root = '',

    # 只生成某个分组：all | cards | back | avatars | ui | fx
    [ValidateSet('all', 'cards', 'back', 'avatars', 'ui', 'fx')]
    [string]$Group = 'all',

    # 牌面默认不生成：游戏用 emoji 渲染牌面，自绘花色会显得突兀。
    # 需要占位牌面时显式加 -GenerateCards，或单独跑 -Group cards。
    [switch]$GenerateCards
)

Set-StrictMode -Version 2.0

# ==============================================================================
# 0. 环境准备
# ==============================================================================

Add-Type -AssemblyName System.Drawing

$null = [System.Drawing.Color]
$null = [System.Drawing.Bitmap]
$null = [System.Drawing.Graphics]
$null = [System.Drawing.FontFamily]

# ---- 解析资源根目录（$PSScriptRoot 在 param() 默认值里为空，故在此解析） ----
if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($scriptDir)) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
    if ([string]::IsNullOrWhiteSpace($scriptDir)) { $scriptDir = (Get-Location).Path }
    $Root = Join-Path (Split-Path -Parent $scriptDir) 'assets'
}
$script:Root = [System.IO.Path]::GetFullPath($Root)

# ---- 字体回退：优先 Microsoft YaHei / Arial，取第一个真实存在的家族 ----------
function Get-FontFamily {
    param([string[]]$Preferred = @('Microsoft YaHei', 'Microsoft YaHei UI', 'Arial'))

    $installed = @([System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name })
    foreach ($name in $Preferred) {
        if ($installed -contains $name) { return New-Object System.Drawing.FontFamily($name) }
    }
    return New-Object System.Drawing.FontFamily($installed[0])
}

$script:Family     = Get-FontFamily
$script:FamilyName = $script:Family.Name

# ------------------------------------------------------------------ 调色板 ----
$script:C = @{
    Red        = [System.Drawing.Color]::FromArgb(255, 204, 32, 46)
    Black      = [System.Drawing.Color]::FromArgb(255, 26, 30, 38)
    CardTop    = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
    CardBottom = [System.Drawing.Color]::FromArgb(255, 238, 240, 246)
    CardEdge   = [System.Drawing.Color]::FromArgb(255, 176, 182, 196)
    Trans      = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)
}

# 花色：S=黑桃(黑) H=红心(红) C=梅花(黑) D=方块(红)
$script:Suits = @{
    S = @{ Sym = [string][char]0x2660; Color = $script:C.Black }
    H = @{ Sym = [string][char]0x2665; Color = $script:C.Red   }
    C = @{ Sym = [string][char]0x2663; Color = $script:C.Black }
    D = @{ Sym = [string][char]0x2666; Color = $script:C.Red   }
}

$script:Ranks = @('A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K')

$script:CardW      = 240
$script:CardH      = 336
$script:CardRadius = 22.0

# ==============================================================================
# 1. 通用绘图工具
# ==============================================================================

function GC {
    <#  颜色简写：GC 255,0,0  /  GC 128,255,255,255 (A,R,G,B)  #>
    param([Parameter(Mandatory)][int]$A, [int]$R = -1, [int]$G = -1, [int]$B = -1)
    if ($R -lt 0) { return [System.Drawing.Color]::FromArgb($A) }
    if ($B -lt 0) { return [System.Drawing.Color]::FromArgb(255, $A, $R, $G) }
    return [System.Drawing.Color]::FromArgb($A, $R, $G, $B)
}

function New-RoundedPath {
    <#  圆角矩形路径；$Radius 自动收敛到不超过半宽半高  #>
    param([float]$X, [float]$Y, [float]$W, [float]$H, [float]$Radius = 8)
    if ($W -le 0 -or $H -le 0) { throw "New-RoundedPath: 非法尺寸 ${W}x${H}" }
    if ($Radius -lt 0) { $Radius = 0 }
    $max = [Math]::Min($W, $H) / 2.0
    if ($Radius -gt $max) { $Radius = $max }

    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    if ($Radius -le 0.001) {
        $p.AddRectangle((New-Object System.Drawing.RectangleF($X, $Y, $W, $H)))
        return $p
    }
    $d = $Radius * 2.0
    $p.AddArc($X, $Y, $d, $d, 180.0, 90.0)
    $p.AddArc(($X + $W - $d), $Y, $d, $d, 270.0, 90.0)
    $p.AddArc(($X + $W - $d), ($Y + $H - $d), $d, $d, 0.0, 90.0)
    $p.AddArc($X, ($Y + $H - $d), $d, $d, 90.0, 90.0)
    # CloseFigure() 返回 void，但必须吞掉返回值，否则会和 $p 一起被当成函数返回值
    $null = $p.CloseFigure()
    return $p
}

function New-CirclePath {
    param([float]$CX, [float]$CY, [float]$R)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddEllipse(($CX - $R), ($CY - $R), ($R * 2.0), ($R * 2.0))
    return $p
}

function New-EllipsePath {
    param([float]$X, [float]$Y, [float]$W, [float]$H)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddEllipse($X, $Y, $W, $H)
    return $p
}

function New-LinearBrush {
    <#  线性渐变（-Deg 为渐变角度）  #>
    param(
        [float]$X, [float]$Y, [float]$W, [float]$H,
        [System.Drawing.Color]$ColorA, [System.Drawing.Color]$ColorB,
        [float]$Deg = 90.0
    )
    $r = New-Object System.Drawing.RectangleF($X, $Y, [Math]::Max($W, 0.01), [Math]::Max($H, 0.01))
    return (New-Object System.Drawing.Drawing2D.LinearGradientBrush($r, $ColorA, $ColorB, $Deg))
}

function New-RadialBrush {
    <#  径向渐变。返回 @{ Brush=...; Path=... }，调用方需一并释放 Path  #>
    param(
        [float]$CX, [float]$CY, [float]$R,
        [System.Drawing.Color]$InnerColor, [System.Drawing.Color]$OuterColor
    )
    $path = New-CirclePath -CX $CX -CY $CY -R $R
    $b = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
    $b.CenterColor    = $InnerColor
    $b.SurroundColors = @($OuterColor)
    $b.CenterPoint    = New-Object System.Drawing.PointF($CX, $CY)
    return , @{ Brush = $b; Path = $path }
}

function New-Font {
    param([float]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular)
    return New-Object System.Drawing.Font($script:Family, $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
}

function New-G {
    <#  新建带透明通道的位图。返回 @{ Bitmap=...; G=... }  #>
    param([int]$W, [int]$H)
    $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint  = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    return , @{ Bitmap = $bmp; G = $g }
}

function Save-Png {
    param([System.Drawing.Bitmap]$Bitmap, [System.Drawing.Graphics]$G, [string]$Path)
    if ($G) { $G.Dispose() }
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $Bitmap.Dispose()
}

function Add-SoftShadow {
    <#  圆角路径外的柔和阴影（由外到内逐层加深）——纯 GDI+，无需模糊滤镜  #>
    param(
        [System.Drawing.Graphics]$G,
        [float]$X, [float]$Y, [float]$W, [float]$H, [float]$Radius = 20,
        [int]$Steps = 6, [double]$Spread = 5.0, [int]$MaxAlpha = 46, [float]$Dy = 2.0
    )
    for ($i = $Steps; $i -ge 1; $i--) {
        $t = $i / [double]$Steps
        $pad = $Spread * $t
        $alpha = [int]([Math]::Round($MaxAlpha * (1.0 - $t) + 5))
        $p = New-RoundedPath -X ($X - $pad) -Y ($Y - $pad + $Dy) -W ($W + $pad * 2) -H ($H + $pad * 2) -Radius ($Radius + $pad)
        $br = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, 8, 12, 24))
        $G.FillPath($br, $p)
        $br.Dispose(); $p.Dispose()
    }
}

function Add-InnerStroke {
    <#  沿路径内侧描一条白渐变内描边（玻璃高光）  #>
    param(
        [System.Drawing.Graphics]$G, [System.Drawing.Drawing2D.GraphicsPath]$Path,
        [float]$X, [float]$Y, [float]$W, [float]$H,
        [int]$AlphaTop = 180, [int]$AlphaBottom = 30, [float]$Width = 3.0
    )
    $br = New-LinearBrush -X $X -Y $Y -W $W -H $H `
        -ColorA ([System.Drawing.Color]::FromArgb($AlphaTop, 255, 255, 255)) `
        -ColorB ([System.Drawing.Color]::FromArgb($AlphaBottom, 255, 255, 255)) -Deg 90
    $pen = New-Object System.Drawing.Pen($br, $Width)
    $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
    $pen.LineJoin  = [System.Drawing.Drawing2D.LineJoin]::Round
    $G.DrawPath($pen, $Path)
    $pen.Dispose(); $br.Dispose()
}

function Add-OuterStroke {
    param(
        [System.Drawing.Graphics]$G, [System.Drawing.Drawing2D.GraphicsPath]$Path,
        [System.Drawing.Color]$Color, [float]$Width = 3.0
    )
    $pen = New-Object System.Drawing.Pen($Color, $Width)
    $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Center
    $pen.LineJoin  = [System.Drawing.Drawing2D.LineJoin]::Round
    $G.DrawPath($pen, $Path)
    $pen.Dispose()
}

function New-CenteredFormat {
    param([string]$Align = 'Center')
    $sf = New-Object System.Drawing.StringFormat
    switch ($Align) {
        'Center' { $sf.Alignment = [System.Drawing.StringAlignment]::Center }
        'Near'   { $sf.Alignment = [System.Drawing.StringAlignment]::Near }
        'Far'    { $sf.Alignment = [System.Drawing.StringAlignment]::Far }
    }
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $sf.FormatFlags   = [System.Drawing.StringFormatFlags]::NoWrap -bor [System.Drawing.StringFormatFlags]::NoClip
    return $sf
}

function Draw-TextCentered {
    <#  在 (CX, CY) 居中绘制文本（转曲填充，边缘更锐利）；可选偏移阴影  #>
    param(
        [System.Drawing.Graphics]$G, [string]$Text, [System.Drawing.Font]$Font,
        [System.Drawing.Brush]$Brush, [float]$CX, [float]$CY,
        [System.Drawing.Color]$ShadowColor = $script:C.Trans,
        [float]$ShadowDx = 0.0, [float]$ShadowDy = 1.6, [float]$ShadowInflate = 0.0
    )
    if ([string]::IsNullOrEmpty($Text)) { return }

    $sf = New-CenteredFormat
    $box = New-Object System.Drawing.RectangleF(($CX - 600), ($CY - 600), 1200, 1200)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddString($Text, $script:Family, [int]$Font.Style, $Font.Size, $box, $sf)

    if ($ShadowColor.A -gt 0) {
        $G.TranslateTransform($ShadowDx, $ShadowDy)
        if ($ShadowInflate -gt 0) {
            $pen = New-Object System.Drawing.Pen($ShadowColor, $ShadowInflate)
            $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            $G.DrawPath($pen, $path)
            $pen.Dispose()
        }
        $sb = New-Object System.Drawing.SolidBrush($ShadowColor)
        $G.FillPath($sb, $path)
        $sb.Dispose()
        $G.TranslateTransform(-$ShadowDx, -$ShadowDy)
    }

    $G.FillPath($Brush, $path)
    $path.Dispose(); $sf.Dispose()
}

function Draw-TextRotated180 {
    <#  右下角倒置点数：绕 (CX, CY) 旋转 180° 后居中绘制  #>
    param(
        [System.Drawing.Graphics]$G, [string]$Text, [System.Drawing.Font]$Font,
        [System.Drawing.Brush]$Brush, [float]$CX, [float]$CY
    )
    $state = $G.Save()
    $G.TranslateTransform($CX, $CY)
    $G.RotateTransform(180.0)
    Draw-TextCentered -G $G -Text $Text -Font $Font -Brush $Brush -CX 0 -CY 0
    $G.Restore($state)
}

function New-StarPath {
    param(
        [float]$CX, [float]$CY, [float]$R,
        [int]$Points = 5, [double]$InnerRatio = 0.42, [float]$Rotation = -90.0
    )
    $pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
    $step = [Math]::PI / $Points
    $rot  = $Rotation * [Math]::PI / 180.0
    for ($i = 0; $i -lt ($Points * 2); $i++) {
        $r = if ($i % 2 -eq 0) { $R } else { $R * $InnerRatio }
        $a = $rot + $i * $step
        $pts.Add((New-Object System.Drawing.PointF(
            [float]($CX + $r * [Math]::Cos($a)),
            [float]($CY + $r * [Math]::Sin($a)))))
    }
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddPolygon($pts.ToArray())
    $null = $p.CloseFigure()
    return $p
}

function New-FlowerPath {
    <#  n 瓣对称花纹：r = R * (1 - d + d*cos(Petals*theta))  #>
    param([float]$CX, [float]$CY, [float]$R, [double]$Petals = 6, [double]$Depth = 0.34, [int]$Segments = 240)
    $pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
    for ($i = 0; $i -lt $Segments; $i++) {
        $t = 2.0 * [Math]::PI * $i / $Segments
        $rr = $R * (1.0 - $Depth + $Depth * [Math]::Cos($Petals * $t))
        $pts.Add((New-Object System.Drawing.PointF(
            [float]($CX + $rr * [Math]::Cos($t)),
            [float]($CY + $rr * [Math]::Sin($t)))))
    }
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddPolygon($pts.ToArray())
    $null = $p.CloseFigure()
    return $p
}

function Add-DiamondRow {
    <#  对称菱形链（牌背边框花纹）  #>
    param(
        [System.Drawing.Graphics]$G, [System.Drawing.Brush]$Brush,
        [float]$X, [float]$Y, [float]$W, [float]$H, [int]$Count, [bool]$Vertical = $false
    )
    $s = if ($Vertical) { $W * 0.28 } else { $H * 0.28 }
    for ($i = 0; $i -lt $Count; $i++) {
        if ($Vertical) { $cy = $Y + ($H * ($i + 0.5) / $Count); $cx = $X + $W / 2.0 }
        else           { $cx = $X + ($W * ($i + 0.5) / $Count); $cy = $Y + $H / 2.0 }
        $pts = @(
            (New-Object System.Drawing.PointF($cx, ($cy - $s))),
            (New-Object System.Drawing.PointF(($cx + $s), $cy)),
            (New-Object System.Drawing.PointF($cx, ($cy + $s))),
            (New-Object System.Drawing.PointF(($cx - $s), $cy))
        )
        $G.FillPolygon($Brush, $pts)
    }
}

function Get-HslColor {
    <#  HSL -> Color，用于批量生成区分度高的配色  #>
    param([double]$H, [double]$S, [double]$L, [int]$Alpha = 255)
    $h = ((($H % 360) + 360) % 360) / 360.0
    $s = [Math]::Max(0.0, [Math]::Min(1.0, $S))
    $l = [Math]::Max(0.0, [Math]::Min(1.0, $L))
    if ($s -eq 0) { $r = $l; $g = $l; $b = $l }
    else {
        $q = if ($l -lt 0.5) { $l * (1 + $s) } else { $l + $s - $l * $s }
        $p2 = 2 * $l - $q
        $r = Hue2Rgb -P $p2 -Q $q -T ($h + 1.0 / 3.0)
        $g = Hue2Rgb -P $p2 -Q $q -T $h
        $b = Hue2Rgb -P $p2 -Q $q -T ($h - 1.0 / 3.0)
    }
    return [System.Drawing.Color]::FromArgb($Alpha,
        [int][Math]::Round($r * 255), [int][Math]::Round($g * 255), [int][Math]::Round($b * 255))
}

function Hue2Rgb {
    param([double]$P, [double]$Q, [double]$T)
    if ($T -lt 0) { $T += 1 }
    if ($T -gt 1) { $T -= 1 }
    if ($T -lt 1.0 / 6.0) { return $P + ($Q - $P) * 6 * $T }
    if ($T -lt 1.0 / 2.0) { return $Q }
    if ($T -lt 2.0 / 3.0) { return $P + ($Q - $P) * (2.0 / 3.0 - $T) * 6 }
    return $P
}

# ==============================================================================
# 2. 牌面（240 x 336）
# ==============================================================================

function New-CardBase {
    <#  卡面底：柔和投影 + 圆角渐变 + 描边 + 顶部柔光  #>
    param(
        [System.Drawing.Graphics]$G, [float]$W, [float]$H,
        [System.Drawing.Color]$TopColor, [System.Drawing.Color]$BottomColor,
        [System.Drawing.Color]$EdgeColor, [int]$Inset = 6
    )
    $rad = $script:CardRadius
    $iw = $W - $Inset * 2
    $ih = $H - $Inset * 2
    Add-SoftShadow -G $G -X $Inset -Y $Inset -W $iw -H $ih -Radius $rad -Steps 6 -Spread 5 -MaxAlpha 44 -Dy 2

    $path = New-RoundedPath -X $Inset -Y $Inset -W $iw -H $ih -Radius $rad
    $br = New-LinearBrush -X $Inset -Y $Inset -W $iw -H $ih -ColorA $TopColor -ColorB $BottomColor -Deg 90
    $G.FillPath($br, $path); $br.Dispose()

    $gh = $ih * 0.42
    $gloss = New-RoundedPath -X ($Inset + 3) -Y ($Inset + 3) -W ($iw - 6) -H $gh -Radius ($rad * 0.8)
    $gbr = New-LinearBrush -X ($Inset + 3) -Y ($Inset + 3) -W ($iw - 6) -H $gh `
        -ColorA ([System.Drawing.Color]::FromArgb(70, 255, 255, 255)) `
        -ColorB ([System.Drawing.Color]::FromArgb(0, 255, 255, 255)) -Deg 90
    $G.FillPath($gbr, $gloss); $gbr.Dispose(); $gloss.Dispose()

    Add-OuterStroke -G $G -Path $path -Color $EdgeColor -Width 2.0
    Add-InnerStroke -G $G -Path $path -X $Inset -Y $Inset -W $iw -H $ih -AlphaTop 200 -AlphaBottom 24 -Width 3.0
    $path.Dispose()
}

function New-CardFront {
    param([string]$SuitKey, [string]$Rank, [string]$Path)

    $suit = $script:Suits[$SuitKey]
    $cc   = $suit.Color
    $sym  = $suit.Sym

    $W = $script:CardW
    $H = $script:CardH
    $canvas = New-G -W $W -H $H
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    New-CardBase -G $g -W $W -H $H -TopColor $script:C.CardTop -BottomColor $script:C.CardBottom -EdgeColor $script:C.CardEdge -Inset 6

    $cx = $W / 2.0

    # ---------- 左上角小号点数 + 花色 ----------
    $fSmall    = New-Font -Size 44 -Style ([System.Drawing.FontStyle]::Bold)
    $fSmallSym = New-Font -Size 32
    $brCorner  = New-Object System.Drawing.SolidBrush($cc)
    Draw-TextCentered -G $g -Text $Rank -Font $fSmall    -Brush $brCorner -CX 40 -CY 46
    Draw-TextCentered -G $g -Text $sym  -Font $fSmallSym -Brush $brCorner -CX 40 -CY 88

    # ---------- 中央大号点数 ----------
    $fBig    = New-Font -Size 124 -Style ([System.Drawing.FontStyle]::Bold)
    $fBigSym = New-Font -Size 96
    $sf      = New-CenteredFormat
    $box     = New-Object System.Drawing.RectangleF(($cx - 400), (138 - 400), 800, 800)
    $bigPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bigPath.AddString($Rank, $script:Family, [int]$fBig.Style, $fBig.Size, $box, $sf)
    $hiR = [Math]::Min(255, [int]$cc.R + 40)
    $hiG = [Math]::Min(255, [int]$cc.G + 40)
    $hiB = [Math]::Min(255, [int]$cc.B + 40)
    $bigBrush = New-LinearBrush -X ($cx - 100) -Y 80 -W 200 -H 130 `
        -ColorA $cc -ColorB ([System.Drawing.Color]::FromArgb(255, $hiR, $hiG, $hiB)) -Deg 90
    $g.FillPath($bigBrush, $bigPath)
    $bigBrush.Dispose(); $bigPath.Dispose(); $sf.Dispose()

    Draw-TextCentered -G $g -Text $sym -Font $fBigSym -Brush $brCorner -CX $cx -CY 236

    $brCorner.Dispose(); $fSmall.Dispose(); $fSmallSym.Dispose(); $fBig.Dispose(); $fBigSym.Dispose()

    # ---------- 右下角倒置点数 + 花色 ----------
    $fSmall2    = New-Font -Size 44 -Style ([System.Drawing.FontStyle]::Bold)
    $fSmallSym2 = New-Font -Size 32
    $brCorner2  = New-Object System.Drawing.SolidBrush($cc)
    Draw-TextRotated180 -G $g -Text $Rank -Font $fSmall2    -Brush $brCorner2 -CX ($W - 40) -CY ($H - 46)
    Draw-TextRotated180 -G $g -Text $sym  -Font $fSmallSym2 -Brush $brCorner2 -CX ($W - 40) -CY ($H - 88)
    $brCorner2.Dispose(); $fSmall2.Dispose(); $fSmallSym2.Dispose()

    Save-Png -Bitmap $bmp -G $g -Path $Path
}

function New-CardJoker {
    param([bool]$Big, [string]$Path)

    if ($Big) {
        $txt = '大王'
        $top = [System.Drawing.Color]::FromArgb(255, 255, 246, 232)
        $bot = [System.Drawing.Color]::FromArgb(255, 255, 222, 196)
        $edge = [System.Drawing.Color]::FromArgb(255, 214, 140, 60)
        $ink  = [System.Drawing.Color]::FromArgb(255, 214, 40, 40)
        $accent = [System.Drawing.Color]::FromArgb(255, 244, 176, 54)
        $sub = 'RED JOKER'
    }
    else {
        $txt = '小王'
        $top = [System.Drawing.Color]::FromArgb(255, 244, 240, 255)
        $bot = [System.Drawing.Color]::FromArgb(255, 222, 218, 244)
        $edge = [System.Drawing.Color]::FromArgb(255, 110, 108, 156)
        $ink  = [System.Drawing.Color]::FromArgb(255, 30, 34, 46)
        $accent = [System.Drawing.Color]::FromArgb(255, 124, 128, 200)
        $sub = 'BLACK JOKER'
    }

    $W = $script:CardW
    $H = $script:CardH
    $canvas = New-G -W $W -H $H
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    New-CardBase -G $g -W $W -H $H -TopColor $top -BottomColor $bot -EdgeColor $edge -Inset 6

    $cx = $W / 2.0

    # 中央圆形徽章
    $badge = New-CirclePath -CX $cx -CY 150 -R 78
    $bb = New-LinearBrush -X ($cx - 78) -Y 72 -W 156 -H 156 `
        -ColorA ([System.Drawing.Color]::FromArgb(80, 255, 255, 255)) `
        -ColorB ([System.Drawing.Color]::FromArgb(30, 255, 255, 255)) -Deg 90
    $g.FillPath($bb, $badge); $bb.Dispose()
    Add-OuterStroke -G $g -Path $badge -Color $accent -Width 4.0
    $badge.Dispose()

    # 四角对称星饰
    $starBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, $accent))
    foreach ($p in @(@(58, 72), @(182, 72), @(58, 228), @(182, 228))) {
        $sp = New-StarPath -CX $p[0] -CY $p[1] -R 15 -Points 4 -InnerRatio 0.34
        $g.FillPath($starBrush, $sp); $sp.Dispose()
    }
    $starBrush.Dispose()

    # 文案
    $fJoker = New-Font -Size 30 -Style ([System.Drawing.FontStyle]::Bold)
    $fMain  = New-Font -Size 76 -Style ([System.Drawing.FontStyle]::Bold)
    $fSub   = New-Font -Size 24 -Style ([System.Drawing.FontStyle]::Bold)
    $brInk  = New-Object System.Drawing.SolidBrush($ink)
    $brAcc  = New-Object System.Drawing.SolidBrush($accent)

    Draw-TextCentered -G $g -Text 'JOKER' -Font $fJoker -Brush $brInk -CX $cx -CY 88
    Draw-TextRotated180 -G $g -Text 'JOKER' -Font $fJoker -Brush $brInk -CX $cx -CY ($H - 88)
    Draw-TextCentered -G $g -Text $txt -Font $fMain -Brush $brInk -CX $cx -CY 152 `
        -ShadowColor ([System.Drawing.Color]::FromArgb(70, 255, 255, 255)) -ShadowDy 2
    Draw-TextCentered -G $g -Text $sub -Font $fSub -Brush $brAcc -CX $cx -CY 268

    $brInk.Dispose(); $brAcc.Dispose()
    $fJoker.Dispose(); $fMain.Dispose(); $fSub.Dispose()

    Save-Png -Bitmap $bmp -G $g -Path $Path
}

# ==============================================================================
# 3. 牌背（240 x 336，三种配色）
# ==============================================================================

function New-CardBack {
    param([int]$Variant, [string]$Path)

    $palettes = @(
        @{ Top = [System.Drawing.Color]::FromArgb(255, 46, 58, 130);  Bot = [System.Drawing.Color]::FromArgb(255, 24, 28, 74)
           A1  = [System.Drawing.Color]::FromArgb(255, 255, 138, 190); A2 = [System.Drawing.Color]::FromArgb(255, 255, 214, 122)
           Edge = [System.Drawing.Color]::FromArgb(255, 160, 176, 240) },
        @{ Top = [System.Drawing.Color]::FromArgb(255, 122, 40, 128); Bot = [System.Drawing.Color]::FromArgb(255, 54, 20, 74)
           A1  = [System.Drawing.Color]::FromArgb(255, 128, 240, 255); A2 = [System.Drawing.Color]::FromArgb(255, 255, 160, 220)
           Edge = [System.Drawing.Color]::FromArgb(255, 226, 160, 246) },
        @{ Top = [System.Drawing.Color]::FromArgb(255, 20, 92, 96);   Bot = [System.Drawing.Color]::FromArgb(255, 10, 44, 56)
           A1  = [System.Drawing.Color]::FromArgb(255, 255, 214, 120); A2 = [System.Drawing.Color]::FromArgb(255, 140, 250, 214)
           Edge = [System.Drawing.Color]::FromArgb(255, 140, 226, 214) }
    )
    $pal = $palettes[($Variant - 1) % 3]

    $W = $script:CardW
    $H = $script:CardH
    $canvas = New-G -W $W -H $H
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    New-CardBase -G $g -W $W -H $H -TopColor $pal.Top -BottomColor $pal.Bot -EdgeColor $pal.Edge -Inset 6

    $cx = $W / 2.0
    $cy = $H / 2.0

    # 内框
    $inner = New-RoundedPath -X 24 -Y 24 -W ($W - 48) -H ($H - 48) -Radius 14
    $ip = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(190, $pal.A2), 3.0)
    $ip.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
    $g.DrawPath($ip, $inner); $ip.Dispose(); $inner.Dispose()

    $penA1 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, $pal.A1), 2.0)
    $penA2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(190, $pal.A2), 2.4)
    $penA2.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    # 四角对称花纹（同一路径旋转 90° 四次）
    $corner = New-FlowerPath -CX $cx -CY 74 -R 30 -Petals 5 -Depth 0.36
    for ($k = 0; $k -lt 4; $k++) {
        $state = $g.Save()
        $g.TranslateTransform($cx, $cy)
        $g.RotateTransform(90.0 * $k)
        $g.TranslateTransform(-$cx, -$cy)
        $g.DrawPath($penA1, $corner)
        $g.Restore($state)
    }
    $corner.Dispose()

    # 中央同心圆 + 大花 + 星核
    foreach ($r in @(62, 50)) {
        $c = New-CirclePath -CX $cx -CY $cy -R $r
        $g.DrawPath($penA1, $c); $c.Dispose()
    }
    $petal = New-FlowerPath -CX $cx -CY $cy -R 46 -Petals 8 -Depth 0.30
    $pb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, $pal.A1))
    $g.FillPath($pb, $petal); $pb.Dispose()
    $g.DrawPath($penA2, $petal); $petal.Dispose()

    $core = New-StarPath -CX $cx -CY $cy -R 24 -Points 8 -InnerRatio 0.46
    $cb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(210, $pal.A2))
    $g.FillPath($cb, $core); $cb.Dispose()
    $g.DrawPath($penA1, $core); $core.Dispose()

    # 菱形链（上下 + 左右，几何对称）
    $db = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(170, $pal.A2))
    Add-DiamondRow -G $g -Brush $db -X 44 -Y 196 -W ($W - 88) -H 22 -Count 5
    Add-DiamondRow -G $g -Brush $db -X 44 -Y 252 -W ($W - 88) -H 22 -Count 5
    Add-DiamondRow -G $g -Brush $db -X 40 -Y 60 -W 20 -H ($H - 120) -Count 6 -Vertical $true
    Add-DiamondRow -G $g -Brush $db -X 180 -Y 60 -W 20 -H ($H - 120) -Count 6 -Vertical $true
    $db.Dispose()

    # 中央上下对称弧线
    for ($i = 1; $i -le 3; $i++) {
        $rr = 46 + $i * 12
        $arc1 = New-Object System.Drawing.Drawing2D.GraphicsPath
        $arc1.AddArc(($cx - $rr), ($cy - $rr * 0.55), ($rr * 2), ($rr * 1.1), 200.0, 140.0)
        $g.DrawPath($penA1, $arc1); $arc1.Dispose()
        $arc2 = New-Object System.Drawing.Drawing2D.GraphicsPath
        $arc2.AddArc(($cx - $rr), ($cy - $rr * 0.55), ($rr * 2), ($rr * 1.1), 20.0, 140.0)
        $g.DrawPath($penA1, $arc2); $arc2.Dispose()
    }

    $penA1.Dispose(); $penA2.Dispose()
    Save-Png -Bitmap $bmp -G $g -Path $Path
}

# ==============================================================================
# 4. 头像（256 x 256，30 张明显可区分）
# ==============================================================================

function New-Avatar {
    param([int]$Index, [string]$Path)

    $W = 256; $H = 256
    $cx = $W / 2.0
    $cy = $H / 2.0
    $R  = 120.0

    # ---- 由索引派生的确定性配色 / 发型，保证 30 张互不相同 ----
    $bgHue   = (($Index - 1) * 37) % 360
    $hairHue = ($Index * 83 + 15) % 360
    $eyeHue  = ($Index * 57 + 200) % 360
    $styleIdx = ($Index - 1) % 6
    $skinTone = 20 + (($Index - 1) % 4) * 3

    $bgC1   = Get-HslColor -H $bgHue -S 0.62 -L 0.86
    $bgC2   = Get-HslColor -H (($bgHue + 42) % 360) -S 0.72 -L 0.58
    $bgC3   = Get-HslColor -H (($bgHue + 320) % 360) -S 0.55 -L 0.42
    $hairA  = Get-HslColor -H $hairHue -S 0.70 -L 0.72
    $hairB  = Get-HslColor -H $hairHue -S 0.78 -L 0.42
    $eyeC   = Get-HslColor -H $eyeHue -S 0.85 -L 0.52
    $eyeC2  = Get-HslColor -H (($eyeHue + 20) % 360) -S 0.95 -L 0.30
    $skin   = Get-HslColor -H $skinTone -S 0.55 -L 0.93
    $skinSh = Get-HslColor -H $skinTone -S 0.60 -L 0.83
    $blush  = Get-HslColor -H 350 -S 0.80 -L 0.78
    $clothA = Get-HslColor -H (($hairHue + 180) % 360) -S 0.55 -L 0.70
    $clothB = Get-HslColor -H (($hairHue + 180) % 360) -S 0.62 -L 0.48

    $canvas = New-G -W $W -H $H
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    Add-SoftShadow -G $g -X ($cx - $R) -Y ($cy - $R) -W ($R * 2) -H ($R * 2) -Radius $R -Steps 6 -Spread 6 -MaxAlpha 50 -Dy 3

    $clip = New-CirclePath -CX $cx -CY $cy -R $R
    $state = $g.Save()
    $g.SetClip($clip)

    # ---- 圆形渐变底（圆外保持透明） ----
    $bgBr = New-LinearBrush -X ($cx - $R) -Y ($cy - $R) -W ($R * 2) -H ($R * 2) -ColorA $bgC1 -ColorB $bgC2 -Deg 115
    $g.FillPath($bgBr, $clip); $bgBr.Dispose()

    # 斜向条纹
    $stripe = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 255, 255, 255))
    for ($i = -6; $i -le 12; $i++) {
        $x0 = $i * 34.0
        $pts = @(
            (New-Object System.Drawing.PointF(($cx + $x0), ($cy - $R))),
            (New-Object System.Drawing.PointF(($cx + $x0 + 14), ($cy - $R))),
            (New-Object System.Drawing.PointF(($cx + $x0 + 74), ($cy + $R))),
            (New-Object System.Drawing.PointF(($cx + $x0 + 60), ($cy + $R)))
        )
        $g.FillPolygon($stripe, $pts)
    }
    $stripe.Dispose()

    # 左上光斑
    $glow = New-RadialBrush -CX ($cx - 34) -CY ($cy - 54) -R 130 `
        -InnerColor ([System.Drawing.Color]::FromArgb(120, 255, 255, 255)) `
        -OuterColor ([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
    $g.FillPath($glow.Brush, $glow.Path); $glow.Brush.Dispose(); $glow.Path.Dispose()

    # 底部弧形色块
    $wave = New-Object System.Drawing.Drawing2D.GraphicsPath
    $wave.AddArc(($cx - $R - 40), ($cy + 6), (($R + 40) * 2), (($R + 40) * 1.6), 200.0, 140.0)
    $wave.CloseFigure()
    $wb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(70, $bgC3))
    $g.FillPath($wb, $wave); $wb.Dispose(); $wave.Dispose()

    # ---- 脖子 + 肩 ----
    $neck = New-RoundedPath -X ($cx - 20) -Y ($cy + 40) -W 40 -H 60 -Radius 14
    $nb = New-Object System.Drawing.SolidBrush($skinSh)
    $g.FillPath($nb, $neck); $nb.Dispose(); $neck.Dispose()

    $body = New-Object System.Drawing.Drawing2D.GraphicsPath
    $body.AddEllipse(($cx - 92), ($cy + 62), 184, 130)
    $bb = New-LinearBrush -X ($cx - 92) -Y ($cy + 62) -W 184 -H 130 -ColorA $clothA -ColorB $clothB -Deg 90
    $g.FillPath($bb, $body); $bb.Dispose()
    $cp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 255, 255, 255), 3.0)
    $g.DrawPath($cp, $body); $cp.Dispose(); $body.Dispose()

    # ---- 后层头发（6 种发型轮廓） ----
    $hairBack = New-Object System.Drawing.Drawing2D.GraphicsPath
    switch ($styleIdx) {
        0 {   # 长直发
            $hairBack.AddEllipse(($cx - 96), ($cy - 100), 192, 200)
            $hairBack.AddRectangle((New-Object System.Drawing.RectangleF(($cx - 96), ($cy - 10), 192, 120)))
        }
        1 {   # 双马尾
            $hairBack.AddEllipse(($cx - 92), ($cy - 96), 184, 186)
            $hairBack.AddEllipse(($cx - 138), ($cy - 40), 52, 118)
            $hairBack.AddEllipse(($cx + 86), ($cy - 40), 52, 118)
        }
        2 {   # 短发波波
            $hairBack.AddEllipse(($cx - 94), ($cy - 98), 188, 178)
        }
        3 {   # 单侧长马尾
            $hairBack.AddEllipse(($cx - 92), ($cy - 96), 184, 180)
            $hairBack.AddEllipse(($cx + 58), ($cy - 30), 62, 150)
        }
        4 {   # 卷发
            $hairBack.AddEllipse(($cx - 98), ($cy - 100), 196, 176)
            foreach ($dx in @(-84, -40, 4, 48)) { $hairBack.AddEllipse(($cx + $dx), ($cy - 26), 46, 46) }
        }
        5 {   # 双丸子头
            $hairBack.AddEllipse(($cx - 90), ($cy - 96), 180, 174)
            $hairBack.AddEllipse(($cx - 122), ($cy - 92), 62, 62)
            $hairBack.AddEllipse(($cx + 60), ($cy - 92), 62, 62)
        }
    }
    $hb = New-LinearBrush -X ($cx - 100) -Y ($cy - 104) -W 200 -H 200 -ColorA $hairB -ColorB $hairA -Deg 110
    $g.FillPath($hb, $hairBack); $hb.Dispose()
    $hp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, $hairB), 3.0)
    $g.DrawPath($hp, $hairBack); $hp.Dispose(); $hairBack.Dispose()

    # ---- 脸 ----
    $face = New-EllipsePath -X ($cx - 70) -Y ($cy - 78) -W 140 -H 152
    $fb = New-LinearBrush -X ($cx - 70) -Y ($cy - 78) -W 140 -H 152 -ColorA $skin -ColorB $skinSh -Deg 90
    $g.FillPath($fb, $face); $fb.Dispose()
    $fp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, $skinSh), 3.0)
    $g.DrawPath($fp, $face); $fp.Dispose(); $face.Dispose()

    # 耳朵
    $eb = New-Object System.Drawing.SolidBrush($skinSh)
    foreach ($sx in @(-1, 1)) {
        $ear = New-EllipsePath -X ($cx + $sx * 68 - 11) -Y ($cy - 6) -W 22 -H 34
        $g.FillPath($eb, $ear); $ear.Dispose()
    }
    $eb.Dispose()

    # ---- 眼睛（大眼 + 双高光 + 睫毛 + 眉毛） ----
    $eyeWhite = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 253, 253, 255))
    $pupilBr  = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 18, 18, 30))
    $hlBr1    = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(245, 255, 255, 255))
    $hlBr2    = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(190, 255, 255, 255))
    $lidPen   = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 46, 32, 40), 5.0)
    $lidPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $lidPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $lashPen  = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 46, 32, 40), 3.0)
    $browPen  = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, $hairB), 4.0)
    $browPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $browPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round

    foreach ($sx in @(-1, 1)) {
        $ex = $cx + $sx * 32.0
        $ey = $cy + 6.0

        $sclera = New-EllipsePath -X ($ex - 13) -Y ($ey - 17) -W 26 -H 34
        $g.FillPath($eyeWhite, $sclera); $sclera.Dispose()

        $iris = New-EllipsePath -X ($ex - 11.5) -Y ($ey - 14.5) -W 23 -H 29
        $ib = New-LinearBrush -X ($ex - 11.5) -Y ($ey - 14.5) -W 23 -H 29 -ColorA $eyeC2 -ColorB $eyeC -Deg 90
        $g.FillPath($ib, $iris); $ib.Dispose(); $iris.Dispose()

        $pupil = New-EllipsePath -X ($ex - 6) -Y ($ey - 7) -W 12 -H 15
        $g.FillPath($pupilBr, $pupil); $pupil.Dispose()

        $hl1 = New-EllipsePath -X ($ex - 12) -Y ($ey - 14) -W 11 -H 12
        $g.FillPath($hlBr1, $hl1); $hl1.Dispose()
        $hl2 = New-EllipsePath -X ($ex + 1) -Y ($ey + 6) -W 6 -H 6
        $g.FillPath($hlBr2, $hl2); $hl2.Dispose()

        $lid = New-Object System.Drawing.Drawing2D.GraphicsPath
        $lid.AddArc(($ex - 15), ($ey - 20), 30, 26, 190.0, 160.0)
        $g.DrawPath($lidPen, $lid); $lid.Dispose()

        $g.DrawLine($lashPen, ($ex + $sx * 13), ($ey - 15), ($ex + $sx * 21), ($ey - 22))
        $g.DrawLine($lashPen, ($ex + $sx * 8), ($ey - 19), ($ex + $sx * 15), ($ey - 26))

        $brow = New-Object System.Drawing.Drawing2D.GraphicsPath
        $brow.AddArc(($ex - 15), ($ey - 34), 30, 20, 200.0, 140.0)
        $g.DrawPath($browPen, $brow); $brow.Dispose()
    }
    $eyeWhite.Dispose(); $pupilBr.Dispose(); $hlBr1.Dispose(); $hlBr2.Dispose()
    $lidPen.Dispose(); $lashPen.Dispose(); $browPen.Dispose()

    # ---- 腮红 ----
    foreach ($sx in @(-1, 1)) {
        $bx = $cx + $sx * 46.0
        $by = $cy + 34.0
        $bl = New-RadialBrush -CX $bx -CY $by -R 20 `
            -InnerColor ([System.Drawing.Color]::FromArgb(150, $blush.R, $blush.G, $blush.B)) `
            -OuterColor ([System.Drawing.Color]::FromArgb(0, $blush.R, $blush.G, $blush.B))
        $g.FillPath($bl.Brush, $bl.Path); $bl.Brush.Dispose(); $bl.Path.Dispose()
    }

    # ---- 鼻子 ----
    $nose = New-Object System.Drawing.Drawing2D.GraphicsPath
    $nose.AddArc(($cx - 5), ($cy + 20), 10, 9, 200.0, 140.0)
    $np = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(130, $skinSh), 3.0)
    $g.DrawPath($np, $nose); $np.Dispose(); $nose.Dispose()

    # ---- 微笑嘴 ----
    $mouth = New-Object System.Drawing.Drawing2D.GraphicsPath
    $mouth.AddArc(($cx - 15), ($cy + 38), 30, 26, 20.0, 140.0)
    $mt = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(120, 214, 96, 110))
    $g.FillPath($mt, $mouth); $mt.Dispose()
    $mp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(225, 150, 62, 74), 4.5)
    $mp.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $mp.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawPath($mp, $mouth); $mp.Dispose(); $mouth.Dispose()

    # ---- 前层刘海（按发型区分） ----
    $bang = New-Object System.Drawing.Drawing2D.GraphicsPath
    switch ($styleIdx) {
        0 { $bang.AddEllipse(($cx - 78), ($cy - 92), 156, 62) }
        1 { $bang.AddEllipse(($cx - 76), ($cy - 94), 152, 58)
            $bang.AddEllipse(($cx - 40), ($cy - 74), 80, 40) }
        2 { $bang.AddEllipse(($cx - 80), ($cy - 92), 160, 54)
            $bang.AddEllipse(($cx - 96), ($cy - 70), 52, 90) }
        3 { $bang.AddEllipse(($cx - 74), ($cy - 96), 148, 60)
            $bang.AddEllipse(($cx + 34), ($cy - 74), 62, 96) }
        4 { $bang.AddEllipse(($cx - 82), ($cy - 92), 164, 56)
            $bang.AddEllipse(($cx - 30), ($cy - 76), 60, 44) }
        5 { $bang.AddEllipse(($cx - 72), ($cy - 98), 144, 56)
            $bang.AddEllipse(($cx - 20), ($cy - 86), 40, 34) }
    }
    $fbb = New-LinearBrush -X ($cx - 96) -Y ($cy - 100) -W 192 -H 110 -ColorA $hairA -ColorB $hairB -Deg 90
    $g.FillPath($fbb, $bang); $fbb.Dispose()
    $fbp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(170, $hairB), 2.6)
    $g.DrawPath($fbp, $bang); $fbp.Dispose()

    # 发丝高光
    $shine = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, 255, 255, 255))
    $g.FillEllipse($shine, ($cx - 52), ($cy - 86), 44, 12)
    $g.FillEllipse($shine, ($cx + 12), ($cy - 80), 26, 9)
    $shine.Dispose()
    $bang.Dispose()

    # ---- 圆形外描边 ----
    $g.Restore($state)
    $ring = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 255, 255, 255), 6.0)
    $g.DrawPath($ring, $clip); $ring.Dispose()
    $crow = New-CirclePath -CX $cx -CY $cy -R ($R - 4)
    $ring2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, $hairB), 2.0)
    $g.DrawPath($ring2, $crow); $ring2.Dispose(); $crow.Dispose()
    $clip.Dispose()

    Save-Png -Bitmap $bmp -G $g -Path $Path
}

# ==============================================================================
# 5. UI 资源
# ==============================================================================

function New-NinePatchButton {
    <#  圆角胶囊按钮底图（九宫格：左右各 96px、上下各 32px 为固定角）  #>
    param(
        [string]$Path,
        [System.Drawing.Color]$TopColor, [System.Drawing.Color]$BottomColor,
        [System.Drawing.Color]$BorderColor, [System.Drawing.Color]$GlowColor
    )
    $W = 384; $H = 128
    $canvas = New-G -W $W -H $H
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    $inset = 6.0
    $iw = $W - $inset * 2
    $ih = $H - $inset * 2
    $rad = $ih / 2.0

    Add-SoftShadow -G $g -X $inset -Y $inset -W $iw -H $ih -Radius $rad -Steps 6 -Spread 5 -MaxAlpha 60 -Dy 3

    [System.Drawing.Drawing2D.GraphicsPath]$path = New-RoundedPath -X $inset -Y $inset -W $iw -H $ih -Radius $rad
    $br = New-LinearBrush -X $inset -Y $inset -W $iw -H $ih -ColorA $TopColor -ColorB $BottomColor -Deg 90
    $g.FillPath($br, $path); $br.Dispose()

    $hlH = $ih * 0.46
    $hl = New-RoundedPath -X ($inset + 4) -Y ($inset + 4) -W ($iw - 8) -H $hlH -Radius ($rad * 0.7)
    $hbr = New-LinearBrush -X ($inset + 4) -Y ($inset + 4) -W ($iw - 8) -H $hlH `
        -ColorA ([System.Drawing.Color]::FromArgb($GlowColor.A, $GlowColor)) `
        -ColorB ([System.Drawing.Color]::FromArgb(0, $GlowColor)) -Deg 90
    $g.FillPath($hbr, $hl); $hbr.Dispose(); $hl.Dispose()

    $bl = New-RoundedPath -X ($inset + 10) -Y ($H - $inset - 24) -W ($iw - 20) -H 16 -Radius 8
    $bbr = New-LinearBrush -X ($inset + 10) -Y ($H - $inset - 24) -W ($iw - 20) -H 16 `
        -ColorA ([System.Drawing.Color]::FromArgb(0, 255, 255, 255)) `
        -ColorB ([System.Drawing.Color]::FromArgb(70, 255, 255, 255)) -Deg 90
    $g.FillPath($bbr, $bl); $bbr.Dispose(); $bl.Dispose()

    Add-OuterStroke -G $g -Path $path -Color $BorderColor -Width 4.0
    Add-InnerStroke -G $g -Path $path -X $inset -Y $inset -W $iw -H $ih -AlphaTop 210 -AlphaBottom 40 -Width 4.0
    $path.Dispose()

    Save-Png -Bitmap $bmp -G $g -Path $Path
}

function New-PanelFrame {
    <#  半透明面板底图（九宫格：四周各 40px 为固定角）  #>
    param([string]$Path)
    $W = 320; $H = 320
    $canvas = New-G -W $W -H $H
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    $inset = 6.0
    $iw = $W - $inset * 2
    $ih = $H - $inset * 2

    Add-SoftShadow -G $g -X $inset -Y $inset -W $iw -H $ih -Radius 40 -Steps 6 -Spread 5 -MaxAlpha 70 -Dy 3

    $path = New-RoundedPath -X $inset -Y $inset -W $iw -H $ih -Radius 40
    $br = New-LinearBrush -X $inset -Y $inset -W $iw -H $ih `
        -ColorA ([System.Drawing.Color]::FromArgb(232, 32, 40, 62)) `
        -ColorB ([System.Drawing.Color]::FromArgb(212, 16, 20, 36)) -Deg 100
    $g.FillPath($br, $path); $br.Dispose()

    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 255, 255, 255), 4.0)
    $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
    $pen.LineJoin  = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($pen, $path); $pen.Dispose()

    $inner = New-RoundedPath -X ($inset + 8) -Y ($inset + 8) -W ($iw - 16) -H ($ih - 16) -Radius 32
    $ip = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 255, 226, 168), 2.0)
    $ip.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
    $g.DrawPath($ip, $inner); $ip.Dispose(); $inner.Dispose()

    Add-InnerStroke -G $g -Path $path -X $inset -Y $inset -W $iw -H $ih -AlphaTop 60 -AlphaBottom 12 -Width 3.0

    # 四角对称暗纹
    $cb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 255, 255, 255))
    foreach ($p in @(@(60, 60), @(($W - 60), 60), @(60, ($H - 60)), @(($W - 60), ($H - 60)))) {
        $sp = New-StarPath -CX $p[0] -CY $p[1] -R 13 -Points 4 -InnerRatio 0.32
        $g.FillPath($cb, $sp); $sp.Dispose()
    }
    $cb.Dispose()
    $path.Dispose()

    Save-Png -Bitmap $bmp -G $g -Path $Path
}

function New-Icon {
    <#  96x96 图标：彩色圆底 + 白色图形  #>
    param([string]$Name, [string]$Path)

    $S = 96
    $cx = 48.0
    $cy = 48.0
    $canvas = New-G -W $S -H $S
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    $tuples = @{
        icon_chat     = @(90, 170, 250)
        icon_shop     = @(255, 176, 60)
        icon_sign     = @(120, 220, 160)
        icon_settings = @(170, 170, 200)
        icon_sound    = @(120, 190, 255)
        icon_mic      = @(255, 120, 150)
        icon_flower   = @(255, 150, 200)
        icon_egg      = @(255, 210, 130)
    }
    $t = $tuples[$Name]
    $dR = [Math]::Max(0, [int]$t[0] - 90)
    $dG = [Math]::Max(0, [int]$t[1] - 90)
    $dB = [Math]::Max(0, [int]$t[2] - 90)

    # 圆形底
    $disc = New-CirclePath -CX $cx -CY $cy -R 45
    $db = New-RadialBrush -CX ($cx - 12) -CY ($cy - 14) -R 70 `
        -InnerColor ([System.Drawing.Color]::FromArgb(235, $t[0], $t[1], $t[2])) `
        -OuterColor ([System.Drawing.Color]::FromArgb(225, $dR, $dG, $dB))
    $g.FillPath($db.Brush, $disc); $db.Brush.Dispose(); $db.Path.Dispose()
    $ringP = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(190, 255, 255, 255), 3.0)
    $g.DrawPath($ringP, $disc); $ringP.Dispose(); $disc.Dispose()

    $white    = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(250, 255, 255, 255))
    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(250, 255, 255, 255), 6.0)
    $whitePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $whitePen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $whitePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $accent   = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $t[0], $t[1], $t[2]))

    switch ($Name) {
        'icon_chat' {
            $bub = New-RoundedPath -X 18 -Y 22 -W 60 -H 44 -Radius 12
            $g.FillPath($white, $bub); $bub.Dispose()
            $tail = @(
                (New-Object System.Drawing.PointF(32, 62)),
                (New-Object System.Drawing.PointF(30, 78)),
                (New-Object System.Drawing.PointF(46, 62))
            )
            $g.FillPolygon($white, $tail)
            foreach ($dx in @(-14, 0, 14)) { $g.FillEllipse($accent, (48 + $dx - 4), 40, 8, 8) }
        }
        'icon_shop' {
            $bag = New-RoundedPath -X 22 -Y 34 -W 52 -H 44 -Radius 8
            $g.FillPath($white, $bag); $bag.Dispose()
            $g.DrawArc($whitePen, 32, 18, 32, 30, 180.0, 180.0)
            $g.FillEllipse($accent, 40, 48, 16, 16)
        }
        'icon_sign' {
            $cal = New-RoundedPath -X 20 -Y 24 -W 56 -H 54 -Radius 10
            $g.FillPath($white, $cal); $cal.Dispose()
            $head = New-RoundedPath -X 20 -Y 24 -W 56 -H 18 -Radius 10
            $g.FillPath($accent, $head); $head.Dispose()
            $g.DrawLine($whitePen, 20, 42, 76, 42)
            $g.DrawLine($whitePen, 34, 16, 34, 28)
            $g.DrawLine($whitePen, 62, 16, 62, 28)
            $g.DrawLine($whitePen, 34, 56, 44, 66)
            $g.DrawLine($whitePen, 44, 66, 64, 46)
        }
        'icon_settings' {
            $gear = New-FlowerPath -CX $cx -CY $cy -R 30 -Petals 10 -Depth 0.22 -Segments 360
            $g.FillPath($white, $gear); $gear.Dispose()
            $hc = New-CirclePath -CX $cx -CY $cy -R 11
            $g.FillPath($accent, $hc); $hc.Dispose()
        }
        'icon_sound' {
            $spk = @(
                (New-Object System.Drawing.PointF(24, 40)),
                (New-Object System.Drawing.PointF(38, 40)),
                (New-Object System.Drawing.PointF(54, 26)),
                (New-Object System.Drawing.PointF(54, 70)),
                (New-Object System.Drawing.PointF(38, 56)),
                (New-Object System.Drawing.PointF(24, 56))
            )
            $g.FillPolygon($white, $spk)
            $g.DrawArc($whitePen, 44, 30, 22, 36, -55.0, 110.0)
            $g.DrawArc($whitePen, 50, 20, 34, 56, -52.0, 104.0)
        }
        'icon_mic' {
            $cap = New-RoundedPath -X 37 -Y 18 -W 22 -H 42 -Radius 11
            $g.FillPath($white, $cap); $cap.Dispose()
            $g.DrawArc($whitePen, 28, 36, 40, 34, 0.0, 180.0)
            $g.DrawLine($whitePen, 48, 68, 48, 78)
            $g.DrawLine($whitePen, 36, 78, 60, 78)
            foreach ($dy in @(0, 10, 20)) { $g.FillEllipse($accent, 44, (26 + $dy), 8, 4) }
        }
        'icon_flower' {
            $petal = New-FlowerPath -CX $cx -CY $cy -R 30 -Petals 6 -Depth 0.38
            $g.FillPath($white, $petal); $petal.Dispose()
            $cc2 = New-CirclePath -CX $cx -CY $cy -R 11
            $g.FillPath($accent, $cc2); $cc2.Dispose()
        }
        'icon_egg' {
            $egg = New-Object System.Drawing.Drawing2D.GraphicsPath
            $egg.AddBezier(48, 18, 68, 40, 74, 54, 74, 62)
            $egg.AddBezier(74, 62, 74, 78, 62, 80, 48, 80)
            $egg.AddBezier(48, 80, 34, 80, 22, 78, 22, 62)
            $egg.AddBezier(22, 62, 22, 54, 28, 40, 48, 18)
            $egg.CloseFigure()
            $g.FillPath($white, $egg); $egg.Dispose()
            $shellPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, $t[0], $t[1], $t[2]), 3.0)
            $g.DrawArc($shellPen, 28, 40, 40, 26, 30.0, 140.0)
            $shellPen.Dispose()
            $shine = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180, 255, 255, 255))
            $g.FillEllipse($shine, 36, 34, 10, 14); $shine.Dispose()
        }
    }

    $white.Dispose(); $whitePen.Dispose(); $accent.Dispose()
    Save-Png -Bitmap $bmp -G $g -Path $Path
}

function New-Logo {
    param([string]$Path)
    $S = 512
    $cx = 256.0
    $cy = 256.0
    $canvas = New-G -W $S -H $S
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    $R = 236.0

    # 外圈柔光
    $glow = New-RadialBrush -CX $cx -CY $cy -R ($R + 14) `
        -InnerColor ([System.Drawing.Color]::FromArgb(90, 255, 226, 140)) `
        -OuterColor ([System.Drawing.Color]::FromArgb(0, 255, 190, 60))
    $g.FillPath($glow.Brush, $glow.Path); $glow.Brush.Dispose(); $glow.Path.Dispose()

    Add-SoftShadow -G $g -X ($cx - $R) -Y ($cy - $R) -W ($R * 2) -H ($R * 2) -Radius $R -Steps 6 -Spread 6 -MaxAlpha 60 -Dy 4

    # 金色徽章底
    $disc = New-CirclePath -CX $cx -CY $cy -R $R
    $db = New-RadialBrush -CX ($cx - 70) -CY ($cy - 90) -R ($R * 1.5) `
        -InnerColor ([System.Drawing.Color]::FromArgb(255, 255, 226, 150)) `
        -OuterColor ([System.Drawing.Color]::FromArgb(255, 214, 118, 26))
    $g.FillPath($db.Brush, $disc); $db.Brush.Dispose(); $db.Path.Dispose()

    $p1 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 250, 224), 10.0)
    $p1.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
    $g.DrawPath($p1, $disc); $p1.Dispose()

    $r2p = New-CirclePath -CX $cx -CY $cy -R ($R - 18)
    $p2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 168, 84, 12), 4.0)
    $p2.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
    $g.DrawPath($p2, $r2p); $p2.Dispose(); $r2p.Dispose()

    # 内侧红盘
    $inner = New-CirclePath -CX $cx -CY $cy -R ($R - 30)
    $ib = New-RadialBrush -CX ($cx - 50) -CY ($cy - 60) -R ($R * 1.2) `
        -InnerColor ([System.Drawing.Color]::FromArgb(255, 226, 62, 62)) `
        -OuterColor ([System.Drawing.Color]::FromArgb(255, 150, 18, 30))
    $g.FillPath($ib.Brush, $inner); $ib.Brush.Dispose(); $ib.Path.Dispose()
    $p3 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 236, 176), 6.0)
    $p3.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
    $g.DrawPath($p3, $inner); $p3.Dispose(); $inner.Dispose()

    # 一圈对称菱形
    $db2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 255, 240, 190))
    for ($k = 0; $k -lt 16; $k++) {
        $a  = $k * (2.0 * [Math]::PI / 16.0)
        $px = $cx + ($R - 12) * [Math]::Cos($a)
        $py = $cy + ($R - 12) * [Math]::Sin($a)
        $pts = @(
            (New-Object System.Drawing.PointF($px, ($py - 9))),
            (New-Object System.Drawing.PointF(($px + 9), $py)),
            (New-Object System.Drawing.PointF($px, ($py + 9))),
            (New-Object System.Drawing.PointF(($px - 9), $py))
        )
        $g.FillPolygon($db2, $pts)
    }
    $db2.Dispose()

    # 中央扇形牌组
    $cardPen  = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 250, 235), 5.0)
    $cardFill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(48, 255, 255, 255))
    foreach ($rot in @(-26, -13, 0, 13, 26)) {
        $state = $g.Save()
        $g.TranslateTransform($cx, ($cy + 104))
        $g.RotateTransform([float]$rot)
        $g.TranslateTransform(-$cx, -($cy + 104))
        $rp = New-RoundedPath -X ($cx - 46) -Y ($cy - 16) -W 92 -H 130 -Radius 12
        $g.FillPath($cardFill, $rp)
        $g.DrawPath($cardPen, $rp)
        $rp.Dispose()
        $g.Restore($state)
    }
    $cardPen.Dispose(); $cardFill.Dispose()

    # "斗地主" 主字样
    $fLogo = New-Font -Size 118 -Style ([System.Drawing.FontStyle]::Bold)
    $fSub  = New-Font -Size 34 -Style ([System.Drawing.FontStyle]::Bold)
    $brW   = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 250, 236))
    Draw-TextCentered -G $g -Text '斗地主' -Font $fLogo -Brush $brW -CX $cx -CY ($cy - 46) `
        -ShadowColor ([System.Drawing.Color]::FromArgb(190, 96, 8, 18)) -ShadowDy 6 -ShadowInflate 5
    $brW.Dispose()

    $brSub = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 226, 168))
    Draw-TextCentered -G $g -Text 'DOU DI ZHU' -Font $fSub -Brush $brSub -CX $cx -CY ($cy + 34)
    $brSub.Dispose()

    $fLogo.Dispose(); $fSub.Dispose()
    Save-Png -Bitmap $bmp -G $g -Path $Path
}

# ==============================================================================
# 6. 特效资源
# ==============================================================================

function New-BombFx {
    param([string]$Path)
    $S = 512
    $cx = 256.0
    $cy = 256.0
    $canvas = New-G -W $S -H $S
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    # 放射光束（16 道，向外渐隐）
    $beams = 16
    for ($i = 0; $i -lt $beams; $i++) {
        $a0   = $i * (360.0 / $beams)
        $wide = 11.0
        $pts = @(
            (New-Object System.Drawing.PointF($cx, $cy)),
            (New-Object System.Drawing.PointF(
                [float]($cx + 250 * [Math]::Cos(($a0 - $wide) * [Math]::PI / 180)),
                [float]($cy + 250 * [Math]::Sin(($a0 - $wide) * [Math]::PI / 180)))),
            (New-Object System.Drawing.PointF(
                [float]($cx + 250 * [Math]::Cos(($a0 + $wide) * [Math]::PI / 180)),
                [float]($cy + 250 * [Math]::Sin(($a0 + $wide) * [Math]::PI / 180))))
        )
        $bp = New-Object System.Drawing.Drawing2D.GraphicsPath
        $bp.AddPolygon($pts)
        $bb = New-LinearBrush -X ($cx - 250) -Y ($cy - 250) -W 500 -H 500 `
            -ColorA ([System.Drawing.Color]::FromArgb(235, 255, 214, 64)) `
            -ColorB ([System.Drawing.Color]::FromArgb(0, 255, 110, 20)) -Deg ([float]$a0)
        $g.FillPath($bb, $bp); $bb.Dispose(); $bp.Dispose()
    }

    # 火球（多层径向叠加）
    $layers = @(
        @{ R = 200; A = 90;  Col = @(255, 140, 30) },
        @{ R = 160; A = 150; Col = @(255, 190, 60) },
        @{ R = 122; A = 210; Col = @(255, 232, 130) },
        @{ R = 84;  A = 245; Col = @(255, 252, 214) }
    )
    foreach ($l in $layers) {
        $lay = New-RadialBrush -CX $cx -CY $cy -R $l.R `
            -InnerColor ([System.Drawing.Color]::FromArgb($l.A, $l.Col[0], $l.Col[1], $l.Col[2])) `
            -OuterColor ([System.Drawing.Color]::FromArgb(0, $l.Col[0], $l.Col[1], $l.Col[2]))
        $g.FillPath($lay.Brush, $lay.Path); $lay.Brush.Dispose(); $lay.Path.Dispose()
    }

    # 冲击环
    foreach ($rr in @(216, 232)) {
        $ring = New-CirclePath -CX $cx -CY $cy -R $rr
        $rp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, 255, 236, 150), 6.0)
        $g.DrawPath($rp, $ring); $rp.Dispose(); $ring.Dispose()
    }

    # 火星（对称分布）
    $sparkBr = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 255, 244, 190))
    for ($i = 0; $i -lt 12; $i++) {
        $a  = $i * 30.0 + 15.0
        $rr = 176.0 + (($i % 3) * 22.0)
        $px = $cx + $rr * [Math]::Cos($a * [Math]::PI / 180)
        $py = $cy + $rr * [Math]::Sin($a * [Math]::PI / 180)
        $sp = New-StarPath -CX $px -CY $py -R 18 -Points 4 -InnerRatio 0.30 -Rotation ($a + 45)
        $g.FillPath($sparkBr, $sp); $sp.Dispose()
    }
    $sparkBr.Dispose()

    Save-Png -Bitmap $bmp -G $g -Path $Path
}

function New-SpringBanner {
    param([string]$Path)
    $W = 1024; $H = 256
    $canvas = New-G -W $W -H $H
    $bmp = $canvas.Bitmap
    $g   = $canvas.G
    $cx = $W / 2.0
    $cy = $H / 2.0

    # 横幅底（圆角 + 横向渐变）
    $bar = New-RoundedPath -X 8 -Y 42 -W ($W - 16) -H ($H - 84) -Radius 40
    $bb = New-LinearBrush -X 8 -Y 42 -W ($W - 16) -H ($H - 84) `
        -ColorA ([System.Drawing.Color]::FromArgb(242, 255, 214, 120)) `
        -ColorB ([System.Drawing.Color]::FromArgb(242, 255, 108, 96)) -Deg 0
    $g.FillPath($bb, $bar); $bb.Dispose()

    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 252, 232), 8.0)
    $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
    $pen.LineJoin  = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($pen, $bar); $pen.Dispose()

    $inner = New-RoundedPath -X 20 -Y 54 -W ($W - 40) -H ($H - 108) -Radius 30
    $ip = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(150, 198, 46, 40), 3.0)
    $ip.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
    $g.DrawPath($ip, $inner); $ip.Dispose(); $inner.Dispose()

    # 顶部高光
    $hl = New-RoundedPath -X 20 -Y 52 -W ($W - 40) -H 44 -Radius 22
    $hb = New-LinearBrush -X 20 -Y 52 -W ($W - 40) -H 44 `
        -ColorA ([System.Drawing.Color]::FromArgb(120, 255, 255, 255)) `
        -ColorB ([System.Drawing.Color]::FromArgb(0, 255, 255, 255)) -Deg 90
    $g.FillPath($hb, $hl); $hb.Dispose(); $hl.Dispose()

    # 左右对称花饰
    $dec    = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 255, 246, 200))
    $nodeBr = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 226, 62, 62))
    foreach ($sx in @(-1, 1)) {
        $px = $cx + $sx * 360.0
        $fl = New-FlowerPath -CX $px -CY $cy -R 40 -Petals 6 -Depth 0.34
        $g.FillPath($dec, $fl); $fl.Dispose()
        $fc = New-CirclePath -CX $px -CY $cy -R 15
        $g.FillPath($nodeBr, $fc); $fc.Dispose()
        for ($k = 0; $k -lt 3; $k++) {
            $lx = $px + $sx * (58 + $k * 34)
            $leaf = New-FlowerPath -CX $lx -CY ($cy + ($k - 1) * 26) -R (18 - $k * 3) -Petals 4 -Depth 0.30
            $g.FillPath($dec, $leaf); $leaf.Dispose()
        }
        $st = New-StarPath -CX ($px + $sx * 210) -CY ($cy - 34) -R 16 -Points 5
        $g.FillPath($dec, $st); $st.Dispose()
    }
    $dec.Dispose(); $nodeBr.Dispose()

    # "春天" 主文案
    $fBig = New-Font -Size 132 -Style ([System.Drawing.FontStyle]::Bold)
    $fSub = New-Font -Size 32 -Style ([System.Drawing.FontStyle]::Bold)
    $brT  = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 252, 240))
    Draw-TextCentered -G $g -Text '春天' -Font $fBig -Brush $brT -CX $cx -CY $cy `
        -ShadowColor ([System.Drawing.Color]::FromArgb(200, 150, 24, 24)) -ShadowDy 7 -ShadowInflate 6
    $brT.Dispose()

    $brS = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 255, 240, 210))
    Draw-TextCentered -G $g -Text 'SPRING' -Font $fSub -Brush $brS -CX $cx -CY ($cy + 78)
    $brS.Dispose()
    $fBig.Dispose(); $fSub.Dispose()

    Save-Png -Bitmap $bmp -G $g -Path $Path
}

function New-Particle {
    <#  $Kind: star = 星点, petal = 花瓣  #>
    param([string]$Kind, [string]$Path)
    $S = 64
    $cx = 32.0
    $cy = 32.0
    $canvas = New-G -W $S -H $S
    $bmp = $canvas.Bitmap
    $g   = $canvas.G

    if ($Kind -eq 'star') {
        $soft = New-RadialBrush -CX $cx -CY $cy -R 30 `
            -InnerColor ([System.Drawing.Color]::FromArgb(150, 255, 255, 255)) `
            -OuterColor ([System.Drawing.Color]::FromArgb(0, 255, 240, 250))
        $g.FillPath($soft.Brush, $soft.Path); $soft.Brush.Dispose(); $soft.Path.Dispose()

        $outer = New-StarPath -CX $cx -CY $cy -R 26 -Points 4 -InnerRatio 0.16
        $ob = New-LinearBrush -X 6 -Y 6 -W 52 -H 52 `
            -ColorA ([System.Drawing.Color]::FromArgb(240, 255, 255, 255)) `
            -ColorB ([System.Drawing.Color]::FromArgb(200, 255, 214, 236)) -Deg 90
        $g.FillPath($ob, $outer); $ob.Dispose(); $outer.Dispose()

        $core = New-StarPath -CX $cx -CY $cy -R 13 -Points 4 -InnerRatio 0.22
        $cb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(250, 255, 255, 255))
        $g.FillPath($cb, $core); $cb.Dispose(); $core.Dispose()
    }
    else {
        $soft = New-RadialBrush -CX $cx -CY $cy -R 30 `
            -InnerColor ([System.Drawing.Color]::FromArgb(130, 255, 235, 245)) `
            -OuterColor ([System.Drawing.Color]::FromArgb(0, 255, 200, 225))
        $g.FillPath($soft.Brush, $soft.Path); $soft.Brush.Dispose(); $soft.Path.Dispose()

        $petal = New-FlowerPath -CX $cx -CY $cy -R 27 -Petals 5 -Depth 0.36 -Segments 300
        $pb = New-LinearBrush -X 5 -Y 5 -W 54 -H 54 `
            -ColorA ([System.Drawing.Color]::FromArgb(235, 255, 255, 255)) `
            -ColorB ([System.Drawing.Color]::FromArgb(215, 255, 190, 220)) -Deg 100
        $g.FillPath($pb, $petal); $pb.Dispose()
        $pp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(170, 255, 255, 255), 2.0)
        $g.DrawPath($pp, $petal); $pp.Dispose(); $petal.Dispose()

        $inner = New-FlowerPath -CX $cx -CY $cy -R 15 -Petals 5 -Depth 0.34 -Segments 300
        $ib = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 255, 255, 255))
        $g.FillPath($ib, $inner); $ib.Dispose(); $inner.Dispose()

        $cc = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 255, 208, 228))
        $ccp = New-CirclePath -CX $cx -CY $cy -R 6
        $g.FillPath($cc, $ccp); $cc.Dispose(); $ccp.Dispose()
    }

    Save-Png -Bitmap $bmp -G $g -Path $Path
}

# ==============================================================================
# 7. 生成主流程
# ==============================================================================

function Get-TreeSummary {
    param([string]$Base)
    $rows = New-Object 'System.Collections.Generic.List[object]'
    $dirs = @(Get-Item -LiteralPath $Base) + @(Get-ChildItem -LiteralPath $Base -Directory -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName)
    foreach ($d in $dirs) {
        $n = @(Get-ChildItem -LiteralPath $d.FullName -File -Filter *.png -ErrorAction SilentlyContinue).Count
        $rows.Add([pscustomobject]@{
            Dir   = $d.FullName.Substring($Base.Length).TrimStart('\', '/')
            Count = $n
        })
    }
    return $rows
}

Write-Host ''
Write-Host '======================================================================' -ForegroundColor DarkCyan
Write-Host ' 斗地主占位贴图批量生成 (PowerShell + System.Drawing)' -ForegroundColor Cyan
Write-Host '======================================================================' -ForegroundColor DarkCyan
Write-Host (" 资源输出目录 : {0}" -f $script:Root)
Write-Host (" 字体         : {0}" -f $script:FamilyName)
Write-Host (" 生成分组     : {0}" -f $Group)
Write-Host ''

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$made = 0

if ($Group -eq 'cards' -or ($Group -eq 'all' -and $GenerateCards)) {
    $frontDir = Join-Path $script:Root 'cards\front'
    $null = New-Item -ItemType Directory -Path $frontDir -Force
    Write-Host '[1/5] 牌面 cards/front (54 张, 240x336) ...' -ForegroundColor Yellow
    foreach ($sk in @('S', 'H', 'C', 'D')) {
        foreach ($r in $script:Ranks) {
            New-CardFront -SuitKey $sk -Rank $r -Path (Join-Path $frontDir ("{0}_{1}.png" -f $sk, $r))
            $made++
        }
    }
    New-CardJoker -Big $false -Path (Join-Path $frontDir 'joker_s.png'); $made++
    New-CardJoker -Big $true  -Path (Join-Path $frontDir 'joker_b.png'); $made++
    Write-Host ("      完成 {0} 张" -f (@(Get-ChildItem -LiteralPath $frontDir -File -Filter *.png).Count)) -ForegroundColor Green
}
else { Write-Host '[1/5] 跳过 cards/front' -ForegroundColor DarkGray }

if ($Group -eq 'all' -or $Group -eq 'back') {
    $backDir = Join-Path $script:Root 'cards\back'
    $null = New-Item -ItemType Directory -Path $backDir -Force
    Write-Host '[2/5] 牌背 cards/back (3 张, 240x336) ...' -ForegroundColor Yellow
    for ($v = 1; $v -le 3; $v++) {
        New-CardBack -Variant $v -Path (Join-Path $backDir ("back_{0:00}.png" -f $v))
        $made++
    }
    Write-Host ("      完成 {0} 张" -f (@(Get-ChildItem -LiteralPath $backDir -File -Filter *.png).Count)) -ForegroundColor Green
}
else { Write-Host '[2/5] 跳过 cards/back' -ForegroundColor DarkGray }

if ($Group -eq 'all' -or $Group -eq 'avatars') {
    # 头像单独放在项目根的 image/ 里：这里的文件就是"拿来替换成真实头像"的，
    # 任意尺寸/任意长宽比都行，界面上按居中裁剪的正方形显示（CSS 再裁成圆形）。
    $avDir = Join-Path (Split-Path -Parent $script:Root) 'image'
    $null = New-Item -ItemType Directory -Path $avDir -Force
    Write-Host '[3/5] 头像 image (30 张, 256x256) ...' -ForegroundColor Yellow
    for ($i = 1; $i -le 30; $i++) {
        New-Avatar -Index $i -Path (Join-Path $avDir ("avatar_{0:00}.png" -f $i))
        $made++
    }
    Write-Host ("      完成 {0} 张" -f (@(Get-ChildItem -LiteralPath $avDir -File -Filter *.png).Count)) -ForegroundColor Green
}
else { Write-Host '[3/5] 跳过 avatars' -ForegroundColor DarkGray }

if ($Group -eq 'all' -or $Group -eq 'ui') {
    $uiDir = Join-Path $script:Root 'ui'
    $null = New-Item -ItemType Directory -Path $uiDir -Force
    Write-Host '[4/5] UI 资源 ui (13 张) ...' -ForegroundColor Yellow

    New-Logo -Path (Join-Path $uiDir 'logo.png'); $made++
    New-NinePatchButton -Path (Join-Path $uiDir 'btn_primary.png') `
        -TopColor ([System.Drawing.Color]::FromArgb(255, 96, 176, 255)) `
        -BottomColor ([System.Drawing.Color]::FromArgb(255, 34, 96, 214)) `
        -BorderColor ([System.Drawing.Color]::FromArgb(240, 22, 66, 158)) `
        -GlowColor ([System.Drawing.Color]::FromArgb(120, 255, 255, 255)); $made++
    New-NinePatchButton -Path (Join-Path $uiDir 'btn_secondary.png') `
        -TopColor ([System.Drawing.Color]::FromArgb(255, 206, 214, 230)) `
        -BottomColor ([System.Drawing.Color]::FromArgb(255, 132, 144, 168)) `
        -BorderColor ([System.Drawing.Color]::FromArgb(240, 84, 94, 116)) `
        -GlowColor ([System.Drawing.Color]::FromArgb(110, 255, 255, 255)); $made++
    New-NinePatchButton -Path (Join-Path $uiDir 'btn_danger.png') `
        -TopColor ([System.Drawing.Color]::FromArgb(255, 255, 122, 116)) `
        -BottomColor ([System.Drawing.Color]::FromArgb(255, 206, 40, 52)) `
        -BorderColor ([System.Drawing.Color]::FromArgb(240, 148, 20, 30)) `
        -GlowColor ([System.Drawing.Color]::FromArgb(120, 255, 255, 255)); $made++
    New-PanelFrame -Path (Join-Path $uiDir 'panel_frame.png'); $made++

    foreach ($ic in @('icon_chat', 'icon_shop', 'icon_sign', 'icon_settings', 'icon_sound', 'icon_mic', 'icon_flower', 'icon_egg')) {
        New-Icon -Name $ic -Path (Join-Path $uiDir ("$ic.png")); $made++
    }
    Write-Host ("      完成 {0} 张" -f (@(Get-ChildItem -LiteralPath $uiDir -File -Filter *.png).Count)) -ForegroundColor Green
}
else { Write-Host '[4/5] 跳过 ui' -ForegroundColor DarkGray }

if ($Group -eq 'all' -or $Group -eq 'fx') {
    $fxDir = Join-Path $script:Root 'fx'
    $null = New-Item -ItemType Directory -Path $fxDir -Force
    Write-Host '[5/5] 特效 fx (4 张) ...' -ForegroundColor Yellow
    New-BombFx       -Path (Join-Path $fxDir 'bomb.png'); $made++
    New-SpringBanner -Path (Join-Path $fxDir 'spring.png'); $made++
    New-Particle -Kind 'star'  -Path (Join-Path $fxDir 'particle_01.png'); $made++
    New-Particle -Kind 'petal' -Path (Join-Path $fxDir 'particle_02.png'); $made++
    Write-Host ("      完成 {0} 张" -f (@(Get-ChildItem -LiteralPath $fxDir -File -Filter *.png).Count)) -ForegroundColor Green
}
else { Write-Host '[5/5] 跳过 fx' -ForegroundColor DarkGray }

$sw.Stop()

# ==============================================================================
# 8. 统计输出
# ==============================================================================

Write-Host ''
Write-Host '----------------------------------------------------------------------' -ForegroundColor DarkCyan
Write-Host ' 目录统计' -ForegroundColor Cyan
Write-Host '----------------------------------------------------------------------' -ForegroundColor DarkCyan

foreach ($row in (Get-TreeSummary -Base $script:Root)) {
    $label = if ([string]::IsNullOrEmpty($row.Dir)) { '(root)' } else { $row.Dir }
    Write-Host ("  {0,-20} {1,4} 个 PNG" -f $label, $row.Count)
}

$all = @(Get-ChildItem -LiteralPath $script:Root -Recurse -File -Filter *.png -ErrorAction SilentlyContinue)
$bytes = ($all | Measure-Object -Property Length -Sum).Sum

Write-Host '----------------------------------------------------------------------' -ForegroundColor DarkCyan
Write-Host ("  本次生成/覆盖        : {0} 张" -f $made)
Write-Host ("  PNG 总数             : {0} 张" -f $all.Count)
Write-Host ("  总体积               : {0:N2} MB" -f ($bytes / 1MB))
Write-Host ("  耗时                 : {0:N2} 秒" -f $sw.Elapsed.TotalSeconds)
Write-Host '======================================================================' -ForegroundColor DarkCyan
Write-Host ''

if ($Group -eq 'all' -and $all.Count -lt 104) {
    Write-Warning ("PNG 数量少于预期 104 张（当前 {0} 张）" -f $all.Count)
}
