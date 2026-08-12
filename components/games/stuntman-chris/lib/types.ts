/**
 * Stuntman Chris — shared contract between the engine, renderer, and UI layers.
 *
 * OWNED BY THE ORCHESTRATOR. Builders code against these types; if a change is
 * genuinely needed, report it rather than editing this file.
 *
 * Layer boundaries:
 *  - engine  (lib/engine/engine.ts, exports `createEngine: CreateEngine`;
 *             lib/engine/flightPlan.ts, exports `createDummyFlightPlanProvider(): FlightPlanProvider`;
 *             lib/engine/tuning.ts, exports `TUNING`)
 *             Pure TS. No React, no DOM, no window. Owns all game truth.
 *  - renderer(lib/render/renderer.ts, exports `createRenderer: CreateRendererFn`
 *             and `loadStuntAssets: LoadAssetsFn`; lib/render/sprites.ts)
 *             Canvas 2D. Owns the rAF loop: each frame calls engine.tick(now)
 *             then draws everything IN the scene (parallax, Chris, world
 *             objects, lasers, the charging power meter). No React state.
 *  - UI      (StuntmanChris.tsx orchestrator, StuntmanChrisWindow.tsx island,
 *             setup card, overlays, app/games/stuntman-chris/page.tsx)
 *             All DOM: title/instruction/result overlays, distance HUD,
 *             controls. Reads engine state via refs each frame — never
 *             setState per frame.
 *
 * Determinism model (the future on-chain seam): outcome-first. A
 * FlightPlanProvider turns a launch power into a complete scripted outcome
 * BEFORE the flight starts; the engine's kinematics exactly realize that
 * script. v1 provider is dummy RNG; v2 swaps in a contract-backed provider
 * with zero changes elsewhere. The provider is async on purpose — the riding
 * phase masks its latency (later: tx + VRF wait).
 */

// ── Scene design space ──────────────────────────────────────────────────────

export const DESIGN_W = 1920;
export const DESIGN_H = 1080;
/** Foreground world-to-screen scale. Parallax layers scroll at a fraction of this. */
export const PX_PER_METER = 6;

// ── Flight plan (the scripted outcome) ──────────────────────────────────────

export type EndCause = "laser" | "bone" | "crash" | "landed";

export type FlightEventKind =
  | "laser" // laser bolt fired at Chris mid-air; lethal:true = the death event
  | "skeleton" // grave skeleton scenery that throws a bone as Chris passes; lethal:true = bone connects
  | "bounce" // object Chris lands on that re-launches him with a boost
  | "moonboots" // mid-air pickup granting a speed boost
  | "blocker"; // ground obstacle that stops the run on contact (endCause "crash")

export interface FlightEvent {
  id: number;
  kind: FlightEventKind;
  /** World x in meters where the event lives / fires. Sorted ascending in the plan. */
  atX: number;
  /** Art variant, e.g. skeleton throw 1 vs 2, bounce object variant. */
  variant: number;
  /** Whether this event ends the run (laser hit / bone hit / blocker). */
  lethal: boolean;
}

export interface FlightPlan {
  /** Launch power 0..1 the plan was generated for. */
  power: number;
  /** Authoritative final distance in meters. */
  finalDistance: number;
  endCause: EndCause;
  /** Sorted by atX. A lethal event, if any, is the last event and sits at ~finalDistance. */
  events: FlightEvent[];
}

export type FlightPlanProvider = (power: number) => Promise<FlightPlan>;

// ── Engine ──────────────────────────────────────────────────────────────────

export type StuntPhase =
  | "title" // pre-game; scene idle behind title overlay
  | "ready" // Chris idling on bike, waiting for input
  | "charging" // player holding; powerFrac sweeps
  | "riding" // released; bike accelerates toward the ramp (plan may still be resolving)
  | "launching" // on the ramp, transitioning to air
  | "flying" // main phase; events fire
  | "dying" // lethal event hit; death anim plays, momentum decays
  | "landing" // touched down alive; sliding to a stop
  | "ended"; // run complete; result overlay time

export type ChrisAnimKey =
  | "idle"
  | "idleTransition"
  | "riding"
  | "flying"
  | "death";

export interface ChrisAnimState {
  key: ChrisAnimKey;
  /** Engine timeMs when this anim began (renderer derives the frame from elapsed). */
  startedAtMs: number;
}

export interface WorldObjectState {
  id: number;
  kind: FlightEventKind;
  /** World x meters. */
  x: number;
  /**
   * World altitude (meters, y=0 ground) of the object's anchor, for airborne
   * objects. The engine MUST set this for "moonboots" (a point on Chris's
   * scripted arc so the pickup visually connects) and MAY set it for raised
   * "bounce" objects. Ground objects omit it (renderer assumes 0).
   */
  y?: number;
  variant: number;
  lethal: boolean;
  /** Engine timeMs its reaction anim started (bone throw / bounce squash / pickup), null if not yet. */
  triggeredAtMs: number | null;
  /** Bounce used / powerup collected. */
  consumed: boolean;
}

export interface EngineState {
  phase: StuntPhase;
  /** Engine clock, ms since engine creation (monotonic, from tick's nowMs). */
  timeMs: number;
  /** Chris world position, meters. y = 0 is the road surface; +y is up. */
  x: number;
  y: number;
  /** Velocity m/s. */
  vx: number;
  vy: number;
  /** 0..1. Sweeps during charging; frozen at its launch value afterwards. */
  powerFrac: number;
  /** Display distance (m) — what the HUD shows. */
  distanceM: number;
  /** Camera world x, meters (renderer converts with PX_PER_METER). */
  cameraX: number;
  plan: FlightPlan | null;
  /** All plan objects, world-positioned; renderer culls to camera range. */
  objects: WorldObjectState[];
  chris: ChrisAnimState;
  endCause: EndCause | null;
}

export interface StuntEngine {
  readonly state: Readonly<EngineState>;
  /**
   * Advance to wall-clock nowMs (performance.now()) and return the new state.
   * Called once per frame by the renderer's rAF loop. Must be safe against
   * large dt (tab-hidden gaps) — clamp internally.
   */
  tick(nowMs: number): Readonly<EngineState>;
  /** title → ready */
  begin(): void;
  /** ready → charging */
  startCharge(): void;
  /** charging → riding; captures powerFrac and requests the flight plan. */
  releaseCharge(): void;
  /** any → ready (fresh run, same session). */
  reset(): void;
  /** Subscribe to phase transitions. Returns unsubscribe. */
  onPhase(cb: (phase: StuntPhase, state: Readonly<EngineState>) => void): () => void;
}

export type CreateEngine = (provider: FlightPlanProvider) => StuntEngine;

// ── Renderer ────────────────────────────────────────────────────────────────

/**
 * Opaque loaded-asset bag. The renderer module defines the concrete shape;
 * the UI just loads it (for the preload overlay's progress bar) and hands it
 * to createRenderer.
 */
export interface StuntAssets {
  readonly ready: true;
}

export type LoadAssetsFn = (
  onProgress?: (loaded: number, total: number) => void,
) => Promise<StuntAssets>;

export interface CreateRendererOpts {
  /** Fill-parent host element; renderer appends its canvas and observes size. */
  container: HTMLElement;
  engine: StuntEngine;
  assets: StuntAssets;
}

export interface RendererHandle {
  dispose(): void;
}

export type CreateRendererFn = (opts: CreateRendererOpts) => RendererHandle;
