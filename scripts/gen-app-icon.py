# -*- coding: utf-8 -*-
"""生成青鸟桌面图标源图（1024x1024 PNG，透明底）。

设计来源：应用内朱砂「青」印（DESIGN.md §4 seal-btn / mockup-v2）。
- 底：朱砂 #B3483A 圆角方（radius 比例 0.214，与 21px 印章的 4.5px 同源）
- 内描边：rgba(255,255,255,.18)，对应 CSS inset box-shadow
- 字：思源宋体 Bold（内置 woff2 转ttf，与界面同源）「青」，暖白 #F9F3EA
- 打斜：整印顺时针倾斜（CSS rotate(-3deg) 同向），打破四方正置惯例
输出：docs/redesign/app-icon.png（1024x1024，留透明边距供旋转与圆角安全区）
"""
import io
import os

from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

ROOT = r"F:/AIwork/qingbird-md-rust"
WOFF2 = os.path.join(ROOT, "src/assets/fonts/SourceHanSerifSC-700.woff2")
OUT = os.path.join(ROOT, "docs/redesign/app-icon.png")

S = 1024            # 画布
SEAL = 880          # 印章边长（留边距：旋转 + 平台圆角裁切安全区）
RADIUS = int(SEAL * 0.214)  # 与应用内印章 4.5/21 同比例
BG = (179, 72, 58, 255)      # --zhu #B3483A
FG = (249, 243, 234, 255)    # --surface 暖白
STROKE = (255, 255, 255, 46) # rgba(255,255,255,.18) 内描边
TILT = 4.0                   # 顺时针倾斜度数（CSS rotate(-4deg) 同视觉）

# ---- woff2 → ttf（内存），并验证「青」(U+9752) 在子集里 ----
font_tt = TTFont(io.BytesIO(open(WOFF2, "rb").read()))
cmap = font_tt.getBestCmap()
assert ord("青") in cmap, "subset 缺「青」字形！"
buf = io.BytesIO()
font_tt.flavor = None
font_tt.save(buf)
buf.seek(0)

# ---- 印章图层（正置绘制，最后整体旋转）----
seal = Image.new("RGBA", (SEAL, SEAL), (0, 0, 0, 0))
d = ImageDraw.Draw(seal)
d.rounded_rectangle([0, 0, SEAL - 1, SEAL - 1], radius=RADIUS, fill=BG)
# 内描边：inset 约 0.8% 边长，宽约 0.5%
inset = int(SEAL * 0.008)
d.rounded_rectangle(
    [inset, inset, SEAL - 1 - inset, SEAL - 1 - inset],
    radius=RADIUS - inset,
    outline=STROKE,
    width=max(3, int(SEAL * 0.005)),
)

# ---- 「青」字：居中，字号 ≈ 0.56 印章边长（与应用内 12/21 同比例）----
size = int(SEAL * 0.56)
font = ImageFont.truetype(buf, size)
# 精确居中：用 font bbox 而非经验值
left, top, right, bottom = d.textbbox((0, 0), "青", font=font)
w, h = right - left, bottom - top
d.text(((SEAL - w) / 2 - left, (SEAL - h) / 2 - top), "青", font=font, fill=FG)

# ---- 打斜：PIL rotate 正角 = 逆时针；CSS rotate(-4deg) = 逆时针 4°，同向 ----
seal = seal.rotate(TILT, resample=Image.BICUBIC, expand=True)

# ---- 贴到透明画布中心 ----
canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
px = (S - seal.width) // 2
py = (S - seal.height) // 2
canvas.alpha_composite(seal, (px, py))
canvas.save(OUT)
print("saved:", OUT, canvas.size)
