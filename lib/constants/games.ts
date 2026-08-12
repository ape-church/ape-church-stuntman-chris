// SNAPSHOT-TRIMMED for standalone repo — canonical version lives in ape-church. DO NOT bring this file back; see TRANSITION notes.
//
// Minimal slice of ape-church's lib/constants/games.ts: the `Game` /
// `SimpleGame` types and the single `stuntmanChrisGame` entry, copied verbatim.
// The full catalog (~2500 lines, ~45 games, contract-address imports) stays in
// ape-church.

export interface Game {
  id: number;
  title: string;
  description: string;
  type:
  | "slots"
  | "plinko"
  | "baccarat"
  | "hilo"
  | "roulette"
  | "mines"
  | "wheel"
  | "keno"
  | "cash-dash"
  | "blackjack"
  | "ape-strong"
  | "gimboz-smash"
  | "monkey-match"
  | "horse-racing"
  | "street-looker";
  url: string;
  card: string;
  banner: string;
  gameBackground: string;
  playButton: string;
  themeColorBackground: string;
  themeColorText: string;
  song?: string; // Optional song for the game
  opacity?: string;
  animatedBackground?: string;
}

export interface SimpleGame extends Game {
  gameAddress: string;
}

// Stuntman Chris — pixel-art launch-and-fly distance game (Toss the Turtle /
// Learn to Fly genre). v1 is an OFF-CHAIN visual test build: dummy RNG flight
// plans, no bets, no APE/GP, reachable by direct link only. `type` is a
// category hint; crash/arcade-shaped games use "plinko" here.
export const stuntmanChrisGame: SimpleGame = {
  id: 42,
  title: "Stuntman Chris",
  description:
    "Charge the throttle, hit the electrified UFO ramp and fly for distance — bounce off wrecks, grab moonboots and dodge the lasers for as long as you can.",
  type: "plinko",
  url: "/games/stuntman-chris",
  // TODO: swap to real card/banner art once the brand assets land.
  card: "/images/games/stuntman-chris/startscreen-1.webp",
  banner: "/images/games/stuntman-chris/startscreen-1.webp",
  gameBackground: "/images/games/stuntman-chris/background-dusk.webp",
  playButton: "",
  themeColorBackground: "#2B1D5C",
  themeColorText: "#FFFFFF",
  // TODO: replace placeholder address once the stuntman chris contract is deployed.
  gameAddress: "0x0000000000000000000000000000000000000004",
};
