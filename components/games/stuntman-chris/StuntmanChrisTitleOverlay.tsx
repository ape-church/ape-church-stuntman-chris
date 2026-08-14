"use client";

import React, { useState } from "react";
import { IMAGES } from "./lib/assets.generated";
import { sfx } from "./lib/sound/sfx";

interface StuntmanChrisTitleOverlayProps {
  /** Kicks the engine out of `title` into `ready` (click / space / button). */
  onStart: () => void;
}

/**
 * Title screen drawn over the scene while the engine sits in its `title` phase.
 *
 * Two presentations, matched to the window shape:
 *
 *  - Below lg the window is the platform's 1:1 square, which is exactly the
 *    start-screen clip's native aspect — so the produced intro video runs
 *    full-bleed (`object-cover` is a no-crop fit here).
 *  - On lg+ the HUD stage is wide and viewport-driven, where the square clip
 *    used to letterbox with dead pillars. Instead the LIVE idle scene (already
 *    rendering underneath) becomes the backdrop and the overlay only adds the
 *    glow title lockup (`title-logo-fx`), the start prompt and a legibility
 *    scrim — full-bleed at any stage aspect.
 *
 * Muted + playsInline + autoPlay is the only combination iOS Safari will
 * autoplay; the clip has no audio anyway (v1 ships silent).
 */
const StuntmanChrisTitleOverlay: React.FC<StuntmanChrisTitleOverlayProps> = ({
  onStart,
}) => {
  const [showInstructions, setShowInstructions] = useState(false);

  return (
    <div className="sc-overlay z-[60] overflow-hidden">
      {/* Mobile-only intro clip: 1:1 video in a 1:1 window, exact fit. */}
      <video
        className="absolute inset-0 h-full w-full object-cover lg:hidden"
        src={IMAGES.startScreenVideo.url}
        poster={IMAGES.startScreenPoster.url}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-hidden
      />

      {/* Legibility scrim: gentle bottom fade everywhere (under the prompt),
          plus a soft radial pool behind the desktop lockup. */}
      <div className="sc-title-scrim absolute inset-0" aria-hidden />

      {!showInstructions && (
        <>
          {/* Click-to-start layer. Covers the whole window; the buttons below
              sit above it and stop propagation. */}
          <button
            type="button"
            className="absolute inset-0 z-[61] cursor-pointer"
            onClick={onStart}
            aria-label="Start Stuntman Chris"
          />

          {/* Desktop lockup — the video already carries its own logo below lg. */}
          <div className="sc-title-lockup z-[61] hidden lg:flex" aria-hidden>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={IMAGES.titleLogoFx.url}
              alt=""
              draggable={false}
              style={{ imageRendering: "pixelated" }}
            />
          </div>

          <div className="absolute inset-x-0 bottom-0 z-[62] flex flex-col items-center gap-3 pb-[6%] pointer-events-none">
            <div className="sc-prompt sc-outline">
              Click or press space to start
            </div>
            <button
              type="button"
              className="sc-btn sc-btn-ghost pointer-events-auto"
              onClick={(e) => {
                e.stopPropagation();
                sfx.play("ui_click");
                setShowInstructions(true);
              }}
            >
              How to play
            </button>
          </div>
        </>
      )}

      {/* Instructions: a self-contained card that never depends on the window
          shape. It is width-capped, height-capped to the padded overlay box and
          scrolls its own list if the stage is too short — so it fits the 1:1
          mobile window, the ~0.86:1 narrow stage and the ~1.9:1 wide stage
          alike. The panel art rides along as a dim texture layer only. */}
      {showInstructions && (
        <div className="sc-inst-backdrop z-[63]">
          <div
            className="sc-inst-card"
            role="dialog"
            aria-modal="true"
            aria-label="How to play"
          >
            <div
              className="sc-inst-art"
              style={{ backgroundImage: `url("${IMAGES.instructionBg.url}")` }}
              aria-hidden
            />

            <div className="sc-inst-head">
              <h2 className="sc-inst-title">How to play</h2>
              <button
                type="button"
                className="sc-btn sc-btn-ghost sc-inst-close"
                onClick={() => {
                  sfx.play("ui_click");
                  setShowInstructions(false);
                }}
              >
                Close
              </button>
            </div>

            <ul className="sc-inst-list">
              <li>
                <span className="sc-inst-verb">Hold</span> the launch button (or
                the spacebar) to charge the power meter.
              </li>
              <li>
                <span className="sc-inst-verb">Release</span> to ride at the
                electrified UFO ramp and take off.
              </li>
              <li>
                <span className="sc-inst-verb">Bounce</span> off wrecks and
                bystanders to keep your speed alive.
              </li>
              <li>
                <span className="sc-inst-verb">Grab</span> the moonboots for a
                mid-air boost.
              </li>
              <li>
                <span className="sc-inst-verb">Dodge</span> the lasers and the
                bones the graveyard throws at you.
              </li>
              <li>
                <span className="sc-inst-verb">Fly</span> as far as you can —
                distance is the whole score.
              </li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};

export default StuntmanChrisTitleOverlay;
