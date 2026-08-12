/**
 * Stuntman Chris — canvas 2D scene renderer.
 *
 * Owns the rAF loop: every frame it calls `engine.tick(performance.now())` and
 * draws the whole scene from that snapshot. No React, no game truth, no state
 * that the engine also holds — the only state here is presentation-only
 * (canvas size, the smoothed vertical camera).
 *
 * Draw order, back to front:
 *   sky gradient -> background (×0.10) -> midground (×0.35)
 *   -> foreground road (×1.00) -> world objects -> Chris -> lasers -> power meter
 *
 * Every sprite dimension comes from `assets.generated.ts`; the only art numbers
 * here are the ANCHOR/scale table below, which is expressed in *fractions of the
 * original source canvas* so it stays valid when the packer re-crops a sheet.
 */

import {
  DESIGN_H,
  DESIGN_W,
  PX_PER_METER,
  type CreateRendererFn,
  type CreateRendererOpts,
  type EngineState,
  type ChrisAnimKey,
  type LoadAssetsFn,
  type RendererHandle,
  type StuntAssets,
  type WorldObjectState,
} from "../types";
import { IMAGES, SPRITES, type ImageKey, type SpriteKey } from "../assets.generated";
import {
  createSky,
  drawParallaxLayer,
  paintSky,
  sampleTopLeftColor,
  type LoadedImage,
  type SkyPaint,
} from "./layers";
import { TUNING } from "../engine/tuning";
import {
  drawSheet,
  frameIndexAt,
  type DrawSpriteOpts,
  type LoadedSheet,
  type SpriteAnchor,
} from "./sprites";

// ── Scene constants (measured off the source art) ───────────────────────────

/**
 * Road surface in design space. The foreground layer's asphalt band runs
 * y 890..1020; the styleframe puts Chris's wheels at y≈965, i.e. in the near
 * lane rather than at the kerb. Chris at world y = 0 sits here.
 */
const GROUND_Y = 962;

/** Chris is pinned this far across the screen; `cameraX` is the world x here. */
const CAM_ANCHOR_X = DESIGN_W * 0.3;

/** Camera pans up once Chris climbs above this screen y. */
const CHRIS_TOP_Y = DESIGN_H * 0.28;
const CAM_SMOOTH_TAU_MS = 150;

const PARALLAX_BG = 0.1;
const PARALLAX_MID = 0.35;
const PARALLAX_FG = 1.0;

/**
 * The bone sheets are trimmed to their non-blank window of the shared
 * 96-frame (subsampled to 48) throw clip: throw 1's bone spans source frames
 * 26–44 step 2, throw 2's 24–40 step 2. So bone frame k composites with
 * skeleton frame OFFSET+k, and the bone simply isn't drawn outside that
 * window.
 */
const BONE_FRAME_OFFSET: Record<number, number> = { 1: 13, 2: 12 };
const BONE_SHEETS: Record<number, SpriteKey> = { 1: "skeleton1Bone", 2: "skeleton2Bone" };

/**
 * The 30-frame power-meter clip is a full rise-AND-fall cycle peaking at this
 * packed frame — powerFrac maps onto the rising half only, or the bar would
 * drain as power climbs.
 */
const POWER_METER_PEAK_FRAME = 15;

/** Fallback sky colours if the background image can't be sampled. */
const SKY_BASE_FALLBACK = "#2f0bb2";
const SKY_TOP = "#0a0330";

/** Objects further than this many screens from the camera are skipped. */
const CULL_SCREENS = 1.5;

const LASER_FLASH_MS = 300;
const LASER_MISS_COLOR = "#7fe9ff";
const LASER_LETHAL_COLOR = "#ff5ad2";
const LASER_CORE_W = 13;

/** Fallback altitude for a moonboots pickup if the engine didn't set `obj.y`
 *  (it always should — the pickup sits on Chris's realized arc). */
const MOONBOOTS_ALT_M = 18;

const MAX_FLIGHT_TILT_RAD = (20 * Math.PI) / 180;

const ASSET_TIMEOUT_MS = 10_000;

