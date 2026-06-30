import type { AuctionSale, SaleMedia } from "./types";

const STRONG_NON_PROPERTY_IMAGE_PATTERN =
  /(^|[/_.-])(avatar|brand|default|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)/i;
const NON_IMAGE_EXTENSION_PATTERN = /\.(pdf|docx?|svg)([?#].*)?$/i;

export function firstPropertyImage(media: AuctionSale["media"]): string | null {
  return propertyImages(media)[0]?.url ?? null;
}

export function propertyImages(media: AuctionSale["media"] | undefined): SaleMedia[] {
  if (!Array.isArray(media)) return [];

  const seen = new Set<string>();
  return media.filter((item): item is SaleMedia => {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!isLikelyPropertyImageUrl(url) || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
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

  return shortestSide < 180 || longestSide < 320 || aspectRatio > 4;
}
