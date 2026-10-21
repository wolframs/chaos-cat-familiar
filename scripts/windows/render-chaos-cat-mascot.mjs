// Deterministically render the Chaos Cat v0.3 concept timeline into local WebM media.
// Requires the machine's ffmpeg/ffprobe and Python with Pillow + NumPy; adds no npm dependency.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const concept = path.join(root, "assets/concepts/2026-10-19-cat");
const output = path.join(root, "apps/windows-shell/assets/mascots/chaos-cat");
const names = ["idle", "working", "attention", "thinking"];
const atlases = {
  idle: { src: path.join(concept, "idle-trial/idle-sheet.png"), scale: 334 / 346, anchors: [[278,502],[258.5,502],[277,502],[278,498],[258.5,499],[277,498]] },
  working: { src: path.join(concept, "working-trial/working-sheet-v2.png"), scale: 1, anchors: [[256,486],[256,486],[256,486],[256.5,486],[256,486],[256,486]] },
  attention: { src: path.join(concept, "state-set/needs-attention.png"), scale: 334 / 339, anchors: Array.from({ length: 6 }, () => [256,487]) },
  thinking: { src: path.join(concept, "state-set/thinking-v2.png"), scale: 334 / 346, anchors: [[255.5,488],[255,488],[255,488],[255.5,488],[255,488],[255.5,488]] },
  idleThinking: { src: path.join(concept, "state-set/idle-to-thinking-v4.png"), scale: 0.92, anchors: [[266,506],[256.5,506],[269.5,506],[268,486],[258,486],[274.5,486]] }
};

const one = (state, cell, ms) => ({ layers: [[state, cell, 1]], ms });
function loop(state) {
  if (state === "idle") return [one(state,0,2600),one(state,2,110),one(state,3,150),one(state,2,110),one(state,0,800)];
  return Array.from({ length: 6 }, (_, cell) => one(state,cell,125));
}
function handoff(from,to) {
  if (from === "idle" && to === "thinking") {
    const frames = [one("idle",0,110)];
    for (let cell = 0; cell < 6; cell++) {
      frames.push(one("idleThinking",cell,cell === 0 || cell === 5 ? 75 : 105));
      if (cell < 5) frames.push({ layers: [["idleThinking",cell,0.5],["idleThinking",cell+1,0.5]], ms: 45 });
    }
    frames.push(one("thinking",0,150));
    return frames;
  }
  const frames = [one(from,0,110)];
  if (from === "idle") frames.push(one("idle",2,100),one("idle",3,110));
  const sourceCell = from === "idle" ? 3 : 0;
  const targetCell = to === "idle" ? 3 : 0;
  for (const alpha of [0.25,0.5,0.75]) frames.push({ layers: [[from,sourceCell,1-alpha],[to,targetCell,alpha]], ms: 45 });
  frames.push(one(to,targetCell,110));
  if (to === "idle") frames.push(one("idle",2,100),one("idle",0,150));
  return frames;
}

const clips = [
  ...names.map(state => ({ kind: "loops", name: state, frames: loop(state) })),
  ...names.flatMap(from => names.filter(to => to !== from).map(to => ({ kind: "transitions", name: `${from}-to-${to}`, frames: handoff(from,to) })))
];

// Source-over for held cells; Canvas "lighter" math for the two-layer blend
// samples. The latter sums weighted premultiplied RGB and alpha, then clamps.
const frameRenderer = String.raw`
import json, math, pathlib, sys
import numpy as np
from PIL import Image

job = json.load(sys.stdin)
atlas_images = {}
for key, info in job['atlases'].items():
    image = Image.open(info['src']).convert('RGBA')
    if image.size != (1536, 1024): raise ValueError('bad atlas geometry: '+info['src'])
    atlas_images[key] = image

def jsround(value): return math.floor(value + .5)

def layer_image(key, cell):
    info = job['atlases'][key]
    cropped = atlas_images[key].crop(((cell % 3)*512, (cell // 3)*512, (cell % 3 + 1)*512, (cell // 3 + 1)*512))
    scale = info['scale']
    side = jsround(512 * scale)
    if side != 512: cropped = cropped.resize((side,side), Image.Resampling.NEAREST)
    anchor = info['anchors'][cell]
    x, y = jsround(256-anchor[0]*scale), jsround(488-anchor[1]*scale)
    canvas = Image.new('RGBA',(512,512),(0,0,0,0))
    canvas.alpha_composite(cropped,(x,y))
    return canvas

cache = {}
def image_for(layers):
    key = json.dumps(layers, separators=(',',':'))
    if key in cache: return cache[key]
    if len(layers) == 1:
        result = layer_image(layers[0][0],layers[0][1])
    else:
        a = np.asarray(layer_image(layers[0][0],layers[0][1]),dtype=np.float32)
        b = np.asarray(layer_image(layers[1][0],layers[1][1]),dtype=np.float32)
        wa,wb = layers[0][2],layers[1][2]
        aa = a[:,:,3] * wa
        ab = b[:,:,3] * wb
        alpha = np.minimum(255,aa+ab)
        premul = a[:,:,:3]*(aa[:,:,None]/255) + b[:,:,:3]*(ab[:,:,None]/255)
        rgb = np.divide(premul*255,alpha[:,:,None],out=np.zeros_like(premul),where=alpha[:,:,None]>0)
        pixels = np.concatenate((np.clip(np.rint(rgb),0,255),np.rint(alpha)[:,:,None]),axis=2).astype(np.uint8)
        result = Image.fromarray(pixels,'RGBA')
    cache[key] = result
    return result

temp = pathlib.Path(job['temp'])
temp.mkdir(parents=True, exist_ok=True)
for clip in job['clips']:
    directory = temp / clip['kind'] / clip['name']
    directory.mkdir(parents=True, exist_ok=True)
    for index, frame in enumerate(clip['frames']):
        image_for(frame['layers']).save(directory / f'{index:03d}.png',compress_level=9)
for state in ['idle','working','attention','thinking']:
    image = layer_image(state,0)
    image.resize((120,120),Image.Resampling.NEAREST).save(temp / f'thumbnail-{state}.png',compress_level=9)
`;

