# Idle ⇄ Working transitions — WIP, 2026-10-19

Open `preview.html` for the round trip on dark/light backgrounds at large and desktop sizes.
Both directions are new six-cell 1536×1024 RGBA atlases (3×2, cells 512×512).
Return is authored separately: fire settles and sparks rise, rather than reversing the forward clip.

## Blink handoff trial, 2026-10-20

Wolfram found the generated transitions insufficiently smooth and healthy. Open `preview-v2.html`
for a separate motion study. It uses only the accepted Idle and Working atlas cells: Idle blinks,
then a 180 ms blend introduces Working while its eyes are closed; the return blends into a closed
Idle frame and opens its eyes. A checkbox compares the blend with a direct cut. The original
generated-atlas preview remains available for comparison.

This removes the redrawn in-between cats from playback, but it does not make the accepted endpoint
drawings identical. A short double silhouette may be visible during the blend, especially enlarged.
Treat this as a timing and staging option, not an accepted replacement for the transitions.
No sprite asset or live runtime was changed. A separate image-generation attempt to create an
Idle atlas from the Working body was discarded: despite a narrow edit request, 98–99% of pixels
in sampled body, head-outline and pedestal regions differed from the source. It did not provide
a locked body. A true continuous transition needs shared body/pedestal artwork across states.

The previews are plain HTML files. Opening one with `Start-Process` (or a double-click) can take
a moment before the browser window appears; wait for it rather than opening the file again.

## Playback contract

- Idle: accepted idle blink sequence, unchanged source atlas.
- Forward: exact idle cell 1, generated cells 2–5 at 110 ms, exact Working cell 1.
- Working: accepted v0.2 six-frame forward loop at 125 ms, four cycles in the demo.
- Return: exact Working cell 1, generated cells 2–5 at 130 ms, exact idle cell 1.
- Full demo repeats; isolated directions play once then loop their destination.

The exact endpoint cells prevent a generated approximation from replacing the accepted pose at
the immediate loop join. This does not eliminate differences in the intermediate drawings.
The generated forward sheet follows the idle proportions; return came out wider.
Preview uses ONE constant scale per atlas to match pedestal width (~334 source pixels):
idle 334/346, Working 1, forward 334/348, return 334/360. No per-frame scaling.
Pedestal center/bottom are translated to (256,488); per-cell anchor values are in the HTML
and raw alpha>=128 measurements in `measurements.json`. Disable size matching or alignment
to inspect raw placement. All sampled cell corners have alpha zero.

This is a reviewable v0.1, not pixel-identical production animation. Silhouette and head shape
vary slightly between sheets; constant pedestal scaling cannot repair those variations.
Accepted loop files and running CCF are untouched. Future integration needs sprite-backed
playback and state interruption handling; this page does not implement the runtime state machine.

## Reproduction

Built-in image generation, transparent_background=true, references in this order:
`../idle-trial/idle-sheet.png`, `../working-trial/working-sheet-v2.png`.
Exact prompts: `forward-prompt.txt` and `return-prompt.txt`.
Generated sources copied without raster modification; preview crops/composes on canvas.
Unused generated endpoint cells remain in the source atlases for inspection.

Only four decoded atlases and four canvases are used. Timer runs at frame changes,
stops while hidden, and is cancelled on page exit. No server, installed hooks or app process.

Validation: all referenced local images exist; atlas dimensions/alpha checked; non-graphical
JavaScript checks exercised all three sequence modes, frame indices, wrap targets and canvas calls.
For visual review, open the standalone preview in an ordinary browser.
