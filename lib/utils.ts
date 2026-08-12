// SNAPSHOT-TRIMMED for standalone repo — canonical version lives in ape-church. DO NOT bring this file back; see TRANSITION notes.
//
// Minimal snapshot of ape-church's lib/utils.ts. Only `cn` is reachable from
// the ported Stuntman Chris code; the rest of the real module (game-catalog
// lookups, referral storage, Gimboz metadata fetchers, formatters) pulls in the
// 2500-line games catalog + viem + the referral stack and is deliberately
// omitted here.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
