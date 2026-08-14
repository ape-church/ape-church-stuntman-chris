/**
 * Stuntman Chris — sound director. Pure diffing: called once per frame from
 * the orchestrator's existing rAF ticker, it compares the engine's state with
 * what it last saw and fires the matching sounds. It holds NO game truth —
 * the engine is authoritative and this only reacts to it, exactly like the
 * renderer does for pixels.
 */

import type { EngineState, StuntEngine, StuntPhase } from "../types";
import { TUNING } from "../engine/tuning";
import { sfx } from "./sfx";

/** Engine-clock ms between a skeleton's emerge and its bone leaving the hand
 *  (frame 13 of the 12fps throw clip — see renderer BONE_FRAME_OFFSET). */
const BONE_RELEASE_MS = 1050;

/** Wind loop volume ramps over this vx band (m/s). */
const WIND_MIN_VX = 30;
const WIND_MAX_VX = 130;

/** Flight wind is muted for now — the current recording isn't landing. Flip
 *  this back on when a replacement flight_wind.wav is dropped in. */
const WIND_ENABLED = false;

export interface SoundDirector {
  /** Call once per frame (piggybacks the HUD rAF ticker). */
  tick(): void;
}

export function createSoundDirector(engine: StuntEngine): SoundDirector {
  let prevPhase: StuntPhase = engine.state.phase;
  let prevY = 0;
  let thudded = false;
  const triggered = new Set<number>();
  const consumed = new Set<number>();
  let pendingBones: number[] = [];
  /** Miss-laser shots due at trigger + the robot clip's wind-up (see below). */
  let pendingLasers: { at: number }[] = [];

  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

  /** Stop the run-scoped loops, leaving persistent ambience (crowd) alone. */
  const stopRunLoops = (): void => {
    sfx.stopLoop("charge_loop");
    sfx.stopLoop("engine_ride");
    sfx.stopLoop("flight_wind");
    sfx.stopLoop("skid_loop");
  };

  const onEnterPhase = (phase: StuntPhase, from: StuntPhase, s: Readonly<EngineState>): void => {
    if (from === "ready") sfx.stopLoop("engine_idle");
    switch (phase) {
      case "ready":
        stopRunLoops();
        sfx.loop("engine_idle", { volume: 0.25 });
        // City-crowd ambience runs across the whole session (it survives the
        // result screen); only the title screen silences it.
        if (!sfx.isLooping("crowd_murmur")) sfx.loop("crowd_murmur", { volume: 0.18 });
        break;
      case "charging":
        // 1700ms loop === the meter's ping-pong period; starting together
        // keeps them phase-locked for the whole hold.
        sfx.loop("charge_loop", { volume: 0.65 });
        break;
      case "riding":
        sfx.stopLoop("charge_loop", 20);
        sfx.loop("engine_ride", { volume: 0.8 });
        break;
      case "launching":
        sfx.stopLoop("engine_ride", 60);
        sfx.play("ramp_launch");
        break;
      case "flying":
        if (WIND_ENABLED) sfx.loop("flight_wind", { volume: 0 });
        break;
      case "dying":
        sfx.stopLoop("flight_wind", 80);
        sfx.stopLoop("engine_ride", 40);
        // The lethal laser's SHOT rides the death moment too (the renderer
        // keys the lethal beam to it — see drawLasers); misses stay on the
        // scheduled clip clock below.
        if (s.endCause === "laser") {
          sfx.play("laser_fire");
          sfx.play("laser_hit");
        }
        else if (s.endCause === "bone") sfx.play("bone_hit");
        else sfx.play("crash_blocker"); // producer file — silent until delivered
        thudded = s.y <= 0.001;
        break;
      case "landing":
        sfx.stopLoop("flight_wind", 80);
        sfx.play("landing_touchdown");
        sfx.loop("skid_loop", { volume: 0.55 });
        break;
      case "ended":
        stopRunLoops();
        sfx.stopLoop("engine_idle");
        sfx.play(s.endCause === "landed" ? "result_safe" : "result_crash");
        break;
      case "title":
        sfx.stopAllLoops();
        break;
    }
  };

  const tick = (): void => {
    const s = engine.state;

    if (s.phase !== prevPhase) {
      const from = prevPhase;
      prevPhase = s.phase;
      onEnterPhase(s.phase, from, s);
    }

    // Wind rides the live airspeed.
    if (WIND_ENABLED && s.phase === "flying") {
      sfx.setLoopVolume(
        "flight_wind",
        0.55 * clamp01((s.vx - WIND_MIN_VX) / (WIND_MAX_VX - WIND_MIN_VX)),
      );
    }

    // Skid fades out as the slide runs down; kill it once stopped.
    if (s.phase === "landing" && s.vx <= 0.05) sfx.stopLoop("skid_loop", 120);

    // Dead body hits the road.
    if (s.phase === "dying" && !thudded && s.y <= 0.001 && prevY > 0.001) {
      sfx.play("ground_thud");
      thudded = true;
    }
    prevY = s.y;

    // Object events, edge-triggered off the engine's object list.
    for (let i = 0; i < s.objects.length; i++) {
      const o = s.objects[i];
      if (o.triggeredAtMs !== null && !triggered.has(o.id)) {
        triggered.add(o.id);
        switch (o.kind) {
          case "laser":
            // The robot winds up first (head tips back over ~2s); a MISS
            // shot fires at the clip's flare — the engine leads the trigger
            // so that beat lands right as Chris zips past. The lethal shot
            // is played at the death transition instead (see onEnterPhase).
            if (!o.lethal) pendingLasers.push({ at: o.triggeredAtMs + TUNING.events.laserLeadMs });
            break;
          case "skeleton":
            sfx.play("skeleton_emerge", { volume: 0.85 });
            pendingBones.push(o.triggeredAtMs + BONE_RELEASE_MS);
            break;
          case "moonboots":
            sfx.play("moonboots_pickup");
            sfx.play("moonboots_surge", { volume: 0.9 });
            break;
          default:
            break;
        }
      }
      if (o.consumed && !consumed.has(o.id)) {
        consumed.add(o.id);
        if (o.kind === "bounce") sfx.play("bounce");
      }
    }

    // Bone leaves the skeleton's hand ~1s after the emerge (engine clock, so
    // it stays correct across tab-hidden gaps).
    if (pendingBones.length > 0 && s.timeMs >= pendingBones[0]) {
      const due = pendingBones.filter((t) => s.timeMs >= t);
      pendingBones = pendingBones.filter((t) => s.timeMs < t);
      for (let i = 0; i < due.length; i++) sfx.play("bone_throw", { volume: 0.7 });
    }

    // Miss-laser shot at the robot clip's fire flare (engine clock, like
    // bones). Near-misses zip by lighter and pitched up; the lethal bolt
    // plays full at the death transition (onEnterPhase).
    if (pendingLasers.length > 0 && s.timeMs >= pendingLasers[0].at) {
      const due = pendingLasers.filter((p) => s.timeMs >= p.at);
      pendingLasers = pendingLasers.filter((p) => s.timeMs < p.at);
      for (let i = 0; i < due.length; i++) sfx.play("laser_fire", { volume: 0.65, rate: 1.12 });
    }

    // New run (objects reset) — clear the edge-detection sets.
    if (s.objects.length === 0 && (triggered.size > 0 || consumed.size > 0)) {
      triggered.clear();
      consumed.clear();
      pendingBones = [];
      pendingLasers = [];
    }
  };

  return { tick };
}
