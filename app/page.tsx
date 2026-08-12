import { redirect } from "next/navigation";

/**
 * This repo exists to build one game. The root just sends you to it — the real
 * page is app/games/stuntman-chris/page.tsx, at the same route it occupies in
 * ape-church so the whole folder copies back unchanged.
 */
export default function RootPage() {
  redirect("/games/stuntman-chris");
}
