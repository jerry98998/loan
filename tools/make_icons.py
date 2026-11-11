"""Generate PWA icons for 房贷看板.

Run:
  python tools/make_icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "web")

BG_TOP = (16, 25, 41)
BG_BOT = (5, 8, 16)
INK = (7, 11, 20)
MINT = (61, 220, 151)
BODY = (40, 178, 122)

S = 512

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def base():
    img = Image.new("RGB", (S, S), BG_BOT)
    d = ImageDraw.Draw(img)
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(BG_TOP, BG_BOT, y / (S - 1)))
    return img


def glow(img):
    """Faint mint halo behind the house."""
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy, rmax = 256, 296, 252
    steps = 44
    for i in range(steps, 0, -1):
        r = rmax * i / steps
        a = int(32 * (1 - i / steps) ** 1.6)
        if a > 0:
            d.ellipse([cx - r, cy - r * 0.9, cx + r, cy + r * 0.9],
                      fill=(61, 220, 151, a))
    return Image.alpha_composite(img.convert("RGBA"), layer)


def house(img):
    d = ImageDraw.Draw(img)
    # body: square top corners so the roof seam stays flush
    d.rounded_rectangle([150, 248, 362, 426], radius=28, fill=BODY)
    d.rectangle([150, 248, 362, 280], fill=BODY)
    # roof: two-tone reads as a house rather than an arrow
    d.polygon([(256, 140), (100, 252), (412, 252)], fill=MINT)
    return img


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return None


def yen(img):
    d = ImageDraw.Draw(img)
    font = load_font(188)
    if font is not None:
        d.text((256, 340), "\u00a5", font=font, fill=INK, anchor="mm")
        return img
    # shape fallback
    d.line([(200, 268), (256, 330), (312, 268)], fill=INK, width=24, joint="curve")
    d.line([(256, 322), (256, 386)], fill=INK, width=24)
    d.line([(206, 330), (306, 330)], fill=INK, width=18)
    d.line([(206, 358), (306, 358)], fill=INK, width=18)
    return img


def main():
    img = glow(base())
    img = house(img)
    img = yen(img)
    img = img.convert("RGB")

    img.save(os.path.join(OUT, "icon-512.png"), "PNG", optimize=True)
    for size in (180, 192):
        img.resize((size, size), Image.LANCZOS).save(
            os.path.join(OUT, f"icon-{size}.png"), "PNG", optimize=True)
    print("wrote icon-180.png icon-192.png icon-512.png ->", OUT)


if __name__ == "__main__":
    main()
