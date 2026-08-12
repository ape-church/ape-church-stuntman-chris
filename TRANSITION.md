# TRANSITION — extraction record & re-integration contract

**Game:** Stuntman Chris (off-chain v1, GAME_ID 42)
**Extracted from:** `ape-church` (the live platform repo), branch `develop`
**Extracted on:** 2026-08-12
**This repo:** `ape-church-stuntman-chris`, branch `main`

This document is the authoritative record of what was pulled out of the platform, what was changed on the way, and exactly how it goes back. Read it before the first bring-back.

---

## 1. Why this repo exists

Stuntman Chris is live at `ape.church/games/stuntman-chris` but is **not in the public catalog** — its `GameSummaries` entry in `lib/constants/games.ts` (around line 2452) is commented out, so the game is reachable by direct link only. It needs polish, and that polish is being done by a team that should not have access to the platform repo.

So the game was lifted, verbatim, into this standalone repo:

- The platform copy is **frozen**. Nobody edits `components/games/stuntman-chris/**` in `ape-church` while this repo is active.
- All development happens here.
- Bring-back is a **folder copy over identical paths**, not a merge. Every path and import specifier in this repo matches its platform counterpart byte for byte, on purpose.

Nothing was deleted from `ape-church`. The game there still builds, still routes, still runs.

---

## 2. What was ported, and how

### 2a. Verbatim — the game itself

Byte-identical copies at byte-identical paths. These are the files that come back.

| Path | Files | Notes |
|---|---|---|
| `components/games/stuntman-chris/**` | 14 | 5 components + `stuntman-chris.css` + `lib/types.ts` + `lib/assets.generated.ts` + `lib/engine/{engine,flightPlan,tuning}.ts` + `lib/render/{layers,renderer,sprites}.ts` |
| `app/games/stuntman-chris/page.tsx` | 1 | The route |
| `public/images/games/stuntman-chris/**` | 34 | Runtime assets, ~6.7MB |
| `scripts/build-stuntman-chris-assets.ts` | 1 | Asset pipeline |
| `scripts/test-stuntman-engine.ts` | 1 | Engine conformance test |
| `docs/stuntman-chris-plan.md` | 1 | Architecture + module contract |

### 2b. Verbatim — shared platform modules

Copied unchanged so the game renders identically. They are **not normally copied back** — the canonical copies in `ape-church` are the same files. Only merge one back if it was intentionally changed here, and then merge it by hand after a diff.

| Path | Why it's here |
|---|---|
| `components/games/shared/GameHud.tsx` | The HUD frame the game renders in |
| `components/games/shared/GameHudPage.tsx` | Page shell for a HUD game |
| `components/loading/NewLoadingText.tsx` | Loading text used by `FluidGameWindow` |
| `components/ui/card.tsx` | Used by the setup card |
| `hooks/use-mini-embed.ts` | Mini-window embed detection |
| `lib/game-replay-metadata.ts` | Imported by the game shell |
| `lib/pnl-share.ts` | Imported by the game shell |
| `app/fonts/Nohemi/Variable-TT/Nohemi-VF.ttf` | `--font-heading`, load-bearing for `--sc-display` in `stuntman-chris.css` |

### 2c. SNAPSHOT-TRIMMED — must NEVER be copied back

Four platform modules were too heavy to bring whole (they drag in i18n, the full games catalog, viem, react-query, the referral stack, the leaderboard/promotions component tree). Each was replaced by a minimal snapshot carrying a `SNAPSHOT-TRIMMED` header comment naming what was cut.

**The canonical versions live in `ape-church`. These four files are discarded on bring-back.**

| Path | Trimmed to | Consequence in this repo |
|---|---|---|
| `components/games/shared/FluidGameWindow.tsx` | i18n (`@/lib/i18n`) and `useGameMusic`/Howler stripped; the two paused-overlay strings inlined as their English literals from `lib/i18n/dictionaries/en/gamesSharedUi.ts` | The `song` prop is **kept in the props type** so call sites typecheck, but it does nothing. Stuntman Chris never passes it (no audio in v1). |
| `components/games/GameLeaderboardModal.tsx` | Null-render stub | The real modal (all-time subgraph leaderboard + weekly Supabase panel + promotions panel + `components/games/leaderboard/*`) stays in `ape-church`. v1 is off-chain with a placeholder `gameAddress`, so there is nothing to show. Import and props contract preserved. |
| `lib/utils.ts` | `cn` only | The real module pulls in the games catalog, viem, referral storage, Gimboz metadata fetchers and formatters. Only `cn` is reachable from ported code. |
| `lib/constants/games.ts` | `Game` / `SimpleGame` types + the `stuntmanChrisGame` const (copied verbatim) | The ~2500-line catalog with ~45 games and contract-address imports stays in `ape-church`. |

