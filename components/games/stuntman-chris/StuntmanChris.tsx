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
import { sfx } from "./lib/sound/sfx";
import { createSoundDirector, type SoundDirector } from "./lib/sound/director";
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
  const runsRef = useRef(0);

  // Imperative HUD nodes.
  const distanceRef = useRef<HTMLDivElement>(null);
  const powerFillRef = useRef<HTMLDivElement>(null);

  // Sound: the director diffs engine state → sfx calls each frame; the mute /
  // volume state mirrors the sfx module's persisted prefs for the sound menu.
  const directorRef = useRef<SoundDirector | null>(null);
  const [sfxMuted, setSfxMuted] = useState(false);
  const [musicMuted, setMusicMuted] = useState(false);
  const [sfxVolume, setSfxVolume] = useState(1);
  const [musicVolume, setMusicVolume] = useState(0.7);
  const [soundMenuOpen, setSoundMenuOpen] = useState(false);
  const soundMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSfxMuted(sfx.muted);
    setMusicMuted(sfx.musicMutedPref);
    setSfxVolume(sfx.sfxVolumePref);
    setMusicVolume(sfx.musicVolumePref);
  }, []);

  // Close the sound menu on any pointer-down outside it. Taps inside the
  // corner UI never reach the window (the container stops propagation).
  useEffect(() => {
    if (!soundMenuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!soundMenuRef.current?.contains(e.target as Node)) setSoundMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [soundMenuOpen]);

  // Web Audio needs a user gesture before it may run — any first interaction
  // (click, tap, spacebar) unlocks the context and starts loading the files.
  useEffect(() => {
    const unlock = () => sfx.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

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
                if (runsRef.current > 0) sfx.play("new_best"); // not on run #1
              }
              runsRef.current += 1;
            }
          },
        );

        engineRef.current = instance;
        directorRef.current = createSoundDirector(instance);
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

      directorRef.current?.tick();

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
    sfx.play("ui_click");
    instance.begin();
  }, []);

  const goAgain = useCallback(() => {
    const instance = engineRef.current;
    if (!instance) return;
    holdingRef.current = false;
    setIsNewBest(false);
    sfx.play("ui_click");
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

  const toggleSfxMuted = useCallback(() => {
    const next = !sfx.muted;
    sfx.setMuted(next);
    setSfxMuted(next);
    if (!next) sfx.play("ui_click"); // audible confirmation on unmute
  }, []);

  const toggleMusicMuted = useCallback(() => {
    const next = !sfx.musicMutedPref;
    sfx.setMusicMuted(next);
    setMusicMuted(next);
    sfx.play("ui_click");
  }, []);

  // Dragging a slider while that channel is muted unmutes it — adjusting a
  // volume you can't hear is never what anyone means.
  const changeSfxVolume = useCallback((v: number) => {
    sfx.setSfxVolume(v);
    setSfxVolume(v);
    if (sfx.muted) {
      sfx.setMuted(false);
      setSfxMuted(false);
    }
  }, []);

  const changeMusicVolume = useCallback((v: number) => {
    sfx.setMusicVolume(v);
    setMusicVolume(v);
    if (sfx.musicMutedPref) {
      sfx.setMusicMuted(false);
      setMusicMuted(false);
    }
  }, []);

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
        // No stage override: the renderer derives its design width from the
        // container's aspect and fills whatever box it is given, so the stage
        // takes GameHud's full viewport-driven height (clamp 560–900px) and a
        // wider/taller stage simply sees more world — no letterbox bars.
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
              renderer mount; overlays sit above and swallow their own taps.
              The inline-size container makes cqw units in the game CSS measure
              the STAGE rather than the viewport (vw diverges badly in the HUD). */}
          <div
            className="relative w-full lg:h-full [container-type:inline-size]"
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
              // Mobile keeps the platform's square window; on lg the HUD stage
              // provides the height and the renderer fills whatever aspect
              // that yields.
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

            {/* Sound menu — one button pinned bottom-right opens a small
                panel with mute + volume for music and sfx. pointer-down is
                stopped so a tap here can never start a charge (and so the
                outside-click closer never sees inside taps). */}
            <div
              ref={soundMenuRef}
              className="sc-sound-toggles"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
            >
              {soundMenuOpen && (
                <div className="sc-sound-menu" role="group" aria-label="Sound settings">
                  <div className="sc-sound-row">
                    <span className="sc-sound-row-label">Music</span>
                    <button
                      type="button"
                      className="sc-sound-btn sc-sound-btn--sm"
                      onClick={toggleMusicMuted}
                      aria-pressed={musicMuted}
                      aria-label={musicMuted ? "Unmute music" : "Mute music"}
                      title={musicMuted ? "Music: off" : "Music: on"}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden>
                        <path
                          d="M9 18V6l10-2v11.5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          fill="none"
                          strokeLinecap="round"
                        />
                        <circle cx="7" cy="18" r="2.4" fill="currentColor" />
                        <circle cx="17" cy="15.5" r="2.4" fill="currentColor" />
                        {musicMuted && (
                          <path d="M3.5 4l17 17" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
                        )}
                      </svg>
                    </button>
                    <input
                      type="range"
                      className="sc-sound-slider"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(musicVolume * 100)}
                      onChange={(e) => changeMusicVolume(Number(e.target.value) / 100)}
                      aria-label="Music volume"
                    />
                  </div>
                  <div className="sc-sound-row">
                    <span className="sc-sound-row-label">SFX</span>
                    <button
                      type="button"
                      className="sc-sound-btn sc-sound-btn--sm"
                      onClick={toggleSfxMuted}
                      aria-pressed={sfxMuted}
                      aria-label={sfxMuted ? "Unmute sound effects" : "Mute sound effects"}
                      title={sfxMuted ? "Sound effects: off" : "Sound effects: on"}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden>
                        <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
                        {sfxMuted ? (
                          <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" fill="none" />
                        ) : (
                          <path
                            d="M16 8c1.5 1 2.2 2.4 2.2 4S17.5 15 16 16M18 5.5c2.4 1.6 3.6 3.8 3.6 6.5s-1.2 4.9-3.6 6.5"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            fill="none"
                            strokeLinecap="round"
                          />
                        )}
                      </svg>
                    </button>
                    <input
                      type="range"
                      className="sc-sound-slider"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(sfxVolume * 100)}
                      onChange={(e) => changeSfxVolume(Number(e.target.value) / 100)}
                      onPointerUp={() => sfx.play("ui_click")} // hear the level
                      aria-label="Sound effects volume"
                    />
                  </div>
                </div>
              )}
              <button
                type="button"
                className="sc-sound-btn"
                // The container stops pointer propagation (so taps here can't
                // charge), which also keeps the window-level unlock listener
                // from seeing this gesture — unlock explicitly, or a player
                // whose first click is the sound menu gets no audio/music.
                onClick={() => {
                  sfx.unlock();
                  setSoundMenuOpen((open) => !open);
                }}
                aria-expanded={soundMenuOpen}
                aria-label={soundMenuOpen ? "Close sound settings" : "Open sound settings"}
                title="Sound settings"
              >
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
                  {sfxMuted && musicMuted ? (
                    <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="2" fill="none" />
                  ) : (
                    <path
                      d="M16 8c1.5 1 2.2 2.4 2.2 4S17.5 15 16 16M18 5.5c2.4 1.6 3.6 3.8 3.6 6.5s-1.2 4.9-3.6 6.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      fill="none"
                      strokeLinecap="round"
                    />
                  )}
                </svg>
              </button>
            </div>

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
