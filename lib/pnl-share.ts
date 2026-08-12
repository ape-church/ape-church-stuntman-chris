/**
 * Public URL for a PnL share image in Supabase: `{slug}/{replayId}.png` so replay ids
 * cannot collide across different games.
 */

const bucket =
  process.env.SUPABASE_PNL_SHARE_BUCKET ?? process.env.NEXT_PUBLIC_SUPABASE_PNL_SHARE_BUCKET ?? "pnl-share";

/** Normalize route segment (e.g. from `/games/roulette`) for storage keys. */
export function sanitizePnlGameSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

/**
 * Object path inside the bucket (no leading slash).
 * Returns "" if slug or id is invalid after sanitizing.
 */
export function getPnlShareStoragePath(gameSlug: string, gameId: string): string {
  const slug = sanitizePnlGameSlug(gameSlug);
  const safeId = gameId.replace(/\D/g, "");
  if (!slug || !safeId) {
    return "";
  }
  return `${slug}/${safeId}.png`;
}

/**
 * Full public HTTPS URL for the PnL PNG for this game slug + on-chain replay id.
 */
export function getPnlSharePublicImageUrl(gameSlug: string, gameId: string): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const path = getPnlShareStoragePath(gameSlug, gameId);
  if (!supabaseUrl || !path) {
    return "";
  }
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
}

/**
 * Legacy path before slug namespacing: `{replayId}.png` at bucket root.
 * Used only as an OG image fallback for older uploads.
 */
export function getLegacyPnlSharePublicImageUrl(gameId: string): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const safeId = gameId.replace(/\D/g, "");
  if (!supabaseUrl || !safeId) {
    return "";
  }
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${safeId}.png`;
}
