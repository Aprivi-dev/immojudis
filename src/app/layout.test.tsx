import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
    // Graisses normales dans le layout ; l'italique (mêmes graisses) est déclarée en CSS, voir plus bas.
    expect(faces("--font-cormorant-garamond")).toEqual(["normal 400", "normal 500", "normal 600"]);
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

  it("declares the italic once, by @font-face, not through next/font (which preloads on every route)", () => {
    // Deux déclarations `next/font` du même fichier (une préchargée, une non) produisent deux
    // fichiers distincts, et toute déclaration préchargée l'est sur chaque route qui l'appelle.
    expect(fonts.calls.map((call) => call.variable).sort()).toEqual([
      "--font-cormorant-garamond",
      "--font-ibm-plex-sans",
    ]);
    for (const call of fonts.calls as FontCall[]) {
      expect(call.src.map((source) => source.style)).not.toContain("italic");
    }
    for (const removed of [
      "cormorant-garamond-italic.ts",
      "cormorant-garamond-italic-preloaded.ts",
    ]) {
      expect(existsSync(join(process.cwd(), "src", "fonts", removed)), removed).toBe(false);
    }

    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    const declarations = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]);
    const property = (block: string, name: string) =>
      new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1].trim();
    expect(
      declarations.map((block) => ({
        family: property(block, "font-family"),
        style: property(block, "font-style"),
        weight: property(block, "font-weight"),
        display: property(block, "font-display"),
        src: property(block, "src"),
      })),
    ).toEqual(
      ["400", "500", "600"].map((weight) => ({
        // Le nom que `next/font` donne aux graisses normales du layout (d'après la constante
        // `cormorantGaramond`) : normal et italique forment ainsi UNE famille, sans italique
        // synthétique.
        family: "cormorantGaramond",
        style: "italic",
        weight,
        display: "swap",
        src: 'url("./fonts/cormorant-garamond-latin-italic.woff2") format("woff2")',
      })),
    );
    // La famille du layout porte bien ce nom.
    expect(readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8")).toMatch(
      /\bconst cormorantGaramond = localFont\(/,
    );
  });

  it("preloads the italic only through the pages that show it above the fold (home, /ressources)", () => {
    const root = process.cwd();
    const importers: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (/from "@\/components\/PreloadCormorantItalic"/.test(readFileSync(path, "utf8"))) {
            importers.push(relative(root, path).split("\\").join("/"));
          }
        }
      }
    };
    walk(join(root, "src"));
    expect(importers.sort()).toEqual(["src/app/page.tsx", "src/app/ressources/page.tsx"]);
  });

  it("self-hosts the font files with their licence, without Google Fonts", () => {
    const layoutDir = join(process.cwd(), "src", "app");
    // Les chemins sont relatifs au layout, qui déclare les polices `next/font`.
    for (const call of fonts.calls) {
      for (const source of (call as FontCall).src) {
        const file = join(layoutDir, source.path);
        expect(existsSync(file), source.path).toBe(true);
        expect(readFileSync(file).subarray(0, 4).toString("latin1"), source.path).toBe("wOF2");
      }
    }
    const italic = join(process.cwd(), "src", "fonts", "cormorant-garamond-latin-italic.woff2");
    expect(readFileSync(italic).subarray(0, 4).toString("latin1")).toBe("wOF2");
    for (const licence of ["OFL-cormorant-garamond.txt", "OFL-ibm-plex-sans.txt"]) {
      expect(existsSync(join(process.cwd(), "src", "fonts", licence)), licence).toBe(true);
    }
    expect(readFileSync(join(layoutDir, "layout.tsx"), "utf8")).not.toMatch(
      /from\s+["']next\/font\/google["']/,
    );
  });
});
