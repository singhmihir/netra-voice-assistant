# bundled 3D libs

- `three-r147.min.js` — three.js r0.147.0 UMD build (last line with the
  `examples/js` UMD add-ons we need). Fetched verbatim from the npm
  `three@0.147.0` package, MIT licensed.
- `three-passes-r147.js` — concatenation of the r147 UMD post-processing
  add-ons (EffectComposer, RenderPass, ShaderPass, MaskPass,
  UnrealBloomPass, CopyShader, LuminosityHighPassShader, Reflector),
  unmodified.

these get concatenated with `stage3d.js` into one scoped UI Script
(`netra_stage3d`) that Service Portal loads as a widget dependency —
no CDN involved, works on locked-down networks.
