/**
 * Asset pipeline for the stuntman-chris game.
 *
 * Raw art ships as ~1.8GB of PNG sequences under
 * public/images/games/meebel-knievel/ (read-only source — this script never
 * writes there). Frames are rendered on huge canvases (1023×1023 for Chris,
 * 1920×1080 for the skeleton throws) with most of the canvas transparent, and
 * the skeleton throws are stored as effectively-uncompressed PNGs at ~8MB per
 * frame. None of that can ship.
 *
 * This script converts them into web-ready WebP spritesheets + compressed
 * statics under public/images/games/stuntman-chris/, and emits a typed
 * manifest at components/games/stuntman-chris/lib/assets.generated.ts that the
 * renderer consumes.
 *
 * Run with:
 *   npx tsx scripts/build-stuntman-chris-assets.ts
 *
 * It is idempotent: the output directory is wiped and rebuilt on every run.
 *
 * Key ideas
 * ---------
 * - UNION crop. Every frame of a sequence is cropped to the SAME box (the
 *   union of all frames' content bounding boxes). That preserves inter-frame
 *   registration, so the renderer can draw a sequence at one anchor point.
 *   The box origin is published as trimX/trimY in the source canvas so the
 *   renderer can reconstruct absolute positions.
 * - Stray-pixel-proof bbox. The renders contain isolated 1px specks (e.g. a
 *   permanent alpha-48 dot at 1919,0 in every skeleton-throw frame) plus a
 *   haze of alpha-1..8 dither, either of which would blow the union box out to
 *   the full canvas. Detection therefore runs on a 4×4 block map that requires
 *   two solid pixels per block, then refines to exact pixel bounds inside that
 *   coarse box.
 * - Subsampling. The 96-frame skeleton throws drop to every 2nd frame and play
 *   at half fps — identical wall-clock duration, half the texture.
 */
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "public", "images", "games", "meebel-knievel");
const OUT = path.join(ROOT, "public", "images", "games", "stuntman-chris");
const OUT_SHEETS = path.join(OUT, "sheets");
const OUT_EXTRAS = path.join(OUT, "extras");
const PUBLIC_PREFIX = "/images/games/stuntman-chris";
const MANIFEST = path.join(
  ROOT,
  "components",
  "games",
  "stuntman-chris",
  "lib",
  "assets.generated.ts",
);

/** Max spritesheet edge. 4096 is the safe floor for WebGL/canvas textures. */
const MAX_SHEET_EDGE = 4096;
/** Padding added around the measured union crop box, in source px. */
const CROP_PAD = 2;
/** Downsample factor for coarse (speck-proof) bbox detection. */
const DS = 4;
/**
 * Coarse qualification: a DS×DS block counts as "content" only if it holds at
 * least COARSE_MIN_PX pixels above COARSE_ALPHA. A mean-alpha test is NOT
 * enough — the throw renders carry a permanent alpha-48 speck at (1919,0)
 * whose 4×4 block means 4.19, which sits inside any sane mean threshold and
 * would drag the union box out to the full 1920×1080 canvas.
 */
const COARSE_ALPHA = 16;
const COARSE_MIN_PX = 2;
/** Exact threshold applied inside the coarse box. */
const EXACT_T = 12;
/**
 * A frame holding fewer than this many qualifying pixels is treated as blank.
 * Real frames run to thousands; the handful that sit below the line are
 * antialiasing residue in the derived bone layer (the combined and skeleonly
 * renders disagree by a few pixels around the skeleton's hand), and letting
 * them count would keep ~20 junk frames alive in the bone sheet.
 */
const MIN_CONTENT_PX = 24;
/** How many frames to decode in parallel. */
const BATCH = 8;

const SHEET_WEBP: sharp.WebpOptions = {
  quality: 80,
  alphaQuality: 100,
  effort: 6,
};
const STATIC_WEBP: sharp.WebpOptions = {
  quality: 85,
  alphaQuality: 100,
  effort: 6,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Natural (numeric-aware) sort — filename patterns are inconsistent across folders. */
function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function listPngs(dirAbs: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirAbs);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .sort(naturalSort);
}

async function fileSize(abs: string): Promise<number> {
  try {
    return (await fs.stat(abs)).size;
  } catch {
    return 0;
  }
}

