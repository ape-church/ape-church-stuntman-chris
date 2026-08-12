/* ============================================================================
 * ON-CHAIN INTEGRATION SEAM
 * ----------------------------------------------------------------------------
 * `generateFlightPlan(rng, power)` is a PURE function: given a stream of
 * uniforms in [0,1) and a launch power it returns the complete scripted
 * outcome of a run. It is the only place randomness enters Stuntman Chris —
 * the engine's kinematics merely realize whatever this returns.
 *
 * v1 feeds it `Math.random` (below). v2 feeds it a VRF/commit-reveal derived
 * uniform stream, or replaces `createDummyFlightPlanProvider` entirely with a
 * provider that reads the resolved plan off a contract. Nothing outside this
 * file changes: the engine only ever sees `FlightPlanProvider`.
 *
 * Math.random is confined to `createDummyFlightPlanProvider`. Do not call it
 * anywhere else in the game.
 *
 * The provider is async on purpose — the riding phase masks its latency, which
 * v1 fakes (TUNING.plan.latency*Ms) and v2 will pay for real.
 * ============================================================================ */

import type { FlightEvent, FlightPlan, FlightPlanProvider } from "../types";
import { TUNING, shapePower } from "./tuning";

/** Uniform in [0, 1). */
export type Rng = () => number;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rangeOf = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
/** Inclusive integer pick. */
const intOf = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pickWeighted = (rng: Rng, cumulative: readonly number[]) => {
  const r = rng();
  for (let i = 0; i < cumulative.length; i++) if (r < cumulative[i]) return i;
  return cumulative.length - 1;
};

/** Draft event before ids are assigned (ids must follow the final atX order). */
type Draft = Omit<FlightEvent, "id">;

/**
 * Turn a launch power into the run's whole scripted outcome.
 *
 * Ordering matters and is deliberate:
 *   1. roll a pre-bonus base distance from the (shaped) power,
 *   2. decide how many bounces / whether moonboots — these ADD distance, which
 *      is what makes them read as "that extended my run",
 *   3. roll lethality, which TRUNCATES the total to a fraction of it,
 *   4. only then place objects, against the final distance, so nothing is ever
 *      scripted past the end of the run.
 */
