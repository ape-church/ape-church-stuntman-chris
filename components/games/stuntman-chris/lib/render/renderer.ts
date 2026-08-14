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

/** Chris is pinned this fraction across the screen; `cameraX` is the world x here. */
const CAM_ANCHOR_FRAC = 0.3;

/**
 * Clamps on the dynamic design width (see `applySize`). The scene always
 * renders the full 1080 design rows and derives its design WIDTH from the
 * container's aspect, so the canvas fills the box edge-to-edge instead of
 * letterboxing the authored 16:9. The HUD stage ranges ~0.86:1–1.9:1
 * (929–2052 design px) and mobile is 1:1 (1080); the clamps only exist so a
 * degenerate container can't produce an absurd world view — inside them
 * there are no pillar bars.
 */
const MIN_DESIGN_W = 720;
const MAX_DESIGN_W = 2600;

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
/** ms after a laser's trigger at which the beam erupts — the robot clip's
 *  wind-up (eye flare peaks at frame ~24 of the 12fps clip). Kept equal to
 *  the engine's trigger lead so the beam fires right as Chris arrives at the
 *  event's atX. */
const LASER_FIRE_DELAY_MS = TUNING.events.laserLeadMs;

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
/**
 * Laser robot (Robot_Obstacles drop): 500×500 source canvas, content bbox
 * (165,119)-(342,433) -> feet at y≈0.866, figure centre x≈0.507. Scale 1.0
 * renders the ~314px figure at the bounce-meebit height (MEEBIT_H), so the
 * robot reads as a near-lane character, not a background extra.
 */
const ROBOT_ANCHOR: SpriteAnchor = { ax: 0.507, ay: 0.866, scale: 1.0 };
/** The clip's first 18 frames are the idle head-scan; untriggered robots
 *  loop them (the fire wind-up starts at frame 18). */
const ROBOT_IDLE_FRAMES = 18;
/** Beam muzzle — the opened visor during the fire frames — as fractions of
 *  the robot's source canvas (same registration space as the anchor). */
const ROBOT_EYE_AX = 0.52;
const ROBOT_EYE_AY = 0.33;
const SKELETON_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 0.875, scale: 1.0 };
const BOUNCE_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 1.0, scale: 0.45 };
const BLOCKER_ANCHOR: SpriteAnchor = { ax: 0.45, ay: 0.86, scale: 0.72 };
const MOONBOOTS_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 0.457, scale: 0.28 };
const POWER_METER_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 0.5, scale: 1.0 };
const POWER_METER_Y = 985;

/**
 * PLACEHOLDER ART. The manifest ships no bespoke bounce/blocker sheets, so:
 *   bounce v1 -> `viz` (the animated dancing Meebit from the styleframe)
 *   bounce v2 -> one of the static meebit extras, picked per object id
 *   blocker   -> `rampUfo` frame 0 (a second crashed UFO reads as a lethal wall)
 */
const BOUNCE_SHEET: SpriteKey = "viz";
const BLOCKER_SHEET: SpriteKey = "rampUfo";

/** The Meebit bystander sheets (extras/). Each file is an 8×8 grid of 80×80
 *  cells — rows 0–3 are 8-frame walk cycles (right / back / left / front),
 *  rows 4–7 the matching idles. Used as bounce-object variant 2 and as the
 *  roadside crowd — exactly the "meebit bystanders" the plan doc lists. */
const MEEBIT_KEYS: readonly ImageKey[] = [
  "meebit01896",
  "meebit02239",
  "meebit03126",
  "meebit03407",
  "meebit05987",
  "meebit06432",
  "meebit07823",
  "meebit08369",
  "meebit17600",
  "meebit18868",
  "meebit19557",
];

/** Deterministic per-seed pick so an object keeps its character every frame. */
const meebitKeyFor = (seed: number): ImageKey =>
  MEEBIT_KEYS[((seed * 7919) >>> 0) % MEEBIT_KEYS.length];

/** Cheap integer hash for deterministic world decoration (no Math.random —
 *  the renderer must stay replay-stable). */
