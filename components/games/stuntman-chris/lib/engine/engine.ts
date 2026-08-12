/* ============================================================================
 * ON-CHAIN INTEGRATION SEAMS
 * ----------------------------------------------------------------------------
 * This engine contains NO randomness and NO outcome logic. It is handed a
 * `FlightPlanProvider` (see flightPlan.ts) and does exactly one job: produce
 * kinematics that land on the plan's `finalDistance` and fire the plan's
 * events, to the metre. Swapping the dummy provider for a contract-backed one
 * changes nothing in here.
 *
 * Two seams matter to the integration:
 *   1. `releaseCharge()` is where the plan is requested (this is where a bet
 *      tx would be sent). The `riding` phase deliberately exists to mask the
 *      provider's latency — Chris rides toward the ramp while the outcome
 *      resolves, and holds short of the ramp if it is still pending.
 *   2. Provider rejection / stall is survivable: after `TUNING.ride.maxHoldMs`
 *      the engine substitutes a fallback plan so a run can never wedge. That
 *      path should never be reachable once a real provider is wired, but it
 *      keeps a dropped RPC from freezing the scene.
 *
 * ── How the plan is realized (the interesting part) ─────────────────────────
 * The flight is a chain of ARCS. An arc runs from one ground contact to the
 * next, where "ground contact" means either a scripted bounce object or the
 * end of the run. For each arc the solver is given the exact horizontal SPAN
 * it must cover and the height it must arrive at, and derives velocities from
 * that rather than the other way round:
 *
 *     T   = clamp(span / vxTarget, minT, maxT)          ← arc *shape*
 *     vy0 = (yEnd − y0 + ½·g·T²) / T                    ← arrives at yEnd at T
 *     vx0 = span·k / (1 − e^(−k·T))                     ← covers span in T
 *
 * Positions are then evaluated ANALYTICALLY from the arc's start state
 * (x = x0 + vx0·(1−e^(−kτ))/k, y = y0 + vy0·τ − ½gτ²) rather than integrated
 * incrementally, so there is no accumulation drift and no end-of-arc snap: at
 * τ = T the arc is exactly on its target by construction, whatever the frame
 * rate did. Correction is therefore never a visible jump — it lives entirely
 * in the (constant, per-arc) choice of vx0.
 *
 * Two events perturb an arc mid-flight and are handled by RE-SOLVING rather
 * than by nudging:
 *   • moonboots — a short boosted segment (higher vx, upward kick), after
 *     which the arc is re-solved from the live state toward the same target.
 *     The re-solve derives T from the CURRENT vy (vertical continuity, no
 *     jerk) and puts the whole correction into vx.
 *   • a lethal hit — the arc is abandoned; `dying` takes over.
 *
 * The alive ending is the one place a span is reserved up front: the last arc
 * aims at `finalDistance − slide`, and the skid solves its own deceleration
 * from the actual touchdown speed so it stops exactly on `finalDistance`.
 * For a mid-air kill the last arc is aimed PAST `finalDistance` so Chris is
 * still airborne when the shot connects.
 * ============================================================================ */

import {
  type ChrisAnimKey,
  type CreateEngine,
  type EndCause,
  type EngineState,
  type FlightPlan,
  type FlightPlanProvider,
  type StuntEngine,
  type StuntPhase,
  type WorldObjectState,
} from "../types";
import { TUNING, shapePower } from "./tuning";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where an arc must arrive, and what happens when it does. */
interface ArcTarget {
  /** World x, metres. */
  x: number;
  /** Altitude on arrival (bounce deck height, or 0 for the ground). */
  y: number;
  kind: "bounce" | "final";
  /** FlightEvent id of the bounce object, when this target is one. */
  eventId: number | null;
}

/** A closed-form ballistic segment. */
interface Arc {
  /** Engine ms at which this segment started. */
  t0: number;
  x0: number;
  y0: number;
  vx0: number;
  vy0: number;
  /** Seconds until the segment ends. */
  durS: number;
  /** `contact` = arrive at the current target; `resolve` = re-solve mid-air. */
  onEnd: "contact" | "resolve";
}

/** Horizontal reach of an exponentially damped launch over T seconds. */
function spanOf(vx0: number, k: number, T: number): number {
  return (vx0 * (1 - Math.exp(-k * T))) / k;
}

