#!/usr/bin/env tsx
/**
 * Stuntman Chris — headless engine conformance test.
 *
 * Drives the real engine with a fake 60fps clock and a SEEDED flight-plan
 * provider (the dummy provider's Math.random stream is replaced by mulberry32
 * here only — flightPlan.ts is untouched), then asserts that the simulated
 * kinematics exactly realize the plan.
 *
 * Usage:
 *   npx tsx scripts/test-stuntman-engine.ts            # default sweep
 *   npx tsx scripts/test-stuntman-engine.ts 80 12345   # runs-per-power, seed
 */

import { createEngine } from "../components/games/stuntman-chris/lib/engine/engine";
import { generateFlightPlan } from "../components/games/stuntman-chris/lib/engine/flightPlan";
import { TUNING } from "../components/games/stuntman-chris/lib/engine/tuning";
import type {
  EngineState,
  FlightPlan,
  FlightPlanProvider,
  StuntPhase,
} from "../components/games/stuntman-chris/lib/types";

// ── harness ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const RUNS_PER_POWER = Number(argv[0] ?? 40) || 40;
const SEED = Number(argv[1] ?? 0xc0ffee) || 0xc0ffee;
const POWERS = [0, 0.08, 0.17, 0.25, 0.34, 0.42, 0.5, 0.62, 0.75, 0.85, 0.93, 1];
const FRAME_MS = 1000 / 60;
const MAX_FRAMES = 60 * 90; // 90 s of fake wall clock — no run should approach this
/** m — the engine's hard ceiling (TUNING.arc.maxAltitudeM) plus frame slack. */
const ALTITUDE_CEILING_M = 102;

function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const failures: string[] = [];
let checks = 0;
let failed = 0;
let currentLabel = "";
function check(ok: boolean, msg: string): void {
  checks++;
  if (ok) return;
  failed++;
  if (failures.length < 40) failures.push(`${currentLabel}: ${msg}`);
}

const LEGAL_NEXT: Record<StuntPhase, StuntPhase[]> = {
  title: ["ready"],
  ready: ["charging"],
  charging: ["riding", "ready"],
  riding: ["launching", "ready"],
  launching: ["flying", "ready"],
  flying: ["dying", "landing", "ready"],
  dying: ["ended", "ready"],
  landing: ["ended", "ready"],
  ended: ["ready"],
};

const finite = (s: Readonly<EngineState>) =>
  [s.timeMs, s.x, s.y, s.vx, s.vy, s.powerFrac, s.distanceM, s.cameraX].every((n) =>
    Number.isFinite(n),
  );

interface RunResult {
  /** The swept power level this run was asked for (bucket key). */
  requestedPower: number;
  /** The power actually captured at release (frame-quantised). */
  power: number;
  plan: FlightPlan;
  frames: number;
  runMs: number;
  flightMs: number;
  maxY: number;
  maxVx: number;
  endX: number;
  endCause: string;
}

/** Assertions on the plan itself, independent of the engine. */
function auditPlan(plan: FlightPlan): void {
  const P = TUNING.plan;
  check(
    plan.finalDistance >= P.minDistanceM && plan.finalDistance <= P.maxDistanceM,
    `finalDistance ${plan.finalDistance} out of bounds`,
  );
  for (let i = 0; i < plan.events.length; i++) {
    check(plan.events[i].id === i, `event id ${plan.events[i].id} != index ${i}`);
    if (i > 0) {
      check(
        plan.events[i].atX >= plan.events[i - 1].atX,
        `events not sorted at ${i} (${plan.events[i - 1].atX} → ${plan.events[i].atX})`,
      );
    }
  }
  const lethals = plan.events.filter((e) => e.lethal);
  if (plan.endCause === "landed") {
    check(lethals.length === 0, `landed plan carries ${lethals.length} lethal event(s)`);
  } else {
    check(lethals.length === 1, `lethal plan carries ${lethals.length} lethal event(s)`);
    check(
      lethals[0] === plan.events[plan.events.length - 1],
      "lethal event is not the last event",
    );
    check(
      Math.abs(lethals[0].atX - plan.finalDistance) < 0.5,
      `lethal event at ${lethals[0].atX} != finalDistance ${plan.finalDistance}`,
    );
  }
}