const hash32 = (n: number): number => {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

/** Meebit sheet geometry (see MEEBIT_KEYS above). */
const MEEBIT_GRID = 8;
/**
 * Row map, identical across all 11 sheets (each was inspected): rows 0–3 are
 * 8-frame walks (right / back / left / front), rows 4–7 the matching idles.
 * Right/left assignment player-verified: row 0 walks screen-right.
 */
const MEEBIT_WALK_RIGHT_ROW = 0;
const MEEBIT_WALK_LEFT_ROW = 2;
/** Front-facing idle row — spectators and bounce targets face the road. */
const MEEBIT_IDLE_ROW = 7;
const MEEBIT_FPS = 6;
/** Walk-cycle rate — raised with the patrol speed so the stride length stays
 *  plausible instead of the feet skating over the road. */
const MEEBIT_WALK_FPS = 12;

/**
 * BOUNCE meebits render at the viz dancer's height (653px art × 0.45 ≈ 294px
 * figure): the meebit figure fills ~75/80 of its cell, so a 314px cell puts
 * its head at the ~270px line the engine's 45m bounce deck expects Chris to
 * hit — mismatched bounce characters made head-bounces look like Chris was
 * bouncing off thin air. Background characters stay deliberately smaller.
 */
const MEEBIT_H = 314;

/** Roadside crowd: one candidate slot every this many metres of world. */
const BYSTANDER_SPACING_M = 210;
/** Far-lane offset and size band for crowd meebits (smaller + higher = depth). */
const BYSTANDER_LANE_RAISE = 36;
const BYSTANDER_H_MIN = 175;
const BYSTANDER_H_VAR = 60;

/** Start-line spectators (world x in metres, all behind Chris's start mark). */
const SPECTATOR_XS: readonly number[] = [-10, -23, -35];
const SPECTATOR_VIZ_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 1.0, scale: 0.36 };

/** Mutable scratch anchor for background viz dancers (scale set per draw). */
const CROWD_VIZ_ANCHOR: SpriteAnchor = { ax: 0.5, ay: 1.0, scale: 0.3 };

// ── speed FX ────────────────────────────────────────────────────────────────
// Perceived speed is mostly presentation: streaks fade in with vx, and a
// moonboots surge layers ghosts + shake on top. All of it is derived from
// EngineState + time functions — no random state, replay-stable.

/** Streaks fade in from this vx (m/s) and saturate at the max. The floor sits
 *  above cruise speed so ordinary flight stays clean — streaks are reserved
 *  for genuinely fast moments (long-span arcs, bounour surges, boosts). */
const STREAK_MIN_VX = 55;
const STREAK_MAX_VX = 130;
const STREAK_COUNT = 9;

/**
 * Streaks are drawn from this pre-feathered sprite (soft head/tail and soft
 * vertical edges) rather than fillRect bars — hard-edged additive rectangles
 * over pixel art read as scan-line glitches, a feathered blur reads as motion.
 */
function makeStreakSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 8;
  const x = c.getContext("2d");
  if (!x) return c;
  const along = x.createLinearGradient(0, 0, 256, 0);
  along.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
  along.addColorStop(0.22, `rgba(${r}, ${g}, ${b}, 0.9)`);
  along.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  x.fillStyle = along;
  x.fillRect(0, 0, 256, 8);
  const across = x.createLinearGradient(0, 0, 0, 8);
  across.addColorStop(0, "rgba(0, 0, 0, 0)");
  across.addColorStop(0.5, "rgba(0, 0, 0, 1)");
  across.addColorStop(1, "rgba(0, 0, 0, 0)");
  x.globalCompositeOperation = "destination-in";
  x.fillStyle = across;
  x.fillRect(0, 0, 256, 8);
  return c;
}

/** How long the surge FX (ghosts, shake, hot streaks) play after a moonboots
 *  pickup. Slightly longer than the engine's 900ms surge so the FX decay out
 *  instead of cutting. The renderer reads the pickup's triggeredAtMs off the
 *  object list — no engine contract change. */
