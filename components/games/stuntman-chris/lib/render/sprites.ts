/**
 * Stuntman Chris — sprite-sheet playback helpers (canvas 2D, no React/DOM
 * globals at module scope).
 *
 * Every number about a sheet comes from `assets.generated.ts` — nothing here
 * hardcodes a frame size, a column count or a trim offset. The one thing a
 * caller supplies is a `SpriteAnchor`, expressed in *original source-canvas*
 * fractions, because that is the only registration frame that is stable across
 * the frames of a sequence (the packed sheet is union-cropped, so its own
 * origin moves per sequence).
 *
 * ── Registration model ──────────────────────────────────────────────────────
 * The asset pipeline takes each original `srcCanvasW × srcCanvasH` frame,
 * union-crops the sequence to a common rect whose top-left is
 * (`trimX`, `trimY`), and writes the crop into the sheet at `scale`, so a
 * packed cell is `frameW × frameH`.
 *
 * A caller thinks purely in original-canvas terms: "the bike's wheels sit at
 * (0.494, 0.972) of the 1023×1023 canvas, draw that point at screen (x, y) and
 * render the canvas at 0.25×". This module turns that into the right
 * `drawImage` rect:
 *
 *   originScreenX = x - ax * srcCanvasW * S          // where the canvas's (0,0) lands
 *   destX         = originScreenX + trimX * S
 *   destW         = (frameW / meta.scale) * S        // packed px -> original px -> design px
 *
 * Flip and rotation are applied about the anchor point, which keeps a sprite
 * pinned to the road / to Chris no matter how it is transformed.
 */

import type { SpriteSheetMeta } from "../assets.generated";

export interface LoadedSheet {
  readonly meta: SpriteSheetMeta;
  readonly img: HTMLImageElement;
}

export interface SpriteAnchor {
  /** Anchor x as a fraction of the ORIGINAL source canvas width (0..1). */
  ax: number;
  /** Anchor y as a fraction of the ORIGINAL source canvas height (0..1). */
  ay: number;
  /** Display scale: design px per original-source-canvas px. */
  scale: number;
}

export interface DrawSpriteOpts {
  flipX?: boolean;
  /** Radians, canvas-clockwise, applied about the anchor point. */
  rotation?: number;
  /** 0..1 (default 1). */
  alpha?: number;
  /** Extra multiplier on `SpriteAnchor.scale` — pop / squash effects. */
  scaleMul?: number;
}

/**
 * Whether `meta.trimX` / `meta.trimY` are measured in ORIGINAL source-canvas
 * pixels (true) or in already-`scale`d sheet pixels (false).
 *
 * The manifest's field ordering (`srcCanvasW/H` next to `trimX/Y`, with `scale`
 * a separate factor) reads as "the crop origin inside the original canvas", so
 * we assume source pixels. If the generated manifest turns out to store scaled
 * pixels instead, flipping this single flag corrects every draw call.
 */
const TRIM_IN_SOURCE_PIXELS = true;

const DEFAULT_FPS = 24;

/** Guards a manifest number that must be > 0 (placeholder manifests exist). */
function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Total run time of one pass through the sheet, ms. */
export function sheetDurationMs(meta: SpriteSheetMeta): number {
  const frames = Math.max(1, Math.floor(positive(meta.frameCount, 1)));
  return (frames * 1000) / positive(meta.fps, DEFAULT_FPS);
}

/** True once a non-looping sheet has reached (and is holding) its last frame. */
export function isSheetFinished(meta: SpriteSheetMeta, elapsedMs: number): boolean {
  if (meta.loop) return false;
  return elapsedMs >= sheetDurationMs(meta);
}

/**
 * Frame index for an elapsed time. Grid layout: frame n lives at
 * col `n % cols`, row `floor(n / cols)`. Loops or clamps per `meta.loop`.
 */
export function frameIndexAt(meta: SpriteSheetMeta, elapsedMs: number): number {
  const frames = Math.max(1, Math.floor(positive(meta.frameCount, 1)));
  if (frames === 1) return 0;
  const fps = positive(meta.fps, DEFAULT_FPS);
  const raw = Math.floor((Math.max(0, elapsedMs) * fps) / 1000);
  if (!meta.loop) return Math.min(raw, frames - 1);
  return ((raw % frames) + frames) % frames;
}

