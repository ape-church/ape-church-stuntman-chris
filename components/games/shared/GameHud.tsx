"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { useIsMiniEmbed } from "@/hooks/use-mini-embed";

/**
 * True for anything rendered in the HUD's `accessory` slot.
 *
 * Accessory buttons (GameLeaderboardModal, roulette's Hot & Cold) are shared
 * with ~35 non-HUD game pages, where they are page-level controls and should
 * stay full-size. Inside the 40px HUD bar the same `h-9` outline button nearly
 * touches both edges and reads as squeezed, so it needs a quieter, shorter
 * treatment — but ONLY here. Hence a context rather than a global restyle.
 *
 * A blanket `[&_button]` descendant selector on the slot was the other option
 * and is wrong: `RouletteHotColdModal` renders `fixed inset-0` in-tree rather
 * than through a portal, so the styling would leak into the modal's own
 * buttons.
 */
const HudBarContext = React.createContext(false);

/** Opt a custom accessory into the HUD bar treatment. */
export const useIsInHudBar = (): boolean => React.useContext(HudBarContext);

/**
 * Treatment for an accessory button in the HUD bar: shorter, quieter, a faint
 * surface instead of a border, so it sits inside the 40px bar as chrome rather
 * than competing with the frame.
 *
 * Apply this ON TOP of the button's normal `variant` — do NOT swap the variant
 * to `ghost` for HUD games. A variant applies at every width, so switching it
 * strips the outline on mobile too, where the bar is the classic page-title row
 * and these are full-size page controls. Every override here is `lg:`-scoped
 * for exactly that reason.
 *
 * The `lg:dark:*` duplicates are load-bearing: `variant="outline"` carries
 * `dark:bg-input/30` / `dark:border-input` / `dark:hover:bg-input/50`, and
 * twMerge keys `dark:bg-*` separately from `lg:bg-*`, so both would survive and
 * CSS source order would decide the winner. Stating both is what makes this
 * deterministic under a dark colour scheme.
 */
export const HUD_ACCESSORY_BUTTON_CLASS = [
  "lg:h-7 lg:px-2.5 lg:text-xs lg:font-medium lg:rounded-md lg:shadow-none",
  "lg:text-[#91989C] lg:hover:text-foreground",
  "lg:border-transparent lg:dark:border-transparent",
  "lg:bg-white/[0.05] lg:dark:bg-white/[0.05]",
  "lg:hover:bg-white/[0.1] lg:dark:hover:bg-white/[0.1]",
].join(" ");

/**
 * Docking treatment for a setup card rendered in the GameHud panel: on lg+
 * the frame owns the chrome, so the card drops its own border/rounding/
 * surface/shadow, fills the panel column (min-h so the column can actually
 * scroll — h-full would silently clip), and runs on tighter padding. Compose
 * with card-specific extras (e.g. `lg:bg-none` for gradient surfaces).
 * Below lg this is inert — the card stays the classic floating card.
 */
export const HUD_PANEL_CARD_CLASS =
  "lg:min-h-full lg:basis-auto lg:p-4 lg:border-0 lg:rounded-none lg:bg-transparent lg:shadow-none";

/**
 * Unified desktop game frame ("HUD"): one bordered container holding a slim
 * title bar, a narrow left-docked control panel (Stake-style) and a wide game
 * stage that gets the bulk of the width. Pilot layout for games whose scenes
 * are procedurally rendered and can fill a non-square window (speed-crash,
 * blocks, mega-bonk); art-locked games keep the classic floating-card layout.
 *
 * Below lg nothing changes versus the classic layout: title row, then the
 * game window, then the controls stacked underneath, no outer frame — the
 * square mobile presentation is deliberately untouched.
 *
 * The child GameWindow must be rendered with `hudMode` so it fills the stage
 * instead of drawing its own border and sizing itself off its background art.
 */
interface GameHudProps {
  /** Game title — rendered in the HUD bar, replacing the page-level <h1>. */
  title: string;
  /** Sits beside the title (e.g. the GameLeaderboardModal trigger). */
  accessory?: React.ReactNode;
  /** Bet/setup controls. Docked left on lg+, stacked below the game on mobile.
   *  The panel column scrolls internally if taller than the stage. */
  panel: React.ReactNode;
  /** Extra classes for the stage wrapper — add constraints (e.g. a
   *  lg:min-h floor for content-heavy scenes) or override the default
   *  viewport-driven height entirely with an aspect class. */
  stageClassName?: string;
  /** The GameWindow (with hudMode) plus any siblings scoped to the stage. */
  children: React.ReactNode;
}

const GameHud: React.FC<GameHudProps> = ({
  title,
  accessory,
  panel,
  stageClassName,
  children,
}) => {
  // The /embed/[slug] mini-window iframes never rendered the page h1, so the
  // HUD bar must not introduce one there either (~380px floating windows).
  const isMiniEmbed = useIsMiniEmbed();

  return (
    <div className="w-full lg:overflow-hidden lg:rounded-[12px] lg:border-[3px] lg:border-[#2A3640] lg:bg-[#12181C]">
      {/* Title bar: mobile keeps the classic page-title row; desktop gets a
          slim in-frame bar, reclaiming the vertical space the h1 used to eat.

          flex-wrap + gap-y matter below lg only: a game with more than one
          accessory (roulette ships Leaderboard AND Hot & Cold) overflowed a
          390px screen instead of dropping to a second line. row-gap is inert
          until something actually wraps, so single-accessory games are
          unchanged. The lg bar is a fixed-height strip and never wraps. */}
      {!isMiniEmbed && (
        <div className="mb-2 flex flex-row flex-wrap items-center gap-y-2 sm:mb-4 lg:mb-0 lg:h-10 lg:flex-nowrap lg:gap-y-0 lg:border-b lg:border-[#2A3640] lg:px-5">
          <h1 className="mr-2 text-3xl font-semibold lg:text-lg">{title}</h1>
          <HudBarContext.Provider value>{accessory}</HudBarContext.Provider>
        </div>
      )}

      <div className="flex flex-col gap-4 sm:gap-8 lg:flex-row lg:gap-0">
        {/* Control panel: fixed narrow column docked to the frame on desktop.
            The inner absolute wrapper pins the column to the stage's height so
            overly tall setup content scrolls instead of stretching the frame. */}
        <div className="relative order-2 lg:order-1 lg:w-[300px] lg:shrink-0 lg:border-r-[3px] lg:border-[#2A3640] xl:w-[340px]">
          <div className="lg:absolute lg:inset-0 lg:overflow-y-auto">{panel}</div>
        </div>

        {/* Stage: the game gets the remaining width, and its height comes from
            the VIEWPORT, not a fixed aspect — the pilot games are procedural
            (no art aspect to honour), and a hard 16:9 left the stage shorter
            than the classic square window on laptops. The clamp keeps short
            windows usable and stops ultra-tall monitors from stretching the
            scene absurdly; all three figures are tuned in globals.css
            (--game-hud-stage-*) because the offset is derived from the chrome
            stacked above the frame and has to move with it. */}
        <div
          className={cn(
            "relative order-1 w-full lg:order-2 lg:min-w-0 lg:flex-1 lg:h-[clamp(var(--game-hud-stage-min),calc(100vh_-_var(--game-hud-stage-offset)),var(--game-hud-stage-max))]",
            stageClassName
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

export default GameHud;
