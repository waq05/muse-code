# dsc desktop icon: white rounded square + DeepSeek-blue dolphin silhouette
# (single-color animal silhouette style, like the DeepSeek orca mark).
# Body = closed cardinal spline (no fold-backs); fins = sharp polygons overlaid.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-icon.ps1 [-OutPath <png>]
param(
    [string]$OutPath = (Join-Path $PSScriptRoot "..\build\icon.png")
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 256
$blue = [System.Drawing.Color]::FromArgb(255, 0x4D, 0x6B, 0xFE)   # DeepSeek blue

$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# ---- white rounded square background ----
$radius = 58
$bg = New-Object System.Drawing.Drawing2D.GraphicsPath
$bg.AddArc(0, 0, $radius, $radius, 180, 90)
$bg.AddArc($size - $radius, 0, $radius, $radius, 270, 90)
$bg.AddArc($size - $radius, $size - $radius, $radius, $radius, 0, 90)
$bg.AddArc(0, $size - $radius, $radius, $radius, 90, 90)
$bg.CloseFigure()
$g.FillPath([System.Drawing.Brushes]::White, $bg)

function PointF([float]$x, [float]$y) {
    New-Object System.Drawing.PointF($x, $y)
}

$brush = New-Object System.Drawing.SolidBrush($blue)

# ---- body: closed spline, clockwise from snout tip (no fold-backs) ----
$body = New-Object System.Drawing.Drawing2D.GraphicsPath
$body.AddClosedCurve([System.Drawing.PointF[]]@(
    (PointF 224 94), (PointF 202 86), (PointF 186 82),   # snout -> beak crease
    (PointF 164 58), (PointF 140 50),                     # melon -> head top
    (PointF 112 52), (PointF 88 60), (PointF 66 76),      # back
    (PointF 54 96), (PointF 50 110), (PointF 52 118),     # tail stock (narrow)
    (PointF 58 124), (PointF 92 130), (PointF 114 130),   # belly line
    (PointF 138 122), (PointF 160 108), (PointF 188 98)   # throat -> jaw
), 0.2)
$body.CloseFigure()
$g.FillPath($brush, $body)
$body.Dispose()

# ---- tail flukes: two lobes as sharp polygon ----
$tail = New-Object System.Drawing.Drawing2D.GraphicsPath
$tail.AddPolygon([System.Drawing.PointF[]]@(
    (PointF 56 104),   # stock top root
    (PointF 26 88),    # upper lobe tip
    (PointF 44 108),   # inner notch
    (PointF 38 118),   # fork gap
    (PointF 24 154),   # lower lobe tip
    (PointF 58 122)    # stock bottom root
))
$g.FillPath($brush, $tail)
$tail.Dispose()

# ---- dorsal fin: crescent polygon (concave rear edge), root buried in body ----
$fin = New-Object System.Drawing.Drawing2D.GraphicsPath
$fin.AddPolygon([System.Drawing.PointF[]]@(
    (PointF 114 58),
    (PointF 104 26),
    (PointF 90 22),
    (PointF 86 40),
    (PointF 76 60)
))
$g.FillPath($brush, $fin)
$fin.Dispose()

# ---- pectoral fin: small polygon reaching down-back, root buried in belly ----
$pect = New-Object System.Drawing.Drawing2D.GraphicsPath
$pect.AddPolygon([System.Drawing.PointF[]]@(
    (PointF 116 118),
    (PointF 132 148),
    (PointF 142 160),
    (PointF 146 144),
    (PointF 140 120)
))
$g.FillPath($brush, $pect)
$pect.Dispose()

# ---- eye: white dot at the melon base above beak crease ----
$eyeBrush = [System.Drawing.Brushes]::White
$g.FillEllipse($eyeBrush, 168, 80, 9, 9)

$g.Dispose()
$dir = Split-Path $OutPath -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "icon saved: $OutPath"
