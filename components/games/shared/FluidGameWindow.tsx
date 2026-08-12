// SNAPSHOT-TRIMMED for standalone repo — canonical version lives in ape-church. DO NOT bring this file back; see TRANSITION notes.
//
// Stripped versus ape-church's components/games/shared/FluidGameWindow.tsx:
//   - `@/lib/i18n` (useTranslation): the two paused-overlay strings are inlined
//     as their English literals from lib/i18n/dictionaries/en/gamesSharedUi.ts.
//   - `./useGameMusic` and the Howler music side-effect. The `song` prop is
//     KEPT in the props type so call sites still typecheck; it is unused here.
//     Stuntman Chris never passes it (the game has no audio).
"use client";

import React from "react";
import { cn } from "@/lib/utils";
import NewLoadingText from "@/components/loading/NewLoadingText";

interface FluidGameWindowProps {
  /** True while the VRF callback is pending after a bet is sent. */
  isLoading?: boolean;
  /** True when the game (or all games) is paused on-chain. */
  isGamePaused?: boolean;
  /** Optional looping background track (Howler). Omit for silent games.
   *  Ignored in this standalone snapshot — see the header note. */
  song?: string;
  /** Custom loading content; defaults to the platform's cycling loading text. */
  loadingContent?: React.ReactNode;
  /** Wrap children in the standard window border. Off by default — fluid games
   *  often carry their own frame (e.g. EZ Baccarat's felt). */
  bordered?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Shared game-window shell for DYNAMICALLY-SIZED games — those whose own layout
 * defines their height rather than conforming to a fixed aspect ratio (e.g. EZ
 * Baccarat's full-width felt). It provides the common chrome — paused / loading
 * overlays and optional looping music — without imposing a ratio or border, so
 * the window hugs its content exactly (the loading overlay matches the real game
 * area instead of a forced box). Games supply their own results modal as part of
 * `children`.
 *
 * Fixed-ratio games (4:3, etc.) should use a fixed-ratio window instead.
 */
const FluidGameWindow: React.FC<FluidGameWindowProps> = ({
  isLoading = false,
  isGamePaused = false,
  song: _song,
  loadingContent,
  bordered = false,
  className,
  children,
}) => {
  void _song;

  return (
    <div
      className={cn(
        "relative w-full",
        bordered &&
          "rounded-[12px] border-[2.25px] sm:border-[3.75px] lg:border-[4.68px] border-[#2A3640] overflow-hidden",
        className,
      )}
    >
      {isGamePaused && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-[#12181C]/75 backdrop-blur-xs rounded-[inherit] p-4">
          <h2 className="font-semibold text-xl sm:text-3xl text-center">
            Game Paused
          </h2>
          <p className="text-sm text-muted-foreground text-center max-w-sm sm:max-w-md mx-auto">
            The game contract is currently paused for maintenance or updates.
            Please check back later.
          </p>
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-[#12181C]/75 backdrop-blur-xs rounded-[inherit]">
          {loadingContent ?? (
            <NewLoadingText
              isLoading={isLoading}
              className="text-sidebar-foreground font-semibold text-lg sm:text-xl text-center"
            />
          )}
        </div>
      )}

      {children}
    </div>
  );
};

export default FluidGameWindow;
