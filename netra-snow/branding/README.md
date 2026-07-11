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

The mark is a stylised eye (Sanskrit *netra* = "eye") crowned by an
iridescent full-spectrum prism arc, with matching sound-wave accents
suggesting voice - a nod to the R8.1 "Prism" UI, where Netra's colour
shifts live with her own voice. Core palette is deep violet `#7A3DF0`
on cosmic near-black `#0B0416`, with a spectrum accent running
`#37E6A8 -> #41C6FF -> #C660FF -> #FFB84D -> #FF5F9E`. Wordmark is Segoe UI
800 weight with `-2` letter-spacing filled with the violet gradient.

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

## Colours

| Token | Hex | Use |
|---|---|---|
| Netra Navy | `#0E2E7A` | Wordmark, eye outline |
| Netra Blue | `#1A56DB` | Iris, primary CTA |
| Netra Sky  | `#3B82F6` | Iris highlight |
| Voice Green| `#22B573` | Sound-wave accent |
| Pupil      | `#0A1530` | Pupil |
| Slate      | `#475569` | Tagline / secondary text |
| Surface    | `#F8FAFC` | Light background |

## Regenerating the PNGs

If you tweak the SVG and need a fresh PNG, run from the repo root:

```powershell
# Renders any *.svg in branding/ to PNG at 2x resolution
python branding/render.py
```

(Uses Python + Pillow + cairosvg. See `render.py` for details.)
