# Exact image-generation prompts

Built-in imagegen with `transparent_background: true`. References are listed before each prompt.

## Idle → Thinking pose shift v1

References, in order: `../idle-trial/idle-sheet.png`, `thinking-v2.png`. Kept as the edit source for v2.

```text
Use case: stylized-concept. Asset type: one transparent six-frame transition sprite atlas, 3 columns by 2 rows of equal 512x512 cells, 1536x1024 landscape, no gutters or labels. Image 1 is the approved Idle atlas; its TOP LEFT cell is the starting pose. Image 2 is the Thinking v2 atlas; its TOP LEFT cell is the destination pose. Draw a real intermediate POSE SHIFT for Idle → Thinking, not a dissolve, ghosted overlap, or six separate unrelated portraits. Same blue-black Arcane Keeper cat on the same wooden disk, amber eyes, violet rim light, upright curved tail, raised viewer-right paw. Six row-major sequential drawings: 1 exact-like curious Idle posture with head tilted and bright open eyes; 2 head and gaze start to angle downward toward the paw while shoulders settle slightly; 3 halfway head/neck silhouette and raised paw between endpoints, eyes narrowing, small flame beginning to curl; 4 near-Thinking head/neck/paw posture, flame curls into a compact orb; 5 final settling of eyes, tail-tip flame and orb, very close to Thinking; 6 exact-like Thinking posture with half-lidded concentrated eyes and a compact violet-white orb. Keep feet rooted in exactly the same locations and wooden pedestal centered, same width and bottom row across all six cells. No body scaling, camera shift, bounce, duplicated outlines, transparent ghosts, extra limbs, text, symbols, or background haze. Preserve crisp hand-crafted pixel-art style and readable anatomy at 120px. All corners and empty spaces must have true alpha 0. Rising sparks continue upward only. Each frame is one solid opaque cat drawing, not two cats blended.
```

## Idle → Thinking pose shift v2

References, in order: `../idle-trial/idle-sheet.png`, `thinking-v2.png`, `idle-to-thinking-v1.png`.

```text
Edit the provided six-cell transition atlas. Use case: stylized-concept. Image 1 is accepted Idle (top-left cell); image 2 is destination Thinking v2 (top-left cell); image 3 is the first six-frame Idle-to-Thinking transition draft to refine. Produce one transparent 1536x1024 PNG atlas, 3 columns x 2 rows, exactly 512x512 per cell, no gutters or labels. Keep image 3's first three progression poses but correct its last three so the cat's head, ear tips, eyes, chest, raised paw, and tail progressively settle into the EXACT posture of image 2 top-left: the destination head sits HIGHER and less deeply bowed than image 3's final draft frame, with the ears and face silhouette matching image 2. Frame 6 must resemble image 2 top-left, not a new extreme downward head pose. Draw one solid cat per frame, no crossfades/ghosts. Lock the feet and wooden pedestal to the same screen coordinates in every cell, centered, same width and bottom baseline; maintain a coherent upright seated torso. Across frames, the eyes narrow, head/gaze angles slightly toward the raised paw, and small paw fire curls into the luminous compact orb. Tail-tip flame rises. Preserve the Arcane Keeper black-violet pixel-art cat, amber eyes, wooden disk, transparent background. Alpha zero outside character and localized fire; no purple background haze, doubled contour, extra limbs, camera movement, scaling, text, or UI.
```

## Idle → Thinking pose shift v3

References, in order: `idle-to-thinking-v2.png`, `../idle-trial/idle-sheet.png`, `thinking-v2.png`. Torso-width correction; kept as the edit source for v4.

```text
Use case: precise-object-edit. Produce a transparent 1536x1024 PNG sprite atlas, 3 columns by 2 rows, each cell exactly 512x512, six row-major consecutive frames. Image 1 is the current Idle→Thinking transition atlas to CORRECT. Image 2 is the accepted Idle atlas; Image 3 is the Thinking destination atlas. Preserve Image 1's head and face pose progression, eye expression, raised paw, orb, tail-tip fire, fixed feet, and wooden pedestal. Correct the anatomy of INTERMEDIATE frames 2, 3, 4, and 5: their torso and belly currently become conspicuously FATTER/wider during the head shift. Draw the same lean seated cat throughout. Keep the left and right outer body contour, shoulder width, chest taper, haunch size, and waist close to the lean proportions of the endpoint cats in Images 2 and 3. A head tilt or eye change must not inflate the chest or belly. Maintain a nearly constant torso silhouette and constant body mass across all six frames; only the neck/head angle and the raised paw/spell should shift. No squash-and-stretch, no bulging side, no growing fur mound, no broader hindquarters, no body zoom, no second outline. The first frame should match the Idle endpoint and last frame should match the Thinking endpoint as closely as possible. Keep exactly one opaque blue-black cat and one wooden disk per cell, amber eyes, violet rim light, hand-crafted crisp pixel art, no camera movement or text. Transparent alpha-zero empty background and corners; no purple haze outside localized magic. This is a restrained anatomy correction, not a new character design.
```

## Idle → Thinking pose shift v4

References, in order: `idle-to-thinking-v3.png`, `thinking-v2.png`. Corrects v3's closed-eye final cell.