async function simulate(power: number, rng: () => number, delayFrames: number): Promise<RunResult> {
  let resolvePending: (() => void) | null = null;
  let planRef: FlightPlan | null = null;

  const provider: FlightPlanProvider = async (p: number) => {
    const plan = generateFlightPlan(rng, p);
    planRef = plan;
    if (delayFrames > 0) await new Promise<void>((res) => (resolvePending = res));
    return plan;
  };

  const engine = createEngine(provider);
  const phaseLog: StuntPhase[] = [];
  engine.onPhase((ph) => phaseLog.push(ph));

  let now = 0;
  const tick = () => {
    now += FRAME_MS;
    return engine.tick(now);
  };

  engine.begin();
  check(engine.state.phase === "ready", `begin() left phase at ${engine.state.phase}`);
  engine.startCharge();

  // Charge to the requested power: the meter rises over the first half sweep.
  const chargeMs = power * (TUNING.charge.sweepMs / 2);
  const chargeFrames = Math.max(1, Math.round(chargeMs / FRAME_MS));
  for (let i = 0; i < chargeFrames; i++) tick();
  const launchPower = engine.state.powerFrac;
  engine.releaseCharge();
  const releaseMs = engine.state.timeMs;

  // ── per-frame invariants ──────────────────────────────────────────────────
  let prevPhase: StuntPhase = "riding";
  let prevDistance = engine.state.distanceM;
  let prevVy = engine.state.vy;
  const triggerOrder: number[] = [];
  const seenTriggered = new Set<number>();
  const seenConsumed = new Set<number>();
  let bounceUpwardFailures = 0;
  let dyingX: number | null = null;
  let dyingVx = 0;
  let flightStartMs: number | null = null;
  let maxY = 0;
  let maxVx = 0;
  let frames = 0;

  while (engine.state.phase !== "ended" && frames < MAX_FRAMES) {
    if (delayFrames > 0 && frames === delayFrames && resolvePending) {
      (resolvePending as () => void)();
      resolvePending = null;
    }
    const s = tick();
    frames++;

    check(finite(s), `non-finite state at frame ${frames}`);
    if (s.phase !== prevPhase) {
      check(
        LEGAL_NEXT[prevPhase].includes(s.phase),
        `illegal transition ${prevPhase} → ${s.phase}`,
      );
      if (s.phase === "flying" && flightStartMs === null) flightStartMs = s.timeMs;
      if (s.phase === "dying" && dyingX === null) {
        dyingX = s.x;
        dyingVx = s.vx;
      }
      prevPhase = s.phase;
    }
    check(s.distanceM >= prevDistance - 1e-6, `distanceM went backwards at frame ${frames}`);
    prevDistance = s.distanceM;
    if (s.plan) {
      check(
        s.distanceM <= s.plan.finalDistance + 1e-6,
        `distanceM ${s.distanceM} exceeded finalDistance ${s.plan.finalDistance}`,
      );
    }
    if (s.y > maxY) maxY = s.y;
    if (s.vx > maxVx) maxVx = s.vx;

    // Renderer contract: cameraX is the world x pinned at 30% screen width.
    if (s.phase === "ready" || s.phase === "charging") {
      check(s.cameraX === 0, `cameraX ${s.cameraX} != 0 while ${s.phase}`);
    } else if (s.phase !== "riding") {
      check(Math.abs(s.cameraX - s.x) < 1e-6, `cameraX ${s.cameraX} != x ${s.x} while ${s.phase}`);
    } else {
      check(s.cameraX >= -1e-6 && s.cameraX <= s.x + 1e-6, "cameraX outside [0, x] while riding");
    }
    // The landing skid must anchor on the wheels, not the flying pose.
    if (s.phase === "landing") check(s.chris.key === "riding", `landing anim is ${s.chris.key}`);
    check(s.y <= ALTITUDE_CEILING_M, `altitude ${s.y.toFixed(1)} m exceeds the renderer's frame budget`);

    for (const o of s.objects) {
      if (o.triggeredAtMs !== null && !seenTriggered.has(o.id)) {
        seenTriggered.add(o.id);
        triggerOrder.push(o.id);
        // A skeleton's or laser robot's trigger LEADS its atX (the throw clip
        // / the robot's head-tip needs wind-up time) — it must never fire
        // after Chris has already passed the event.
        if (o.kind === "skeleton" || o.kind === "laser") {
          check(
            s.x <= o.x + 1,
            `${o.kind} ${o.id} triggered late: x=${s.x.toFixed(1)} past atX=${o.x.toFixed(1)}`,
          );
        }
        if (o.kind === "moonboots") {
          // The pickup must sit ON the realized arc or it never connects.
          check(typeof o.y === "number", "moonboots object has no altitude");
          if (typeof o.y === "number") {
            check(
              Math.abs(o.y - s.y) <= 5,
              `moonboots at y=${o.y.toFixed(1)} but Chris passed at y=${s.y.toFixed(1)}`,
            );
          }
        }
      }
      if (o.consumed && !seenConsumed.has(o.id)) {
        seenConsumed.add(o.id);
        if (o.kind === "bounce" && !(s.vy > prevVy)) bounceUpwardFailures++;
      }
    }
    prevVy = s.vy;

    // The provider's promise chain is microtask-only; drain it while pending.
    if (!engine.state.plan) {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
  }

  const s = engine.state;
  const plan = planRef as FlightPlan | null;
  check(s.phase === "ended", `run did not reach ended (stuck in ${s.phase} after ${frames} frames)`);
  check(plan !== null, "provider never produced a plan");
  if (!plan) throw new Error("no plan");

  auditPlan(plan);
  check(s.plan === plan, "engine adopted a different plan object");
  check(s.endCause === plan.endCause, `endCause ${s.endCause} != plan ${plan.endCause}`);

  // Every event fires exactly once. Cursor-ordered events fire in plan order;
  // skeletons and lasers are proximity-triggered with a long lead
  // (engine.processEvents) so they may legitimately fire before an un-reached
  // ordered neighbour.
  check(
    triggerOrder.length === plan.events.length,
    `${triggerOrder.length}/${plan.events.length} events triggered`,
  );
  const orderedIds = triggerOrder.filter(
    (id) => plan.events[id].kind !== "skeleton" && plan.events[id].kind !== "laser",
  );
  for (let i = 1; i < orderedIds.length; i++) {
    check(
      orderedIds[i] > orderedIds[i - 1],
      `event ${orderedIds[i]} fired out of order (after ${orderedIds[i - 1]})`,
    );
  }
  check(bounceUpwardFailures === 0, `${bounceUpwardFailures} bounce(s) produced no upward vy change`);
  // Moonboots SKIP the next bounce head (engine.applyMoonboots): if the plan
  // carries a triggered moonboots, exactly one bounce may legitimately go
  // un-landed. Every other bounce must be contacted.
  const bounces = plan.events.filter((e) => e.kind === "bounce");
  const consumedBounces = bounces.filter((e) => seenConsumed.has(e.id)).length;
  const moonbootsTriggered = plan.events.some(
    (e) => e.kind === "moonboots" && seenTriggered.has(e.id),
  );
  const minConsumed = Math.max(0, bounces.length - (moonbootsTriggered ? 1 : 0));
  check(
    consumedBounces >= minConsumed,
    `${consumedBounces}/${bounces.length} bounces landed on (min ${minConsumed})`,
  );

  if (plan.endCause === "landed") {
    check(
      Math.abs(s.x - plan.finalDistance) <= 1,
      `landed at ${s.x.toFixed(2)} m, plan said ${plan.finalDistance} m`,
    );
    check(
      Math.abs(s.distanceM - plan.finalDistance) <= 1,
      `distanceM ${s.distanceM.toFixed(2)} != finalDistance ${plan.finalDistance}`,
    );
    check(phaseLog.includes("landing"), "landed run never entered the landing phase");
  } else {
    check(phaseLog.includes("dying"), `${plan.endCause} run never entered the dying phase`);
    check(dyingX !== null, "dying x not captured");
    if (dyingX !== null) {
      // A hit can only register on the frame Chris crosses the line, so the
      // overshoot is bounded by one frame of travel — at 200 m/s that is 3.3 m.
      const tol = Math.max(3, dyingVx * (FRAME_MS / 1000) * 1.5);
      check(
        Math.abs(dyingX - plan.finalDistance) <= tol,
        `died at ${dyingX.toFixed(2)} m, plan said ${plan.finalDistance} m (tol ${tol.toFixed(2)})`,
      );
    }
    check(
      Math.abs(s.distanceM - plan.finalDistance) <= 0.5,
      `frozen distance ${s.distanceM.toFixed(2)} != finalDistance ${plan.finalDistance}`,
    );
  }

  // reset() must return to a clean ready state from `ended`.
  engine.reset();
  check(engine.state.phase === "ready", `reset() from ended left phase ${engine.state.phase}`);
  check(engine.state.plan === null && engine.state.distanceM === 0, "reset() left stale run state");

  return {
    requestedPower: power,
    power: launchPower,
    plan,
    frames,
    runMs: s.timeMs - releaseMs,
    flightMs: flightStartMs === null ? 0 : s.timeMs - flightStartMs,
    maxY,
    maxVx,
    endX: s.x,
    endCause: plan.endCause,
  };
}

/** reset() must be legal from any phase, not just `ended`. */
async function testMidRunReset(rng: () => number): Promise<void> {
  currentLabel = "mid-run reset";
  for (const stopAfter of [5, 40, 120, 400]) {
    const engine = createEngine(async (p: number) => generateFlightPlan(rng, p));
    let now = 0;
    engine.begin();
    engine.startCharge();
    for (let i = 0; i < 20; i++) engine.tick((now += FRAME_MS));
    engine.releaseCharge();
    for (let i = 0; i < stopAfter; i++) {
      engine.tick((now += FRAME_MS));
      if (!engine.state.plan) for (let j = 0; j < 5; j++) await Promise.resolve();
    }
    engine.reset();
    check(engine.state.phase === "ready", `reset() after ${stopAfter} frames → ${engine.state.phase}`);
    check(engine.state.x === 0 && engine.state.y === 0, "reset() left Chris off the start line");
    // A stale plan resolving after reset must not resurrect the dead run.
    for (let j = 0; j < 10; j++) await Promise.resolve();
    check(engine.state.plan === null, "a stale plan leaked into the reset run");
    engine.tick((now += FRAME_MS));
    check(engine.state.phase === "ready", "engine left ready without input after reset");
  }
}

/** Huge dt (tab hidden) must not corrupt or fast-forward the run. */
async function testClockGaps(rng: () => number): Promise<void> {
  currentLabel = "clock gaps";
  const engine = createEngine(async (p: number) => generateFlightPlan(rng, p));
  let now = 0;
  engine.begin();
  engine.startCharge();
  for (let i = 0; i < 30; i++) engine.tick((now += FRAME_MS));
  engine.releaseCharge();
  let guard = 0;
  while (engine.state.phase !== "ended" && guard++ < 4000) {
    // 5 s wall-clock gap every 20th frame.
    now += guard % 20 === 0 ? 5000 : FRAME_MS;
    const s = engine.tick(now);
    check(finite(s), "non-finite state across a clock gap");
    if (!engine.state.plan) for (let j = 0; j < 5; j++) await Promise.resolve();
  }
  check(engine.state.phase === "ended", `run with clock gaps stuck in ${engine.state.phase}`);
  const plan = engine.state.plan;
  if (plan && plan.endCause === "landed") {
    check(
      Math.abs(engine.state.x - plan.finalDistance) <= 1,
      `gapped run landed at ${engine.state.x.toFixed(2)}, plan ${plan.finalDistance}`,
    );
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rng = mulberry32(SEED);
  const t0 = Date.now();
  const results: RunResult[] = [];

  for (const power of POWERS) {
    for (let i = 0; i < RUNS_PER_POWER; i++) {
      currentLabel = `power ${power.toFixed(2)} run ${i}`;
      // Every 7th run holds at the ramp for ~0.5 s to exercise the async seam.
      const delayFrames = i % 7 === 0 ? 30 : 0;
      results.push(await simulate(power, rng, delayFrames));
    }
  }

  await testMidRunReset(rng);
  await testClockGaps(rng);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  // ── report ────────────────────────────────────────────────────────────────
  const fmt = (n: number, d = 1) => n.toFixed(d);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const bucket = (p: number) => results.filter((r) => r.requestedPower === p);

  console.log("");
  console.log("=== distance / duration by launch power ===");
  console.log("power   n     dist min      med      max     run s (min/med/max)   apex m med/max   maxVx m/s");
  for (const p of POWERS) {
    const b = bucket(p);
    if (!b.length) continue;
    const d = b.map((r) => r.plan.finalDistance).sort((a, z) => a - z);
    const t = b.map((r) => r.runMs / 1000).sort((a, z) => a - z);
    const mid = <T,>(a: T[]) => a[Math.floor(a.length / 2)];
    console.log(
      `${fmt(p, 2).padStart(5)} ${String(b.length).padStart(4)}   ` +
        `${fmt(d[0], 0).padStart(6)} ${fmt(mid(d), 0).padStart(8)} ${fmt(d[d.length - 1], 0).padStart(8)}    ` +
        `${fmt(t[0], 1).padStart(5)} / ${fmt(mid(t), 1).padStart(5)} / ${fmt(t[t.length - 1], 1).padStart(5)}    ` +
        `${fmt(mid(b.map((r) => r.maxY).sort((a, z) => a - z)), 0).padStart(6)} /` +
        `${fmt(Math.max(...b.map((r) => r.maxY)), 0).padStart(4)}    ` +
        `${fmt(Math.max(...b.map((r) => r.maxVx)), 0).padStart(6)}`,
    );
  }

  const causes = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.endCause] = (acc[r.endCause] ?? 0) + 1;
    return acc;
  }, {});
  console.log("");
  console.log("=== outcome mix ===");
  for (const [c, n] of Object.entries(causes).sort((a, z) => z[1] - a[1])) {
    console.log(`  ${c.padEnd(7)} ${String(n).padStart(5)}  (${pct(n / results.length)})`);
  }
  const evCount = results.reduce((a, r) => a + r.plan.events.length, 0);
  const bounceCount = results.reduce(
    (a, r) => a + r.plan.events.filter((e) => e.kind === "bounce").length,
    0,
  );
  const bootCount = results.reduce(
    (a, r) => a + r.plan.events.filter((e) => e.kind === "moonboots").length,
    0,
  );
  console.log("");
  console.log("=== scripted objects ===");
  console.log(`  events / run   : ${fmt(evCount / results.length, 2)}`);
  console.log(`  bounces / run  : ${fmt(bounceCount / results.length, 2)}`);
  console.log(`  moonboots rate : ${pct(bootCount / results.length)}`);
  console.log("");
  console.log("=== envelope (renderer-facing) ===");
  console.log(`  max altitude   : ${fmt(Math.max(...results.map((r) => r.maxY)), 1)} m`);
  console.log(`  max vx         : ${fmt(Math.max(...results.map((r) => r.maxVx)), 1)} m/s`);
  console.log(
    `  run duration   : ${fmt(Math.min(...results.map((r) => r.runMs)) / 1000, 1)} – ` +
      `${fmt(Math.max(...results.map((r) => r.runMs)) / 1000, 1)} s (release → ended)`,
  );

  console.log("");
  console.log("=".repeat(60));
  console.log(
    `${results.length} runs · ${checks.toLocaleString()} assertions · ${elapsed}s · ` +
      (failed === 0 ? "PASS" : `FAIL (${failed})`),
  );
  if (failures.length) {
    console.log("");
    for (const f of failures) console.log(`  ✗ ${f}`);
    if (failed > failures.length) console.log(`  … and ${failed - failures.length} more`);
  }
  console.log("=".repeat(60));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
