"use client";

import { usePathname } from "next/navigation";

/**
 * True when rendering inside an /embed/[slug] page — the bare game view loaded
 * by the desktop mini-window iframes (see components/mini-games). Games and
 * shared shells use this to drop page-only extras that don't belong in a
 * ~380px floating window: background music and the history section.
 */
export function useIsMiniEmbed(): boolean {
  const pathname = usePathname();
  return pathname.startsWith("/embed");
}