/** Inverse of `spanOf`: the vx0 that covers exactly `span` in T seconds. */
function vxForSpan(span: number, k: number, T: number): number {
  const denom = 1 - Math.exp(-k * T);
  return denom > 1e-9 ? (span * k) / denom : span / Math.max(T, 1e-6);
}

/** Time to fall from y0 to y1 given an initial vy (positive = upward). */
function fallTime(y0: number, y1: number, vy0: number, g: number): number {
  const disc = vy0 * vy0 + 2 * g * (y0 - y1);
  if (disc <= 0) return Math.max(vy0 / g, 1e-3) * 2;
  return (vy0 + Math.sqrt(disc)) / g;
}

/** Initial vy that puts you at y1, coming from y0, after exactly T seconds. */
function vyForDuration(y0: number, y1: number, T: number, g: number): number {
  return (y1 - y0 + 0.5 * g * T * T) / T;
}

/**
 * Largest upward vy allowed from altitude `y`. Apex is y + vy²/(2g), so this
 * makes `arc.maxAltitudeM` a hard ceiling on every code path that sets vy —
 * fresh arcs, mid-air re-solves and the moonboots surge alike.
 */
function vyCeilingAt(y: number): number {
  const g = TUNING.world.gravity;
  const headroom = Math.max(TUNING.arc.maxAltitudeM - y, 0);
  return Math.min(TUNING.arc.maxVy, Math.sqrt(2 * g * headroom));
}

class Engine implements StuntEngine {
  private readonly provider: FlightPlanProvider;
  private readonly listeners = new Set<(phase: StuntPhase, state: Readonly<EngineState>) => void>();
  private readonly s: EngineState;

  /** Wall clock of the previous tick, for dt. */
  private lastNowMs: number | null = null;
  /** Bumped on reset() so an in-flight provider promise from a dead run is ignored. */
  private runToken = 0;

  private chargeStartMs = 0;
  private rideSpeed = 0;
  private rideStartMs = 0;
  private holdMs = 0;
  private launchStartMs = 0;

  private targets: ArcTarget[] = [];
  private targetIdx = 0;
  private arc: Arc | null = null;
  private finalContact = false;
  /** Highest x reached; the HUD distance is derived from this so it can't tick backwards. */
  private maxX = 0;
  /** Arc-shape speed for this run, derived from the launch power. */
  private vxTarget: number = TUNING.arc.vxTargetMin;
  /** Metres of climb an arc may spend this run, derived from the launch power. */
  private apexBudget: number = TUNING.arc.apexBudgetMin;
  /** Metres reserved for the alive skid, chosen before the last arc is solved. */
  private slideM: number = TUNING.landing.slideMinM;

  private eventCursor = 0;
  /** World x at which a triggered lethal event actually connects (bones lead). */
  private pendingLethalX: number | null = null;

  private landT0 = 0;
  private landX0 = 0;
  private landV0 = 0;
  private landA = 0;
  private landStopS = 0;
  private landStoppedAtMs: number | null = null;

  private deathT0 = 0;
  private deathX0 = 0;
  private deathY0 = 0;
  private deathVx0 = 0;
  private deathVy0 = 0;
  private deathGroundedAtMs: number | null = null;

  constructor(provider: FlightPlanProvider) {
    this.provider = provider;
    this.s = {
      phase: "title",
      timeMs: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      powerFrac: 0,
      distanceM: 0,
      cameraX: 0,
      plan: null,
      objects: [],
      chris: { key: "idle", startedAtMs: 0 },
      endCause: null,
    };
    this.updateCamera();
  }

  get state(): Readonly<EngineState> {
    return this.s;
  }

  // ── public API ────────────────────────────────────────────────────────────

  tick(nowMs: number): Readonly<EngineState> {
    if (this.lastNowMs === null) this.lastNowMs = nowMs;
    let dt = nowMs - this.lastNowMs;
    this.lastNowMs = nowMs;
    if (!Number.isFinite(dt) || dt <= 0) return this.s;
    // A tab-hidden gap must not fast-forward the run; the engine clock simply
    // loses that time (it is a presentation clock, not wall time).
    dt = Math.min(dt, TUNING.loop.maxFrameMs);

    while (dt > 1e-6) {
      const step = Math.min(dt, TUNING.loop.maxStepMs);
      this.step(step);
      dt -= step;
    }
    return this.s;
  }

  begin(): void {
    if (this.s.phase !== "title") return;
    this.resetRunState();
    this.setPhase("ready");
  }

