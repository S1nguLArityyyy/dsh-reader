"""生成应用图标（build/icon.ico / build/icon.png）。

用法：python scripts/make-icon.py [源图路径]
默认从 assets/icon-source.png 读取，把白色背景做成透明后输出多尺寸 ico。

依赖：Pillow、numpy
"""

from __future__ import annotations

import os
import sys
from collections import deque

import numpy as np
from PIL import Image

SIZE = 1024
WHITE_THRESHOLD = 236


def strip_white_background(img: Image.Image) -> Image.Image:
    """把与四边连通的白色区域变透明（角色内部的白色部分不受影响）"""
    arr = np.array(img.convert("RGBA"))
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3].astype(np.int16)
    near_white = (rgb >= WHITE_THRESHOLD).all(axis=2)

    visited = np.zeros((h, w), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def push(y: int, x: int) -> None:
        if 0 <= y < h and 0 <= x < w and near_white[y, x] and not visited[y, x]:
            visited[y, x] = True
            queue.append((y, x))

    for x in range(w):
        push(0, x)
        push(h - 1, x)
    for y in range(h):
        push(y, 0)
        push(y, w - 1)

    while queue:
        y, x = queue.popleft()
        push(y - 1, x)
        push(y + 1, x)
        push(y, x - 1)
        push(y, x + 1)

    arr[:, :, 3] = np.where(visited, 0, arr[:, :, 3])

    # 让边缘的白色过渡像素半透明，缩放后不会留下白边
    edge = np.zeros((h, w), dtype=bool)
    edge[1:, :] |= visited[:-1, :]
    edge[:-1, :] |= visited[1:, :]
    edge[:, 1:] |= visited[:, :-1]
    edge[:, :-1] |= visited[:, 1:]
    fringe = edge & ~visited & (rgb.min(axis=2) >= 200)
    arr[:, :, 3] = np.where(fringe, 120, arr[:, :, 3])

    return Image.fromarray(arr, "RGBA")


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    source = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "assets", "icon-source.png")
    out_dir = os.path.join(root, "build")
    os.makedirs(out_dir, exist_ok=True)

    if not os.path.exists(source):
        raise SystemExit(f"找不到源图：{source}")

    img = Image.open(source).convert("RGBA")
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    img = strip_white_background(img)

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
