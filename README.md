# Stuntman Chris

Standalone development repo for **Stuntman Chris**, a game extracted from the [Ape Church](https://ape.church) platform so it can be polished outside the main application.

The game already runs live at `ape.church/games/stuntman-chris` (direct link only — it is not in the public game catalog yet). This repo is a minimal Next.js host containing that game, its assets, its build tooling and just enough of the platform's shared UI to make it render exactly as it does in production.

**The copy in the platform repo is frozen.** All work happens here. When the game is polished it goes back to the platform as a folder copy — which is why the file layout, paths and import specifiers in this repo must not change. See [`TRANSITION.md`](./TRANSITION.md) for the full extraction record and the re-integration contract.

---

## Quickstart

```bash
npm install
npm run dev
```

Open `http://localhost:3000` — the root route 307-redirects to `/games/stuntman-chris`, which is the real page.

Other scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build (must pass before handing work back) |
| `npm start` | Serve the production build |
| `npm run test:engine` | Engine conformance test — see below |
| `npm run assets:stuntman` | Regenerate runtime art from the raw drop — see below |
| `npx tsc --noEmit` | Type check. Must stay clean. |

`npm run lint` exists but the platform's eslint flat config has a pre-existing crash, so **`npx tsc --noEmit` is the verification gate**, not eslint.

---

## Repo map

### Your canvas — edit freely

```
components/games/stuntman-chris/
  StuntmanChris.tsx               # client orchestrator: phases, HUD, result overlay
  StuntmanChrisWindow.tsx         # canvas host: sizing, DPR, rAF loop, engine/renderer wiring
  StuntmanChrisSetupCard.tsx      # the HUD left panel
  StuntmanChrisTitleOverlay.tsx   # title screen (start-screen.mp4 + logo)
  StuntmanChrisPreloadOverlay.tsx # blocking asset preloader
  stuntman-chris.css              # all game styling, namespaced under .stuntman-chris
  lib/
    types.ts                      # the layer contract between engine / renderer / UI
    assets.generated.ts           # GENERATED — do not hand-edit, see asset pipeline
    engine/{engine,flightPlan,tuning}.ts
    render/{renderer,sprites,layers}.ts

app/games/stuntman-chris/page.tsx      # the route (thin server component)
public/images/games/stuntman-chris/**  # runtime assets (34 files, ~6.7MB)
scripts/build-stuntman-chris-assets.ts # asset pipeline
scripts/test-stuntman-engine.ts        # engine conformance test
docs/stuntman-chris-plan.md            # architecture + module contract — READ THIS
```

### Verbatim platform modules — don't edit unless you must

These are byte-identical copies of files that live in the platform repo. They work as-is. If you genuinely need a change, make it small and obvious and flag it in your handback notes — a platform engineer has to merge it by hand.

```
components/games/shared/GameHud.tsx
components/games/shared/GameHudPage.tsx
components/loading/NewLoadingText.tsx
components/ui/card.tsx
hooks/use-mini-embed.ts
lib/game-replay-metadata.ts
lib/pnl-share.ts
app/fonts/Nohemi/Variable-TT/Nohemi-VF.ttf
```

### SNAPSHOT-TRIMMED files — never edit

Four files are cut-down stand-ins for much larger platform modules. Each carries a `SNAPSHOT-TRIMMED` header comment. On re-integration they are **thrown away** and the real platform versions take over, so any change you make here is lost.

| File | What was cut | What it means for you |
|---|---|---|
| `components/games/shared/FluidGameWindow.tsx` | i18n + `useGameMusic` (Howler) | The `song` prop still exists on the props type but is **inert**. Paused-overlay strings are inlined English. |
| `components/games/GameLeaderboardModal.tsx` | The whole modal | Renders `null`. The game imports it and passes props; that's the contract. Leave it. |
| `lib/utils.ts` | Everything but `cn` | Only `cn` is available. Don't reach for other helpers. |
| `lib/constants/games.ts` | The ~2500-line game catalog | Only the `Game` / `SimpleGame` types and the `stuntmanChrisGame` entry. |

`SKILL.md` is the generic Ape Church game-template agent guide that shipped with the seed. Parts of it (the `my-game` / `components/shared` paths, the submissions flow) do not apply to this repo — this README and `TRANSITION.md` win where they disagree.

---

## Architecture

Read **[`docs/stuntman-chris-plan.md`](./docs/stuntman-chris-plan.md)** before touching engine or renderer code. The short version:

**Outcome-first, playback-second.** `generateFlightPlan(rng, params) → FlightPlan` is a pure function that decides the whole run up front: `finalDistance`, `endCause`, and a list of events keyed by world distance (bounces, laser misses/hits, skeletons, bone hits, moonboots). v1 feeds it `Math.random`; the on-chain version will feed it VRF-derived values and nothing else changes.

The **engine** (`lib/engine/`, pure TS, no React or DOM) then simulates kinematics that *exactly realize* that plan — piecewise ballistic arcs, scripted bounces, death at the scripted point, glide-out landing at `finalDistance`. The plan is authoritative; physics is presentation. The engine also owns which Chris animation is playing.

The **renderer** (`lib/render/`, canvas 2D at a fixed 1920×1080 internal resolution, letterboxed) just draws whatever `EngineState` says each frame — parallax layers, sprite sheets, world objects. It holds no game truth.

`lib/types.ts` is the contract between those three layers. Changing it means changing all of them.

**Layout:** the game sits in the platform's Game HUD frame. **[`docs/GAME-HUD.md`](./docs/GAME-HUD.md)** is the binding spec — the important rule is that the stage is *not* a fixed shape (roughly 0.9:1 to 1.9:1), so size things with `%`, `cqw`/`cqh`/`cqmin`, `fr` and `aspect-*`, and **never `vw`/`vh`**, which measure the viewport and diverge badly inside the HUD.

---

## Asset pipeline

Runtime art in `public/images/games/stuntman-chris/` is **generated**, along with the sprite-sheet manifest `components/games/stuntman-chris/lib/assets.generated.ts`. The source is a 1.8GB folder of raw renders (`public/images/games/meebel-knievel/`, 827 files) which is **gitignored and delivered to you separately** — zip/drive, not git. Drop it at exactly that path.

```bash
npm run assets:stuntman     # requires ffmpeg on PATH
```

This crops, trims, packs and compresses the raw renders into the runtime WebP sheets and rewrites `assets.generated.ts` with the frame grids and trim offsets.

- Don't hand-edit `assets.generated.ts` — change the pipeline or the raw art and re-run.
- Don't move assets out of `public/images/games/stuntman-chris/`; the path is baked into the platform.
- If you change art, commit the regenerated runtime assets *and* the regenerated manifest together.

---

## Engine conformance test

```bash
npm run test:engine                            # default run
npx tsx scripts/test-stuntman-engine.ts 25     # 25 seeds → 300 runs, ~1.35M assertions
```

It asserts the engine actually realizes the flight plan: the run ends at the planned distance, with the planned cause, having fired the planned events in order. **Run it after any change to `lib/engine/engine.ts`, `flightPlan.ts` or `tuning.ts`** — tuning changes in particular are exactly the thing that silently breaks plan conformance.

Last known state: `25` seeds → PASS, 300 runs, 1,353,052 assertions.

---

## Hard rules for re-integration

This code goes back into the platform as a **folder copy over the existing paths**. Break these and the merge stops being a copy and starts being a project.

1. **Keep paths exactly as they are.** No renaming the game folder, no moving files, no restructuring `lib/engine` or `lib/render`.
2. **Keep import specifiers exactly as they are.** `@/components/games/shared/...`, `@/lib/utils`, `@/lib/constants/games` and friends all resolve to real (much bigger) modules on the other side.
3. **Assets stay under `public/images/games/stuntman-chris/`.**
4. **Don't add npm dependencies** without checking the package already exists in the platform repo at a compatible version. A new dep is a platform-side decision, not a copy. If you truly need one, flag it loudly in your handback notes.
5. **Don't edit the four SNAPSHOT-TRIMMED files.** They are replaced on the way back.
6. **Keep the game working with the inert `song` prop and the null leaderboard stub.** Don't build features that assume those do something here — on the platform side they do, and that's where they get wired.
7. **`npx tsc --noEmit` must stay clean** and `npm run build` must pass.
8. Keep the repo LF-normalized (`.gitattributes` handles this) so the bring-back diff shows real changes, not line endings.

---

## Support

- **Email:** [ministry@ape.church](mailto:ministry@ape.church)
- **Telegram:** [https://t.me/+wgoE4TSxxcM5Njdh](https://t.me/+wgoE4TSxxcM5Njdh)
- **Discord:** [https://discord.gg/3Jxeeqt59W](https://discord.gg/3Jxeeqt59W)
- **Platform game-builder docs:** [docs.ape.church/building/build-a-game](https://docs.ape.church/building/build-a-game)
