# Idle blink trial

Open `preview.html` locally. No server, dependencies, installation, or network requests are needed.
The existing CCF mascot is untouched.

Generated with the built-in image tool from `../03-arcane-keeper.png`. This is an exploratory
animation atlas, not a production pixel-grid master. The final PNG is 1536×1024, a 3×2 grid of
512×512 cells. Alpha was inspected: background sample pixels are fully transparent; the visible
purple background in the tool's displayed result comes from RGB beneath transparent pixels.

## Consistency findings

The generated body and pedestal are not identical between frames despite explicit instructions.
Pedestal anchors measured from alpha >=128 in the bottom band (cell coordinates):

| Frame | Center X | Bottom Y |
| --- | ---: | ---: |
| 1 | 278 | 502 |
| 2 | 258.5 | 502 |
| 3 | 277 | 502 |
| 4 | 278 | 498 |
| 5 | 258.5 | 499 |
| 6 | 277 | 498 |

The raw sequence exhibits nearly 20 source pixels of horizontal placement drift. The comparison
preview corrects translation only, with a shared anchor (256,488); no per-frame scaling is applied.
Its shortened blink uses frames 1→3→4→3→1, reusing poses to avoid mismatched reopening frames.
Timings are 2600,110,150,110,800 ms. Flame changes accompany the blink; this is not a separately
controlled flame loop. Silhouette and interior variations remain, so the atlas is not installed.

The next production step should use one locked body/pedestal and separately authored eye/flame
layers. Whole-character regeneration did not satisfy strict frame consistency in this trial.
The HTML preview redraws only at frame boundaries and suspends its timer when hidden.

Exact generation and correction prompts are in `prompts.txt`.