const BOOST_FX_MS = 1050;

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
      // decode() pre-rasterizes so the first draw of a big sheet doesn't
      // stall a frame — but it is BEST-EFFORT ONLY: Chrome defers decode
      // work indefinitely for hidden/occluded windows, and gating "loaded"
      // on it made every asset time out whenever the game loaded in a
      // background tab. The bytes are fully fetched at onload; worst case a
      // first draw pays a one-off synchronous decode.
      const grace = setTimeout(() => finish(true), 250);
      img.decode().then(
        () => {
          clearTimeout(grace);
          finish(true);
        },
        () => {
          clearTimeout(grace);
          finish(true);
        },
      );
    };
    img.onerror = () => finish(false);
    img.src = url;
  });
}

/** One retry per asset: a transient dev-server / network hiccup on a single
 *  request must not permanently strip a sprite from the whole session. */
async function loadImageElWithRetry(
  url: string,
  timeoutMs: number,
): Promise<HTMLImageElement | null> {
  const first = await loadImageEl(url, timeoutMs);
  if (first) return first;
  return loadImageEl(url, timeoutMs);
}

/** Images the scene is unreadable without. Everything else (meebit extras,
 *  overlay art the DOM loads separately) degrades to a missing draw. */
const CRITICAL_IMAGES: readonly ImageKey[] = [
  "backgroundDusk",
  "midgroundDusk",
  "foregroundDusk",
];

/**
 * Load every sprite sheet + static image in the manifest. The `.mp4` title clip
 * is skipped — the UI layer mounts that as a `<video>`.
 *
 * A per-asset timeout means one straggler (or a 404 while art is still being
 * generated) degrades to a missing sprite instead of wedging the preloader —
 * but if a SHEET or a parallax layer is still missing after its retry, the
 * load REJECTS so the UI shows its failure banner instead of silently playing
 * a run with an invisible world.
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
      const img = await loadImageElWithRetry(meta.url, ASSET_TIMEOUT_MS);
      if (img) sheets[key] = { meta, img };
      bump();
    }),
    ...imageKeys.map(async (key) => {
      const img = await loadImageElWithRetry(IMAGES[key].url, ASSET_TIMEOUT_MS);
      if (img) images[key] = img;
      bump();
    }),
  ]);

  const missing: string[] = [
    ...spriteKeys.filter((k) => !sheets[k]),
    ...CRITICAL_IMAGES.filter((k) => !images[k]),
  ];
  if (missing.length > 0) {
    throw new Error(`critical assets failed to load: ${missing.join(", ")}`);
  }

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

/**
 * Draw one cell of a meebit walk/idle sheet standing on the road:
 * bottom-centre anchored at (x, groundY), scaled to `h` design px tall.
 * The sheets are 8×8 grids (MEEBIT_GRID) with feet at each cell's bottom
 * edge, so bottom-anchoring is their natural registration; `scaleMul`
 * squashes/pops about the feet. `seed` offsets the animation phase so a
 * crowd doesn't idle in lock-step.
 */
function drawMeebit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  groundY: number,
  h: number,
  timeMs: number,
  seed: number,
  scaleMul = 1,
  alpha = 1,
  row = MEEBIT_IDLE_ROW,
  fps = MEEBIT_FPS,
): void {
  const cw = (img.naturalWidth || MEEBIT_GRID) / MEEBIT_GRID;
  const ch = (img.naturalHeight || MEEBIT_GRID) / MEEBIT_GRID;
  const frame = (Math.floor((timeMs / 1000) * fps) + seed) % MEEBIT_GRID;
  const sx = frame * cw;
  const sy = row * ch;
  const dh = h * scaleMul;
  const dw = (cw / ch) * dh;
  const needsAlpha = alpha < 1;
  if (needsAlpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
  }
  ctx.drawImage(img, sx, sy, cw, ch, x - dw / 2, groundY - dh, dw, dh);
  if (needsAlpha) ctx.restore();
}

/** Pulsing cyan pad under a bounce object — marks it as interactive so the
 *  bounce meebits read differently from the decorative roadside crowd. */
