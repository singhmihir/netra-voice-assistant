# Netra brand assets

Original logo, icon and badge for the Netra Voice Assistant. All files are
hand-built SVG with no third-party trademark content.

| File | Use |
|---|---|
| [`netra-logo.svg`](netra-logo.svg) | Primary horizontal lock-up - eye mark + "Netra" wordmark + tagline. Use on white / light backgrounds. |
| [`netra-icon.svg`](netra-icon.svg) | 256x256 square app icon - for favicons, app shortcuts, tray icons. |
| [`netra-badge.svg`](netra-badge.svg) | "Built with Netra" badge - safe to place next to other approved logos in product credits. |
| [`netra-logo.png`](netra-logo.png) | Rasterised version of the primary logo (1440x440, 2x retina). |
| [`netra-icon.png`](netra-icon.png) | Rasterised icon (512x512). |

The mark is a stylised eye (Sanskrit *netra* = "eye") sitting inside an
**open voice ring** — two case-hardened violet arcs whose gaps suggest
turn-taking: there is always space to interrupt. Release X aligned the
brand assets with the in-app orb, favicon and PWA tile: deep violet-black
tile `#12081F`, violet ring gradient `#8B3DF0 → #C660FF → #FFB84D → #6920B8`
(the amber patch is the "heat-treatment" patina), lavender lid `#D8C8FF`,
and the green iris `#7FFFB0 → #2EB858 → #021A0D`. Wordmark is Segoe UI 800
weight with `-2` letter-spacing in deep violet `#4C1D95`.

## Using with Deloitte branding

Netra is an independent project. To pair Netra with the Deloitte brand
inside a Deloitte engagement:

1. Obtain the official Deloitte logo and lock-up template from
   **Deloitte Brand Space** (internal portal). Never download Deloitte's
   mark from the public web.
2. Use the Deloitte template's "third-party tool" or "partner mark"
   slot - that is where Netra's mark belongs.
3. Maintain Deloitte's clear-space and minimum-size rules - do not
   alter, recolour or place Netra's mark inside Deloitte's clear space.
4. If the deliverable is client-facing, route the lock-up through your
   local Brand & Communications team for approval.

**Do not** fuse, overlap, or recolour the Deloitte logo with Netra's
mark. Deloitte's brand guidelines explicitly prohibit derivative
fusions, and so does this repo.

## Colours (Release X)

| Token | Hex | Use |
|---|---|---|
| Netra Void    | `#12081F` | Icon tile / dark surfaces |
| Ring Violet   | `#8B3DF0` | Voice ring primary |
| Ring Magenta  | `#C660FF` | Voice ring mid-tone |
| Ring Amber    | `#FFB84D` | Heat-treatment patina accent |
| Ring Deep     | `#6920B8` | Voice ring shadow end |
| Lid Lavender  | `#D8C8FF` | Eye outline, dark-surface text |
| Iris Bright   | `#7FFFB0` | Iris highlight |
| Iris Green    | `#2EB858` | Iris body |
| Iris Deep     | `#021A0D` | Iris edge / pupil ring |
| Wordmark      | `#4C1D95` | Wordmark on light backgrounds |
| Slate         | `#475569` | Tagline / secondary text |

## Regenerating the PNGs

If you tweak the SVG and need a fresh PNG, run from the repo root:

```bash
pip install cairosvg
python branding/render.py
```

The SVGs are the source of truth; `render.py` just rasterises them.
