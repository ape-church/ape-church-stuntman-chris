"use client";

import React, { useState } from "react";
import { IMAGES } from "./lib/assets.generated";

interface StuntmanChrisTitleOverlayProps {
  /** Kicks the engine out of `title` into `ready` (click / space / button). */
  onStart: () => void;
}

/**
 * Title screen drawn over the scene while the engine sits in its `title` phase.
 *
 * The start-screen clip is a 1:1 SQUARE video inside our 16:9 window, so it is
 * letterboxed with `object-contain` over a dusk wash that continues the art's
 * sky rather than stretched to fill (SkateOrCrash's intro is 16:9 and can use
 * object-cover — ours can't). The poster frame is the matching square still, so
 * the framing is identical before the video decodes.
 *
 * Muted + playsInline + autoPlay is the only combination iOS Safari will
 * autoplay; the clip has no audio anyway (v1 ships silent).
 */
const StuntmanChrisTitleOverlay: React.FC<StuntmanChrisTitleOverlayProps> = ({
  onStart,
}) => {
  const [showInstructions, setShowInstructions] = useState(false);

  return (
    <div className="sc-overlay sc-duskwash z-[60] overflow-hidden">
      {/* Letterboxed title clip. pointer-events are handled by the click layer
          above it so a tap anywhere starts the run. */}
      <video
        className="absolute inset-0 h-full w-full object-contain"
        src={IMAGES.startScreenVideo.url}
        poster={IMAGES.startScreenPoster.url}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-hidden
      />

      {!showInstructions && (
        <>
          {/* Click-to-start layer. Covers the whole window; the two buttons
              below sit above it and stop propagation. */}
          <button
            type="button"
            className="absolute inset-0 z-[61] cursor-pointer"
            onClick={onStart}
            aria-label="Start Stuntman Chris"
          />

          <div className="absolute inset-x-0 bottom-0 z-[62] flex flex-col items-center gap-3 pb-[6%] pointer-events-none">
            <div className="sc-prompt sc-outline">
              Click or press space to start
            </div>
            <button
              type="button"
              className="sc-btn sc-btn-ghost pointer-events-auto"
              onClick={(e) => {
                e.stopPropagation();
                setShowInstructions(true);
              }}
            >
              How to play
            </button>
          </div>
        </>
      )}

      {showInstructions && (
        <div className="absolute inset-0 z-[63] flex items-center justify-center bg-[#0b0619]/80 p-2">
          <div
            className="sc-instructions"
            style={{ backgroundImage: `url("${IMAGES.instructionBg.url}")` }}
          >
            <div className="sc-inst-title">How to play</div>
            <ul className="flex flex-col gap-[0.35em] list-none">
              <li>
                <strong>Hold</strong> the launch button (or the spacebar) to
                charge the power meter.
              </li>
              <li>
                <strong>Release</strong> to ride at the electrified UFO ramp and
                take off.
              </li>
              <li>
                <strong>Bounce</strong> off wrecks and bystanders to keep your
                speed alive.
              </li>
              <li>
                <strong>Grab</strong> the moonboots for a mid-air boost.
              </li>
              <li>
                <strong>Dodge</strong> the lasers and the bones the graveyard
                throws at you.
              </li>
              <li>Fly as far as you can. Distance is the whole score.</li>
            </ul>
          </div>

          <button
            type="button"
            className="sc-btn sc-btn-ghost absolute top-3 right-3 z-[64]"
            onClick={() => setShowInstructions(false)}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
};

export default StuntmanChrisTitleOverlay;
