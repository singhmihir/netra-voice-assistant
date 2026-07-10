"""
Render the Netra brand SVGs to PNG.

Release X: the SVGs are now the single source of truth (violet
voice-ring identity), so this script simply rasterises them with
cairosvg instead of hand-drawing shapes in Pillow.

    pip install cairosvg
    python render.py

Output:
  branding/netra-icon.png    512x512
  branding/netra-logo.png    1440x440 (2x retina)
  branding/netra-badge.png   720x180  (2x retina)
"""
from __future__ import annotations
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

JOBS = [
    ("netra-icon.svg",  "netra-icon.png",  512,  512),
    ("netra-logo.svg",  "netra-logo.png",  1440, 440),
    ("netra-badge.svg", "netra-badge.png", 720,  180),
]


def main() -> int:
    try:
        import cairosvg
    except ImportError:
        print("cairosvg is required: pip install cairosvg", file=sys.stderr)
        return 1
    for src, dst, w, h in JOBS:
        cairosvg.svg2png(
            url=os.path.join(HERE, src),
            write_to=os.path.join(HERE, dst),
            output_width=w,
            output_height=h,
        )
        print(f"rendered {dst} ({w}x{h})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
