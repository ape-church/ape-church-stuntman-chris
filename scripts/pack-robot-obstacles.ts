/**
 * One-off packer for the late-arriving Robot_Obstacles drop (the laser-source
 * character delivered AFTER the main raw-art drop was taken away).
 *
 * Mirrors scripts/build-stuntman-chris-assets.ts conventions exactly — union
 * content crop, near-square grid, frame-halving to 12fps, lossy WebP q80 —
 * and prints the SpriteSheetMeta entry to paste into assets.generated.ts
 * (which cannot be regenerated here: the 1.8GB meebel-knievel drop is not in
 * this repo). On re-integration, fold this sequence into the main pipeline's
 * SEQUENCES list and delete this script.
 *
 *   npx tsx scripts/pack-robot-obstacles.ts
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";

const SRC = "public/images/games/stuntman-chris/sheets/Robot_Obstacles";
const OUT = "public/images/games/stuntman-chris/sheets/robot-obstacle.webp";
const STEP = 2; // 90 → 45 frames, 24fps → 12fps (skeleton precedent)
const FPS = 12;
const MAX_EDGE = 360; // Chris-sheet precedent: ~4× the on-screen size
const ALPHA_MIN = 8;
const MIN_CONTENT_PX = 24;
const MAX_SHEET_EDGE = 4096;

interface Box { minX: number; minY: number; maxX: number; maxY: number }

async function contentBox(file: string): Promise<{ box: Box | null; w: number; h: number }> {
  const img = sharp(file).ensureAlpha();
  const { width: w = 0, height: h = 0 } = await img.metadata();
  const raw = await img.raw().toBuffer();
  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (raw[(y * w + x) * 4 + 3] > ALPHA_MIN) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        count++;
      }
    }
  }
  return { box: maxX < minX || count < MIN_CONTENT_PX ? null : { minX, minY, maxX, maxY }, w, h };
}

function chooseCols(n: number, fw: number, fh: number): number {
  const maxCols = Math.max(1, Math.floor(MAX_SHEET_EDGE / fw));
  const maxRows = Math.max(1, Math.floor(MAX_SHEET_EDGE / fh));
  let cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt((n * fh) / fw))));
  while (Math.ceil(n / cols) > maxRows && cols < maxCols) cols++;
  if (Math.ceil(n / cols) > maxRows) throw new Error("cannot fit sheet");
  return cols;
}

async function main() {
  const files = (await fs.readdir(SRC)).filter((f) => f.endsWith(".png")).sort();
  const stepped = files.filter((_, i) => i % STEP === 0);
  console.log(`${files.length} source frames → ${stepped.length} packed @ ${FPS}fps`);

  let union: Box | null = null;
  let srcW = 0, srcH = 0;
  for (const f of stepped) {
    const { box, w, h } = await contentBox(path.join(SRC, f));
    srcW = w; srcH = h;
    if (!box) continue;
    union = union
      ? {
          minX: Math.min(union.minX, box.minX),
          minY: Math.min(union.minY, box.minY),
          maxX: Math.max(union.maxX, box.maxX),
          maxY: Math.max(union.maxY, box.maxY),
        }
      : { ...box };
  }
  if (!union) throw new Error("no content found");

  const cropW = union.maxX - union.minX + 1;
  const cropH = union.maxY - union.minY + 1;
  const scale = Math.min(1, MAX_EDGE / Math.max(cropW, cropH));
  const frameW = Math.round(cropW * scale);
  const frameH = Math.round(cropH * scale);
  const cols = chooseCols(stepped.length, frameW, frameH);
  const rows = Math.ceil(stepped.length / cols);

  const composites: sharp.OverlayOptions[] = [];
  for (let i = 0; i < stepped.length; i++) {
    const buf = await sharp(path.join(SRC, stepped[i]))
      .extract({ left: union.minX, top: union.minY, width: cropW, height: cropH })
      .resize(frameW, frameH)
      .png()
      .toBuffer();
    composites.push({ input: buf, left: (i % cols) * frameW, top: Math.floor(i / cols) * frameH });
  }

  await sharp({
    create: { width: cols * frameW, height: rows * frameH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .webp({ quality: 80, alphaQuality: 80, effort: 6 })
    .toFile(OUT);

  const bytes = (await fs.stat(OUT)).size;
  console.log(`wrote ${OUT} — ${cols}×${rows} grid, ${(bytes / 1024).toFixed(0)}KB`);
  console.log("\nPaste into assets.generated.ts SPRITES:\n");
  console.log(`  robotObstacle: {
    url: "/images/games/stuntman-chris/sheets/robot-obstacle.webp",
    frameCount: ${stepped.length},
    cols: ${cols},
    rows: ${rows},
    frameW: ${frameW},
    frameH: ${frameH},
    fps: ${FPS},
    loop: false,
    srcCanvasW: ${srcW},
    srcCanvasH: ${srcH},
    trimX: ${union.minX},
    trimY: ${union.minY},
    scale: ${Number(scale.toFixed(6))},
  },`);
}

main();