  startCharge(): void {
    if (this.s.phase !== "ready") return;
    this.chargeStartMs = this.s.timeMs;
    this.s.powerFrac = 0;
    this.setPhase("charging");
  }

  releaseCharge(): void {
    if (this.s.phase !== "charging") return;
    const shaped = shapePower(this.s.powerFrac);
    this.vxTarget = lerp(TUNING.arc.vxTargetMin, TUNING.arc.vxTargetMax, shaped);
    this.apexBudget = lerp(TUNING.arc.apexBudgetMin, TUNING.arc.apexBudgetMax, shaped);
    this.rideSpeed = 0;
    this.rideStartMs = this.s.timeMs;
    this.holdMs = 0;
    this.setAnim("idleTransition");
    this.setPhase("riding");
    this.requestPlan(this.s.powerFrac);
  }

  reset(): void {
    this.runToken++;
    this.resetRunState();
    this.setPhase("ready");
  }

  onPhase(cb: (phase: StuntPhase, state: Readonly<EngineState>) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ── plan plumbing ─────────────────────────────────────────────────────────

  private requestPlan(power: number): void {
    const token = this.runToken;
    let settled = false;
    const accept = (plan: FlightPlan) => {
      if (settled || token !== this.runToken) return;
      settled = true;
      this.adoptPlan(plan);
    };
    try {
      this.provider(power).then(accept, () => accept(this.fallbackPlan(power)));
    } catch {
      accept(this.fallbackPlan(power));
    }
  }

  /** Last-resort plan so a stalled/rejected provider can't wedge the scene. */
  private fallbackPlan(power: number): FlightPlan {
    const s = shapePower(power);
    return {
      power: clamp(power, 0, 1),
      finalDistance: Math.round(lerp(200, 900, s)),
      endCause: "landed",
      events: [],
    };
  }

  private adoptPlan(plan: FlightPlan): void {
    if (this.s.plan) return;
    this.s.plan = plan;
    this.s.objects = plan.events.map<WorldObjectState>((e) => ({
      id: e.id,
      kind: e.kind,
      x: e.atX,
      variant: e.variant,
      lethal: e.lethal,
      triggeredAtMs: null,
      consumed: false,
    }));
  }

  // ── phase machine ─────────────────────────────────────────────────────────

  private setPhase(phase: StuntPhase): void {
    if (this.s.phase === phase) return;
    this.s.phase = phase;
    for (const cb of this.listeners) cb(phase, this.s);
  }

  private setAnim(key: ChrisAnimKey): void {
    if (this.s.chris.key === key) return;
    this.s.chris = { key, startedAtMs: this.s.timeMs };
  }

  private resetRunState(): void {
    this.s.x = 0;
    this.s.y = 0;
    this.s.vx = 0;
    this.s.vy = 0;
    this.s.powerFrac = 0;
    this.s.distanceM = 0;
    this.s.plan = null;
    this.s.objects = [];
    this.s.endCause = null;
    this.s.chris = { key: "idle", startedAtMs: this.s.timeMs };
    this.targets = [];
    this.targetIdx = 0;
    this.arc = null;
    this.finalContact = false;
    this.maxX = 0;
    this.eventCursor = 0;
    this.pendingLethalX = null;
    this.rideSpeed = 0;
    this.holdMs = 0;
    this.landStoppedAtMs = null;
    this.deathGroundedAtMs = null;
    this.updateCamera();
  }

  private step(dtMs: number): void {
    this.s.timeMs += dtMs;
    switch (this.s.phase) {
      case "charging":
        this.stepCharging();
        break;
      case "riding":
        this.stepRiding(dtMs);
        break;
      case "launching":
        this.stepLaunching();
        break;
      case "flying":
        this.stepFlying();
        break;
      case "dying":
        this.stepDying();
        break;
      case "landing":
        this.stepLanding();
        break;
      default:
        break;
    }
    this.updateDistance();
    this.updateCamera();
  }

  private stepCharging(): void {
    const period = TUNING.charge.sweepMs;
    const phase = ((this.s.timeMs - this.chargeStartMs) % period) / period;
    this.s.powerFrac = phase < 0.5 ? phase * 2 : 2 - phase * 2;
  }

  private stepRiding(dtMs: number): void {
    const dt = dtMs / 1000;
    const top = lerp(TUNING.ride.topSpeedMin, TUNING.ride.topSpeedMax, shapePower(this.s.powerFrac));
    this.rideSpeed = Math.min(this.rideSpeed + TUNING.ride.accel * dt, top);

    if (this.s.chris.key === "idleTransition" && this.s.timeMs - this.rideStartMs >= TUNING.ride.idleTransitionMs) {
      this.setAnim("riding");
    }

    let nx = this.s.x + this.rideSpeed * dt;
    if (!this.s.plan) {
      // Outcome still resolving: park short of the ramp rather than launch
      // blind. Bounded, so a dead provider degrades instead of freezing.
      const holdX = TUNING.rampX - TUNING.ride.holdMarginM;
      if (nx > holdX) {
        nx = holdX;
        this.rideSpeed = Math.min(this.rideSpeed, TUNING.ride.holdSpeed);
        this.holdMs += dtMs;
        if (this.holdMs >= TUNING.ride.maxHoldMs) this.adoptPlan(this.fallbackPlan(this.s.powerFrac));
      }
    }

    this.s.x = nx;
    this.s.vx = this.rideSpeed;
    this.s.vy = 0;

    if (this.s.plan && this.s.x >= TUNING.rampX) {
      this.s.x = TUNING.rampX;
      this.launchStartMs = this.s.timeMs;
      this.setAnim("flying");
      this.setPhase("launching");
    }
  }

  private stepLaunching(): void {
    const f = clamp((this.s.timeMs - this.launchStartMs) / TUNING.ride.launchMs, 0, 1);
    this.s.x = TUNING.rampX + f * TUNING.ride.rampLengthM;
    // Ease the climb so the lip reads as a kick rather than a linear ramp.
    this.s.y = f * f * TUNING.ride.rampHeightM;
    const durS = TUNING.ride.launchMs / 1000;
    this.s.vx = TUNING.ride.rampLengthM / durS;
    this.s.vy = (2 * f * TUNING.ride.rampHeightM) / durS;
    if (f >= 1) this.beginFlight();
  }

  // ── flight ────────────────────────────────────────────────────────────────

  private beginFlight(): void {
    const plan = this.s.plan;
    if (!plan) return;
    const startX = TUNING.rampX + TUNING.ride.rampLengthM;
    const { minSpanM } = TUNING.arc;

    // Reserve the skid before anything else: it moves the last arc's target.
    this.slideM = clamp(
      Math.min(this.vxTarget * TUNING.landing.slideSeconds * 0.5, plan.finalDistance * TUNING.landing.slideMaxFrac),
      TUNING.landing.slideMinM,
      TUNING.landing.slideMaxM,
    );

    let finalX: number;
    if (plan.endCause === "landed") {
      finalX = plan.finalDistance - this.slideM;
    } else if (plan.endCause === "crash") {
      // The blocker sits on the ground exactly at finalDistance.
      finalX = plan.finalDistance;
    } else {
      // Mid-air kill: aim past the kill point so he is still airborne for it.
      const margin = clamp(
        plan.finalDistance * TUNING.death.airMarginFrac,
        TUNING.death.airMarginMinM,
        TUNING.death.airMarginMaxM,
      );
      finalX = plan.finalDistance + margin;
    }
    finalX = Math.max(finalX, startX + minSpanM);

    this.targets = [];
    let lastX = startX;
    for (const e of plan.events) {
      if (e.kind !== "bounce") continue;
      // A bounce too tight against its neighbours is flown OVER rather than
      // squeezed into a degenerate arc; it still triggers as scenery.
      if (e.atX < lastX + minSpanM) continue;
      if (e.atX > finalX - minSpanM) continue;
      this.targets.push({ x: e.atX, y: TUNING.world.bounceTopM, kind: "bounce", eventId: e.id });
      lastX = e.atX;
    }
    this.targets.push({ x: finalX, y: 0, kind: "final", eventId: null });

    this.targetIdx = 0;
    this.finalContact = false;
    this.s.x = startX;
    this.s.y = TUNING.ride.rampHeightM;

    // Dry-run every arc up front purely to give airborne pickups an altitude:
    // a moonboots has to sit ON the trajectory or it never visually connects.
    // Arc solving is deterministic, so the first arc of this pass IS the real
    // one; later arcs are re-annotated as they are actually solved (a
    // moonboots surge can reshape the arc it happens on, but never an earlier
    // one, and the provider emits at most one pickup per run).
    let simX = startX;
    let simY = this.s.y;
    let simT = this.s.timeMs;
    let firstArc: Arc | null = null;
    for (const target of this.targets) {
      const a = this.solveFreshArc(simT, simX, simY, target);
      this.annotateAirborneObjects(a, target.x);
      if (!firstArc) firstArc = a;
      simX = target.x;
      simY = target.y;
      simT += a.durS * 1000;
    }
    // Safety net: the contract requires an altitude on every moonboots, even
    // one the provider somehow scripted outside the flown corridor.
    for (const o of this.s.objects) if (o.kind === "moonboots" && o.y === undefined) o.y = 0;

    this.arc = firstArc;
    this.setAnim("flying");
    this.setPhase("flying");
  }

  /**
   * Give every not-yet-triggered airborne object on `arc` the altitude the
   * trajectory actually has at its x, so the renderer can draw the pickup
   * exactly where Chris will pass through it.
   */
  private annotateAirborneObjects(arc: Arc, endX: number): void {
    const { gravity: g, airDragK: k } = TUNING.world;
    for (const o of this.s.objects) {
      if (o.kind !== "moonboots" || o.triggeredAtMs !== null) continue;
      if (o.x < arc.x0 - 1e-6 || o.x > endX + 1e-6) continue;
      // Invert x(τ) = x0 + vx0·(1 − e^(−kτ))/k for the τ at this object's x.
      const inner = 1 - ((o.x - arc.x0) * k) / Math.max(arc.vx0, 1e-6);
      const tau = clamp(inner > 1e-6 ? -Math.log(inner) / k : arc.durS, 0, arc.durS);
      o.y = Math.max(arc.y0 + arc.vy0 * tau - 0.5 * g * tau * tau, 0);
    }
  }

  /** Arc start: pick the SHAPE from the span, then derive exact velocities. */
  private solveFreshArc(t0: number, x0: number, y0: number, target: ArcTarget): Arc {
    const { gravity: g, airDragK: k } = TUNING.world;
    const A = TUNING.arc;
    const span = Math.max(target.x - x0, 1e-3);

    // Two independent lids on the climb: this run's power budget (looks) and
    // the absolute frame ceiling (the renderer's hard constraint).
    const vyMax = Math.min(vyCeilingAt(y0), Math.sqrt(2 * g * this.apexBudget));
    let T = clamp(span / Math.max(this.vxTarget, 1), A.minT, A.maxT);
    let vy0 = vyForDuration(y0, target.y, T, g);
    if (vy0 > vyMax || vy0 < A.minVy) {
      // Velocity clamp wins on looks; T is re-derived so the arc still lands
      // exactly on the target (never clamp both — that breaks the contract).
      vy0 = clamp(vy0, A.minVy, vyMax);
      T = fallTime(y0, target.y, vy0, g);
    }
    const vx0 = vxForSpan(span, k, T);
    return { t0, x0, y0, vx0, vy0, durS: T, onEnd: "contact" };
  }

  /**
   * Mid-air re-solve (post-moonboots). T comes from the CURRENT vy so there is
   * no vertical discontinuity; the entire correction goes into vx.
   */
  private solveContinuingArc(t0: number, x: number, y: number, vy: number, target: ArcTarget): Arc {
    const { gravity: g, airDragK: k } = TUNING.world;
    const span = Math.max(target.x - x, 1e-3);
    let vy0 = vy;
    let T = fallTime(y, target.y, vy0, g);
    // Too little air left for the distance owed → buy time with lift rather
    // than teleport him forward at an impossible speed.
    const minT = span / TUNING.arc.maxVx;
    if (T < minT) {
      vy0 = clamp(vyForDuration(y, target.y, minT, g), TUNING.arc.minVy, vyCeilingAt(y));
      T = Math.max(fallTime(y, target.y, vy0, g), 1e-3);
    }
    const vx0 = vxForSpan(span, k, T);
    return { t0, x0: x, y0: y, vx0, vy0, durS: T, onEnd: "contact" };
  }

  private evalArc(a: Arc, tauS: number): void {
    const { gravity: g, airDragK: k } = TUNING.world;
    const e = Math.exp(-k * tauS);
    this.s.x = a.x0 + (a.vx0 * (1 - e)) / k;
    this.s.y = a.y0 + a.vy0 * tauS - 0.5 * g * tauS * tauS;
    this.s.vx = a.vx0 * e;
    this.s.vy = a.vy0 - g * tauS;
  }

  private stepFlying(): void {
    // Segment boundaries are resolved by carrying leftover time into the next
    // arc (rather than splitting dt), which keeps arcs exact at any frame rate.
    let guard = 0;
    while (this.arc && guard++ < 8) {
      const arc = this.arc;
      const tau = (this.s.timeMs - arc.t0) / 1000;
      if (tau < arc.durS) {
        this.evalArc(arc, tau);
        break;
      }
      this.evalArc(arc, arc.durS);
      const endMs = arc.t0 + arc.durS * 1000;
      const target = this.targets[this.targetIdx];

      if (arc.onEnd === "resolve") {
        this.arc = target ? this.solveContinuingArc(endMs, this.s.x, this.s.y, this.s.vy, target) : null;
        if (this.arc && target) this.annotateAirborneObjects(this.arc, target.x);
        continue;
      }
      if (!target) {
        this.arc = null;
        break;
      }

      // Contact.
      this.s.x = target.x;
      this.s.y = target.y;
      if (target.kind === "bounce") {
        const obj = target.eventId === null ? undefined : this.s.objects.find((o) => o.id === target.eventId);
        if (obj) obj.consumed = true;
        this.targetIdx++;
        const next = this.targets[this.targetIdx];
        this.arc = next ? this.solveFreshArc(endMs, this.s.x, this.s.y, next) : null;
        if (this.arc && next) this.annotateAirborneObjects(this.arc, next.x);
        continue;
      }
      this.arc = null;
      this.finalContact = true;
      break;
    }

    this.processEvents();
    if (this.pendingLethalX !== null && this.s.x >= this.pendingLethalX) {
      this.die();
      return;
    }
    if (this.finalContact) this.beginLanding();
  }

  private processEvents(): void {
    const plan = this.s.plan;
    if (!plan) return;
    // Strictly ordered: an event can only fire once its predecessor has. The
    // bone lead can pull a skeleton's trigger point backwards, and the plan's
    // minimum event gap is sized to exceed that lead, so this never starves.
    while (this.eventCursor < plan.events.length) {
      const ev = plan.events[this.eventCursor];
      const triggerX =
        ev.kind === "skeleton"
          ? ev.atX - Math.max(this.s.vx, 1) * (TUNING.events.boneLeadMs / 1000)
          : ev.atX;
      if (this.s.x < triggerX) break;

      const obj = this.s.objects[this.eventCursor];
      if (obj) obj.triggeredAtMs = this.s.timeMs;
      this.eventCursor++;

      if (ev.kind === "moonboots") {
        if (obj) obj.consumed = true;
        this.applyMoonboots();
      }
      // The bone is in the air at trigger time; it connects at the grave's atX.
      if (ev.lethal && this.pendingLethalX === null) this.pendingLethalX = ev.atX;
    }
  }

  private applyMoonboots(): void {
    if (this.s.phase !== "flying" || !this.arc) return;
    const target = this.targets[this.targetIdx];
    if (!target) return;
    const { airDragK: k, gravity: g } = TUNING.world;
    const spanLeft = target.x - this.s.x;
    if (spanLeft <= TUNING.arc.minSpanM) return;

    const vx0 = Math.max(this.s.vx, 1) * TUNING.events.moonbootsVxMult;
    const vy0 = Math.min(this.s.vy + TUNING.events.moonbootsVyBoost, vyCeilingAt(this.s.y));
    // The surge must neither overshoot the target nor eat the whole descent —
    // whatever it does consume, the follow-up re-solve absorbs.
    let T = Math.min(
      TUNING.events.moonbootsBoostMs / 1000,
      fallTime(this.s.y, target.y, vy0, g) * 0.7,
    );
    const maxSpan = spanLeft * 0.7;
    if (spanOf(vx0, k, T) > maxSpan) {
      const inner = 1 - (maxSpan * k) / vx0;
      T = inner > 1e-6 ? Math.min(T, -Math.log(inner) / k) : T;
    }
    if (!(T > 0.05)) return;

    this.arc = { t0: this.s.timeMs, x0: this.s.x, y0: this.s.y, vx0, vy0, durS: T, onEnd: "resolve" };
  }

  // ── endings ───────────────────────────────────────────────────────────────

  private beginLanding(): void {
    const plan = this.s.plan;
    if (!plan) return;
    this.arc = null;
    this.s.y = 0;
    this.s.vy = 0;
    // Deceleration is solved from the ACTUAL touchdown speed and the metres
    // still owed, so the skid stops exactly on finalDistance.
    const remaining = Math.max(plan.finalDistance - this.s.x, 0.5);
    const v0 = Math.max(this.s.vx, 0.5);
    this.landT0 = this.s.timeMs;
    this.landX0 = this.s.x;
    this.landV0 = v0;
    this.landA = (v0 * v0) / (2 * remaining);
    this.landStopS = (2 * remaining) / v0;
    this.landStoppedAtMs = null;
    this.s.endCause = "landed";
    this.setAnim("riding");
    this.setPhase("landing");
  }

  private stepLanding(): void {
    const plan = this.s.plan;
    const tau = (this.s.timeMs - this.landT0) / 1000;
    if (tau >= this.landStopS) {
      this.s.x = plan ? plan.finalDistance : this.s.x;
      this.s.vx = 0;
      if (this.landStoppedAtMs === null) this.landStoppedAtMs = this.s.timeMs;
      if (this.s.timeMs - this.landStoppedAtMs >= TUNING.landing.settleMs) this.setPhase("ended");
    } else {
      this.s.x = this.landX0 + this.landV0 * tau - 0.5 * this.landA * tau * tau;
      this.s.vx = Math.max(this.landV0 - this.landA * tau, 0);
    }
    this.s.y = 0;
    this.s.vy = 0;
    this.processEvents();
  }

  private die(): void {
    const plan = this.s.plan;
    this.arc = null;
    this.pendingLethalX = null;
    this.s.endCause = (plan?.endCause ?? "crash") as EndCause;
    this.deathT0 = this.s.timeMs;
    this.deathX0 = this.s.x;
    this.deathY0 = this.s.y;
    this.deathVx0 = Math.max(this.s.vx, 0);
    this.deathVy0 = Math.min(this.s.vy + TUNING.death.popVy, vyCeilingAt(this.s.y));
    this.deathGroundedAtMs = null;
    this.setAnim("death");
    this.setPhase("dying");
  }

  private stepDying(): void {
    if (this.deathGroundedAtMs !== null) {
      this.s.vx = 0;
      this.s.vy = 0;
      this.s.y = 0;
      if (this.s.timeMs - this.deathGroundedAtMs >= TUNING.death.groundMs) this.setPhase("ended");
      return;
    }
    const { gravity: g } = TUNING.world;
    const kd = TUNING.death.dragK;
    const tau = (this.s.timeMs - this.deathT0) / 1000;
    const e = Math.exp(-kd * tau);
    this.s.x = this.deathX0 + (this.deathVx0 * (1 - e)) / kd;
    this.s.vx = this.deathVx0 * e;
    this.s.y = this.deathY0 + this.deathVy0 * tau - 0.5 * g * tau * tau;
    this.s.vy = this.deathVy0 - g * tau;
    if (this.s.y <= 0) {
      this.s.y = 0;
      this.s.vx = 0;
      this.s.vy = 0;
      this.deathGroundedAtMs = this.s.timeMs;
    }
  }

  // ── derived state ─────────────────────────────────────────────────────────

  private updateDistance(): void {
    if (this.s.x > this.maxX) this.maxX = this.s.x;
    const cap = this.s.plan?.finalDistance;
    this.s.distanceM = cap === undefined ? this.maxX : Math.min(this.maxX, cap);
  }

  /**
   * `cameraX` is the world x the renderer pins at 30% screen width, so it
   * tracks Chris exactly — any smoothing here would show up as him sliding off
   * his anchor at 150+ m/s. The only easing is the one-shot pull-away from the
   * start-line framing right after release.
   */
  private updateCamera(): void {
    switch (this.s.phase) {
      case "title":
      case "ready":
      case "charging":
        this.s.cameraX = 0;
        return;
      case "riding": {
        const t = clamp((this.s.timeMs - this.rideStartMs) / TUNING.camera.engageMs, 0, 1);
        const ease = t * t * (3 - 2 * t);
        this.s.cameraX = this.s.x * ease;
        return;
      }
      default:
        this.s.cameraX = this.s.x;
    }
  }
}

export const createEngine: CreateEngine = (provider: FlightPlanProvider) => new Engine(provider);
