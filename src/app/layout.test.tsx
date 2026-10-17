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
// Importé pour que le simulacre de `next/font/local` enregistre aussi sa déclaration.
import "@/fonts/cormorant-garamond-italic-preloaded";

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
    // Graisses normales dans le layout ; italique (mêmes graisses) déclarée à part, voir plus bas.
    expect(faces("--font-cormorant-garamond")).toEqual(["normal 400", "normal 500", "normal 600"]);
    expect(faces("--font-cormorant-garamond-italic")).toEqual([
      "italic 400",
      "italic 500",
      "italic 600",
    ]);
    expect(faces("--font-cormorant-garamond-italic-preloaded")).toEqual(
      faces("--font-cormorant-garamond-italic"),
    );
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

  it("preloads the italic of the home heading only through the pages that show it", () => {
    // Non préchargée dans le layout (donc sur aucune page, /sales comprise) ; préchargée par le
    // module que seules l'accueil et /ressources importent.
    expect(fontCall("--font-cormorant-garamond-italic")).toMatchObject({
      preload: false,
      display: "swap",
      adjustFontFallback: false,
    });
    expect(fontCall("--font-cormorant-garamond-italic-preloaded")).toMatchObject({
      preload: true,
      display: "swap",
      adjustFontFallback: false,
    });
    // Même plage de caractères que les graisses normales.
    expect(fontCall("--font-cormorant-garamond-italic").declarations).toEqual(
      fontCall("--font-cormorant-garamond").declarations,
    );

    const root = process.cwd();
    const importers: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (
            /from "@\/fonts\/cormorant-garamond-italic-preloaded"/.test(readFileSync(path, "utf8"))
          ) {
            importers.push(relative(root, path).split("\\").join("/"));
          }
        }
      }
    };
    walk(join(root, "src"));
    expect(importers.sort()).toEqual(["src/app/page.tsx", "src/app/ressources/page.tsx"]);
  });

  it("gives normal and italic weights ONE family: the three declarations share their constant name", () => {
    // `next/font` nomme la famille d'après la constante. Normal et italique ne forment une seule
    // famille (donc pas d'italique synthétique) que si la constante porte le même nom partout.
    for (const file of [
      "src/app/layout.tsx",
      "src/fonts/cormorant-garamond-italic.ts",
      "src/fonts/cormorant-garamond-italic-preloaded.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), file), "utf8"), file).toMatch(
        /\bconst cormorantGaramond = localFont\(/,
      );
    }
  });

  it("self-hosts the font files with their licence, without Google Fonts", () => {
    const layoutDir = join(process.cwd(), "src", "app");
    // Les chemins sont relatifs au module qui déclare la police : le layout, ou `src/fonts`.
    const sourceDir = (call: FontCall) =>
      String(call.variable).includes("italic")
        ? join(process.cwd(), "src", "fonts")
        : join(process.cwd(), "src", "app");
    for (const call of fonts.calls) {
      for (const source of (call as FontCall).src) {
        const file = join(sourceDir(call as FontCall), source.path);
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