export function generateFlightPlan(rng: Rng, power: number): FlightPlan {
  const P = TUNING.plan;
  const p = clamp(power, 0, 1);
  const s = shapePower(p);

  const baseDist = rangeOf(
    rng,
    lerp(P.baseDistLowMin, P.baseDistHighMin, s),
    lerp(P.baseDistLowMax, P.baseDistHighMax, s),
  );

  // Bounce count: random, but floored by distance. Every bounce is an extra
  // arc, and arcs are time-capped — without this floor a 3000 m run would have
  // to be covered by one absurdly fast arc.
  const bounceFloor = clamp(Math.ceil(baseDist / P.metersPerBounceHint) - 1, 0, 3);
  let bounceCount = Math.max(pickWeighted(rng, P.bounceCountWeights), bounceFloor);
  if (baseDist < P.bounceMinDistanceM) bounceCount = 0;

  const hasMoonboots = rng() < P.moonbootsChance;

  let bonus = 0;
  for (let i = 0; i < bounceCount; i++) bonus += rangeOf(rng, P.bounceBonusMin, P.bounceBonusMax);
  if (hasMoonboots) bonus += rangeOf(rng, P.moonbootsBonusMin, P.moonbootsBonusMax);
  const fullDist = baseDist * (1 + bonus);

  const lethal = rng() < P.lethalChance;
  const lethalKind = lethal ? pickWeighted(rng, P.lethalKindWeights) : -1;
  const endCause: FlightPlan["endCause"] = !lethal
    ? "landed"
    : lethalKind === 0
      ? "laser"
      : lethalKind === 1
        ? "bone"
        : "crash";

  const rawFinal = lethal ? fullDist * rangeOf(rng, P.lethalFracMin, P.lethalFracMax) : fullDist;
  const finalDistance = Math.round(clamp(rawFinal, P.minDistanceM, P.maxDistanceM));

  // ── object placement ──────────────────────────────────────────────────────
  const flightStartX = TUNING.rampX + TUNING.ride.rampLengthM;
  const minGap = clamp(finalDistance * P.minGapFrac, P.minGapMinM, P.minGapMaxM);
  const firstX = flightStartX + P.firstEventMarginM;
  const kept: Draft[] = [];

  const fits = (atX: number) => {
    for (const e of kept) if (Math.abs(e.atX - atX) < minGap) return false;
    return true;
  };
  /** Try a few placements in [lo,hi]; give up rather than crowd the run. */
  const tryPlace = (kind: Draft["kind"], lo: number, hi: number, variant: number) => {
    if (hi - lo < 1) return;
    for (let attempt = 0; attempt < 12; attempt++) {
      const atX = rangeOf(rng, lo, hi);
      if (!fits(atX)) continue;
      kept.push({ kind, atX, variant, lethal: false });
      return;
    }
  };

  // Bounces first — they are load-bearing (they define the arc structure), so
  // they get the corridor and everything else places around them. n bounces
  // cut the corridor into n+1 arcs of roughly equal span: uneven bounces make
  // one arc the long pole, and since arcs are time-capped that arc then has to
  // be flown stupidly fast.
  const bStart = firstX;
  const corridor = finalDistance * P.bounceMaxFrac - bStart;
  if (finalDistance >= P.bounceMinDistanceM && bounceCount > 0) {
    const n = Math.min(bounceCount, Math.max(0, Math.floor(corridor / P.bounceMinSpacingM) - 1));
    for (let i = 0; i < n; i++) {
      const slot = (i + 1 + rangeOf(rng, -P.bounceJitter, P.bounceJitter)) / (n + 1);
      kept.push({
        kind: "bounce",
        atX: bStart + corridor * slot,
        variant: intOf(rng, 1, 2),
        lethal: false,
      });
    }
  }

  if (hasMoonboots) {
    tryPlace("moonboots", firstX + 20, finalDistance * P.moonbootsMaxFrac, 1);
  }

  const skeletons = intOf(rng, P.skeletonMin, P.skeletonMax);
  for (let i = 0; i < skeletons; i++) {
    tryPlace("skeleton", flightStartX + 25, finalDistance * P.skeletonMaxFrac, intOf(rng, 1, 2));
  }

  const lasers = clamp(Math.round(finalDistance / P.metersPerLaser), P.laserMin, P.laserMax);
  for (let i = 0; i < lasers; i++) {
    tryPlace("laser", flightStartX + 30, finalDistance * P.laserMaxFrac, 1);
  }

  // The kill sits AT finalDistance and must be the last event, so anything
  // crowding the finish is removed rather than reordered.
  if (lethal) {
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].atX > finalDistance - minGap) kept.splice(i, 1);
    }
    kept.push({
      // A bone kill needs the skeleton variant that actually ships a bone sheet.
      kind: endCause === "laser" ? "laser" : endCause === "bone" ? "skeleton" : "blocker",
      atX: finalDistance,
      variant: endCause === "bone" ? 2 : 1,
      lethal: true,
    });
  }

  kept.sort((a, b) => a.atX - b.atX);
  const events: FlightEvent[] = kept.map((e, i) => ({ ...e, id: i, atX: Math.round(e.atX * 100) / 100 }));

  return { power: p, finalDistance, endCause, events };
}

/**
 * v1 provider: local RNG plus a faked resolve latency so the async seam is
 * exercised in development exactly as it will be in production.
 */
export const createDummyFlightPlanProvider: () => FlightPlanProvider = () => {
  return (power: number) =>
    new Promise<FlightPlan>((resolve) => {
      const { latencyMinMs, latencyMaxMs } = TUNING.plan;
      const delay = latencyMinMs + Math.random() * (latencyMaxMs - latencyMinMs);
      const plan = generateFlightPlan(Math.random, power);
      setTimeout(() => resolve(plan), delay);
    });
};