// ── Anchors ─────────────────────────────────────────────────────────────────
// ax/ay are fractions of the ORIGINAL source canvas; scale is design px per
// source px. Measured from the raw sequences:
//   Chris   1023×1023, bike bbox (59,39)-(951,996) -> wheels at y≈0.97, centre x≈0.494
//   flying  1023×1023, body bbox (10,255)-(977,665) -> anchored low so the
//           riding→flying hand-off is a small pop, not a jump
//   skeleton 1920×1080 (already design-space), grave base at y≈0.875
//   ramp    839×327 crashed-UFO plate, dug into the road
//   viz     335×653 standing Meebit bystander, feet at y≈1.0
//   moonboots 1000×1000, content bbox (49,179)-(953,735) -> centre y≈0.457

const CHRIS_ANCHORS: Record<ChrisAnimKey, SpriteAnchor> = {
  idle: { ax: 0.494, ay: 0.972, scale: 0.25 },
  idleTransition: { ax: 0.494, ay: 0.972, scale: 0.25 },
  riding: { ax: 0.494, ay: 0.965, scale: 0.25 },
  flying: { ax: 0.5, ay: 0.78, scale: 0.25 },
  death: { ax: 0.5, ay: 0.78, scale: 0.25 },
};

const CHRIS_SHEETS: Record<ChrisAnimKey, SpriteKey> = {
  idle: "chrisIdle",
  idleTransition: "chrisIdleTransition",
  riding: "chrisRiding",
  flying: "chrisFlying",
  death: "chrisDeathLaser",
};

const RAMP_ANCHOR: SpriteAnchor = { ax: 0.45, ay: 0.86, scale: 0.9 };
const SKELETON_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 0.875, scale: 1.0 };
const BOUNCE_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 1.0, scale: 0.45 };
const BLOCKER_ANCHOR: SpriteAnchor = { ax: 0.45, ay: 0.86, scale: 0.72 };
const MOONBOOTS_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 0.457, scale: 0.28 };
const POWER_METER_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 0.5, scale: 1.0 };
const POWER_METER_Y = 985;

/**
 * PLACEHOLDER ART. The manifest ships no bounce/blocker sheets, so:
 *   bounce  -> `viz` (the animated green Meebit bystander from the styleframe;
 *              the plan lists "meebit bystanders" as a bounce object, so this
 *              is the intended subject even though it isn't a bespoke sheet)
 *   blocker -> `rampUfo` frame 0 (a second crashed UFO reads as a lethal wall)
 * Swap these two constants when real art lands.
 */
const BOUNCE_SHEET: SpriteKey = "viz";
const BLOCKER_SHEET: SpriteKey = "rampUfo";

// ── Assets ──────────────────────────────────────────────────────────────────

export interface StuntAssetBag extends StuntAssets {
  readonly ready: true;
  /** Missing entries mean that file failed to load; every draw site guards. */
  readonly sheets: Partial<Record<SpriteKey, LoadedSheet>>;
  readonly images: Partial<Record<ImageKey, HTMLImageElement>>;
}

function loadImageEl(url: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const img = new Image();
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(ok ? img : null);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => {
      // decode() makes "loaded" mean "ready to paint" — without it the first
      // draw of a big sheet can stall a frame.
      img.decode().then(
        () => finish(true),
        () => finish(true),
      );
    };
    img.onerror = () => finish(false);
    img.src = url;
  });
}

/**
 * Load every sprite sheet + static image in the manifest. The `.mp4` title clip
 * is skipped — the UI layer mounts that as a `<video>`.
 *
 * A per-asset timeout means one straggler (or a 404 while art is still being
 * generated) degrades to a missing sprite instead of wedging the preloader.
 */
