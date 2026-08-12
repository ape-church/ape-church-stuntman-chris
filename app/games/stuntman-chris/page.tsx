import type { Metadata } from "next";
import { mergeGameReplayMetadata } from "@/lib/game-replay-metadata";
import { stuntmanChrisGame } from "@/lib/constants/games";
import StuntmanChris from "@/components/games/stuntman-chris/StuntmanChris";
import GameHudPage from "@/components/games/shared/GameHudPage";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}): Promise<Metadata> {
  return mergeGameReplayMetadata(
    {
      title: stuntmanChrisGame.title,
      description: stuntmanChrisGame.description,
    },
    searchParams,
    stuntmanChrisGame.url,
  );
}

const StuntmanChrisPage: React.FC = () => {
  return (
    <GameHudPage>
      {/* Title + leaderboard now live in the HUD bar (see GameHud). */}
      <StuntmanChris game={stuntmanChrisGame} />
    </GameHudPage>
  );
};

export default StuntmanChrisPage;
