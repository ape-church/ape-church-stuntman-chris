/**
 * Stuntman Chris — parallax layers + the sky the camera reveals above them.
 *
 * The three dusk layers are authored to loop horizontally at 1920×1080, so a
 * layer is drawn as N tiles of `meta.w * (DESIGN_H / meta.h)` px wide, laid
 * from the first tile whose world span crosses the left edge. Tile indices are
 * derived from `floor(p / tileW)` rather than a modulo so negative camera
 * offsets need no sign fix-up.
 *
 * Vertical camera is applied UNIFORMLY to all three layers (only the
 * horizontal scroll is parallaxed). The layers share one authored horizon;
 * moving them apart vertically would tear it. Panning them together instead
 * reads as a plain camera pan and exposes sky above the background's top edge,
 * which `paintSky` fills.
 */

import type { StaticImageMeta } from "../assets.generated";

export interface LoadedImage {
  readonly meta: StaticImageMeta;
  readonly img: HTMLImageElement;
}

export interface SkyPaint {
  readonly gradient: CanvasGradient;
  readonly topColor: string;
  readonly baseColor: string;
  readonly fadeH: number;
}

/** How far above the background's top edge the sky fades to night, design px. */
const SKY_FADE_H = 1600;

/**
 * Build the reusable sky gradient. Created once in a FIXED local space
 * (0..SKY_FADE_H) so it can be re-used every frame under a translate — canvas
 * gradients are resolved against the CTM at fill time, so no per-frame
 * allocation is needed.
 */
export function createSky(ctx: CanvasRenderingContext2D, baseColor: string, topColor: string): SkyPaint {
  const gradient = ctx.createLinearGradient(0, 0, 0, SKY_FADE_H);
  gradient.addColorStop(0, topColor);
  gradient.addColorStop(0.55, mixHex(topColor, baseColor, 0.55));
  gradient.addColorStop(1, baseColor);
  return { gradient, topColor, baseColor, fadeH: SKY_FADE_H };
}

/**
 * Fill the scene with the sky. `bgTopY` is the background layer's top edge in
 * design space; everything below it gets covered by the layers themselves, so
 * the base fill is only insurance against a missing/short layer.
 */
export function paintSky(
  ctx: CanvasRenderingContext2D,
  sky: SkyPaint,
  bgTopY: number,
  designW: number,
  designH: number,
): void {
  ctx.fillStyle = sky.baseColor;
  ctx.fillRect(0, 0, designW, designH);

  if (bgTopY <= 0) return;

  const stripTop = bgTopY - sky.fadeH;
  if (stripTop > 0) {
    ctx.fillStyle = sky.topColor;
    ctx.fillRect(0, 0, designW, stripTop);
  }
  ctx.save();
  ctx.translate(0, stripTop);
  ctx.fillStyle = sky.gradient;
  ctx.fillRect(0, 0, designW, sky.fadeH);
  ctx.restore();
}

/**
 * Draw one horizontally-looping parallax layer.
 *
 * @param images     One entry = plain repeat. Two+ entries = alternate per tile
 *                   (the two foreground variants are pixel-aligned twins that
 *                   differ only in which street lamps are lit).
 * @param cameraPx   Camera world x in design px (`cameraX * PX_PER_METER`).
 * @param factorX    Parallax factor (bg 0.10 / mid 0.35 / fg 1.00).
 * @param camY       Vertical camera offset; screen y = worldY - camY.
 */
export function drawParallaxLayer(
  ctx: CanvasRenderingContext2D,
  images: readonly (LoadedImage | undefined)[],
  cameraPx: number,
  factorX: number,
  camY: number,
  designW: number,
  designH: number,
): void {
  let variants = 0;
  for (let i = 0; i < images.length; i++) if (images[i]) variants++;
  if (variants === 0) return;

  // Sizing comes from the manifest, never from a hardcoded 1920.
  let base: LoadedImage | undefined;
  for (let i = 0; i < images.length; i++) {
    if (images[i]) {
      base = images[i];
      break;
    }
  }
  if (!base) return;

  const metaH = base.meta.h > 0 ? base.meta.h : designH;
  const metaW = base.meta.w > 0 ? base.meta.w : designW;
  const sc = designH / metaH;
  const tileW = metaW * sc;
  const tileH = designH;
  if (!(tileW > 0)) return;

  const p = cameraPx * factorX;
  const k0 = Math.floor(p / tileW);
  const y = -camY;

  const slots = images.length;
  for (let i = 0; i < 8; i++) {
    const k = k0 + i;
    const x = k * tileW - p;
    if (x >= designW) break;
    const slot = ((k % slots) + slots) % slots;
    const layer = images[slot] ?? base;
    // +1px overlap kills the sub-pixel seam between tiles at fractional scales.
    ctx.drawImage(layer.img, x, y, tileW + 1, tileH);
  }
}

/** Linear blend of two `#rrggbb` strings, t = 0 -> a, 1 -> b. */
function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `#rrggbb` for the top-left pixel of an image, or null if it can't be read. */
export function sampleTopLeftColor(img: HTMLImageElement): string | null {
  try {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    const cx = c.getContext("2d", { willReadFrequently: true });
    if (!cx) return null;
    cx.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    const hex = (v: number) => v.toString(16).padStart(2, "0");
    return `#${hex(d[0])}${hex(d[1])}${hex(d[2])}`;
  } catch {
    return null;
  }
}