/** Frame index mapped from a 0..1 progress value (power meter, etc.). */
export function frameIndexAtFraction(meta: SpriteSheetMeta, frac: number): number {
  const frames = Math.max(1, Math.floor(positive(meta.frameCount, 1)));
  const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  return Math.round(clamped * (frames - 1));
}

/** Displayed width of the whole original canvas at this anchor's scale. */
export function canvasWidthPx(meta: SpriteSheetMeta, anchor: SpriteAnchor): number {
  return positive(meta.srcCanvasW, 1) * anchor.scale;
}

/** Displayed height of the whole original canvas at this anchor's scale. */
export function canvasHeightPx(meta: SpriteSheetMeta, anchor: SpriteAnchor): number {
  return positive(meta.srcCanvasH, 1) * anchor.scale;
}

/**
 * Draw one frame of a sheet, registering it by the caller's original-canvas
 * anchor. `screenX/screenY` are design-space (1920×1080) coordinates.
 *
 * `opts` is read and never retained — callers pass a reused scratch object so
 * the per-frame allocation count stays at zero.
 */
export function drawSheet(
  ctx: CanvasRenderingContext2D,
  sheet: LoadedSheet | undefined,
  anchor: SpriteAnchor,
  screenX: number,
  screenY: number,
  frame: number,
  opts?: DrawSpriteOpts,
): void {
  if (!sheet) return;

  const meta = sheet.meta;
  const cols = Math.max(1, Math.floor(positive(meta.cols, 1)));
  const frameW = positive(meta.frameW, 1);
  const frameH = positive(meta.frameH, 1);
  const packScale = positive(meta.scale, 1);
  const srcW = positive(meta.srcCanvasW, 1);
  const srcH = positive(meta.srcCanvasH, 1);

  const frames = Math.max(1, Math.floor(positive(meta.frameCount, 1)));
  const f = frame < 0 ? 0 : frame > frames - 1 ? frames - 1 : Math.floor(frame);

  const sx = (f % cols) * frameW;
  const sy = Math.floor(f / cols) * frameH;

  const scaleMul = opts?.scaleMul;
  const s = anchor.scale * (scaleMul === undefined ? 1 : scaleMul);
  if (!(s > 0)) return;

  // Packed pixels -> original-canvas pixels -> design pixels.
  const destW = (frameW / packScale) * s;
  const destH = (frameH / packScale) * s;

  const trimUnits = TRIM_IN_SOURCE_PIXELS ? 1 : 1 / packScale;
  // Offset of the packed crop's top-left from the anchor, in design px.
  const offX = (meta.trimX * trimUnits - anchor.ax * srcW) * s;
  const offY = (meta.trimY * trimUnits - anchor.ay * srcH) * s;

  const flipX = opts?.flipX === true;
  const rotation = opts?.rotation;
  const alpha = opts?.alpha;
  const needsState =
    flipX || (rotation !== undefined && rotation !== 0) || (alpha !== undefined && alpha < 1);

  if (!needsState) {
    ctx.drawImage(sheet.img, sx, sy, frameW, frameH, screenX + offX, screenY + offY, destW, destH);
    return;
  }

  ctx.save();
  if (alpha !== undefined && alpha < 1) ctx.globalAlpha = alpha;
  ctx.translate(screenX, screenY);
  if (rotation !== undefined && rotation !== 0) ctx.rotate(rotation);
  // scale(-1, 1) mirrors local x about the anchor, so drawing at the SAME local
  // offset yields the mirrored sprite: local [offX, offX+destW] maps to screen
  // offsets [-(offX+destW), -offX].
  if (flipX) ctx.scale(-1, 1);
  ctx.drawImage(sheet.img, sx, sy, frameW, frameH, offX, offY, destW, destH);
  ctx.restore();
}

/** Convenience: pick the frame from an elapsed time, then draw it. */
export function drawSheetAt(
  ctx: CanvasRenderingContext2D,
  sheet: LoadedSheet | undefined,
  anchor: SpriteAnchor,
  screenX: number,
  screenY: number,
  elapsedMs: number,
  opts?: DrawSpriteOpts,
): void {
  if (!sheet) return;
  drawSheet(ctx, sheet, anchor, screenX, screenY, frameIndexAt(sheet.meta, elapsedMs), opts);
}
