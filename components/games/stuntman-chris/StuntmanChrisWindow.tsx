"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { RendererHandle, StuntAssets, StuntEngine } from "./lib/types";

interface StuntmanChrisWindowProps {
  /** Engine instance owned by the orchestrator. Null until it finishes its
   *  dynamic import — the renderer simply doesn't mount until then. */
  engine: StuntEngine | null;
  /** Extra classes for the box. Used by the HUD layout to trade the intrinsic
   *  16:9 aspect for "fill the stage" on lg (the stage itself is 16:9 there). */
  className?: string;
  /** Asset-loader progress, forwarded to the preload overlay's bar. */
  onAssetProgress?: (loaded: number, total: number) => void;
  /** Fired once every sheet is decoded and the renderer is live. */
  onAssetsReady?: () => void;
  /** Fired if the loader or the renderer blows up (overlay stops blocking). */
  onAssetError?: (error: unknown) => void;
}

/**
 * The imperative canvas renderer mounted as a React island (GhostMachineWindow
 * pattern).
 *
 * The renderer module — and with it the whole sprite pipeline — is pulled in
 * with a dynamic `import()` inside the effect so nothing touches `window`,
 * `Image` or a canvas during SSR. The renderer owns the rAF loop: each frame it
 * calls `engine.tick(now)` and draws the scene. React state is never written
 * per frame; the orchestrator's HUD reads `engine.state` through refs.
 *
 * The box is a plain aspect-ratio container (16:9, the scene's design space —
 * see DESIGN_W/DESIGN_H in lib/types.ts) so the window height follows the page
 * width on every breakpoint; on lg the HUD hands it a definite height instead
 * (`lg:h-full` into a 16:9 stage) via `className`. Either way the renderer
 * observes the host and letterbox-fits its internal 1920x1080 buffer, so an
 * off-ratio box degrades to bars rather than distortion. `touch-manipulation`
 * keeps hold-to-charge from triggering double-tap zoom on mobile.
 *
 * Teardown races the async import exactly like GhostMachineWindow: a `disposed`
 * flag is checked after every await, and if the component unmounted while the
 * chunk / assets were in flight we dispose immediately instead of leaking a
 * rAF loop into a detached container.
 */
export default function StuntmanChrisWindow({
  engine,
  className,
  onAssetProgress,
  onAssetsReady,
  onAssetError,
}: StuntmanChrisWindowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<RendererHandle | null>(null);

  // Callbacks live in a ref so a parent re-render (new inline closures) can't
  // tear down and re-create the renderer.
  const cbRef = useRef({ onAssetProgress, onAssetsReady, onAssetError });
  cbRef.current = { onAssetProgress, onAssetsReady, onAssetError };

  useEffect(() => {
    if (!engine) return;
    let disposed = false;

    (async () => {
      try {
        const { createRenderer, loadStuntAssets } = await import(
          "./lib/render/renderer"
        );
        if (disposed) return;

        const assets: StuntAssets = await loadStuntAssets(
          (loaded: number, total: number) => {
            if (disposed) return;
            cbRef.current.onAssetProgress?.(loaded, total);
          },
        );
        if (disposed || !containerRef.current) return;

        rendererRef.current = createRenderer({
          container: containerRef.current,
          engine,
          assets,
        });
        cbRef.current.onAssetsReady?.();
      } catch (error) {
        if (disposed) return;
        console.error("[stuntman-chris] renderer init failed", error);
        cbRef.current.onAssetError?.(error);
      }
    })();

    return () => {
      disposed = true;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [engine]);

  return (
    // Classes, not inline styles: an inline `aspectRatio` would beat every
    // `lg:` utility, and the HUD layout needs to override it (GAME-HUD.md §3).
    <div
      className={cn(
        "relative w-full aspect-[16/9] overflow-hidden bg-[#0b0619] touch-manipulation",
        className,
      )}
    >
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
