// SNAPSHOT-TRIMMED for standalone repo — canonical version lives in ape-church. DO NOT bring this file back; see TRANSITION notes.
//
// The real modal (all-time subgraph leaderboard + weekly Supabase panel +
// promotions panel, react-query, viem, the components/games/leaderboard/*
// subcomponent stack) stays in ape-church. Stuntman Chris v1 is off-chain with
// a placeholder `gameAddress`, so the leaderboard has nothing to show — this
// stub keeps the import and the props contract intact and renders null.
"use client";

import React from "react";

interface GameLeaderboardModalProps {
  gameAddress: string;
  gameName: string;
  /** Game id used to surface an active promo (see lib/constants/promos). */
  gameId?: number;
}

export function GameLeaderboardModal(_props: GameLeaderboardModalProps): React.ReactElement | null {
  return null;
}
