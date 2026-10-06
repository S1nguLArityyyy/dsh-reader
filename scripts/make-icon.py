"""生成应用图标（build/icon.ico / build/icon.png）。

用法：python scripts/make-icon.py
依赖：Pillow
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw

SIZE = 1024
BLUE_TOP = (86, 146, 238)
BLUE_BOTTOM = (43, 92, 200)


def rounded_gradient(size: int) -> Image.Image:
    """蓝色渐变圆角方块底"""
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(size):
        t = y / (size - 1)
        color = tuple(
            int(BLUE_TOP[i] + (BLUE_BOTTOM[i] - BLUE_TOP[i]) * t) for i in range(3)
        )
        for x in range(size):
            px[x, y] = (*color, 255)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255
    )
    base.paste(grad, (0, 0), mask)
    return base


def draw_book(img: Image.Image, size: int) -> None:
    """在中间画一本摊开的书"""
    d = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2
    w = size * 0.50          # 整本书宽度
    h = size * 0.36          # 书页高度
    gap = size * 0.035       # 中缝
    lean = size * 0.035      # 两侧上翘

    left = [
        (cx - gap, cy - h / 2 + lean),
        (cx - w / 2, cy - h / 2 - lean * 0.4),
        (cx - w / 2, cy + h / 2 - lean * 0.4),
        (cx - gap, cy + h / 2 + lean),
    ]
    right = [
        (cx + gap, cy - h / 2 + lean),
        (cx + w / 2, cy - h / 2 - lean * 0.4),
        (cx + w / 2, cy + h / 2 - lean * 0.4),
        (cx + gap, cy + h / 2 + lean),
    ]
    d.polygon(left, fill=(255, 255, 255, 255))
    d.polygon(right, fill=(255, 255, 255, 255))

    # 书脊阴影，增加层次
    spine_w = size * 0.012
    d.rectangle(
        [cx - spine_w, cy - h / 2 + lean, cx + spine_w, cy + h / 2 + lean],
        fill=(214, 228, 250, 255),
    )

    # 文字线条
    line_color = (150, 180, 225, 255)
    for i in range(3):
        y = cy - h * 0.18 + i * h * 0.22
        d.line(
            [(cx - w * 0.40, y + lean * 0.2), (cx - gap - size * 0.022, y)],
            fill=line_color,
            width=max(2, int(size * 0.016)),
        )
        d.line(
            [(cx + gap + size * 0.022, y), (cx + w * 0.40, y + lean * 0.2)],
            fill=line_color,
            width=max(2, int(size * 0.016)),
        )


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "build")
    os.makedirs(out_dir, exist_ok=True)

    img = rounded_gradient(SIZE)
    draw_book(img, SIZE)

    png_path = os.path.join(out_dir, "icon.png")
    img.save(png_path)

    ico_path = os.path.join(out_dir, "icon.ico")
    img.save(
        ico_path,
        format="ICO",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )
    print(f"已生成：{png_path}")
    print(f"已生成：{ico_path}")


if __name__ == "__main__":
    main()
