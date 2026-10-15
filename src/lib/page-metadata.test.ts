import { describe, expect, it } from "vitest";
import { DEFAULT_SHARE_IMAGE, pageMetadata } from "./page-metadata";

describe("pageMetadata", () => {
  const metadata = pageMetadata({
    path: "/a-propos",
    title: "À propos",
    description: "Une description.",
  });

  it("sets the canonical address, the Open Graph card and the Twitter card", () => {
    expect(metadata.title).toBe("À propos");
    expect(metadata.description).toBe("Une description.");
    expect(metadata.alternates).toEqual({ canonical: "/a-propos" });
    expect(metadata.openGraph).toMatchObject({
      title: "À propos",
      description: "Une description.",
      type: "website",
      url: "/a-propos",
      siteName: "Immojudis",
      locale: "fr_FR",
      images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Immojudis" }],
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "À propos",
      description: "Une description.",
      images: ["/opengraph-image"],
    });
  });

  it("never puts the site-name suffix of the layout template in the share titles", () => {
    expect(JSON.stringify(metadata.openGraph)).not.toContain(" - Immojudis");
  });

  it("uses an absolute title as is, for the page and for the shares", () => {
    const absolute = pageMetadata({
      path: "/guide",
      title: { absolute: "Guide complet" },
      description: "d",
    });
    expect(absolute.title).toEqual({ absolute: "Guide complet" });
    expect(absolute.openGraph).toMatchObject({ title: "Guide complet" });
    expect(absolute.twitter).toMatchObject({ title: "Guide complet" });
  });

  it("takes a page-specific image with its dimensions", () => {
    const image = { url: "/media/x.webp", width: 800, height: 400, alt: "X" };
    const custom = pageMetadata({ path: "/x", title: "X", description: "d", image });
    expect(custom.openGraph).toMatchObject({ images: [image] });
    expect(custom.twitter).toMatchObject({ images: ["/media/x.webp"] });
  });

  it("does not share the default image object between pages", () => {
    const first = pageMetadata({ path: "/1", title: "1", description: "d" });
    const images = (first.openGraph as { images: Array<Record<string, unknown>> }).images;
    images[0].url = "/changed";
    expect(DEFAULT_SHARE_IMAGE.url).toBe("/opengraph-image");
  });
});
