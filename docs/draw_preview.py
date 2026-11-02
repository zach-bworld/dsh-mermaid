"""Compose dsh-mermaid preview: rendered state + source state, styled like the real UI."""
import math
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1140, 600
BG = (245, 246, 248)
CARD = (255, 255, 255)
BORDER = (226, 228, 232)
TEXT = (33, 37, 41)
MUTED = (110, 116, 124)
BTN_BG = (247, 248, 250)
CODE_BG = (246, 248, 250)
NODE_FILL = (236, 236, 255)
NODE_STROKE = (147, 112, 219)
EDGE = (51, 51, 51)
KEYWORD = (106, 61, 154)

UI = "C:/Windows/Fonts/msyh.ttc"
MONO = "C:/Windows/Fonts/consola.ttf"
CJK_CUTOFF = 0x2E80

_cache = {}


def ui(size):
    k = ("ui", size)
    if k not in _cache:
        _cache[k] = ImageFont.truetype(UI, size)
    return _cache[k]


def mono(size):
    k = ("mono", size)
    if k not in _cache:
        _cache[k] = ImageFont.truetype(MONO, size)
    return _cache[k]


CODE_LINES = [
    "flowchart TD",
    "    A[需求确认] --> B{口径明确?}",
    "    B -->|是| C[取数 SQL]",
    "    B -->|否| D[先对齐口径]",
    "    D --> C",
    "    C --> E[校验并出结论]",
]


def code_line(d, x, y, text, size=12, color=TEXT):
    """Draw one code line: monospace ASCII, CJK from YaHei, so nothing renders as tofu."""
    fm, fu = mono(size), ui(size - 1)
    cx = x
    for ch in text:
        f = fu if ord(ch) >= CJK_CUTOFF else fm
        d.text((cx, y), ch, font=f, fill=color)
        cx += d.textlength(ch, font=f)
    return cx


def arrow(d, x1, y1, x2, y2, width=2):
    d.line([(x1, y1), (x2, y2)], fill=EDGE, width=width)
    ang = math.atan2(y2 - y1, x2 - x1)
    L, spread = 9, 0.42
    p1 = (x2 - L * math.cos(ang - spread), y2 - L * math.sin(ang - spread))
    p2 = (x2 - L * math.cos(ang + spread), y2 - L * math.sin(ang + spread))
    d.polygon([(x2, y2), p1, p2], fill=EDGE)


def box(d, cx, cy, w, h, text, font):
    d.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
                        radius=5, fill=NODE_FILL, outline=NODE_STROKE, width=2)
    tw = d.textlength(text, font=font)
    d.text((cx - tw / 2, cy - font.size * 0.62), text, font=font, fill=TEXT)


def diamond(d, cx, cy, w, h, text, font):
    d.polygon([(cx, cy - h / 2), (cx + w / 2, cy), (cx, cy + h / 2), (cx - w / 2, cy)],
              fill=NODE_FILL, outline=NODE_STROKE, width=2)
    tw = d.textlength(text, font=font)
    d.text((cx - tw / 2, cy - font.size * 0.62), text, font=font, fill=TEXT)


def edge_label(d, x, y, text, font):
    tw = d.textlength(text, font=font)
    d.rectangle([x - tw / 2 - 3, y - font.size * 0.8, x + tw / 2 + 3, y + font.size * 0.5], fill=CARD)
    d.text((x - tw / 2, y - font.size * 0.68), text, font=font, fill=TEXT)