export const loadStuntAssets: LoadAssetsFn = async (onProgress) => {
  const spriteKeys = Object.keys(SPRITES) as SpriteKey[];
  const imageKeys = (Object.keys(IMAGES) as ImageKey[]).filter(
    (k) => !IMAGES[k].url.toLowerCase().endsWith(".mp4"),
  );

  const total = spriteKeys.length + imageKeys.length;
  let loaded = 0;
  const bump = () => {
    loaded++;
    onProgress?.(loaded, total);
  };

  const sheets: Partial<Record<SpriteKey, LoadedSheet>> = {};
  const images: Partial<Record<ImageKey, HTMLImageElement>> = {};

  await Promise.all([
    ...spriteKeys.map(async (key) => {
      const meta = SPRITES[key];
      const img = await loadImageEl(meta.url, ASSET_TIMEOUT_MS);
      if (img) sheets[key] = { meta, img };
      bump();
    }),
    ...imageKeys.map(async (key) => {
      const img = await loadImageEl(IMAGES[key].url, ASSET_TIMEOUT_MS);
      if (img) images[key] = img;
      bump();
    }),
  ]);

  onProgress?.(total, total);
  const bag: StuntAssetBag = { ready: true, sheets, images };
  return bag;
};

// ── Small helpers ───────────────────────────────────────────────────────────