async function dirSize(abs: string): Promise<number> {
  let total = 0;
  const stack = [abs];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else total += (await fs.stat(p)).size;
    }
  }
  return total;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const res = await Promise.all(chunk.map((it, k) => fn(it, i + k)));
    res.forEach((r, k) => {
      out[i + k] = r;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frame sources
// ---------------------------------------------------------------------------

interface RawFrame {
  /** RGBA, row-major, width*height*4 bytes. */
  data: Buffer;
  width: number;
  height: number;
}

type FrameLoader = (index: number) => Promise<RawFrame>;

async function loadPng(abs: string): Promise<RawFrame> {
  const { data, info } = await sharp(abs)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * bone_throw_1's `_boneonly` folder shipped EMPTY, but the combined
 * `pngseq_skelethrow1` render does contain the bone. Because `_skeleonly` is
 * the exact skeleton layer of the same render, `combined − skeleonly` recovers
 * the bone as a clean isolated layer (verified visually: no skeleton ghosting).
 */
async function loadDiff(combinedAbs: string, baseAbs: string): Promise<RawFrame> {
  const [a, b] = await Promise.all([loadPng(combinedAbs), loadPng(baseAbs)]);
  const out = Buffer.alloc(a.data.length);
  for (let i = 0; i < a.data.length; i += 4) {
    const d =
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]) +
      Math.abs(a.data[i + 3] - b.data[i + 3]);
    if (d > 12) {
      out[i] = a.data[i];
      out[i + 1] = a.data[i + 1];
      out[i + 2] = a.data[i + 2];
      out[i + 3] = a.data[i + 3];
    }
  }
  return { data: out, width: a.width, height: a.height };
}

// ---------------------------------------------------------------------------
// Bounding boxes
// ---------------------------------------------------------------------------

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Pixels the coarse filter threw away that also sat OUTSIDE the frame's coarse
 * box — i.e. the only rejects that could actually shrink the crop. Interior
 * rejects are just dither noise inside the silhouette and are ignored.
 */
let rejectedOutsidePx = 0;

/**
 * Content bbox of one frame, immune to isolated render specks.
 *
 * Pass 1 tallies, per DS×DS block, how many pixels clear COARSE_ALPHA. A lone
 * render speck never reaches COARSE_MIN_PX, while genuine content — even a
 * 1px-wide bright line, which crosses a block in 4 pixels — always does. Pass
 * 2 then re-scans the coarse box (expanded by 4 blocks of slack) at full
 * resolution so soft antialiased fringes aren't quantized away.
 */
function contentBox(frame: RawFrame): Box | null {
  const { data, width: w, height: h } = frame;
  const dw = Math.ceil(w / DS);
  const dh = Math.ceil(h / DS);
  const acc = new Uint16Array(dw * dh);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    const brow = ((y / DS) | 0) * dw;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > COARSE_ALPHA) acc[brow + ((x / DS) | 0)]++;
    }
  }
  let bMinX = dw,
    bMinY = dh,
    bMaxX = -1,
    bMaxY = -1;
  for (let by = 0; by < dh; by++) {
    const r = by * dw;
    for (let bx = 0; bx < dw; bx++) {
      if (acc[r + bx] >= COARSE_MIN_PX) {
        if (bx < bMinX) bMinX = bx;
        if (bx > bMaxX) bMaxX = bx;
        if (by < bMinY) bMinY = by;
        if (by > bMaxY) bMaxY = by;
      }
    }
  }
  if (bMaxX < 0) return null;

  for (let by = 0; by < dh; by++) {
    const r = by * dw;
    const outsideRow = by < bMinY - 4 || by > bMaxY + 4;
    for (let bx = 0; bx < dw; bx++) {
      const c = acc[r + bx];
      if (c === 0 || c >= COARSE_MIN_PX) continue;
      if (outsideRow || bx < bMinX - 4 || bx > bMaxX + 4) rejectedOutsidePx += c;
    }
  }

  const slack = DS * 4;
  const x0 = Math.max(0, bMinX * DS - slack);
  const y0 = Math.max(0, bMinY * DS - slack);
  const x1 = Math.min(w - 1, (bMaxX + 1) * DS - 1 + slack);
  const y1 = Math.min(h - 1, (bMaxY + 1) * DS - 1 + slack);

  let minX = x1 + 1,
    minY = y1 + 1,
    maxX = x0 - 1,
    maxY = y0 - 1,
    count = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * w * 4;
    for (let x = x0; x <= x1; x++) {
      if (data[row + x * 4 + 3] > EXACT_T) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || count < MIN_CONTENT_PX) return null;
  return { minX, minY, maxX, maxY };
}

