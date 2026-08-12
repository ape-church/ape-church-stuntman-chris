import type { Metadata } from "next";
import {
  getLegacyPnlSharePublicImageUrl,
  getPnlSharePublicImageUrl,
  sanitizePnlGameSlug,
} from "@/lib/pnl-share";

type SearchParamsInput = Promise<Record<string, string | string[] | undefined>>;

function getIdFromSearchParams(
  sp: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = sp.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || !/^\d+$/.test(id)) {
    return undefined;
  }
  return id;
}

/**
 * When `?id=` is a numeric game replay id, attach Open Graph / Twitter image
 * pointing at the uploaded PnL PNG in Supabase (if present).
 */
export async function mergeGameReplayMetadata(
  base: Metadata,
  searchParams: SearchParamsInput,
  gamePath: string,
): Promise<Metadata> {
  const sp = await searchParams;
  const id = getIdFromSearchParams(sp);
  if (!id) {
    return base;
  }

  const rawSlug = gamePath.replace(/^\/games\//, "").split("/")[0] ?? "";
  const gameSlug = sanitizePnlGameSlug(rawSlug);
  const ogImageUrl = gameSlug ? getPnlSharePublicImageUrl(gameSlug, id) : "";
  const legacyOgImageUrl = getLegacyPnlSharePublicImageUrl(id);

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.ape.church";
  const canonicalUrl = `${siteUrl}${gamePath}?id=${encodeURIComponent(id)}`;
  const defaultOgImageUrl = `${siteUrl}/opengraph-image.png`;

  const titleFromBase =
    (typeof base.title === "string" && base.title) ||
    (typeof base.openGraph?.title === "string" && base.openGraph.title) ||
    "Ape Church";

  const descriptionFromBase =
    (typeof base.description === "string" && base.description) ||
    (typeof base.openGraph?.description === "string" && base.openGraph.description) ||
    "";

  let previewImageUrl = defaultOgImageUrl;
  const headOk = async (url: string) => {
    try {
      const head = await fetch(url, { method: "HEAD", next: { revalidate: 120 } });
      return head.ok;
    } catch {
      return false;
    }
  };
  if (ogImageUrl && (await headOk(ogImageUrl))) {
    previewImageUrl = ogImageUrl;
  } else if (legacyOgImageUrl && (await headOk(legacyOgImageUrl))) {
    previewImageUrl = legacyOgImageUrl;
  }

  return {
    ...base,
    openGraph: {
      ...base.openGraph,
      title: `${titleFromBase} — replay`,
      description: descriptionFromBase,
      url: canonicalUrl,
      type: "website",
      images: [
        {
          url: previewImageUrl,
          width: 1320,
          height: 742,
          alt: `${titleFromBase} PnL`,
        },
      ],
    },
    twitter: {
      ...base.twitter,
      card: "summary_large_image",
      title: `${titleFromBase} — replay`,
      description: descriptionFromBase,
      images: [previewImageUrl],
    },
  };
}