```text
Use case: precise-object-edit. Edit Image 1, a transparent 1536x1024 six-cell (3 columns by 2 rows, 512x512 cells) Idle→Thinking sprite atlas. Image 2 is the desired Thinking endpoint atlas. Preserve Image 1's corrected lean, constant-width body silhouette across every cell: narrow tapered chest, same shoulder/waist/haunch mass, feet and pedestal fixed. Preserve the existing first five frame poses and their head/paw progression. Correct ONLY the LAST cell (bottom-right, frame 6): its eyes are accidentally fully closed. Open them to match the amber half-lidded, downward-looking concentrated eyes of Image 2 top-left cell. Keep frame 6's head, ears, body, tail, raised paw, orb, flames, wooden pedestal, scale, and position unchanged. No cat enlargement or swelling, no new pose, no blur, no doubled outlines, no change to other cells. One opaque blue-black cat with violet rim light per cell. Transparent alpha-zero empty background; no purple background haze. Frame 6 should naturally connect to the Thinking endpoint, not a sleepy blink.
```

## Needs Attention

References: `../working-trial/working-sheet-v2.png`, `../03-arcane-keeper.png`.

```text
Use case: stylized-concept. Asset type: transparent six-frame animation atlas for a Windows desktop cat companion, 3 columns by 2 rows of equal square cells (same 1536x1024 layout as Image 1). Input images: Image 1 is the approved Working sprite atlas and establishes the cat's exact identity, camera, scale, body pose, wooden pedestal and palette. Image 2 is the selected Arcane Keeper concept for identity only. Create a draft NEEDS ATTENTION / approval-waiting loop. This cat notices the user and waits expectantly, alert but friendly: amber eyes open wider and look toward the viewer, ears attentive, one raised paw held steadily over a bright violet flame. The flame makes a small repeating pulse; two or three tiny embers rise upward and vanish. Tail-tip flame flickers gently. Six distinct consecutive frames in row-major order at roughly 8 fps, with a clear seamless return from frame 6 to frame 1. Keep the cat head tilt, face outline, fur silhouette, feet, raised paw, tail, pedestal wood grain, camera and scale as close to Image 1 as possible. No bouncing, wobbling pedestal, zoom, additional limbs, distress expression, text, symbols, UI, or new props. Only the eyes and magical fire should move. Strong legible eye and flame changes at 120 px. Transparent RGBA background with alpha-zero empty corners and no colored haze. Preserve blue-black fur, amber slit pupils, crisp purple rim light, hand-crafted pixel-art appearance.
```
## Thinking v1

References: `../working-trial/working-sheet-v2.png`, `../03-arcane-keeper.png`. This image is retained as the edit source for v2.

```text
Use case: stylized-concept. Asset type: transparent six-frame animation atlas for a Windows desktop cat companion, 3 columns by 2 rows of equal square cells (same 1536x1024 layout as Image 1). Input images: Image 1 is the approved Working sprite atlas and establishes the cat's identity, camera, scale, body pose, wooden pedestal and palette. Image 2 is the selected Arcane Keeper concept for identity only. Create a draft THINKING / context-compaction loop. The cat is quietly concentrating: amber eyes look slightly upward and inward, eyelids relaxed, expression thoughtful rather than sleepy or worried. The raised paw remains steady over a compact violet flame that curls into a small orbiting wisp; a few tiny violet sparks circle once and drift upward across six successive frames. Tail-tip flame is calmer than Working. Six distinct consecutive frames in row-major order at roughly 8 fps, with a natural seamless return from frame 6 to frame 1. Keep the cat's head tilt, facial outline, fur silhouette, feet, raised paw, curved tail, pedestal wood grain, camera and scale as close to Image 1 as possible. No bouncing, wobbling pedestal, zoom, extra limbs, thought bubble, question mark, symbols, text, UI, or new props. Most motion belongs to gaze and magical fire. Strong legible differences from Working and Needs Attention at 120 px while retaining the same Arcane Keeper cat. Transparent RGBA background with alpha-zero empty corners and no colored haze. Preserve blue-black fur, amber slit pupils, crisp purple rim light and hand-crafted pixel-art appearance.
```

## Thinking v2

Reference/edit target: `thinking.png`.

```text
Use case: precise-object-edit. Asset type: transparent six-frame 3-column by 2-row animated sprite atlas, same 1536x1024 geometry as input. Edit target: the supplied Thinking draft atlas. Make its THINKING / context-compaction state visibly distinct from alert and working at 120 pixels while preserving the Arcane Keeper identity. The amber eyelids are half-lowered in concentration and the pupils angle down toward the raised paw, as though mentally inspecting a spell. The hovering magic beneath the paw changes from a tall flame into a small circular violet-white orb with a curling wisp around it; across six consecutive frames, the wisp slowly rotates, tiny sparks rise, and the orb subtly breathes. The tail-tip flame is shorter and steadier than before. Keep the blue-black cat's face outline, ears, head tilt, fur silhouette, raised paw, feet, curved tail, wooden pedestal wood grain, camera, cell grid, and scale in place. All six cells must have the same anchor and no body bounce. No closed sleeping eyes, worried face, thought bubble, text, symbols, new props, haze, background, or extra limbs. True transparent RGBA with empty corners alpha 0. Hand-crafted crisp pixel-art appearance; no blur.
```
