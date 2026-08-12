"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import FluidGameWindow from "@/components/games/shared/FluidGameWindow";
import GameHud from "@/components/games/shared/GameHud";
import { GameLeaderboardModal } from "@/components/games/GameLeaderboardModal";
import type { SimpleGame } from "@/lib/constants/games";
import type {
  EndCause,
  EngineState,
  StuntEngine,
  StuntPhase,
} from "./lib/types";
import StuntmanChrisWindow from "./StuntmanChrisWindow";
import StuntmanChrisSetupCard from "./StuntmanChrisSetupCard";
import StuntmanChrisPreloadOverlay from "./StuntmanChrisPreloadOverlay";
import StuntmanChrisTitleOverlay from "./StuntmanChrisTitleOverlay";
import "./stuntman-chris.css";

interface StuntmanChrisProps {
  game: SimpleGame;
}

/** Phases during which the distance read-out is meaningful. "ended" is
 *  excluded on purpose — the result overlay shows the number there, and the
 *  HUD underneath would double it up. */
const HUD_PHASES: ReadonlySet<StuntPhase> = new Set<StuntPhase>([
  "riding",
  "launching",
  "flying",
  "dying",
  "landing",
]);

const END_CAUSE_HEADLINE: Record<EndCause, string> = {
  laser: "Lasered!",
  bone: "Boned!",
  crash: "Crashed!",
  landed: "Safe landing",
};

const END_CAUSE_FLAVOR: Record<EndCause, string> = {
  laser: "A UFO picked him out of the sky.",
  bone: "The graveyard has a good arm.",
  crash: "Solid object, meet stuntman.",
  landed: "Wheels down, all limbs attached.",
};

/**
 * Stuntman Chris — client orchestrator.
 *
 * v1 is an OFF-CHAIN visual build: dummy-RNG flight plans, no bet, no APE/GP,
 * no results modal, no history. What lives here is the flow, not the game — the
 * engine owns every bit of truth and the renderer owns the rAF loop and
 * everything drawn inside the scene.
 *
 * Flow / overlay mapping (all keyed off the ENGINE's phase, mirrored into React
 * state by a single `onPhase` subscription — never a per-frame setState):
 *
 *   assets loading  -> StuntmanChrisPreloadOverlay covers the window (z-80)
 *   phase "title"   -> StuntmanChrisTitleOverlay (looping clip + how-to-play)
 *   phase ready…landing -> bare scene + the distance HUD
 *   phase "ended"   -> result overlay (distance, end-cause flavour, Go Again)
 *
 * The distance read-out changes every frame, so it is written imperatively:
 * one rAF ticker reads `engine.state` through a ref and pokes `textContent` /
 * `style.width`. React only ever re-renders on a phase change or an end-of-run
 * stat update.
 */