function run(command, args, options = {}) {
  const result = spawnSync(command,args,{ cwd: root, encoding: "utf8", maxBuffer: 8*1024*1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result.stdout.trim();
}
function quoteConcat(name) { return name.replaceAll("'", "'\\''").replaceAll("\\", "/"); }
function writeConcat(clip,temp) {
  const directory = path.join(temp,clip.kind,clip.name);
  const lines = ["ffconcat version 1.0"];
  for (let i=0; i<clip.frames.length; i++) {
    lines.push(`file '${quoteConcat(path.join(directory,`${String(i).padStart(3,"0")}.png`))}'`);
    lines.push("option framerate 1000");
    lines.push(`duration ${(clip.frames[i].ms/1000).toFixed(3)}`);
  }
  // The demuxer needs a following packet to honor the final still's duration.
  lines.push(`file '${quoteConcat(path.join(directory,`${String(clip.frames.length-1).padStart(3,"0")}.png`))}'`);
  lines.push("option framerate 1000");
  const manifest = path.join(directory,"frames.ffconcat");
  fs.writeFileSync(manifest,lines.join("\n")+"\n");
  return manifest;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(),"ccf-chaos-cat-v03-"));
try {
  run(process.env.CCF_PYTHON ?? "python",["-c",frameRenderer],{ input: JSON.stringify({ atlases, clips, temp: scratch }) });
  for (const clip of clips) {
    const dest = path.join(output,clip.kind,`${clip.name}.webm`);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    const manifest = writeConcat(clip,scratch);
    run(process.env.CCF_FFMPEG ?? "ffmpeg",[
      "-hide_banner","-loglevel","error","-y","-f","concat","-safe","0","-i",manifest,
      "-fps_mode","vfr","-c:v","libvpx-vp9","-pix_fmt","yuva420p","-auto-alt-ref","0",
      "-deadline","good","-cpu-used","4","-row-mt","1","-b:v","0","-crf","30",dest
    ]);
    const probe = JSON.parse(run(process.env.CCF_FFPROBE ?? "ffprobe",["-v","error","-show_entries","format=duration:stream=codec_name,width,height:stream_tags=alpha_mode","-of","json",dest]));
    const stream = probe.streams?.[0];
    const expected = clip.frames.reduce((sum,frame)=>sum+frame.ms,0)/1000;
    if (stream?.codec_name !== "vp9" || stream.width !== 512 || stream.height !== 512 || stream.tags?.alpha_mode !== "1")
      throw new Error(`Invalid transparent WebM: ${dest}`);
    if (Math.abs(Number(probe.format?.duration)-expected) > 0.04)
      throw new Error(`Bad duration for ${dest}: ${probe.format?.duration}s, expected ${expected}s`);
    process.stdout.write(`${path.relative(root,dest)} ${expected.toFixed(3)}s ${fs.statSync(dest).size} bytes\n`);
  }
  fs.mkdirSync(path.join(output,"thumbnails"),{recursive:true});
  for (const state of names) fs.copyFileSync(path.join(scratch,`thumbnail-${state}.png`),path.join(output,"thumbnails",`${state}.png`));
} finally {
  // Only remove the unique, freshly created temporary directory under os.tmpdir().
  if (path.dirname(scratch) === os.tmpdir() && path.basename(scratch).startsWith("ccf-chaos-cat-v03-"))
    fs.rmSync(scratch,{recursive:true,force:true});
}
