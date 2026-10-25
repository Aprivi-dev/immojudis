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

  it("loads Manrope only, preloaded, in the weights the stylesheet uses", () => {
    // Une seule police depuis le 25/10/2026 (Cormorant Garamond et IBM Plex Sans retirées).
    expect(fonts.calls.map((call) => call.variable)).toEqual(["--font-manrope"]);
    expect(fontCall("--font-manrope")).toMatchObject({
      preload: true,
      display: "swap",
      adjustFontFallback: "Arial",
    });
    expect(faces("--font-manrope")).toEqual([
      "normal 400",
      "normal 500",
      "normal 600",
      "normal 700",
      "normal 800",
    ]);
  });

  it("declares no italic and no other font face", () => {
    for (const call of fonts.calls as FontCall[]) {
      expect(call.src.map((source) => source.style)).not.toContain("italic");
    }
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    expect(css).not.toMatch(/@font-face/);
    expect(css).not.toMatch(/font-style:\s*italic/);
    for (const removed of [
      "cormorant-garamond-latin-normal.woff2",
      "cormorant-garamond-latin-italic.woff2",
      "ibm-plex-sans-latin.woff2",
    ]) {
      expect(existsSync(join(process.cwd(), "src", "fonts", removed)), removed).toBe(false);
    }
    expect(existsSync(join(process.cwd(), "src", "components", "PreloadCormorantItalic.tsx"))).toBe(
      false,
    );
  });

  it("self-hosts the font file with its licence, without Google Fonts", () => {
    const layoutDir = join(process.cwd(), "src", "app");
    // Les chemins sont relatifs au layout, qui déclare la police `next/font`.
    for (const call of fonts.calls) {
      for (const source of (call as FontCall).src) {
        const file = join(layoutDir, source.path);
        expect(existsSync(file), source.path).toBe(true);
        expect(readFileSync(file).subarray(0, 4).toString("latin1"), source.path).toBe("wOF2");
      }
    }
    expect(existsSync(join(process.cwd(), "src", "fonts", "OFL-manrope.txt"))).toBe(true);
    expect(readFileSync(join(layoutDir, "layout.tsx"), "utf8")).not.toMatch(
      /from\s+["']next\/font\/google["']/,
    );
  });
});
