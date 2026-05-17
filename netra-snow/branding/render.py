"""
Render the Netra logo / icon / badge as PNG using Pillow.

We hand-build the raster instead of relying on a SVG renderer so the
script has zero native dependencies (no cairo, no librsvg).

Output:
  branding/netra-logo.png    1440x440
  branding/netra-icon.png    512x512
  branding/netra-badge.png   720x180
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw, ImageFont

HERE   = os.path.dirname(os.path.abspath(__file__))

# Colours
NAVY   = (14, 46, 122)
BLUE   = (26, 86, 219)
SKY    = (59, 130, 246)
GREEN  = (34, 181, 115)
PUPIL  = (10, 21, 48)
SLATE  = (71, 85, 105)
WHITE  = (255, 255, 255)
SURFACE= (248, 250, 252)

def _font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = ['arialbd.ttf', 'segoeuib.ttf'] if bold else ['arial.ttf', 'segoeui.ttf']
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()

# ----- Eye drawing primitive (reused across all three rasters) -----
def draw_eye(draw: ImageDraw.ImageDraw, cx: int, cy: int, w: int,
             outline_color=NAVY, stroke=6, draw_waves=True):
    """Draw a stylised eye centred at (cx, cy) with horizontal width w."""
    h = w * 0.46
    # Eye almond - clean ellipse outline (no horizontal seam)
    bbox = [cx - w/2, cy - h/2, cx + w/2, cy + h/2]
    draw.ellipse(bbox, outline=outline_color, fill=None, width=stroke)

    # Iris — gradient simulated by stacked circles
    iris_r = int(h * 0.38)
    for i, color in enumerate([NAVY, BLUE, SKY]):
        r = iris_r - i * iris_r // 5
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    # Pupil
    pup = iris_r * 0.42
    draw.ellipse([cx - pup, cy - pup, cx + pup, cy + pup], fill=PUPIL)
    # Catch-light
    hi = pup * 0.45
    draw.ellipse([cx - pup*0.7, cy - pup*0.7, cx - pup*0.7 + hi*2, cy - pup*0.7 + hi*2], fill=WHITE)

    # Voice waves (green) to the right of the eye
    if draw_waves:
        start_x = cx + w/2 + 12
        for i, span in enumerate([26, 42, 58]):
            arc_box = [start_x - 8, cy - span, start_x + span*1.6, cy + span]
            draw.arc(arc_box, start=200, end=340, fill=GREEN, width=max(3, stroke // 2))


# ============================================================
# 1. Primary logo (1440 x 440)
# ============================================================
def render_logo():
    W, H = 1440, 440
    img = Image.new('RGB', (W, H), WHITE)
    d = ImageDraw.Draw(img)

    draw_eye(d, cx=240, cy=H//2, w=340, stroke=10, draw_waves=True)

    word = _font(170, bold=True)
    tag  = _font(36)
    d.text((520, 110), 'Netra', font=word, fill=NAVY)
    d.text((528, 310), 'VOICE  ASSISTANT', font=tag, fill=SLATE,
           spacing=4)

    out = os.path.join(HERE, 'netra-logo.png')
    img.save(out, 'PNG')
    print(f"wrote {out}  ({os.path.getsize(out):,} bytes)")
    return out


# ============================================================
# 2. Square icon (512 x 512)
# ============================================================
def render_icon():
    S = 512
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded navy square background
    radius = 100
    d.rounded_rectangle([0, 0, S, S], radius=radius, fill=NAVY)

    # Eye in white outline
    draw_eye(d, cx=S//2, cy=S//2 + 30, w=380, stroke=10,
             outline_color=WHITE, draw_waves=False)

    # Voice waves above the eye instead of beside
    for i, w in enumerate([60, 100, 140]):
        d.arc([S//2 - w, 110, S//2 + w, 110 + w*1.2], start=200, end=340,
              fill=GREEN, width=8)

    out = os.path.join(HERE, 'netra-icon.png')
    img.save(out, 'PNG')
    print(f"wrote {out}  ({os.path.getsize(out):,} bytes)")
    return out


# ============================================================
# 3. "Built with Netra" badge (720 x 180)
# ============================================================
def render_badge():
    W, H = 720, 180
    img = Image.new('RGB', (W, H), SURFACE)
    d = ImageDraw.Draw(img)

    # Rounded border
    d.rounded_rectangle([2, 2, W-2, H-2], radius=24, outline=(226, 232, 240), width=2)

    # Small eye
    draw_eye(d, cx=85, cy=H//2, w=120, stroke=6)

    # Text
    small = _font(28)
    big   = _font(64, bold=True)
    d.text((220, 35), 'BUILT  WITH', font=small, fill=SLATE)
    d.text((220, 75), 'Netra',       font=big,   fill=NAVY)

    out = os.path.join(HERE, 'netra-badge.png')
    img.save(out, 'PNG')
    print(f"wrote {out}  ({os.path.getsize(out):,} bytes)")
    return out


if __name__ == '__main__':
    render_logo()
    render_icon()
    render_badge()
