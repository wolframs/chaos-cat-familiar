# WIP — Flame Conductor working loop and transition

Wolfram selected Working base pose **A**. These are draft atlas assets, not installed in CCF.
Open `preview.html` locally: Working loop, transition-to-Working, or accepted-idle-to-Working demo.
It shows dark/light desktop backgrounds, enlarged and 120 px views, pause, step, replay, speed
and raw-versus-anchored placement. No network access or server is required.

## Working

`working-sheet.png`: 1536×1024, six 512×512 cells. Restrained flame contour/brightness changes
under the raised paw; focused eyes and body remain broadly stable. Not a dramatic moving flame.
Raw pedestal anchors vary only 0.5 px horizontally and 1 px vertically (threshold alpha >=128,
pedestal band y=430…511). Width varies 333–334 px. This measures placement, not perfect pixel identity.
The preview uses frames 1,2,3,4,5,4,3,2 at 160 ms each, reusing frames to avoid a mismatched loop seam.

## Transition

`idle-to-working-sheet.png`: same dimensions. First attempt used idle and working sheets as
endpoint references; it regenerated a wider pedestal (356–360 px) and drifted laterally by 14 px.
That attempt was rejected and replaced in this directory, rather than keeping a redundant draft.
Its original remains in the image tool's default generation history.

The selected revision edits the Working sheet with instructions to change only eye regions.
All six measured pedestal anchors are (256,484), width 334 px. It moves from open to focused eyes;
most visible eye change happens early, so this is not six evenly spaced in-between poses.
Preview timings: 160 ms for the first frame, then 100 ms each. One-shot, then Working loops.

The accepted idle atlas is a separate drawing with a 346 px pedestal and somewhat different face
and body proportions. Anchoring does not correct those differences. The full demo deliberately
shows the raw state boundary without crossfades or per-frame rescaling: a small handoff change
can remain. A future locked-layer master should resolve it. No reverse transition was generated.

## Rendering and alpha

Same anchor as idle: draw each cell at `(round(256-anchorX), 488-anchorY)` on a 512×512 canvas.
No per-frame zoom normalization. Timers run at frame boundaries and pause when hidden.
The sheets contain alpha; the tool preview can show RGB from transparent background pixels.
Working's extreme corner alpha is 1/255 (near-transparent), transition's is 0. Alpha max is 254.
Inspect the HTML against both backgrounds rather than assuming an apparent purple backdrop is opaque.

Read-only measurements are in `measurements.json`. Exact prompts are in `prompts.txt` and
`transition-revision-prompt.txt`; generation used the built-in image tool. No raster edits were
performed by Python. Source sprites are drawn by the HTML preview with ordinary atlas coordinates.

## Livelier flames v0.2

Open `preview-v2.html`. `working-sheet-v2.png` keeps the selected body with larger curling paw
flames, a flickering tail flame and drifting embers. Plays frames 1–6 forward at 125 ms each
(8 fps); do not ping-pong ember motion. The previous quieter version remains for comparison.
The transition is still the existing v0.1 transition; its flame intensity changes at the handoff.

A screenshot of flame-sprite examples served as motion guidance only; it is not in this
repository, and no stock sprites, text or watermarks were copied. Exact generation and alpha-correction prompts are saved.
The first v0.2 output had real semi-transparent haze (corner alpha 77), unlike earlier misleading
RGB-only backdrops. A background-removal generation corrected sampled background alpha to zero.
Final pedestal anchors span 0.5 px horizontally and 1 px vertically, widths 334–335 px.
See `measurements-v2.json`. Geometry is measured, not claimed pixel-identical.

Checked in the preview: six distinct frame steps, a transparent canvas corner, and both
backgrounds.

### Accepted Working v0.2 and frame-3 correction

Wolfram accepted the livelier loop as a keeper, noting a downward tip in frame 3.
The threshold-derived bottom (485 vs 486 for other frames) made the preview add an extra
one-source-pixel downward offset. Read-only static head/core comparison against frame 1 favored
zero vertical shift; opaque pedestal pixels also ended on the same row. Rendering now uses the
common 486 baseline for frame 3. PNG unchanged; raw measurements preserved alongside explicit
render anchors. Do not recompute rendering anchors blindly from the alpha fringe.