/** Shared scratch so per-frame draw options cost no allocations. */
const OPTS: DrawSpriteOpts = {};
function opts(flipX: boolean, rotation: number, alpha: number, scaleMul: number): DrawSpriteOpts {
  OPTS.flipX = flipX;
  OPTS.rotation = rotation;
  OPTS.alpha = alpha;
  OPTS.scaleMul = scaleMul;
  return OPTS;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function toLoadedImage(
  key: ImageKey,
  images: Partial<Record<ImageKey, HTMLImageElement>>,
): LoadedImage | undefined {
  const img = images[key];
  return img ? { meta: IMAGES[key], img } : undefined;
}

// ── Renderer ────────────────────────────────────────────────────────────────

export const createRenderer: CreateRendererFn = (options: CreateRendererOpts): RendererHandle => {
  const { container, engine } = options;
  const assets = options.assets as StuntAssetBag;
  const sheets: Partial<Record<SpriteKey, LoadedSheet>> = assets?.sheets ?? {};
  const images: Partial<Record<ImageKey, HTMLImageElement>> = assets?.images ?? {};

  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.touchAction = "manipulation";
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    canvas.remove();
    return { dispose: () => undefined };
  }

  // Layers, resolved once — the parallax draw loop reads these every frame.
  const bgLayers: readonly (LoadedImage | undefined)[] = [toLoadedImage("backgroundDusk", images)];
  const midLayers: readonly (LoadedImage | undefined)[] = [toLoadedImage("midgroundDusk", images)];
  // foregroundDusk / foregroundDusk2 are pixel-identical twins that differ only
  // in which street lamps are lit, so alternating them per tile reads as
  // "some lamps are out" rather than as a seam.
  const fgA = toLoadedImage("foregroundDusk", images);
  const fgB = toLoadedImage("foregroundDusk2", images);
  const fgLayers: readonly (LoadedImage | undefined)[] = fgB ? [fgA, fgB] : [fgA];

  const bgImg = images.backgroundDusk;
  const skyBase = (bgImg ? sampleTopLeftColor(bgImg) : null) ?? SKY_BASE_FALLBACK;
  const sky: SkyPaint = createSky(ctx, skyBase, SKY_TOP);

  // ── Canvas sizing (DPR backing store + letterboxed design-space transform) ─
  let viewScale = 1;
  let viewOffsetX = 0;
  let viewOffsetY = 0;

  const applySize = () => {
    const rect = container.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));

    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }

    viewScale = Math.min(bw / DESIGN_W, bh / DESIGN_H);
    viewOffsetX = (bw - DESIGN_W * viewScale) / 2;
    viewOffsetY = (bh - DESIGN_H * viewScale) / 2;

    // Resizing the backing store resets both the transform and the smoothing
    // flag, so re-apply them here rather than once at construction.
    ctx.setTransform(viewScale, 0, 0, viewScale, viewOffsetX, viewOffsetY);
    ctx.imageSmoothingEnabled = false;
  };

  applySize();

  const ro = new ResizeObserver(() => applySize());
  ro.observe(container);

  // ── Camera (presentation-only; horizontal comes straight from the engine) ──
  let camY = 0;
  let lastNow = 0;

  const updateCamera = (s: EngineState, dtMs: number) => {
    const chrisWorldY = GROUND_Y - s.y * PX_PER_METER;
    // Only ever pans UP (camY <= 0): the ground never rises above its resting
    // position, and Chris is prioritised once he climbs past CHRIS_TOP_Y.
    const target = Math.min(0, chrisWorldY - CHRIS_TOP_Y);
    if (s.phase === "title" || s.phase === "ready") {
      camY = target;
      return;
    }
    const k = 1 - Math.exp(-Math.max(0, dtMs) / CAM_SMOOTH_TAU_MS);
    camY += (target - camY) * k;
  };

  // ── Drawing ───────────────────────────────────────────────────────────────

  /** World metres -> design-space screen x. `cameraX` lands on CAM_ANCHOR_X. */
  const worldToScreenX = (s: EngineState, worldXm: number): number =>
    (worldXm - s.cameraX) * PX_PER_METER + CAM_ANCHOR_X;

  const drawChris = (s: EngineState) => {
    const key = s.chris.key;
    const anchor = CHRIS_ANCHORS[key] ?? CHRIS_ANCHORS.idle;
    const sheet = sheets[CHRIS_SHEETS[key] ?? "chrisIdle"];
    if (!sheet) return;

    const elapsed = s.timeMs - s.chris.startedAtMs;
    const frame = frameIndexAt(sheet.meta, elapsed);

    let tilt = 0;
    if (s.phase === "flying" || s.phase === "dying" || s.phase === "launching") {
      // Canvas y grows downward, so a climbing Chris needs a NEGATIVE rotation
      // for his nose to point up.
      tilt = clamp(-Math.atan2(s.vy, Math.max(0.001, s.vx)), -MAX_FLIGHT_TILT_RAD, MAX_FLIGHT_TILT_RAD);
    }

    const x = worldToScreenX(s, s.x);
    const y = GROUND_Y - s.y * PX_PER_METER - camY;
    drawSheet(ctx, sheet, anchor, x, y, frame, opts(false, tilt, 1, 1));

    if (s.phase === "landing") drawDust(ctx, x, y, s.timeMs);
  };

  const drawObject = (s: EngineState, obj: WorldObjectState) => {
    const x = worldToScreenX(s, obj.x);
    if (x < -DESIGN_W * CULL_SCREENS || x > DESIGN_W * (1 + CULL_SCREENS)) return;
    const groundY = GROUND_Y - camY;

    switch (obj.kind) {
      case "skeleton": {
        const key: SpriteKey = obj.variant === 1 ? "skeleton1" : "skeleton2";
        const sheet = sheets[key];
        if (!sheet) return;
        // Untriggered skeletons hold frame 0 (closed grave); the throw plays
        // once from triggeredAtMs and clamps on its last frame.
        const elapsed = obj.triggeredAtMs === null ? 0 : s.timeMs - obj.triggeredAtMs;
        const skelFrame = frameIndexAt(sheet.meta, elapsed);
        drawSheet(ctx, sheet, SKELETON_ANCHOR, x, groundY, skelFrame);
        // Both throws ship the bone as a separate sequence on the SAME 1920×1080
        // source canvas, so the identical anchor composites it exactly as
        // authored — but the bone sheet only covers a window of the clip, so it
        // is frame-locked to the skeleton rather than played from elapsed 0.
        const bone = sheets[BONE_SHEETS[obj.variant] ?? "skeleton2Bone"];
        if (bone && obj.triggeredAtMs !== null) {
          const boneFrame = skelFrame - (BONE_FRAME_OFFSET[obj.variant] ?? 0);
          if (boneFrame >= 0 && boneFrame < bone.meta.frameCount) {
            drawSheet(ctx, bone, SKELETON_ANCHOR, x, groundY, boneFrame);
          }
        }
        return;
      }
      case "bounce": {
        const sheet = sheets[BOUNCE_SHEET];
        if (!sheet) return;
        // Brief pop on contact so the bounce reads without bespoke art.
        let pop = 1;
        if (obj.triggeredAtMs !== null) {
          const t = (s.timeMs - obj.triggeredAtMs) / 220;
          if (t >= 0 && t < 1) pop = 1 + 0.12 * Math.sin(t * Math.PI);
        }
        drawSheet(
          ctx,
          sheet,
          BOUNCE_ANCHOR,
          x,
          groundY,
          frameIndexAt(sheet.meta, s.timeMs + obj.id * 137),
          opts(false, 0, 1, pop),
        );
        return;
      }
      case "blocker": {
        const sheet = sheets[BLOCKER_SHEET];
        if (!sheet) return;
        drawSheet(ctx, sheet, BLOCKER_ANCHOR, x, groundY, frameIndexAt(sheet.meta, s.timeMs));
        return;
      }
      case "moonboots": {
        if (obj.consumed) return;
        const sheet = sheets.moonboots;
        if (!sheet) return;
        const bob = Math.sin(s.timeMs / 380 + obj.id) * 12;
        const altM = obj.y ?? MOONBOOTS_ALT_M;
        const y = GROUND_Y - altM * PX_PER_METER - camY + bob;
        drawSheet(ctx, sheet, MOONBOOTS_ANCHOR, x, y, frameIndexAt(sheet.meta, s.timeMs));
        return;
      }
      default:
        // "laser" has no art — drawn procedurally in the pass above Chris.
        return;
    }
  };

  const drawLasers = (s: EngineState, chrisX: number, chrisY: number) => {
    for (let i = 0; i < s.objects.length; i++) {
      const obj = s.objects[i];
      if (obj.kind !== "laser" || obj.triggeredAtMs === null) continue;
      const elapsed = s.timeMs - obj.triggeredAtMs;
      if (elapsed < 0 || elapsed > LASER_FLASH_MS) continue;

      const ox = worldToScreenX(s, obj.x);
      if (ox < -DESIGN_W * CULL_SCREENS || ox > DESIGN_W * (1 + CULL_SCREENS)) continue;
      const oy = DESIGN_H + 80;

      // Lethal bolts converge on Chris; near-misses streak past his nose.
      const tx = obj.lethal ? chrisX : chrisX + 190;
      const ty = obj.lethal ? chrisY : chrisY - 150;
      drawLaserBeam(ctx, ox, oy, tx, ty, elapsed / LASER_FLASH_MS, obj.lethal);
    }
  };

  const drawPowerMeter = (s: EngineState) => {
    if (s.phase !== "charging") return;
    const sheet = sheets.powerMeter;
    if (!sheet) return;
    const peak = Math.min(POWER_METER_PEAK_FRAME, sheet.meta.frameCount - 1);
    const frame = Math.round(clamp(s.powerFrac, 0, 1) * peak);
    drawSheet(ctx, sheet, POWER_METER_ANCHOR, DESIGN_W / 2, POWER_METER_Y, frame);
  };

  const draw = (s: EngineState) => {
    // Clear the whole backing store (including any 1px letterbox rounding)
    // in device space, then return to the design-space transform.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    paintSky(ctx, sky, -camY, DESIGN_W, DESIGN_H);

    const cameraPx = s.cameraX * PX_PER_METER - CAM_ANCHOR_X;
    drawParallaxLayer(ctx, bgLayers, cameraPx, PARALLAX_BG, camY, DESIGN_W, DESIGN_H);
    drawParallaxLayer(ctx, midLayers, cameraPx, PARALLAX_MID, camY, DESIGN_W, DESIGN_H);
    drawParallaxLayer(ctx, fgLayers, cameraPx, PARALLAX_FG, camY, DESIGN_W, DESIGN_H);

    // The crashed-UFO ramp is scenery, not a plan event — its world x comes
    // straight from the engine's launch point so the two can never disagree.
    const rampSheet = sheets.rampUfo;
    if (rampSheet) {
      const rx = worldToScreenX(s, TUNING.rampX);
      if (rx > -DESIGN_W * CULL_SCREENS && rx < DESIGN_W * (1 + CULL_SCREENS)) {
        drawSheet(ctx, rampSheet, RAMP_ANCHOR, rx, GROUND_Y - camY, frameIndexAt(rampSheet.meta, s.timeMs));
      }
    }

    for (let i = 0; i < s.objects.length; i++) drawObject(s, s.objects[i]);

    drawChris(s);

    drawLasers(s, worldToScreenX(s, s.x), GROUND_Y - s.y * PX_PER_METER - camY);
    drawPowerMeter(s);
  };

  // ── rAF loop ──────────────────────────────────────────────────────────────
  let raf = 0;
  let disposed = false;

  const frame = (now: number) => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = lastNow === 0 ? 16.7 : Math.min(100, now - lastNow);
    lastNow = now;
    const s = engine.tick(now);
    updateCamera(s, dt);
    draw(s);
  };
  raf = requestAnimationFrame(frame);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.remove();
    },
  };
};

