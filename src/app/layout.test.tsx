import { describe, expect, it, vi } from "vitest";

const fonts = vi.hoisted(() => ({ cormorant: vi.fn(), plex: vi.fn() }));

vi.mock("next/font/google", () => ({
  Cormorant_Garamond: (options: unknown) => {
    fonts.cormorant(options);
    return { variable: "font-cormorant" };
  },
  IBM_Plex_Sans: (options: unknown) => {
    fonts.plex(options);
    return { variable: "font-plex" };
  },
}));
vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("@vercel/analytics/next", () => ({ Analytics: () => null }));
vi.mock("@vercel/speed-insights/next", () => ({ SpeedInsights: () => null }));
vi.mock("./providers", () => ({ AppProviders: () => null }));
vi.mock("@/components/SkipLink", () => ({ SkipLink: () => null }));
vi.mock("./../styles.css", () => ({}));

import { metadata } from "./layout";

describe("root layout metadata", () => {
  it("does not give every page the home page as its Open Graph address", () => {
    // The object is inherited by every page that does not declare its own `openGraph`.
    expect(metadata.openGraph).toBeDefined();
    expect(metadata.openGraph).not.toHaveProperty("url");
    expect(metadata.openGraph).toMatchObject({ siteName: "Immojudis", locale: "fr_FR" });
  });

  it("preloads the display font used by the home heading", () => {
    expect(fonts.cormorant).toHaveBeenCalledWith(
      expect.objectContaining({ preload: true, variable: "--font-cormorant-garamond" }),
    );
  });
});
