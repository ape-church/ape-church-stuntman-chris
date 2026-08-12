import React from "react";
import { cn } from "@/lib/utils";

/**
 * Page shell for a game on the unified HUD (docs/GAME-HUD.md). Replaces the
 * `<div className="w-full max-w-7xl mx-auto">` every ported page used to hand-
 * roll, and reclaims the space the generic page shell was spending on chrome
 * the HUD doesn't need:
 *
 * - `lg:-mt-14` cancels 56px of ContentFrame's `md:pt-20`, leaving 24px above
 *   the frame. The HUD is a self-contained cabinet with its own title bar, so
 *   the page-title breathing room was dead space. This 24px is baked into
 *   `--game-hud-stage-offset` (globals.css) — change one, change the other.
 * - `lg:-mx-6` gives back half of ContentFrame's `lg:px-12` gutter, so the
 *   frame runs to a 24px margin instead of 48px. Combined with the wider cap
 *   below, the stage goes from 931px to ~1139px on a 1920px monitor.
 * - `lg:max-w-[1488px]` — the container tops out at 1536px, minus the 48px of
 *   gutter that survives the negative margin.
 *
 * Everything is `lg:`-prefixed: below 1024 the HUD doesn't render and this is
 * exactly the old `w-full max-w-7xl mx-auto`.
 *
 * Scoped here rather than in ContentFrame on purpose — only ~12 of ~50 game
 * routes are ported, and a path-scoped rule would strip the top padding from
 * the unported ones too, leaving their page <h1> hugging the nav.
 */
const GameHudPage: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <div
    className={cn(
      "w-full max-w-7xl mx-auto lg:-mt-14 lg:-mx-6 lg:w-auto lg:max-w-[1488px]",
      className
    )}
  >
    {children}
  </div>
);

export default GameHudPage;
