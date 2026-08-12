"use client";

import React, { useState } from "react";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { HUD_PANEL_CARD_CLASS } from "@/components/games/shared/GameHud";
import type { SimpleGame } from "@/lib/constants/games";
import type { EndCause, StuntPhase } from "./lib/types";
import { IMAGES } from "./lib/assets.generated";

interface StuntmanChrisSetupCardProps {
  game: SimpleGame;
  phase: StuntPhase;
  /** Blocks input until the sheets are decoded and the renderer is live. */
  assetsReady: boolean;
  /** Distance of the previous run, m. Null before the first run finishes. */
  lastDistance: number | null;
  /** Session best, m. 0 before the first run. */
  bestDistance: number;
  /** Completed runs this session. */
  runs: number;
  lastEndCause: EndCause | null;
  /** title -> ready. */
  onStart: () => void;
  /** ready -> charging (pointer down / space down). */
  onChargeStart: () => void;
  /** charging -> riding (pointer up / space up). */
  onChargeEnd: () => void;
  /** ended -> ready. */
  onGoAgain: () => void;
  /**
   * Imperative handle for the power read-out. The orchestrator's rAF ticker
   * writes `style.width` straight onto this node — powerFrac changes every
   * frame and must never become React state.
   */
  powerFillRef: React.RefObject<HTMLDivElement | null>;
}

const PHASE_STATUS: Record<StuntPhase, string> = {
  title: "Press start to hit the road.",
  ready: "Hold to charge. Release to launch.",
  charging: "Charging…",
  riding: "Here we go…",
  launching: "Ramp!",
  flying: "Flying!",
  dying: "Ouch.",
  landing: "Coming down…",
  ended: "Run over.",
};

const END_CAUSE_LABEL: Record<EndCause, string> = {
  laser: "Lasered out of the sky",
  bone: "Taken down by a bone",
  crash: "Hit something solid",
  landed: "Landed safe",
};

const formatMeters = (m: number) => `${Math.max(0, Math.round(m))} m`;

/**
 * Control panel. Deliberately carries NO bet inputs: v1 is an off-chain visual
 * build, so there is no wager, no APE/GP and no payout anywhere in this game
 * yet. It keeps the platform's standard `Card` frame (`p-6 flex flex-col`, same
 * as the other setup cards) so the page still reads as one of ours, and fills
 * it with the title logo, the how-to-play blurb, the hold-to-charge LAUNCH
 * button and session stats.
 *
 * Below lg it is the classic floating card stacked under the window; on lg+ it
 * is docked into the GameHud's 340px panel column via `HUD_PANEL_CARD_CLASS`
 * (chrome dropped, tighter rhythm, art capped so it doesn't fill the column).
 *
 * The LAUNCH button mirrors the scene's own input exactly — it calls the same
 * charge handlers the pointer/keyboard paths use, so holding it, holding the
 * canvas, or holding space are interchangeable.
 */
const StuntmanChrisSetupCard: React.FC<StuntmanChrisSetupCardProps> = ({
  game,
  phase,
  assetsReady,
  lastDistance,
  bestDistance,
  runs,
  lastEndCause,
  onStart,
  onChargeStart,
  onChargeEnd,
  onGoAgain,
  powerFillRef,
}) => {
  const [logoFailed, setLogoFailed] = useState(false);
  const [buttonArtFailed, setButtonArtFailed] = useState(false);

  const holding = phase === "charging";
  const canCharge = assetsReady && (phase === "ready" || phase === "charging");

  return (
    <Card
      className={cn(
        "lg:basis-1/3 p-6 flex flex-col gap-5",
        HUD_PANEL_CARD_CLASS,
        "lg:gap-3",
      )}
    >
      <CardContent className="flex flex-col gap-5 p-0 lg:gap-4">
        {/* Title lockup */}
        {logoFailed ? (
          <div className="sc-display sc-outline text-center text-2xl text-white">
            {game.title}
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={IMAGES.titleLogo.url}
            alt={game.title}
            className="w-full max-w-[260px] lg:max-w-[170px] mx-auto h-auto"
            style={{ imageRendering: "pixelated" }}
            draggable={false}
            onError={() => setLogoFailed(true)}
          />
        )}

        {/* How to play */}
        <div className="flex flex-col gap-1.5">
          <div className="sc-label">How to play</div>
          <p className="text-sm text-[#b3a8d6] leading-relaxed">
            Hold the button (or the spacebar) to charge your power, then let go
            to launch off the UFO ramp. Bounce off wrecks, grab the moonboots
            and dodge the lasers — the only score is how far you fly.
          </p>
        </div>

        {/* The control. One button, four jobs, depending on the phase. */}
        {phase === "title" && (
          <button
            type="button"
            className="sc-btn sc-btn-primary w-full"
            onClick={onStart}
            disabled={!assetsReady}
          >
            {assetsReady ? "Start" : "Loading…"}
          </button>
        )}

        {phase === "ended" && (
          <button
            type="button"
            className="sc-btn sc-btn-primary w-full"
            onClick={onGoAgain}
          >
            Go again
          </button>
        )}

        {/* Capped and centred in the 340px HUD column so the art doesn't blow
            up to the full panel width. */}
        {phase !== "title" && phase !== "ended" && (
          <div className="flex flex-col gap-2 lg:w-full lg:max-w-[240px] lg:mx-auto">
            <button
              type="button"
              className={cn("sc-launch", holding && "sc-holding")}
              disabled={!canCharge}
              aria-label="Hold to charge, release to launch"
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (!canCharge) return;
                // Capture so the release still lands here if the finger slides
                // off the button while charging.
                e.currentTarget.setPointerCapture?.(e.pointerId);
                onChargeStart();
              }}
              onPointerUp={onChargeEnd}
              onPointerCancel={onChargeEnd}
              onLostPointerCapture={onChargeEnd}
            >
              {buttonArtFailed ? (
                <span className="sc-launch-fallback">Launch</span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={IMAGES.powerButton.url}
                  alt=""
                  draggable={false}
                  onError={() => setButtonArtFailed(true)}
                />
              )}
            </button>

            <div className="sc-power-track" aria-hidden>
              <div ref={powerFillRef} className="sc-power-fill" />
            </div>
          </div>
        )}

        {/* Contextual status line */}
        <div className="min-h-[20px] text-center">
          <span
            className="sc-label"
            style={{ color: holding ? "#7ff0e4" : undefined }}
          >
            {holding ? "Hold…" : PHASE_STATUS[phase]}
          </span>
        </div>
      </CardContent>

      <CardFooter className="mt-auto w-full flex flex-col p-0">
        <div className="w-full flex flex-col">
          <div className="sc-stat-row">
            <span className="sc-label">Last distance</span>
            <span className="sc-stat-value">
              {lastDistance == null ? "—" : formatMeters(lastDistance)}
            </span>
          </div>
          <div className="sc-stat-row">
            <span className="sc-label">Best distance</span>
            <span className="sc-stat-value">
              {bestDistance > 0 ? formatMeters(bestDistance) : "—"}
            </span>
          </div>
          <div className="sc-stat-row">
            <span className="sc-label">Runs</span>
            <span className="sc-stat-value">{runs}</span>
          </div>
          <div className="sc-stat-row">
            <span className="sc-label">Last run</span>
            <span className="sc-stat-value text-[13px]">
              {lastEndCause ? END_CAUSE_LABEL[lastEndCause] : "—"}
            </span>
          </div>
        </div>
      </CardFooter>
    </Card>
  );
};

export default StuntmanChrisSetupCard;