// ── Procedural FX ───────────────────────────────────────────────────────────

/**
 * Chunky additive beam. No art exists for the lasers, so they're built from
 * three stacked hard-edged bars (wide glow / mid / white core) under
 * `globalCompositeOperation = "lighter"` — bright and pixel-adjacent, with no
 * soft shadowBlur that would fight the pixel-art layers.
 */
function drawLaserBeam(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  tx: number,
  ty: number,
  progress: number,
  lethal: boolean,
): void {
  const dx = tx - ox;
  const dy = ty - oy;
  const dist = Math.hypot(dx, dy);
  if (!(dist > 0)) return;

  const angle = Math.atan2(dy, dx);
  const len = dist * 1.6 + 400;
  // Hot for the first third, then a quick fade.
  const a = progress < 0.35 ? 1 : Math.max(0, 1 - (progress - 0.35) / 0.65);
  if (a <= 0) return;

  const color = lethal ? LASER_LETHAL_COLOR : LASER_MISS_COLOR;
  const core = LASER_CORE_W * (0.6 + 0.4 * a);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(ox, oy);
  ctx.rotate(angle);

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.28 * a;
  ctx.fillRect(0, -core * 3, len, core * 6);
  ctx.globalAlpha = 0.55 * a;
  ctx.fillRect(0, -core * 1.4, len, core * 2.8);
  ctx.globalAlpha = 0.95 * a;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, -core * 0.5, len, core);

  // Muzzle flare at the ground end.
  ctx.globalAlpha = 0.7 * a;
  ctx.fillStyle = color;
  ctx.fillRect(-24, -core * 4, 110, core * 8);
  ctx.restore();

  if (!lethal || progress > 0.4) return;

  // Impact spark on the lethal hit.
  const burst = 1 - progress / 0.4;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = burst;
  ctx.fillStyle = "#ffffff";
  const size = 26 + 70 * (1 - burst);
  ctx.fillRect(tx - size / 2, ty - size / 2, size, size);
  ctx.globalAlpha = burst * 0.6;
  ctx.fillStyle = color;
  ctx.fillRect(tx - size, ty - size / 4, size * 2, size / 2);
  ctx.fillRect(tx - size / 4, ty - size, size / 2, size * 2);
  ctx.restore();
}

/** Tiny deterministic dust squares kicked up behind a landing slide. */
function drawDust(ctx: CanvasRenderingContext2D, x: number, y: number, timeMs: number): void {
  ctx.save();
  ctx.fillStyle = "#9aa2d4";
  for (let i = 0; i < 6; i++) {
    const ph = ((timeMs * 0.0042 + i * 0.37) % 1 + 1) % 1;
    const px = x - 26 - ph * 140 - i * 7;
    const py = y - ph * 44 - (i % 3) * 9;
    const size = 6 + ph * 16;
    ctx.globalAlpha = 0.42 * (1 - ph);
    ctx.fillRect(px - size / 2, py - size, size, size);
  }
  ctx.restore();
}
