"""占位 PWA 图标（TODO：换成正式图标）。

生成 remote-web/public/icon-192.png 与 icon-512.png：
深色底（#0f1013，等于 styles.css 深色档的 --bg）+ 强调色 #6b86ff 的 ">" + 白横杠。

用法（需要 Pillow；产物落在 public/ 下，本脚本不参与构建）：
    cd remote-web/public && python ../tools/make-icons.py
"""

from PIL import Image, ImageDraw

ACCENT = (107, 134, 255, 255)
FOREGROUND = (232, 234, 240, 255)
BACKGROUND = (15, 16, 19, 255)


def make_icon(size):
    unit = size / 32
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(7 * unit), fill=BACKGROUND)
    draw.line(
        [(10 * unit, 8 * unit), (20 * unit, 16 * unit), (10 * unit, 24 * unit)],
        fill=ACCENT,
        width=max(2, int(3.4 * unit)),
        joint="curve",
    )
    draw.rounded_rectangle(
        [21.4 * unit, 21.4 * unit, 26.5 * unit, 24.2 * unit],
        radius=max(1, int(1.3 * unit)),
        fill=FOREGROUND,
    )
    return image


if __name__ == "__main__":
    for size in (192, 512):
        make_icon(size).save(f"icon-{size}.png")
        print(f"icon-{size}.png")