def draw_diagram(img, ox, oy, w, h):
    d = ImageDraw.Draw(img)
    f_node, f_lab = ui(13), ui(11)
    cx = ox + w / 2
    A = (cx, oy + 30, 118, 36)
    B = (cx, oy + 108, 132, 66)
    C = (cx + 26, oy + 192, 112, 36)
    D = (ox + 78, oy + 192, 118, 36)
    E = (cx + 26, oy + 264, 140, 36)

    arrow(d, A[0], A[1] + A[3] / 2, B[0], B[1] - B[3] / 2)
    arrow(d, B[0] + 6, B[1] + B[3] / 2, C[0], C[1] - C[3] / 2)
    edge_label(d, B[0] + 22, oy + 165, "是", f_lab)
    arrow(d, B[0] - B[2] / 2, B[1] + 4, D[0] + D[2] / 2, D[1])
    edge_label(d, (B[0] - B[2] / 2 + D[0] + D[2] / 2) / 2 + 4, B[1] - 8, "否", f_lab)
    arrow(d, D[0] + D[2] / 2, D[1], C[0] - C[2] / 2, C[1])
    arrow(d, C[0], C[1] + C[3] / 2, E[0], E[1] - E[3] / 2)

    box(d, A[0], A[1], A[2], A[3], "需求确认", f_node)
    diamond(d, B[0], B[1], B[2], B[3], "口径明确?", ui(12))
    box(d, C[0], C[1], C[2], C[3], "取数 SQL", f_node)
    box(d, D[0], D[1], D[2], D[3], "先对齐口径", f_node)
    box(d, E[0], E[1], E[2], E[3], "校验并出结论", f_node)


def panel(img, x, y, w, h, caption, mode, hint=None):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x, y, x + w, y + h], radius=10, fill=CARD, outline=BORDER)
    d.text((x + 14, y + 10), "Mermaid 图 · mermaid", font=ui(11), fill=MUTED)

    btns = ["查看图示", "放大", "复制源码"] if mode == "source" else ["查看源码", "放大", "复制源码"]
    bx = x + w - 12
    for label in reversed(btns):
        tw = d.textlength(label, font=ui(11))
        bw = tw + 16
        d.rounded_rectangle([bx - bw, y + 6, bx, y + 26], radius=5, fill=BTN_BG, outline=BORDER)
        d.text((bx - bw + 8, y + 11), label, font=ui(11), fill=TEXT)
        bx -= bw + 6
    d.line([x, y + 34, x + w, y + 34], fill=BORDER)

    if mode == "diagram":
        draw_diagram(img, x, y + 40, w, h - 50)
    else:
        cb_y = y + 48
        cb_h = len(CODE_LINES) * 24 + 30
        d.rounded_rectangle([x + 14, cb_y, x + w - 14, cb_y + cb_h], radius=6,
                            fill=CODE_BG, outline=(225, 228, 232))
        d.text((x + 26, cb_y + 8), "mermaid", font=ui(10), fill=MUTED)
        yy = cb_y + 28
        for line in CODE_LINES:
            color = KEYWORD if line.strip().startswith("flowchart") else TEXT
            code_line(d, x + 26, yy, line, color=color)
            yy += 24
        if hint:
            d.text((x + 16, y + h - 34), hint, font=ui(11), fill=MUTED)

    d.text((x, y + h + 12), caption, font=ui(13), fill=TEXT)


img = Image.new("RGB", (W, H), BG)
d0 = ImageDraw.Draw(img)
d0.text((40, 22), "dsh-mermaid · 会话里的 mermaid 代码块自动渲染成图", font=ui(17), fill=TEXT)
d0.text((40, 50), "同一个代码块两种状态：默认看图；点「查看源码」切回代码，再点「查看图示」切回", font=ui(12), fill=MUTED)

PW, PH = 510, 420
panel(img, 40, 88, PW, PH, "① 默认：自动渲染为图表", "diagram")
panel(img, 40 + PW + 40, 88, PW, PH, "② 点「查看源码」：切回原始代码", "source",
      hint="再点「查看图示」回到图表；「放大」全屏查看，可滚轮缩放、拖动平移")
arrow(d0, 40 + PW + 8, 88 + 150, 40 + PW + 32, 88 + 150)

out = "C:/Users/Administrator/.dsh/plugins-src/dsh-mermaid/docs/preview-v1.png"
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG", optimize=True)
print("saved", out, img.size, os.path.getsize(out), "bytes")
