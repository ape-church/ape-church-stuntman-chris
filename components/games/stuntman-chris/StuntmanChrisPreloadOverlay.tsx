"use client";

import React, { useEffect, useState } from "react";

/**
 * Module-scoped singleton: flips true the first time the sheets finish loading
 * in this tab. A later remount (navigate away and back, replay key change)
 * skips the overlay entirely — every file is already in the HTTP cache and the
 * renderer's own loader resolves from it more or less instantly.
 */
let hasEverPreloaded = false;

interface StuntmanChrisPreloadOverlayProps {
  /** Assets decoded so far, reported by the renderer's `loadStuntAssets`. */
  loaded: number;
  /** Total assets the loader will report. 0 until the first progress call. */
  total: number;
  /** True once the renderer is live (or the load failed — we stop blocking). */
  ready: boolean;
}

/**
 * Blocking pre-game loader drawn over the scene (simplified pop-n-drop
 * pattern). It does NOT fetch anything itself — the renderer's `loadStuntAssets`
 * is the single loader, and this only visualises its (loaded, total) callback,
 * so there's no chance of the two disagreeing or double-downloading ~20MB of
 * sheets.
 *
 * `z-[80]` matches the other game preloaders: above scene content, below the
 * app-level nav / mobile menu chrome (z-100+ globally).
 */
const StuntmanChrisPreloadOverlay: React.FC<
  StuntmanChrisPreloadOverlayProps
> = ({ loaded, total, ready }) => {
  const [mounted, setMounted] = useState(!hasEverPreloaded);

  const progress =
    ready || total === 0
      ? ready
        ? 100
        : 0
      : Math.min(100, Math.round((loaded / total) * 100));

  // Flip the module flag and hold ~450ms after ready so the fade-out plays.
  useEffect(() => {
    if (!ready) return;
    hasEverPreloaded = true;
    if (!mounted) return;
    const t = setTimeout(() => setMounted(false), 450);
    return () => clearTimeout(t);
  }, [ready, mounted]);

  if (!mounted) return null;

  return (
    <div
      className={`sc-overlay sc-duskwash z-[80] gap-5 transition-opacity duration-500 ease-out ${
        ready ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
      aria-live="polite"
      aria-busy={!ready}
    >
      <div className="sc-roadline" style={{ top: "58%" }} />
      <div className="sc-roadline" style={{ top: "calc(58% + 10px)", opacity: 0.6 }} />
      <div className="sc-roadline" style={{ top: "calc(58% + 20px)", opacity: 0.3 }} />

      <div className="sc-label">Stuntman Chris</div>
      <div className="sc-display sc-outline text-2xl sm:text-4xl text-white px-4 leading-tight">
        Warming up the bike
      </div>

      <div className="sc-preload-track">
        <div className="sc-preload-fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="sc-label" style={{ letterSpacing: "0.2em" }}>
        {progress}%
      </div>
    </div>
  );
};

export default StuntmanChrisPreloadOverlay;