function drawBouncePad(
  ctx: CanvasRenderingContext2D,
  x: number,
  groundY: number,
  timeMs: number,
): void {
  const pulse = 0.26 + 0.1 * Math.sin(timeMs / 280);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = pulse;
  ctx.fillStyle = "#7ff0e4";
  ctx.beginPath();
  ctx.ellipse(x, groundY + 4, 105, 17, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = pulse * 0.55;
  ctx.beginPath();
  ctx.ellipse(x, groundY + 4, 60, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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

  // ── Canvas sizing (DPR backing store + fill-the-box design-space transform) ─
  // Height-fit: the scene always shows the full DESIGN_H rows, and the design
  // WIDTH follows the container's aspect (clamped) so the canvas fills the box
  // edge-to-edge — a wider stage sees more world rather than pillar bars.
  let viewScale = 1;
  let viewOffsetX = 0;
  let viewOffsetY = 0;
  let designW = DESIGN_W;
  let camAnchorX = DESIGN_W * CAM_ANCHOR_FRAC;

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

    viewScale = bh / DESIGN_H;
    designW = clamp(bw / viewScale, MIN_DESIGN_W, MAX_DESIGN_W);
    camAnchorX = designW * CAM_ANCHOR_FRAC;
    // Zero except when the aspect clamp engages (degenerate containers only).
    viewOffsetX = (bw - designW * viewScale) / 2;
    viewOffsetY = 0;

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

  /** World metres -> design-space screen x. `cameraX` lands on the anchor. */
  const worldToScreenX = (s: EngineState, worldXm: number): number =>
    (worldXm - s.cameraX) * PX_PER_METER + camAnchorX;

  /** 1 at surge start → 0 after BOOST_FX_MS; 0 when no recent pickup. */
  const boostFxT = (s: EngineState): number => {
    let best = 0;
    for (let i = 0; i < s.objects.length; i++) {
      const o = s.objects[i];
      if (o.kind !== "moonboots" || o.triggeredAtMs === null) continue;
      const dt = s.timeMs - o.triggeredAtMs;
      if (dt >= 0 && dt < BOOST_FX_MS) best = Math.max(best, 1 - dt / BOOST_FX_MS);
    }
    return best;
  };

  // Smoothed streak intensity: vx changes DISCONTINUOUSLY at bounces and
  // arc re-solves, and streaks keyed raw to it popped in/out as hard bars
  // ("weird lines"). The level chases the live target over ~300ms instead.
  let streakLevel = 0;
  let streakLastMs = 0;

  // Feathered streak sprites, built once (lavender for plain speed, cyan for
  // the moonboots surge).
  const streakSprite = makeStreakSprite(205, 213, 255);
  const streakSpriteBoost = makeStreakSprite(159, 247, 236);

  /**
   * Horizontal wind streaks. World-anchored (they wrap on camera x), moving
   * slightly faster than the world for a parallax-plus rush; intensity rides
   * a smoothed vx so acceleration is legible, and the surge tints them cyan.
   */
  const drawSpeedStreaks = (s: EngineState, boost: number) => {
    const inFlight = s.phase === "launching" || s.phase === "flying";
    const speedFrac = clamp((s.vx - STREAK_MIN_VX) / (STREAK_MAX_VX - STREAK_MIN_VX), 0, 1);
    const target = inFlight ? Math.max(speedFrac * 0.7, boost) : 0;
    const dtMs = clamp(s.timeMs - streakLastMs, 0, 100);
    streakLastMs = s.timeMs;
    streakLevel += (target - streakLevel) * (1 - Math.exp(-dtMs / 300));
    if (streakLevel <= 0.04) return;

    const level = streakLevel;
    const camPx = s.cameraX * PX_PER_METER;
    const len = 120 + 260 * level;
    const sprite = boost > 0.15 ? streakSpriteBoost : streakSprite;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // The sprites are smooth gradients; nearest-neighbour sampling would band
    // them back into hard bars.
    ctx.imageSmoothingEnabled = true;
    for (let i = 0; i < STREAK_COUNT; i++) {
      const h = hash32(i + 991);
      const lane = (h % 1000) / 1000;
      const y = 40 + lane * (DESIGN_H - 280) - camY * 0.25;
      const speedMul = 1.15 + ((h >>> 10) % 40) / 100;
      const wrapW = designW + len * 2;
      let x = (((h >>> 4) % wrapW) - camPx * speedMul) % wrapW;
      if (x < 0) x += wrapW;
      x -= len;
      ctx.globalAlpha = level * (0.14 + ((h >>> 16) % 14) / 100) * (1 + boost * 0.8);
      const w = len * (0.55 + ((h >>> 20) % 50) / 100);
      ctx.drawImage(sprite, x, y, w, 3 + (h % 3));
    }
    ctx.imageSmoothingEnabled = false;
    ctx.restore();
  };

  const drawChris = (s: EngineState, boost: number) => {
    const key = s.chris.key;
    const anchor = CHRIS_ANCHORS[key] ?? CHRIS_ANCHORS.idle;
    const sheet = sheets[CHRIS_SHEETS[key] ?? "chrisIdle"];
    if (!sheet) return;

    const elapsed = s.timeMs - s.chris.startedAtMs;
    let frame = frameIndexAt(sheet.meta, elapsed);
    // The death sheet's final frame is an authored blank (fade-out), and the
    // dying phase (fall + ground dwell) regularly outlives the 2.08s clip —
    // clamping one frame short keeps the body visible until the result
    // overlay takes over instead of vanishing mid-air.
    if (key === "death") frame = Math.min(frame, sheet.meta.frameCount - 2);

    let tilt = 0;
    if (s.phase === "flying" || s.phase === "dying" || s.phase === "launching") {
      // Canvas y grows downward, so a climbing Chris needs a NEGATIVE rotation
      // for his nose to point up.
      tilt = clamp(-Math.atan2(s.vy, Math.max(0.001, s.vx)), -MAX_FLIGHT_TILT_RAD, MAX_FLIGHT_TILT_RAD);
    }

    const x = worldToScreenX(s, s.x);
    const y = GROUND_Y - s.y * PX_PER_METER - camY;

    // Moonboots surge: ghost afterimages trailing back along the velocity
    // vector, strongest nearest the body. Drawn before the main sprite.
    if (boost > 0 && s.phase === "flying") {
      for (let g = 3; g >= 1; g--) {
        const tau = g * 0.038;
        const gx = x - s.vx * tau * PX_PER_METER;
        const gy = y + s.vy * tau * PX_PER_METER;
        drawSheet(ctx, sheet, anchor, gx, gy, frame, opts(false, tilt, (0.34 / g) * boost, 1));
      }
    }

    drawSheet(ctx, sheet, anchor, x, y, frame, opts(false, tilt, 1, 1));

    if (s.phase === "landing") drawDust(ctx, x, y, s.timeMs);
  };

  /**
   * Roadside decoration: fixed start-line spectators plus a sparse
   * deterministic crowd along the route, drawn in the far lane (raised,
   * smaller, slightly dimmed) so they never read as the interactive bounce
   * objects — those stand full-size in the near lane on a pulsing pad.
   */
  const drawCrowd = (s: EngineState) => {
    const laneY = GROUND_Y - BYSTANDER_LANE_RAISE - camY;

    // Start-line spectators watching the launch from behind Chris; the first
    // slot is the animated viz dancer, the rest are static meebits.
    const viz = sheets.viz;
    for (let i = 0; i < SPECTATOR_XS.length; i++) {
      const x = worldToScreenX(s, SPECTATOR_XS[i]);
      if (x < -300 || x > designW + 300) continue;
      if (i === 0 && viz) {
        drawSheet(ctx, viz, SPECTATOR_VIZ_ANCHOR, x, laneY, frameIndexAt(viz.meta, s.timeMs));
        continue;
      }
      const img = images[meebitKeyFor(i + 3)];
      if (img) {
        drawMeebit(
          ctx,
          img,
          x,
          laneY,
          BYSTANDER_H_MIN + (hash32(i) % BYSTANDER_H_VAR),
          s.timeMs,
          i * 3,
          1,
          0.94,
        );
      }
    }

    // Sparse crowd down the route, hashed off the world slot index so it is
    // identical every frame and every run (renderer stays replay-stable).
    // Behaviour buckets, spatially even because the hash is uniform:
    //   0–5 (60%)  patrol-walkers — ping-pong a ±30–70m route at 2–3.2 m/s,
    //              playing the profile walk that faces their travel direction
    //   6–7 (20%)  idle facing the road (front)
    //   8–9 (20%)  dancing (the viz sheet — the one bespoke action asset)
    const leftM = s.cameraX - camAnchorX / PX_PER_METER;
    const rightM = leftM + designW / PX_PER_METER;
    const k0 = Math.max(1, Math.floor(leftM / BYSTANDER_SPACING_M) - 1);
    const k1 = Math.ceil(rightM / BYSTANDER_SPACING_M) + 1;
    for (let k = k0; k <= k1; k++) {
      const h = hash32(k);
      if (h % 4 === 0) continue; // leave gaps — a solid picket line reads fake
      let xm = k * BYSTANDER_SPACING_M + (((h >>> 3) % 120) - 60);
      const bucket = (h >>> 5) % 10;
      const height = BYSTANDER_H_MIN + ((h >>> 7) % BYSTANDER_H_VAR);
      let row = MEEBIT_IDLE_ROW;
      let fps = MEEBIT_FPS;
      if (bucket < 6) {
        // Walker: ping-pong between xm ± amp. Ground speed is matched to the
        // 12fps stride (1.5 leg-cycles/s) — slower than ~9 m/s the feet churn
        // faster than the ground passes and the walk reads as a treadmill.
        // Each leg of a route still runs 9–30 seconds before the turn-around.
        const ampM = 60 + ((h >>> 9) % 81); // 60–140 m either side
        const speed = 9.0 + ((h >>> 13) % 41) / 10; // 9.0–13.0 m/s
        const halfPeriodS = (2 * ampM) / speed;
        const t = s.timeMs / 1000 + ((h >>> 17) % 100) / 7; // per-slot phase
        const ph = (t / halfPeriodS) % 2;
        const tri = ph < 1 ? ph : 2 - ph; // 0..1..0
        xm += (tri - 0.5) * 2 * ampM;
        row = ph < 1 ? MEEBIT_WALK_RIGHT_ROW : MEEBIT_WALK_LEFT_ROW;
        fps = MEEBIT_WALK_FPS;
      }
      if (Math.abs(xm - TUNING.rampX) < 80) continue; // keep the ramp art clear
      const sx = worldToScreenX(s, xm);
      if (sx < -300 || sx > designW + 300) continue;

      if (bucket >= 8) {
        // Dancer — the animated viz meebit at background scale, desynced.
        const viz = sheets.viz;
        if (!viz) continue;
        CROWD_VIZ_ANCHOR.scale = height / 653;
        drawSheet(
          ctx,
          viz,
          CROWD_VIZ_ANCHOR,
          sx,
          laneY,
          frameIndexAt(viz.meta, s.timeMs + (h % 977) * 16),
          opts(false, 0, 0.9, 1),
        );
        continue;
      }

      const img = images[meebitKeyFor(h)];
      if (!img) continue;
      drawMeebit(ctx, img, sx, laneY, height, s.timeMs, h % MEEBIT_GRID, 1, 0.9, row, fps);
    }
  };

  const drawObject = (s: EngineState, obj: WorldObjectState) => {
    const x = worldToScreenX(s, obj.x);
    if (x < -designW * CULL_SCREENS || x > designW * (1 + CULL_SCREENS)) return;
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
        // Brief pop on contact so the bounce reads without bespoke art.
        let pop = 1;
        if (obj.triggeredAtMs !== null) {
          const t = (s.timeMs - obj.triggeredAtMs) / 220;
          if (t >= 0 && t < 1) pop = 1 + 0.12 * Math.sin(t * Math.PI);
        }
        drawBouncePad(ctx, x, groundY, s.timeMs + obj.id * 271);
        // Variant 1 is the animated viz dancer; variant 2 a static meebit
        // (picked per object id, so the character is stable). Either falls
        // back to the other if its art is missing.
        const meebitImg = images[meebitKeyFor(obj.id)];
        const vizSheet = sheets[BOUNCE_SHEET];
        if ((obj.variant === 2 && meebitImg) || !vizSheet) {
          if (!meebitImg) return;
          drawMeebit(ctx, meebitImg, x, groundY, MEEBIT_H, s.timeMs, obj.id, pop);
          return;
        }
        drawSheet(
          ctx,
          vizSheet,
          BOUNCE_ANCHOR,
          x,
          groundY,
          frameIndexAt(vizSheet.meta, s.timeMs + obj.id * 137),
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
      case "laser": {
        // The beam itself is procedural (drawLasers, above Chris); the robot
        // that fires it stands on the road here. Untriggered robots loop the
        // clip's head-scan, desynced per object; the trigger plays the full
        // 45-frame clip once (scan → head tips back → FIRE → recover) and
        // holds its final frame.
        const sheet = sheets.robotObstacle;
        if (!sheet) return;
        const frame =
          obj.triggeredAtMs === null
            ? Math.floor(((s.timeMs + obj.id * 313) / 1000) * sheet.meta.fps) % ROBOT_IDLE_FRAMES
            : frameIndexAt(sheet.meta, s.timeMs - obj.triggeredAtMs);
        drawSheet(ctx, sheet, ROBOT_ANCHOR, x, groundY, frame);
        return;
      }
      default:
        return;
    }
  };

  const drawLasers = (s: EngineState, chrisX: number, chrisY: number) => {
    const robotMeta = sheets.robotObstacle?.meta;
    for (let i = 0; i < s.objects.length; i++) {
      const obj = s.objects[i];
      if (obj.kind !== "laser" || obj.triggeredAtMs === null) continue;
      // Miss beams erupt at the clip's FIRE flare (trigger + wind-up; the
      // engine leads the trigger by exactly that, so the zip lands roughly as
      // Chris passes). The LETHAL beam instead keys to the death moment
      // itself: the kill is position-anchored (engine dies at atX) while the
      // clip is time-anchored, and a bounce re-solve inside the wind-up can
      // drift the two apart — the one beam that must visibly connect is the
      // one that kills, so it fires exactly when Chris does die.
      let elapsed: number;
      if (obj.lethal) {
        if ((s.phase !== "dying" && s.phase !== "ended") || s.endCause !== "laser") continue;
        elapsed = s.timeMs - s.chris.startedAtMs;
      } else {
        elapsed = s.timeMs - obj.triggeredAtMs - LASER_FIRE_DELAY_MS;
      }
      if (elapsed < 0 || elapsed > LASER_FLASH_MS) continue;

      const rx = worldToScreenX(s, obj.x);
      if (rx < -designW * CULL_SCREENS || rx > designW * (1 + CULL_SCREENS)) continue;
      // Beam origin: the robot's opened visor (falls back to off-screen
      // bottom if the sheet failed to load — the pillar still reads).
      const ox = robotMeta
        ? rx + (ROBOT_EYE_AX - ROBOT_ANCHOR.ax) * robotMeta.srcCanvasW * ROBOT_ANCHOR.scale
        : rx;
      const oy = robotMeta
        ? GROUND_Y - camY - (ROBOT_ANCHOR.ay - ROBOT_EYE_AY) * robotMeta.srcCanvasH * ROBOT_ANCHOR.scale
        : DESIGN_H + 80;

      // The beam is a vertical skyward PILLAR, matching the fire pose (the
      // head tips fully back; an angled bolt from that pose reads wrong —
      // and Chris regularly flies at robot-head altitude, where aiming the
      // beam at him degenerates into a shot through the robot's own body).
      // Lethal: Chris is exactly at the robot's x when he dies, so he flies
      // into the pillar; the impact spark marks the hit on him. Misses erupt
      // just behind a passed Chris (see TUNING.events.laserMissLeadMs).
      drawLaserPillar(ctx, ox, oy, elapsed / LASER_FLASH_MS, obj.lethal, chrisX, chrisY);
    }
  };

  const drawPowerMeter = (s: EngineState) => {
    if (s.phase !== "charging") return;
    const sheet = sheets.powerMeter;
    if (!sheet) return;
    const peak = Math.min(POWER_METER_PEAK_FRAME, sheet.meta.frameCount - 1);
    const frame = Math.round(clamp(s.powerFrac, 0, 1) * peak);
    drawSheet(ctx, sheet, POWER_METER_ANCHOR, designW / 2, POWER_METER_Y, frame);
  };

  const draw = (s: EngineState) => {
    // Clear the whole backing store (including any 1px letterbox rounding)
    // in device space, then return to the design-space transform.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Moonboots surge: the whole scene judders while the FX window decays.
    const boost = boostFxT(s);
    ctx.save();
    if (boost > 0) {
      const amp = 6 * boost;
      ctx.translate(Math.sin(s.timeMs * 0.09) * amp, Math.cos(s.timeMs * 0.13) * amp * 0.6);
    }

    paintSky(ctx, sky, -camY, designW, DESIGN_H);

    const cameraPx = s.cameraX * PX_PER_METER - camAnchorX;
    drawParallaxLayer(ctx, bgLayers, cameraPx, PARALLAX_BG, camY, designW, DESIGN_H);
    drawParallaxLayer(ctx, midLayers, cameraPx, PARALLAX_MID, camY, designW, DESIGN_H);
    drawParallaxLayer(ctx, fgLayers, cameraPx, PARALLAX_FG, camY, designW, DESIGN_H);

    drawCrowd(s);

    // The crashed-UFO ramp is scenery, not a plan event — its world x comes
    // straight from the engine's launch point so the two can never disagree.
    const rampSheet = sheets.rampUfo;
    if (rampSheet) {
      const rx = worldToScreenX(s, TUNING.rampX);
      if (rx > -designW * CULL_SCREENS && rx < designW * (1 + CULL_SCREENS)) {
        drawSheet(ctx, rampSheet, RAMP_ANCHOR, rx, GROUND_Y - camY, frameIndexAt(rampSheet.meta, s.timeMs));
      }
    }

    for (let i = 0; i < s.objects.length; i++) drawObject(s, s.objects[i]);

    drawSpeedStreaks(s, boost);
    drawChris(s, boost);

    drawLasers(s, worldToScreenX(s, s.x), GROUND_Y - s.y * PX_PER_METER - camY);
    drawPowerMeter(s);
    ctx.restore();
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
 * Chunky additive skyward beam. No art exists for the beam itself, so it's
 * built from three stacked hard-edged bars (wide glow / mid / white core)
 * under `globalCompositeOperation = "lighter"` — bright and pixel-adjacent,
 * with no soft shadowBlur that would fight the pixel-art layers. The pillar
 * fires straight UP from the visor at (ox, oy), far past the top of the
 * frame; a lethal shot also flashes an impact spark on Chris (sparkX/Y).
 */
function drawLaserPillar(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  progress: number,
  lethal: boolean,
  sparkX: number,
  sparkY: number,
): void {
  // Hot for the first third, then a quick fade.
  const a = progress < 0.35 ? 1 : Math.max(0, 1 - (progress - 0.35) / 0.65);
  if (a <= 0) return;

  // Tall enough to leave the frame even with the camera panned far up.
  const len = oy + DESIGN_H * 2;
  const color = lethal ? LASER_LETHAL_COLOR : LASER_MISS_COLOR;
  const core = LASER_CORE_W * (0.6 + 0.4 * a);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.28 * a;
  ctx.fillRect(ox - core * 3, oy - len, core * 6, len);
  ctx.globalAlpha = 0.55 * a;
  ctx.fillRect(ox - core * 1.4, oy - len, core * 2.8, len);
  ctx.globalAlpha = 0.95 * a;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(ox - core * 0.5, oy - len, core, len);

  // Muzzle flare at the robot's visor.
  ctx.globalAlpha = 0.7 * a;
  ctx.fillStyle = color;
  ctx.fillRect(ox - core * 4, oy - 86, core * 8, 110);
  ctx.restore();

  if (!lethal || progress > 0.4) return;

  // Impact spark on the lethal hit.
  const burst = 1 - progress / 0.4;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = burst;
  ctx.fillStyle = "#ffffff";
  const size = 26 + 70 * (1 - burst);
  ctx.fillRect(sparkX - size / 2, sparkY - size / 2, size, size);
  ctx.globalAlpha = burst * 0.6;
  ctx.fillStyle = color;
  ctx.fillRect(sparkX - size, sparkY - size / 4, size * 2, size / 2);
  ctx.fillRect(sparkX - size / 4, sparkY - size, size / 2, size * 2);
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
