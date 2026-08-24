import { describe, expect, it } from "vitest";
import {
  isLikelyPropertyImageUrl,
  propertyImageUrlScore,
  propertyImages,
  shouldRejectRenderedPropertyImage,
} from "@/lib/sale-media";

describe("sale media selection", () => {
  it("rejects obvious branding and banner assets", () => {
    expect(isLikelyPropertyImageUrl("https://example.test/assets/logos/cabinet.png")).toBe(false);
    expect(isLikelyPropertyImageUrl("https://example.test/media/banner-home.webp")).toBe(false);
    expect(isLikelyPropertyImageUrl("https://example.test/photos/maison.webp")).toBe(true);
  });

  it("ranks original property photos ahead of thumbnails while keeping stable order", () => {
    const media = [
      { type: "image" as const, url: "https://example.test/thumb/sale-small.jpg" },
      { type: "image" as const, url: "https://example.test/photo/original-maison.jpg?w=1200" },
      { type: "image" as const, url: "https://example.test/gallery/interieur.jpg" },
    ];

    expect(propertyImages(media).map((item) => item.url)).toEqual([
      "https://example.test/photo/original-maison.jpg?w=1200",
      "https://example.test/gallery/interieur.jpg",
      "https://example.test/thumb/sale-small.jpg",
    ]);
    expect(propertyImageUrlScore(media[1].url)).toBeGreaterThan(
      propertyImageUrlScore(media[0].url),
    );
  });

  it("rejects low-resolution and extreme-aspect rendered images", () => {
    expect(
      shouldRejectRenderedPropertyImage({
        naturalWidth: 320,
        naturalHeight: 180,
      } as HTMLImageElement),
    ).toBe(true);
    expect(
      shouldRejectRenderedPropertyImage({
        naturalWidth: 1200,
        naturalHeight: 240,
      } as HTMLImageElement),
    ).toBe(true);
    expect(
      shouldRejectRenderedPropertyImage({
        naturalWidth: 1200,
        naturalHeight: 800,
      } as HTMLImageElement),
    ).toBe(false);
  });
});
