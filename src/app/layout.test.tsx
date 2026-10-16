import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fonts = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("next/font/local", () => ({
  default: (options: Record<string, unknown>) => {
    fonts.calls.push(options);
    return { variable: String(options.variable) };
  },
}));
vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("@vercel/analytics/next", () => ({ Analytics: () => null }));
vi.mock("@vercel/speed-insights/next", () => ({ SpeedInsights: () => null }));
vi.mock("./providers", () => ({ AppProviders: () => null }));
vi.mock("@/components/SkipLink", () => ({ SkipLink: () => null }));
vi.mock("./../styles.css", () => ({}));

import { metadata } from "./layout";

type FontCall = Record<string, unknown> & {
  src: Array<{ path: string; weight: string; style: string }>;
};

function fontCall(variable: string): FontCall {
  const call = fonts.calls.find((candidate) => candidate.variable === variable);
  if (!call) throw new Error(`Police ${variable} non déclarée`);
  return call as FontCall;
}

function faces(variable: string): string[] {
  return fontCall(variable).src.map((source) => `${source.style} ${source.weight}`);
}

describe("root layout metadata", () => {
  it("does not give every page the home page as its Open Graph address", () => {
    // The object is inherited by every page that does not declare its own `openGraph`.
    expect(metadata.openGraph).toBeDefined();
    expect(metadata.openGraph).not.toHaveProperty("url");
    expect(metadata.openGraph).toMatchObject({ siteName: "Immojudis", locale: "fr_FR" });
  });

  it("preloads the display font used by the home heading", () => {
    expect(fontCall("--font-cormorant-garamond")).toMatchObject({
      preload: true,
      display: "swap",
      adjustFontFallback: "Times New Roman",
    });
  });

  it("loads exactly the weights and styles the stylesheet uses, same variables as before", () => {
    expect(faces("--font-cormorant-garamond")).toEqual([
      "normal 400",
      "normal 500",
      "normal 600",
      "italic 400",
      "italic 500",
      "italic 600",
    ]);
    expect(faces("--font-ibm-plex-sans")).toEqual([
      "normal 400",
      "normal 500",
      "normal 600",
      "normal 700",
    ]);
    expect(fontCall("--font-ibm-plex-sans")).toMatchObject({
      display: "swap",
      adjustFontFallback: "Arial",
    });
  });

  it("self-hosts the font files with their licence, without Google Fonts", () => {
    const layoutDir = join(process.cwd(), "src", "app");
    for (const call of fonts.calls) {
      for (const source of (call as FontCall).src) {
        const file = join(layoutDir, source.path);
        expect(existsSync(file), source.path).toBe(true);
        expect(readFileSync(file).subarray(0, 4).toString("latin1"), source.path).toBe("wOF2");
      }
    }
    for (const licence of ["OFL-cormorant-garamond.txt", "OFL-ibm-plex-sans.txt"]) {
      expect(existsSync(join(process.cwd(), "src", "fonts", licence)), licence).toBe(true);
    }
    expect(readFileSync(join(layoutDir, "layout.tsx"), "utf8")).not.toMatch(
      /from\s+["']next\/font\/google["']/,
    );
  });
});
