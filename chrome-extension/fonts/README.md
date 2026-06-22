# Bundled Fonts

For air-gap compliance (HC-07) the extension loads fonts locally — there are **no
CDN calls at runtime**. These files are referenced by every extension page via
`@font-face`:

- `Montserrat.woff2` — headings / UI (geometric sans-serif, brand display face)
- `LibreFranklin.woff2` — body copy and functional labels

## About these files

Both are the **official Google Fonts variable webfonts** (latin subset, weight
axis 100–900), so a single file per family covers every weight used in the UI.
They contain the full latin glyph set — no missing characters / tofu boxes.

| File | Family | Axis | Subset |
|------|--------|------|--------|
| `Montserrat.woff2` | Montserrat | `wght 100..900` | latin |
| `LibreFranklin.woff2` | Libre Franklin | `wght 100..900` | latin |

## Brand typography (per DESIGN.md — Luminous Bio-Tech)

- **Montserrat** — headlines, buttons, brand wordmark. Heavy weights (600/700),
  tight letter-spacing.
- **Libre Franklin** — body text and UI labels (a capable Proxima Nova
  alternative). Generous line height for data-heavy contexts.

## Replacing / extending

To add weights or other subsets, download from Google Fonts on a networked
machine and keep the **exact filenames** above (the `@font-face` `src` paths and
`manifest.json` `web_accessible_resources` point here). For non-latin support,
fetch the matching subset and add a second `@font-face` with a `unicode-range`.
