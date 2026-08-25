import type { AuctionSale, SaleMedia } from "./types";

const STRONG_NON_PROPERTY_IMAGE_PATTERN =
  /(^|[/_.-])(avatar|banner|banniere|brand|default|favicon|icon|icone|logo|logos|placeholder|profile|sprite|user)([/_.-]|$)/i;
const NON_IMAGE_EXTENSION_PATTERN = /\.(pdf|docx?|svg)([?#].*)?$/i;
const POSITIVE_PROPERTY_IMAGE_PATTERN =
  /(^|[/_.-])(annonce|bien|gallery|galerie|hd|house|image|immobilier|large|media|original|photo|property|upload)([/_.-]|$)/i;
const LOW_RESOLUTION_IMAGE_PATTERN =
  /(^|[/_.-])(low|mini|small|thumb|thumbnail)([/_.-]|$)|[?&](?:h|height|w|width)=(?:[1-3]?\d{1,2})(?:&|$)/i;

export function firstPropertyImage(media: AuctionSale["media"]): string | null {
  return propertyImages(media)[0]?.url ?? null;
}

export function propertyImages(media: AuctionSale["media"] | undefined): SaleMedia[] {
  if (!Array.isArray(media)) return [];

  const seen = new Set<string>();
  return media
    .filter((item): item is SaleMedia => {
      const url = typeof item?.url === "string" ? item.url.trim() : "";
      if (!isLikelyPropertyImageUrl(url) || seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .map((item, index) => ({ item, index, score: propertyImageUrlScore(item.url) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item);
}

export function isLikelyPropertyImageUrl(url: string | null | undefined): url is string {
  if (!url || !/^https?:\/\//i.test(url)) return false;

  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    const searchable = `${parsed.hostname}${path}`.toLowerCase();

    if (NON_IMAGE_EXTENSION_PATTERN.test(path)) return false;
    if (STRONG_NON_PROPERTY_IMAGE_PATTERN.test(searchable)) return false;

    return true;
  } catch {
    return false;
  }
}

export function shouldRejectRenderedPropertyImage(image: HTMLImageElement) {
  const { naturalWidth, naturalHeight } = image;
  if (!naturalWidth || !naturalHeight) return false;

  const shortestSide = Math.min(naturalWidth, naturalHeight);
  const longestSide = Math.max(naturalWidth, naturalHeight);
  const aspectRatio = longestSide / shortestSide;

  return shortestSide < 300 || longestSide < 480 || aspectRatio > 3.2;
}

export function propertyImageUrlScore(url: string): number {
  let score = 0;
  if (POSITIVE_PROPERTY_IMAGE_PATTERN.test(url)) score += 20;
  if (LOW_RESOLUTION_IMAGE_PATTERN.test(url)) score -= 35;

  try {
    const parsed = new URL(url);
    for (const key of ["w", "width", "h", "height"]) {
      const dimension = Number(parsed.searchParams.get(key));
      if (dimension >= 800) score += 8;
    }
  } catch {
    return score;
  }

  return score;
}