function unionBox(boxes: Array<Box | null>): Box | null {
  let u: Box | null = null;
  for (const b of boxes) {
    if (!b) continue;
    u = u
      ? {
          minX: Math.min(u.minX, b.minX),
          minY: Math.min(u.minY, b.minY),
          maxX: Math.max(u.maxX, b.maxX),
          maxY: Math.max(u.maxY, b.maxY),
        }
      : { ...b };
  }
  return u;
}

// ---------------------------------------------------------------------------
// Sheet packing
// ---------------------------------------------------------------------------

/** Pick a near-square column count that keeps both sheet edges under the cap. */
function chooseCols(n: number, fw: number, fh: number): number {
  const maxCols = Math.max(1, Math.floor(MAX_SHEET_EDGE / fw));
  const maxRows = Math.max(1, Math.floor(MAX_SHEET_EDGE / fh));
  let cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt((n * fh) / fw))));
  while (Math.ceil(n / cols) > maxRows && cols < maxCols) cols++;
  if (Math.ceil(n / cols) > maxRows) {
    throw new Error(
      `cannot fit ${n} frames of ${fw}×${fh} within ${MAX_SHEET_EDGE}px`,
    );
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Sequence specs
// ---------------------------------------------------------------------------

/** How the packed frame size is derived from the cropped source box. */
type SizeRule =
  | { kind: "maxEdge"; px: number }
  | { kind: "width"; px: number }
  | { kind: "scale"; factor: number };

interface SequenceSpec {
  /** camelCase manifest key. */
  key: string;
  /** Output filename stem under sheets/. */
  file: string;
  /**
   * Source folder relative to SRC, an explicit ordered file list, or a diff
   * pair for layers that have to be recovered from a combined render.
   */
  src: string | { files: string[] } | { combined: string; base: string };
  /** Keep every Nth frame (1 = all). */
  step?: number;
  /** Optional inclusive source-frame range (before stepping). */
  range?: [number, number];
  size: SizeRule;
  fps: number;
  loop: boolean;
  note?: string;
}

const SEQUENCES: SequenceSpec[] = [
  // --- Chris ------------------------------------------------------------
  // 1023×1023 canvases; union boxes stay near-full for the bike poses (the
  // bike wheels reach the edges) so the win here is the downscale, not the
  // crop. 360px max edge is ~4× the on-screen size.
  {
    key: "chrisIdle",
    file: "chris-idle",
    src: "Chris_motorbike_idle",
    size: { kind: "maxEdge", px: 360 },
    fps: 24,
    loop: true,
  },
  {
    key: "chrisIdleTransition",
    file: "chris-idle-transition",
    src: "Chris_motorbike_idle_transition",
    size: { kind: "maxEdge", px: 360 },
    fps: 24,
    loop: false,
  },
  {
    key: "chrisRiding",
    file: "chris-riding",
    src: "Chris_motorbike_riding",
    size: { kind: "maxEdge", px: 360 },
    fps: 24,
    loop: true,
  },
  {
    key: "chrisFlying",
    file: "chris-flying",
    src: "Chris_flying",
    size: { kind: "maxEdge", px: 360 },
    fps: 24,
    loop: true,
  },
  {
    key: "chrisDeathLaser",
    file: "chris-death-laser",
    src: "Chris_death_laser",
    size: { kind: "maxEdge", px: 360 },
    fps: 24,
    loop: false,
    note: "final frame is intentionally blank (fade-out)",
  },
  // --- Props ------------------------------------------------------------
  {
    key: "rampUfo",
    file: "ramp-ufo",
    src: "Ramp",
    size: { kind: "scale", factor: 0.75 },
    fps: 24,
    loop: true,
  },
  {
    key: "powerMeter",
    file: "power-meter",
    src: "UI/Power Meter",
    step: 2,
    size: { kind: "width", px: 640 },
    fps: 12,
    loop: false,
  },
  {
    key: "viz",
    file: "viz",
    src: "Extras/Viz",
    size: { kind: "scale", factor: 1 },
    fps: 24,
    loop: true,
  },
  // --- Skeleton throws --------------------------------------------------
  // Skeleton and bone are separate sheets so the renderer can collide the
  // bone independently. Both layers are subsampled with the same step and
  // parity, so bone frame k lines up with skeleton frame k + (firstSrcFrame/2)
  // — see the build log for each bone's source range.
  //
  // The skeletons sit in a small fixed box and take scale 0.75. The bones do
  // NOT: their union box is dominated by flight travel (nearly half the
  // 1920×1080 canvas), so 0.75 would produce a 4000px sheet. They are capped
  // at a 512px longest edge instead.
  {
    key: "skeleton1",
    file: "skeleton1",
    src: "Skeleton_Throw_Obstacle/bone_throw_1_anims/pngseq_skelethrow1_skeleonly",
    step: 2,
    size: { kind: "scale", factor: 0.75 },
    fps: 12,
    loop: false,
  },
  {
    key: "skeleton1Bone",
    file: "skeleton1-bone",
    src: {
      combined: "Skeleton_Throw_Obstacle/bone_throw_1_anims/pngseq_skelethrow1",
      base: "Skeleton_Throw_Obstacle/bone_throw_1_anims/pngseq_skelethrow1_skeleonly",
    },
    step: 2,
    size: { kind: "maxEdge", px: 512 },
    fps: 12,
    loop: false,
    note: "recovered from combined − skeleonly (source _boneonly folder is empty)",
  },
  {
    key: "skeleton2",
    file: "skeleton2",
    src: "Skeleton_Throw_Obstacle/bone_throw_2_anims/pngseq_skelethrow2_skeleonly",
    step: 2,
    size: { kind: "scale", factor: 0.75 },
    fps: 12,
    loop: false,
  },
  {
    key: "skeleton2Bone",
    file: "skeleton2-bone",
    src: "Skeleton_Throw_Obstacle/bone_throw_2_anims/pngseq_skelethrow2_boneonly",
    step: 2,
    size: { kind: "maxEdge", px: 512 },
    fps: 12,
    loop: false,
  },
  // --- Powerup ----------------------------------------------------------
  // MoonBoots_01..04.gif are single-frame stills (ffprobe: nb_read_frames=1)
  // but they are NOT four different powerups — the boots are pixel-identical
  // and only the sparkle overlay changes, i.e. it's a 4-frame twinkle loop
  // delivered as four files. Packed as one looping sheet.
  {
    key: "moonboots",
    file: "moonboots",
    src: {
      files: [
        "Powerups_moonboots/MoonBoots_01.gif",
        "Powerups_moonboots/MoonBoots_02.gif",
        "Powerups_moonboots/MoonBoots_03.gif",
        "Powerups_moonboots/MoonBoots_04.gif",
      ],
    },
    size: { kind: "maxEdge", px: 512 },
    fps: 8,
    loop: true,
  },
];

/**
 * Sequences whose leading/trailing blank frames should be dropped instead of
 * packed. Only the bone layers qualify: the bone is airborne for a short
 * window of an otherwise 96-frame clip, and packing 80 empty cells would waste
 * most of the texture. The trimmed start index is reported so the renderer can
 * align the bone against its skeleton sheet.
 */
const TRIM_BLANK_FRAMES = new Set(["skeleton1Bone", "skeleton2Bone"]);

// ---------------------------------------------------------------------------
// Static image specs
// ---------------------------------------------------------------------------

interface StaticSpec {
  key: string;
  file: string;
  src: string;
  /** Longest-edge cap; omit to keep native size. */
  maxEdge?: number;
  /** Output subdirectory relative to OUT. */
  sub?: string;
  /**
   * Force lossless even when lossy is smaller. Set on the parallax layers:
   * they are tiled edge-to-edge, and WebP's block quantizer treats the left
   * and right edge columns independently, which can leave a faint vertical
   * seam at every wrap.
   */
  forceLossless?: boolean;
  note?: string;
}

const STATICS: StaticSpec[] = [
  // Parallax layers must tile seamlessly — never trimmed, never resized.
  {
    key: "backgroundDusk",
    file: "background-dusk",
    src: "Backgrounds/background_dusk.png",
    forceLossless: true,
  },
  {
    key: "midgroundDusk",
    file: "midground-dusk",
    src: "Midgrounds/midground_dusk.png",
    forceLossless: true,
  },
  {
    key: "foregroundDusk",
    file: "foreground-dusk",
    src: "Foregrounds/foreground_dusk.png",
    forceLossless: true,
  },
  {
    key: "foregroundDusk2",
    file: "foreground-dusk-2",
    src: "Foregrounds/foreground_dusk_2.png",
    forceLossless: true,
  },
  { key: "powerButton", file: "power-button", src: "UI/Power Button/Power Button_.png" },
  { key: "titleLogo", file: "title-logo", src: "UI/Title Logo/Title Logo_no effect.png" },
  {
    key: "titleLogoFx",
    file: "title-logo-fx",
    src: "UI/Title Logo/Title Logo_with effect.png",
  },
  {
    key: "instructionBg",
    file: "instruction-bg",
    src: "UI/Instruction Screen/Instruction_background.png",
  },
  { key: "startScreenPoster", file: "startscreen-1", src: "startscreen_1.png" },
];

const MEEBITS_DIR = "Extras/Extra Meebits Spritesheet";

// ---------------------------------------------------------------------------
// Build steps
// ---------------------------------------------------------------------------

interface SheetResult {
  key: string;
  url: string;
  frameCount: number;
  cols: number;
  rows: number;
  frameW: number;
  frameH: number;
  fps: number;
  loop: boolean;
  srcCanvasW: number;
  srcCanvasH: number;
  trimX: number;
  trimY: number;
  scale: number;
  /** Reporting only — not part of the manifest. */
  meta: {
    before: number;
    after: number;
    sheetW: number;
    sheetH: number;
    cropW: number;
    cropH: number;
    srcFrames: number;
    firstSrcFrame: number;
    lastSrcFrame: number;
    step: number;
    note?: string;
  };
}

async function buildSequence(spec: SequenceSpec): Promise<SheetResult> {
  const step = spec.step ?? 1;

  // ---- resolve the frame list -----------------------------------------
  let loader: FrameLoader;
  let srcCount: number;
  let bytesBefore = 0;
  let srcLabel: string;

  if (typeof spec.src === "string") {
    const dir = path.join(SRC, spec.src);
    const files = await listPngs(dir);
    if (!files.length) throw new Error(`no PNGs in ${spec.src}`);
    srcCount = files.length;
    srcLabel = spec.src;
    for (const f of files) bytesBefore += await fileSize(path.join(dir, f));
    loader = (i) => loadPng(path.join(dir, files[i]));
  } else if ("files" in spec.src) {
    const files = spec.src.files.map((f) => path.join(SRC, f));
    srcCount = files.length;
    srcLabel = spec.src.files[0];
    for (const f of files) bytesBefore += await fileSize(f);
    loader = (i) => loadPng(files[i]);
  } else {
    const cDir = path.join(SRC, spec.src.combined);
    const bDir = path.join(SRC, spec.src.base);
    const cFiles = await listPngs(cDir);
    const bFiles = await listPngs(bDir);
    if (!cFiles.length || cFiles.length !== bFiles.length) {
      throw new Error(`diff source mismatch for ${spec.key}`);
    }
    srcCount = cFiles.length;
    srcLabel = `${spec.src.combined} − skeleonly`;
    for (const f of cFiles) bytesBefore += await fileSize(path.join(cDir, f));
    loader = (i) =>
      loadDiff(path.join(cDir, cFiles[i]), path.join(bDir, bFiles[i]));
  }

  const [lo, hi] = spec.range ?? [0, srcCount - 1];
  let indices: number[] = [];
  for (let i = lo; i <= hi; i += step) indices.push(i);

  // ---- pass 1: measure -------------------------------------------------
  rejectedOutsidePx = 0;
  const boxes = await mapLimit(indices, BATCH, async (i) => {
    const frame = await loader(i);
    return { box: contentBox(frame), w: frame.width, h: frame.height };
  });
  const srcCanvasW = boxes[0].w;
  const srcCanvasH = boxes[0].h;
  const coarseRejected = rejectedOutsidePx;

  if (TRIM_BLANK_FRAMES.has(spec.key)) {
    let first = boxes.findIndex((b) => b.box !== null);
    let last = boxes.length - 1;
    while (last >= 0 && boxes[last].box === null) last--;
    if (first < 0) throw new Error(`${spec.key}: every frame is blank`);
    indices = indices.slice(first, last + 1);
    boxes.splice(last + 1);
    boxes.splice(0, first);
  }

  const union = unionBox(boxes.map((b) => b.box));
  if (!union) throw new Error(`${spec.key}: no content in any frame`);

  const trimX = Math.max(0, union.minX - CROP_PAD);
  const trimY = Math.max(0, union.minY - CROP_PAD);
  const cropW = Math.min(srcCanvasW - trimX, union.maxX + CROP_PAD - trimX + 1);
  const cropH = Math.min(srcCanvasH - trimY, union.maxY + CROP_PAD - trimY + 1);

  // ---- derive packed frame size ---------------------------------------
  let scale: number;
  switch (spec.size.kind) {
    case "maxEdge":
      scale = Math.min(1, spec.size.px / Math.max(cropW, cropH));
      break;
    case "width":
      scale = Math.min(1, spec.size.px / cropW);
      break;
    case "scale":
      scale = spec.size.factor;
      break;
  }
  const frameW = Math.max(1, Math.round(cropW * scale));
  const frameH = Math.max(1, Math.round(cropH * scale));
  // Report the scale actually realised after integer rounding.
  const realScale = frameW / cropW;

  const cols = chooseCols(indices.length, frameW, frameH);
  const rows = Math.ceil(indices.length / cols);
  const sheetW = cols * frameW;
  const sheetH = rows * frameH;

  // ---- pass 2: crop, resize, composite --------------------------------
  const composites = await mapLimit(indices, BATCH, async (srcIdx, i) => {
    const frame = await loader(srcIdx);
    const buf = await sharp(frame.data, {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    })
      .extract({ left: trimX, top: trimY, width: cropW, height: cropH })
      .resize(frameW, frameH, { kernel: sharp.kernel.lanczos3, fit: "fill" })
      .raw()
      .toBuffer();
    return {
      input: buf,
      raw: { width: frameW, height: frameH, channels: 4 as const },
      left: (i % cols) * frameW,
      top: Math.floor(i / cols) * frameH,
    };
  });

  const outAbs = path.join(OUT_SHEETS, `${spec.file}.webp`);
  await sharp({
    create: {
      width: sheetW,
      height: sheetH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .webp(SHEET_WEBP)
    .toFile(outAbs);

  const after = await fileSize(outAbs);

  console.log(
    `  ${spec.key.padEnd(20)} ${String(indices.length).padStart(3)}f  src ${srcCanvasW}×${srcCanvasH}` +
      `  crop ${cropW}×${cropH} @(${trimX},${trimY})  frame ${frameW}×${frameH}` +
      `  sheet ${cols}×${rows}=${sheetW}×${sheetH}  ${formatBytes(bytesBefore).padStart(10)} → ${formatBytes(after).padStart(9)}`,
  );
  if (spec.note) console.log(`  ${"".padEnd(20)} note: ${spec.note}`);
  if (srcLabel && indices.length !== srcCount) {
    console.log(
      `  ${"".padEnd(20)} using source frames ${indices[0]}..${indices[indices.length - 1]} step ${step} of ${srcCount}`,
    );
  }
  const blanks = boxes.reduce((a, b) => a + (b.box ? 0 : 1), 0);
  if (blanks) console.log(`  ${"".padEnd(20)} ${blanks} blank frame(s) packed`);
  // Sanity: how much did the speck filter discard? A handful of pixels per
  // frame is the known render noise; hundreds would mean real art was cut.
  const perFrame = coarseRejected / indices.length;
  console.log(
    `  ${"".padEnd(20)} coarse filter dropped ${coarseRejected} px (${perFrame.toFixed(1)}/frame)` +
      (perFrame > 40 ? "   <<< CHECK FOR CLIPPING" : ""),
  );

  return {
    key: spec.key,
    url: `${PUBLIC_PREFIX}/sheets/${spec.file}.webp`,
    frameCount: indices.length,
    cols,
    rows,
    frameW,
    frameH,
    fps: spec.fps,
    loop: spec.loop,
    srcCanvasW,
    srcCanvasH,
    trimX,
    trimY,
    scale: realScale,
    meta: {
      before: bytesBefore,
      after,
      sheetW,
      sheetH,
      cropW,
      cropH,
      srcFrames: srcCount,
      firstSrcFrame: indices[0],
      lastSrcFrame: indices[indices.length - 1],
      step,
      note: spec.note,
    },
  };
}

interface ImageResult {
  key: string;
  url: string;
  w: number;
  h: number;
  before: number;
  after: number;
}

async function buildStatic(spec: StaticSpec): Promise<ImageResult> {
  const srcAbs = path.join(SRC, spec.src);
  const before = await fileSize(srcAbs);
  const meta = await sharp(srcAbs).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  const longest = Math.max(srcW, srcH);
  const factor = spec.maxEdge ? Math.min(1, spec.maxEdge / longest) : 1;
  const w = Math.max(1, Math.round(srcW * factor));
  const h = Math.max(1, Math.round(srcH * factor));

  const dir = spec.sub ? path.join(OUT, spec.sub) : OUT;
  await fs.mkdir(dir, { recursive: true });
  const outAbs = path.join(dir, `${spec.file}.webp`);

  const base = () => {
    let p = sharp(srcAbs, { animated: false }).ensureAlpha();
    if (factor < 1) {
      p = p.resize(w, h, { kernel: sharp.kernel.lanczos3, fit: "fill" });
    }
    return p;
  };
  // Flat pixel art (the meebit sheets, the gradient-free sky) encodes smaller
  // AND exactly with lossless WebP; photographic-ish art wants lossy. Try both
  // and keep whichever is smaller — the encode cost here is milliseconds.
  const [lossy, lossless] = await Promise.all([
    spec.forceLossless ? null : base().webp(STATIC_WEBP).toBuffer(),
    base().webp({ lossless: true, effort: 6 }).toBuffer(),
  ]);
  const chosen = !lossy || lossless.length < lossy.length ? lossless : lossy;
  await fs.writeFile(outAbs, chosen);

  const after = chosen.length;
  const rel = spec.sub ? `${spec.sub}/${spec.file}.webp` : `${spec.file}.webp`;
  console.log(
    `  ${spec.key.padEnd(20)} ${`${srcW}×${srcH}`.padEnd(11)}→ ${`${w}×${h}`.padEnd(11)}` +
      ` ${formatBytes(before).padStart(10)} → ${formatBytes(after).padStart(9)}` +
      `  ${chosen === lossless ? "lossless" : "q85"}`,
  );
  return { key: spec.key, url: `${PUBLIC_PREFIX}/${rel}`, w, h, before, after };
}

async function buildVideo(): Promise<ImageResult> {
  const srcAbs = path.join(SRC, "Start Screen_3.mp4");
  const outAbs = path.join(OUT, "start-screen.mp4");
  const before = await fileSize(srcAbs);
  // Audio track is digital silence (volumedetect: mean/max −91 dB) → drop it.
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel", "error",
      "-i", srcAbs,
      "-an",
      "-c:v", "libx264",
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-crf", "26",
      "-preset", "slow",
      "-movflags", "+faststart",
      outAbs,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const after = await fileSize(outAbs);
  console.log(
    `  ${"startScreenVideo".padEnd(20)} ${"1080×1080".padEnd(11)}→ ${"1080×1080".padEnd(11)}` +
      ` ${formatBytes(before).padStart(10)} → ${formatBytes(after).padStart(9)}`,
  );
  return {
    key: "startScreenVideo",
    url: `${PUBLIC_PREFIX}/start-screen.mp4`,
    w: 1080,
    h: 1080,
    before,
    after,
  };
}

async function buildMeebits(): Promise<ImageResult[]> {
  const dir = path.join(SRC, MEEBITS_DIR);
  const files = await listPngs(dir);
  const out: ImageResult[] = [];
  for (const f of files) {
    const id = path.basename(f, ".png");
    out.push(
      await buildStatic({
        key: `meebit${id}`,
        file: `meebit-${id}`,
        src: `${MEEBITS_DIR}/${f}`,
        sub: "extras",
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function renderManifest(sheets: SheetResult[], images: ImageResult[]): string {
  const sprite = (s: SheetResult) =>
    [
      `  ${s.key}: {`,
      `    url: ${JSON.stringify(s.url)},`,
      `    frameCount: ${s.frameCount},`,
      `    cols: ${s.cols},`,
      `    rows: ${s.rows},`,
      `    frameW: ${s.frameW},`,
      `    frameH: ${s.frameH},`,
      `    fps: ${s.fps},`,
      `    loop: ${s.loop},`,
      `    srcCanvasW: ${s.srcCanvasW},`,
      `    srcCanvasH: ${s.srcCanvasH},`,
      `    trimX: ${s.trimX},`,
      `    trimY: ${s.trimY},`,
      `    scale: ${Number(s.scale.toFixed(6))},`,
      `  },`,
    ].join("\n");

  const image = (i: ImageResult) =>
    `  ${i.key}: { url: ${JSON.stringify(i.url)}, w: ${i.w}, h: ${i.h} },`;

  return `// AUTO-GENERATED by scripts/build-stuntman-chris-assets.ts — do not edit by hand.
export interface SpriteSheetMeta {
  url: string;        // public path, e.g. "/images/games/stuntman-chris/sheets/chris-flying.webp"
  frameCount: number;
  cols: number;
  rows: number;
  frameW: number;     // packed frame px
  frameH: number;
  fps: number;        // playback fps (all sources render at 24fps; 12 for the frame-halved skeleton + power meter — i.e. halve fps when you halve frames)
  loop: boolean;      // idle/riding/flying/ramp/viz loop; transition/death/throws/meter don't
  srcCanvasW: number; // original per-frame canvas (1023, 1920, etc.)
  srcCanvasH: number;
  trimX: number;      // crop box origin in source canvas
  trimY: number;
  scale: number;      // packed px / source px
}
export interface StaticImageMeta { url: string; w: number; h: number; }
export const SPRITES = {
${sheets.map(sprite).join("\n")}
} as const satisfies Record<string, SpriteSheetMeta>;
export const IMAGES = {
${images.map(image).join("\n")}
} as const satisfies Record<string, StaticImageMeta>;
export type SpriteKey = keyof typeof SPRITES;
export type ImageKey = keyof typeof IMAGES;
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const srcTotal = await dirSize(SRC);
  console.log(`Source: ${SRC}`);
  console.log(`        ${formatBytes(srcTotal)} raw\n`);

  // Idempotent: nuke and recreate the output tree.
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT_SHEETS, { recursive: true });
  await fs.mkdir(OUT_EXTRAS, { recursive: true });
  await fs.mkdir(path.dirname(MANIFEST), { recursive: true });

  console.log("Spritesheets");
  const sheets: SheetResult[] = [];
  for (const spec of SEQUENCES) sheets.push(await buildSequence(spec));

  console.log("\nStatics");
  const images: ImageResult[] = [];
  for (const spec of STATICS) images.push(await buildStatic(spec));
  images.push(await buildVideo());

  console.log("\nExtras (meebit sheets)");
  images.push(...(await buildMeebits()));

  await fs.writeFile(MANIFEST, renderManifest(sheets, images), "utf8");

  const outTotal = await dirSize(OUT);
  const sheetTotal = sheets.reduce((a, s) => a + s.meta.after, 0);
  const imgTotal = images.reduce((a, i) => a + i.after, 0);
  console.log(
    `\nSheets ${formatBytes(sheetTotal)} + statics/extras ${formatBytes(imgTotal)}`,
  );
  console.log(
    `TOTAL OUTPUT: ${formatBytes(outTotal)}  (from ${formatBytes(srcTotal)} raw, ` +
      `${((1 - outTotal / srcTotal) * 100).toFixed(2)}% smaller)`,
  );
  console.log(`Manifest: ${path.relative(ROOT, MANIFEST)}`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