const StuntmanChris: React.FC<StuntmanChrisProps> = ({ game }) => {
  const [engine, setEngine] = useState<StuntEngine | null>(null);
  const engineRef = useRef<StuntEngine | null>(null);
  const [phase, setPhase] = useState<StuntPhase>("title");

  // Asset / renderer readiness (drives the preload overlay + input gating).
  const [assetProgress, setAssetProgress] = useState({ loaded: 0, total: 0 });
  const [assetsReady, setAssetsReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const assetsReadyRef = useRef(false);
  assetsReadyRef.current = assetsReady;

  // Session stats — updated once per run, not per frame.
  const [lastDistance, setLastDistance] = useState<number | null>(null);
  const [bestDistance, setBestDistance] = useState(0);
  const [runs, setRuns] = useState(0);
  const [lastEndCause, setLastEndCause] = useState<EndCause | null>(null);
  const [isNewBest, setIsNewBest] = useState(false);
  const bestRef = useRef(0);

  // Imperative HUD nodes.
  const distanceRef = useRef<HTMLDivElement>(null);
  const powerFillRef = useRef<HTMLDivElement>(null);

  /** True while a charge is actually in flight — makes start/release idempotent
   *  no matter which of the three input paths fired (pointer, key, button). */
  const holdingRef = useRef(false);

  // ── Engine construction ──────────────────────────────────────────────────
  // Dynamically imported inside the effect so the engine module (and the dummy
  // plan provider) never runs during SSR.
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      try {
        const [{ createEngine }, { createDummyFlightPlanProvider }] =
          await Promise.all([
            import("./lib/engine/engine"),
            import("./lib/engine/flightPlan"),
          ]);
        if (disposed) return;

        const instance: StuntEngine = createEngine(
          createDummyFlightPlanProvider(),
        );
        unsubscribe = instance.onPhase(
          (next: StuntPhase, state: Readonly<EngineState>) => {
            setPhase(next);
            if (next === "ended") {
              const distance = Math.max(0, Math.round(state.distanceM));
              setLastDistance(distance);
              setLastEndCause(state.endCause);
              setRuns((n) => n + 1);
              const beat = distance > bestRef.current;
              setIsNewBest(beat);
              if (beat) {
                bestRef.current = distance;
                setBestDistance(distance);
              }
            }
          },
        );

        engineRef.current = instance;
        setEngine(instance);
        setPhase(instance.state.phase);
      } catch (error) {
        if (disposed) return;
        console.error("[stuntman-chris] engine init failed", error);
        setLoadFailed(true);
      }
    })();

    return () => {
      disposed = true;
      unsubscribe?.();
      engineRef.current = null;
    };
  }, []);

  // ── Per-frame HUD ticker ─────────────────────────────────────────────────
  // Deliberately outside React: distance and power change ~60x/second and must
  // never become state. Runs for the component's lifetime once the engine
  // exists; the renderer's own loop is what actually advances the engine.
  useEffect(() => {
    if (!engine) return;
    let raf = 0;
    let lastDistanceText = "";

    const tickHud = () => {
      raf = requestAnimationFrame(tickHud);
      const state = engineRef.current?.state;
      if (!state) return;

      const node = distanceRef.current;
      if (node) {
        const text = `${Math.max(0, Math.round(state.distanceM))} m`;
        if (text !== lastDistanceText) {
          lastDistanceText = text;
          node.textContent = text;
        }
      }

      const fill = powerFillRef.current;
      if (fill) {
        fill.style.width = `${Math.round(
          Math.min(1, Math.max(0, state.powerFrac)) * 100,
        )}%`;
      }
    };

    raf = requestAnimationFrame(tickHud);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  // ── Input ────────────────────────────────────────────────────────────────

  const beginRun = useCallback(() => {
    const instance = engineRef.current;
    if (!instance || !assetsReadyRef.current) return;
    if (instance.state.phase !== "title") return;
    instance.begin();
  }, []);

  const goAgain = useCallback(() => {
    const instance = engineRef.current;
    if (!instance) return;
    holdingRef.current = false;
    setIsNewBest(false);
    instance.reset();
  }, []);

  const startCharge = useCallback(() => {
    const instance = engineRef.current;
    if (!instance || !assetsReadyRef.current) return;
    if (holdingRef.current) return;
    if (instance.state.phase !== "ready") return;
    holdingRef.current = true;
    instance.startCharge();
  }, []);

  const releaseCharge = useCallback(() => {
    const instance = engineRef.current;
    if (!instance) return;
    if (!holdingRef.current) return;
    holdingRef.current = false;
    instance.releaseCharge();
  }, []);

  // Spacebar mirrors the pointer path exactly. `repeat` is dropped so held-key
  // auto-repeat can't re-enter startCharge, and window blur releases so a
  // tab-switch mid-charge doesn't leave the engine stuck in `charging`.
  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSpace(e) || isTyping(e.target)) return;
      const instance = engineRef.current;
      if (!instance) return;
      // Stop the page from scrolling and stop space from re-clicking whatever
      // button happens to hold focus (we already handle the action ourselves).
      e.preventDefault();
      if (e.repeat) return;

      const current = instance.state.phase;
      if (current === "title") {
        beginRun();
      } else if (current === "ended") {
        goAgain();
      } else {
        startCharge();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!isSpace(e)) return;
      releaseCharge();
    };

    const onBlur = () => releaseCharge();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [beginRun, goAgain, startCharge, releaseCharge]);

  // ── Asset callbacks (stable — the window keeps them in a ref anyway) ──────

  const handleAssetProgress = useCallback((loaded: number, total: number) => {
    setAssetProgress({ loaded, total });
  }, []);
  const handleAssetsReady = useCallback(() => setAssetsReady(true), []);
  const handleAssetError = useCallback(() => setLoadFailed(true), []);

  const showHud = HUD_PHASES.has(phase);
  const endCause = lastEndCause ?? "landed";
  const crashed = phase === "ended" && endCause !== "landed";

  return (
    <div className="stuntman-chris w-full">
      <GameHud
        title={game.title}
        accessory={
          <GameLeaderboardModal
            gameAddress={game.gameAddress}
            gameName={game.title}
            gameId={game.id}
          />
        }
        // The scene is authored in a fixed 1920x1080 design space and the
        // renderer letterboxes anything else, so the stage keeps 16:9 rather
        // than taking GameHud's viewport-driven height (which would just add
        // bars above and below). `lg:h-auto` releases that height so the
        // aspect class governs — same move as Gimboz's 4:3 stage.
        stageClassName="lg:h-auto lg:aspect-[16/9] lg:max-h-[860px]"
        panel={
          <StuntmanChrisSetupCard
            game={game}
            phase={phase}
            assetsReady={assetsReady}
            lastDistance={lastDistance}
            bestDistance={bestDistance}
            runs={runs}
            lastEndCause={lastEndCause}
            onStart={beginRun}
            onChargeStart={startCharge}
            onChargeEnd={releaseCharge}
            onGoAgain={goAgain}
            powerFillRef={powerFillRef}
          />
        }
      >
        {/* On lg the HUD owns the frame, so the window drops its own border and
            rounding and fills the (already 16:9) stage. */}
        <FluidGameWindow
          bordered
          className="lg:h-full lg:rounded-none lg:border-0"
        >
          {/* Scene + everything drawn over it. The pointer handlers live here
              rather than inside the window island so the island stays a pure
              renderer mount; overlays sit above and swallow their own taps. */}
          <div
            className="relative w-full lg:h-full"
            style={{ touchAction: "manipulation" }}
            onPointerDown={(e) => {
              if (!engineRef.current) return;
              if (engineRef.current.state.phase !== "ready") return;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              startCharge();
            }}
            onPointerUp={releaseCharge}
            onPointerCancel={releaseCharge}
            onLostPointerCapture={releaseCharge}
            onContextMenu={(e) => e.preventDefault()}
          >
            <StuntmanChrisWindow
              engine={engine}
              // Mobile keeps the intrinsic 16:9 box; on lg the stage already
              // is 16:9, so the scene just fills it.
              className="lg:h-full lg:aspect-auto"
              onAssetProgress={handleAssetProgress}
              onAssetsReady={handleAssetsReady}
              onAssetError={handleAssetError}
            />

            {/* Distance HUD — top-centred over the scene, written by the rAF
                ticker above (never React state). */}
            <div
              className="sc-hud"
              style={{ opacity: showHud ? 1 : 0 }}
              aria-hidden={!showHud}
            >
              <div ref={distanceRef} className="sc-hud-distance sc-outline">
                0 m
              </div>
              {bestDistance > 0 && (
                <div className="sc-hud-best">Best {bestDistance} m</div>
              )}
            </div>

            {phase === "title" && assetsReady && (
              <StuntmanChrisTitleOverlay onStart={beginRun} />
            )}

            {phase === "ended" && (
              <div className="sc-overlay sc-scrim z-[70] gap-3 px-6">
                <div className="sc-label">Distance</div>
                <div className="sc-result-distance sc-outline">
                  {lastDistance ?? 0} m
                </div>
                {isNewBest && lastDistance ? (
                  <div className="sc-newbest">New session best!</div>
                ) : (
                  <div className="sc-label">Best {bestDistance} m</div>
                )}
                <div
                  className={`sc-endcause sc-outline ${
                    crashed ? "sc-crash" : "sc-safe"
                  }`}
                >
                  {END_CAUSE_HEADLINE[endCause]}
                </div>
                <p className="text-xs sm:text-sm text-[#b3a8d6] max-w-xs">
                  {END_CAUSE_FLAVOR[endCause]}
                </p>
                <button
                  type="button"
                  className="sc-btn sc-btn-primary mt-1"
                  onClick={goAgain}
                >
                  Go again
                </button>
              </div>
            )}

            <StuntmanChrisPreloadOverlay
              loaded={assetProgress.loaded}
              total={assetProgress.total}
              ready={assetsReady || loadFailed}
            />

            {loadFailed && (
              <div className="absolute inset-x-0 bottom-0 z-[85] bg-[#0b0619]/85 px-4 py-2 text-center text-xs text-[#d33a46]">
                Scene failed to load. Check the console and refresh.
              </div>
            )}
          </div>
        </FluidGameWindow>
      </GameHud>
    </div>
  );
};

export default StuntmanChris;
