/**
 * Stuntman Chris — every gameplay constant, in one place.
 *
 * Units are stated per field. World units are METERS and SECONDS; anything
 * with an `Ms` suffix is milliseconds because it is compared against the
 * engine clock. `y = 0` is the road surface, `+y` is up, `+x` is forward.
 *
 * The engine never invents a distance: the FlightPlan is authoritative and the
 * kinematics are solved to land exactly on it (see engine.ts "arc solver").
 * These constants therefore control SHAPE (how high / how fast / how long an
 * arc is) rather than outcome. The `plan.*` block is the one exception — it is
 * the dummy provider's distribution, which goes away when the on-chain
 * provider lands.
 */

export const TUNING = {
  /**
   * m — world x of the crashed-UFO ramp's leading edge, i.e. the exact spot
   * Chris leaves the ground. Top-level because the RENDERER imports it to draw
   * the ramp; the ride/launch geometry that hangs off it lives in `ride`.
   */
  rampX: 55,

  /** rAF-loop safety. */
  loop: {
    /** ms — most wall-clock time one tick() may consume (tab-hidden gap guard). */
    maxFrameMs: 100,
    /** ms — largest integration substep; tick() loops until the frame is spent. */
    maxStepMs: 50,
  },

  /** Ballistics. */
  world: {
    /** m/s² downward. Tuned with `arc.maxT` so a full-power apex stays ~75 m. */
    gravity: 24,
    /** 1/s — exponential horizontal air drag: vx(t) = vx0 · e^(−k·t). Mild. */
    airDragK: 0.02,
    /**
     * m — height of the deck Chris lands on when he hits a bounce object.
     * Matched to the bounce art: the Meebit bystander renders ~294 px tall
     * (viz sheet at the renderer's 0.45 scale), so contact at ~45 m puts
     * Chris on the character's head instead of clipping through the body.
     */
    bounceTopM: 45,
  },

  /** Power meter. */
  charge: {
    /** ms for a full 0→1→0 ping-pong sweep. */
    sweepMs: 1200,
  },

  /** Ground run from the start line to the ramp. */
  ride: {
    /** m/s² — bike acceleration off the line. */
    accel: 20,
    /** m/s — top ground speed at power 0 / power 1 (only a look; not the launch). */
    topSpeedMin: 26,
    topSpeedMax: 52,
    /** m — horizontal length of the ramp transit, measured from `TUNING.rampX`. */
    rampLengthM: 8,
    /** m — Chris's altitude at the ramp lip (first arc starts here). */
    rampHeightM: 9,
    /** ms — how long the idle→riding transition anim plays before `riding`. */
    idleTransitionMs: 420,
    /** m — Chris parks this far short of the ramp while waiting on the plan. */
    holdMarginM: 6,
    /** m/s — crawl speed while holding (keeps the bike anim alive). */
    holdSpeed: 8,
    /**
     * ms — hard cap on the pre-ramp wait. The v1 dummy provider always
     * resolves in <1s; this only fires if a future (tx + VRF) provider stalls
     * or rejects, in which case the engine substitutes a fallback plan so the
     * run can never wedge.
     */
    maxHoldMs: 6000,
    /** ms — ramp transit (ground → airborne) before the flight arcs begin. */
    launchMs: 280,
  },

  /** Arc solver — the shape of each ballistic hop. */
  arc: {
    /**
     * m/s — the horizontal speed an arc *aims* for at power 0 / power 1. The
     * solver picks arc duration T = span / vxTarget (clamped), then derives the
     * exact vx needed to cover the span in T. Long spans push vx above this.
     */
    vxTargetMin: 32,
    vxTargetMax: 105,
    /** s — arc duration clamps. maxT caps apex at g·T²/8 ≈ 75 m. */
    minT: 0.9,
    maxT: 5.0,
    /**
     * m/s — launch-velocity clamps. maxVy is the binding altitude constraint:
     * apex = y0 + maxVy²/(2g) ≈ 89 m off the ramp lip. The renderer can only
     * keep BOTH Chris and the road in frame below ~130 m, so distance is
     * bought with horizontal speed, never with height.
     */
    minVy: 2,
    maxVy: 62,
    /**
     * m — how high above its launch point an arc may peak, lerped by shaped
     * power. Without this every arc pins to `maxT` and a feeble 200 m launch
     * loops as high as a 3000 m one; with it, power reads vertically (low flat
     * hop → towering arc) as well as horizontally.
     */
    apexBudgetMin: 34,
    apexBudgetMax: 80,
    /**
     * m — hard altitude ceiling. Every vy the solver hands out is additionally
     * capped at sqrt(2g·(this − y)), so apex ≤ this by construction no matter
     * where a moonboots surge or a mid-air re-solve happens. The renderer only
     * keeps Chris AND the road in frame below ~130 m; this leaves headroom.
     */
    maxAltitudeM: 100,
    /** m/s — safety ceiling used only by the mid-air re-solve path. */
    maxVx: 200,
    /** m — an arc shorter than this is not worth flying; targets closer than
     * this to each other are dropped (Chris flies over them). */
    minSpanM: 30,
  },

  /** Alive touchdown → skid to a stop exactly on plan.finalDistance. */
  landing: {
    /**
     * The slide length is reserved BEFORE the last arc is solved, so the arc
     * aims at `finalDistance − slide` and the skid consumes the remainder with
     * a deceleration solved from the actual touchdown speed. Two independent
     * bounds keep it sane on both short and long runs.
     */
    /** s — nominal skid duration; slide ≈ vxTarget · this / 2. */
    slideSeconds: 2.4,
    /** fraction of finalDistance the skid may occupy. */
    slideMaxFrac: 0.12,
    /** m — absolute slide clamps. */
    slideMinM: 10,
    slideMaxM: 140,
    /** ms — dwell on the stopped bike before `ended`. */
    settleMs: 700,
  },

  /** Lethal event → ragdoll to the ground. */
  death: {
    /** 1/s — hard exponential horizontal decay once he's hit. */
    dragK: 0.9,
    /** m/s — upward jolt at the moment of impact (sells the hit). */
    popVy: 6,
    /** ms — time on the ground playing the death anim before `ended`. */
    groundMs: 1100,
    /**
     * m — for a mid-air kill (laser / bone) the last arc is aimed this far
     * PAST finalDistance so Chris is still airborne when the shot connects.
     * Scales with the run, clamped.
     */
    airMarginFrac: 0.08,
    airMarginMinM: 40,
    airMarginMaxM: 150,
  },

  /** Scripted-event triggering. */
  events: {
    /**
     * ms — a grave skeleton starts its throw this long BEFORE Chris reaches
     * its atX, so the bone has time to arc across at him. Converted to a
     * distance each frame with the live vx, so it leads correctly at any speed.
     */
    boneLeadMs: 350,
    /** ms — duration of the moonboots surge before the arc is re-solved. */
    moonbootsBoostMs: 700,
    /** × — horizontal speed multiplier applied for the surge. */
    moonbootsVxMult: 1.35,
    /** m/s — upward kick added at pickup (clamped by arc.maxVy). */
    moonbootsVyBoost: 14,
  },

  /** Camera. */
  camera: {
    /**
     * `state.cameraX` is the world x the renderer pins at 30% of screen width,
     * i.e. it tracks Chris exactly once the run is underway.
     *
     * ms — but not instantly: it eases from 0 (the start-line framing) to
     * Chris's x over this window after the throttle is released, so the bike
     * visibly pulls away from the camera before it settles. Zero lag after,
     * which matters at 150+ m/s.
     */
    engageMs: 900,
  },

  /**
   * Dummy-provider distribution. NOT physics — this is the block the on-chain
   * provider replaces wholesale.
   */
  plan: {
    /** power is shaped by p^this before mapping to distance (back-loads the meter). */
    powerExponent: 1.4,

    /**
     * Pre-bonus distance band, lerped by shaped power. Bounce / moonboots
     * bonuses are multiplied on top, so this band sits deliberately BELOW the
     * target observed band (~150–400 m at low power, ~1200–3000 m at full).
     */
    baseDistLowMin: 150, // m at power 0
    baseDistLowMax: 400,
    baseDistHighMin: 950, // m at power 1
    baseDistHighMax: 2300,
    /** m — absolute clamps on the published finalDistance. */
    minDistanceM: 170,
    maxDistanceM: 3300,

    /**
     * m of base distance per bounce. Long runs are forced to carry enough
     * bounces that no single arc has to span an absurd distance (each bounce
     * adds an arc; arcs are capped at `arc.maxT` seconds).
     */
    metersPerBounceHint: 600,
    /** cumulative weights for the random bounce count 0/1/2/3. */
    bounceCountWeights: [0.25, 0.6, 0.87, 1],
    /** fraction of base distance each bounce adds (uniform in range). */
    bounceBonusMin: 0.06,
    bounceBonusMax: 0.16,
    /** m — runs shorter than this get no bounce objects at all. */
    bounceMinDistanceM: 350,
    /**
     * Bounces split the corridor [firstEventMargin, finalDistance·this] into
     * n+1 roughly equal arcs. It has to reach near the end of the run: if the
     * bounces bunch early, the unbroken tail arc becomes the longest one and
     * (being time-capped) has to be flown at an absurd vx.
     */
    bounceMaxFrac: 0.93,
    /** ± fraction of a segment each bounce may wander from its even slot. */
    bounceJitter: 0.15,
    /** m — minimum corridor a bounce needs; extra bounces are dropped, not squeezed. */
    bounceMinSpacingM: 130,

    /** probability a run carries a moonboots pickup, and what it adds. */
    moonbootsChance: 0.4,
    moonbootsBonusMin: 0.08,
    moonbootsBonusMax: 0.16,
    /** moonboots sit below this fraction of finalDistance. */
    moonbootsMaxFrac: 0.75,

    /** grave skeletons per run (inclusive) and where they may stand. */
    skeletonMin: 1,
    skeletonMax: 3,
    skeletonMaxFrac: 0.9,

    /** flavour laser near-misses: one per this many meters, clamped. */
    metersPerLaser: 350,
    laserMin: 1,
    laserMax: 6,
    laserMaxFrac: 0.95,

    /** probability the run ends on a lethal event rather than a landing. */
    lethalChance: 0.25,
    /** cumulative weights for laser / bone / crash given the run is lethal. */
    lethalKindWeights: [0.45, 0.8, 1],
    /** the kill lands at this fraction of what the run would otherwise have been. */
    lethalFracMin: 0.5,
    lethalFracMax: 0.95,

    /** m — first scripted object may not sit closer than this past the ramp. */
    firstEventMarginM: 40,
    /** minimum spacing between any two events, as a fraction of finalDistance… */
    minGapFrac: 0.05,
    /** …clamped to this metre range (must exceed the bone lead distance). */
    minGapMinM: 25,
    minGapMaxM: 90,

    /** ms — artificial provider latency; the riding phase masks it. */
    latencyMinMs: 300,
    latencyMaxMs: 800,
  },
} as const;

/**
 * Power meter position → the curve everything downstream lerps on. Exported
 * (rather than inlined) because the provider maps it to distance and the
 * engine maps it to arc speed, and the two must agree.
 */
export function shapePower(power: number): number {
  const p = power < 0 ? 0 : power > 1 ? 1 : power;
  return Math.pow(p, TUNING.plan.powerExponent);
}
