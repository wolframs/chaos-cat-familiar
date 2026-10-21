# Four-state Arcane Keeper concept — 2026-10-20

Open `preview.html` locally. It offers all four state loops, each of the 12 directed handoffs,
and a full tour that visits every directed pair. Its clickable timeline shows every held frame
and blend sample. The page has dark/light backgrounds and a 120 px view.

Idle → Thinking now uses six drawn intermediary poses (`idle-to-thinking-v4.png`),
with the exact Idle and Thinking atlas cells at its ends. Earlier sheets v1–v3 are retained
because each was an image-edit reference for the next. Delete them when an accepted master
supersedes v4 or the generation chain is no longer needed. Wolfram accepted v4 and this
four-state set as the v0.3 default mascot. Exact prompts and references are in `prompts.md`.

| State | Art | Status |
| --- | --- | --- |
| Idle | `../idle-trial/idle-sheet.png` | Accepted anchored blink v0.1 |
| Working | `../working-trial/working-sheet-v2.png` | Accepted livelier flame v0.2 |
| Needs Attention | `needs-attention.png` | Accepted in v0.3; eyes open wide, paw flame pulses |
| Thinking | `thinking-v2.png` | Accepted in v0.3; concentrated eyes, rotating violet orb |

`thinking.png` is the first Thinking draft. It remains because it was the edit source for
`thinking-v2.png` and is needed to reproduce that result with the exact prompt in `prompts.md`.
Delete it when a later accepted master supersedes v2 or its generation chain is no longer needed.
The image tool's own generated originals remain outside the project.

All three new state-loop sheets are 1536×1024 RGBA atlases with six 512×512 cells in row-major order.
Sampled cell corners have alpha zero. With alpha threshold 128 in pedestal rows 420–511,
Needs Attention anchors are (256,487) in every frame, width 339 px. Thinking v2 anchors
range x=255–255.5, y=488, width 346–347 px. The preview uses one fixed scale per atlas to
match the 334 px Working pedestal, then translates each cell by its measured anchor. These
measurements establish placement, not pixel-identical bodies or a genuinely coarse pixel grid.

Idle retains its accepted five-step blink. The other loops run six frames forward at 125 ms each;
returning sparks are not played backward. Idle → Thinking uses six pose-shift cells for
75–105 ms each, with one 45 ms, 50/50 blend sample between each adjacent pair. Exact Idle and
Thinking cells bracket this sequence. Additive weighted compositing keeps the shared body area
opaque during blends. The v4 sheet is 1536×1024 RGBA with alpha-zero corners; pedestal widths
vary 367–379 px and the bottom baseline differs by 20 px between rows. One fixed 0.92 scale
and per-cell translations align the pedestal center and baseline; its width remains slightly
larger than the accepted sheets. The drawings still differ in texture. The other 11 directed
handoffs use exact source and target cells with a short blend. Idle closes and reopens its eyes
on those routes.
Their body silhouettes still differ, so a brief double outline can remain during blends. Those
limits remain in the accepted v0.3 baseline and can be refined in a later version.

Exact imagegen prompts and references are in `prompts.md`. The generated art was copied into this
project without raster modification. Only preview canvas transforms adjust placement and size.
The four-state graph comes from bundled `masko.json`; it has four loops and all 12 directed
non-loop edges. The preview's full tour is a visual inspection route, not a simulation of actual
approval priority or transition interruption. Syntax, atlas geometry, and mocked playback
checks covered all 17 selectable routes, including the new pose sequence in its own route and
the full tour. The bundled runtime clips and thumbnails live under
`apps/windows-shell/assets/mascots/chaos-cat/`; regenerate them with
`node scripts/windows/render-chaos-cat-mascot.mjs` from the repo root.