### 2d. App wiring added in this repo (does not come back)

- `app/page.tsx` — 307-redirects `/` to `/games/stuntman-chris`. Repo-local convenience only.
- `app/layout.tsx` — uses ape-church's font trio: Roboto → `--font-body`, local `Nohemi-VF` → `--font-heading`, Orbitron → `--font-orbitron`. **Load-bearing**: `stuntman-chris.css` reads `--sc-display` off these.
- `app/globals.css` — gained a section marked *"Ported from ape-church globals.css for the Game HUD"*: `--shadow-card` / `--shadow-lifted` tokens and the `.shadow-ds-card` / `.shadow-ds-lifted` / `.tabular-amount` utilities. The template's `--game-hud-stage-*` values were already identical to ape-church's, so nothing there needed changing.
- `.gitignore` — added `public/images/games/meebel-knievel/` (the raw art drop).

### 2e. Package changes

- devDependencies added: `sharp` `^0.34.5`, `tsx` `^4.21.0` (both required by the asset pipeline / engine test).
- scripts added: `assets:stuntman` → `tsx scripts/build-stuntman-chris-assets.ts`, `test:engine` → `tsx scripts/test-stuntman-engine.ts`.

No runtime dependencies were added. **Any new runtime dependency introduced here is a bring-back blocker** until it is confirmed present in `ape-church` at a compatible version.

---

## 3. What was removed from the template

This repo was seeded from `ape-church-game-template`. The template's example game and its shared-component set were deleted in the port commit. They are preserved in the seed commit `060382b` if anything needs to be recovered.

Removed:

```
components/my-game/         (MyGame, MyGameWindow, MyGameSetupCard, MyGameInGameOverlay, myGameConfig)
components/shared/          (GameHud, GameHudPage, GameWindow, WideGameWindow, GameResultsModal,
                             BetAmountInput, CustomSlider, ChipSelection, SpriteAnimation)
public/my-game/
public/shared/
lib/games.ts
```

Note the platform uses `components/games/shared/`, not `components/shared/` — that's why the template's copies went and ape-church's came in at the platform path.

`SKILL.md` was kept as-is. It is the template's generic agent guide and is stale in places (it still describes `components/my-game/` and the submissions flow); README.md and this document override it.

---

## 4. What was deliberately left behind in ape-church

Nothing was deleted there. These references stay live in the platform repo and are **not** duplicated or maintained here:

