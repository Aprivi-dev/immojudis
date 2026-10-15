import type { Metadata } from "next";

/** Preview image shared by every page that has none of its own (`app/opengraph-image.tsx`). */
export const DEFAULT_SHARE_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Immojudis",
} as const;

export type ShareImage = {
  url: string;
  width: number;
  height: number;
  alt: string;
};

/**
 * Metadata of a public page: canonical address, Open Graph and Twitter card from one place.
 *
 * A page-level `openGraph` REPLACES the one of the root layout (it is not merged), so a page that
 * sets none would be shared without title, address or image. This factory always sets all of
 * them, with the image dimensions.
 *
 * - `path` is the canonical path of the page (relative: `metadataBase` of the layout makes it
 *   absolute), used for `alternates.canonical` and `openGraph.url`.
 * - `title` follows the layout template (" - Immojudis" is appended to the `<title>`); pass
 *   `{ absolute }` for a title that must be used as is. The Open Graph and Twitter titles never
 *   carry the suffix.
 * - Other keys (`robots`, …) are added by the caller on the returned object.
 */
export function pageMetadata({
  path,
  title,
  description,
  image = DEFAULT_SHARE_IMAGE,
}: {
  path: string;
  title: string | { absolute: string };
  description: string;
  image?: ShareImage;
}): Metadata {
  const shareTitle = typeof title === "string" ? title : title.absolute;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title: shareTitle,
      description,
      type: "website",
      url: path,
      siteName: "Immojudis",
      locale: "fr_FR",
      images: [{ ...image }],
    },
    twitter: {
      card: "summary_large_image",
      title: shareTitle,
      description,
      images: [image.url],
    },
  };
}