- The frozen game folder, route and assets (identical to this repo's copies as of extraction).
- `lib/constants/games.ts` — the real `stuntmanChrisGame` entry (id 42) and the **commented-out `GameSummaries` block** at ~line 2452. That block is the catalog go-live switch.
- `.gitignore` — the `meebel-knievel` raw-art entry.
- `docs/stuntman-chris-plan.md` and the Stuntman Chris rows in `docs/GAME-HUD.md`.
- Both scripts (`build-stuntman-chris-assets.ts`, `test-stuntman-engine.ts`).
- The real `FluidGameWindow`, `GameLeaderboardModal`, `lib/utils.ts` and the full games catalog — see §2c.
- `docs/stuntman-chris-extraction.md` — the ape-church-side mirror of this document.

---

## 5. Bring-back procedure

For a platform engineer, working in `ape-church` on a branch off `develop`.

**Prep**

1. Confirm the standalone repo is green: `npx tsc --noEmit`, `npm run build`, `npm run test:engine` all pass there.
2. Diff `package.json` between the two repos. Confirm **no new runtime dependencies** were introduced in the standalone repo. If any were, decide consciously — add them to `ape-church` deliberately, or send the change back. Do not let a dep arrive as a side effect of a file copy.
3. Branch `ape-church` off `develop`.

**Copy**

4. Copy `components/games/stuntman-chris/**` over the ape-church folder. This is the bulk of the work and it is a straight overwrite — same paths, same import specifiers.
5. Copy `app/games/stuntman-chris/page.tsx` **only if it changed**.
6. Copy `public/images/games/stuntman-chris/**` over the ape-church folder. Delete any ape-church-side files the standalone repo no longer has (stale assets), and confirm the file count matches.
7. Copy `scripts/build-stuntman-chris-assets.ts` and `scripts/test-stuntman-engine.ts` **only if they changed**. If the raw art changed, run `npm run assets:stuntman` in ape-church (needs ffmpeg on PATH and the raw drop at `public/images/games/meebel-knievel/`) and commit the regenerated runtime assets *and* `lib/assets.generated.ts` together.
8. Copy `docs/stuntman-chris-plan.md` if it was updated.

**Do NOT copy**

9. **Never copy these four back** — the ape-church versions are canonical and much larger:
   - `components/games/shared/FluidGameWindow.tsx`
   - `components/games/GameLeaderboardModal.tsx`
   - `lib/utils.ts`
   - `lib/constants/games.ts`
10. Do not copy `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `.gitignore`, `package.json`, `README.md`, `TRANSITION.md`, `metadata.json`, `SKILL.md`, `next.config.ts`, `tsconfig.json` or `components.json`. All of them are repo-local scaffolding.

**Shared modules**

11. `diff` each verbatim shared module (§2b) against its ape-church counterpart. Expect zero changes. If a diff is non-empty, review it and merge **only intentional** changes by hand — these files are used by every other game on the platform, so a casual edit there is a platform-wide change.

**Verify in ape-church**

12. `npx tsc --noEmit` — must be clean. (Repo eslint has a pre-existing flat-config crash; tsc is the gate.)
13. `npx tsx scripts/test-stuntman-engine.ts 25` — expect PASS (300 runs, ~1.35M assertions).
14. `npm run build`, then load `/games/stuntman-chris` and play a full run: title → charge → launch → flight → each end cause → result overlay → play again.
15. Confirm the game still works with the real `FluidGameWindow` (i18n + `useGameMusic` are back — the `song` prop is now live) and the real `GameLeaderboardModal` (it renders for real now).

**Go-live switch (only when the game is ready for the public catalog)**

16. In `lib/constants/games.ts` (~line 2452) uncomment the `stuntmanChris` `GameSummaries` block and add the trailing comma to the `dojoDrop` entry above it. That puts the game on the hub, activity feed and leaderboards. Leave it commented until launch is actually intended.

**Housekeeping**

17. The raw `meebel-knievel/` art drop stays **gitignored** in both repos. Never commit it.
18. Update `docs/stuntman-chris-extraction.md` in ape-church to record that the bring-back happened and whether the freeze is lifted.

---

## 6. Line endings

This repo carries a root `.gitattributes` with:

```
* text=auto eol=lf
```

and the tree was normalized with `git add --renormalize .` at the time this document was written. `ape-church` content is LF in git as well.

**Why it matters:** development here happens on Windows. Without normalization, a round trip through a Windows checkout can rewrite every line of every file as CRLF, and the bring-back diff becomes 100% noise — every file "changed", real changes invisible. Keep `.gitattributes` in place and don't configure editors to force CRLF.

If you ever see a diff where whole files changed but nothing looks different, that's this. Check `git diff --stat` against `git diff --ignore-all-space --stat`.

---

## 7. Raw art transfer (out of band)

`public/images/games/meebel-knievel/` is the source art drop: **1.8GB, 827 files**. It is **gitignored in both repos** and must be transferred by zip / shared drive / file transfer — never through git (it would blow up the Vercel deploy and the PWA precache on the platform side).

It exists on disk in both repos on the extraction machine. The pipeline (`npm run assets:stuntman`) reads from it and regenerates:

- `public/images/games/stuntman-chris/**` (the runtime WebP sheets and backgrounds)
- `components/games/stuntman-chris/lib/assets.generated.ts` (frame grids, trim offsets, manifest)

If a team member has no raw drop they can still work on engine, renderer and UI — the runtime assets are committed. They just can't re-run the pipeline. `ffmpeg` must be on `PATH` for it to run.

---

## 8. Verification state at extraction

Recorded so a regression is attributable. All checks run in this repo:

- `npm install` — clean
- `npx tsc --noEmit` — clean
- `npm run build` — passing, route emitted as `ƒ /games/stuntman-chris`
- `npx tsx scripts/test-stuntman-engine.ts 25` — PASS, 300 runs, 1,353,052 assertions
- `next start` smoke test — 200 on the route and on assets

Commits: `060382b` template seed, `ff2f7c5` game port.
