import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: null as null | Record<string, unknown> }));
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(_element: unknown, options: Record<string, unknown>) {
      captured.options = options;
    }
  },
}));

import OpenGraphImage, { size } from "./opengraph-image";

describe("image de partage (repasse design n° 38)", () => {
  it("dessine le texte en Manrope 400, 700 et 800, à partir des fichiers statiques de src/fonts", async () => {
    await OpenGraphImage();
    const options = captured.options as {
      width: number;
      height: number;
      fonts: { name: string; weight: number; style: string; data: Buffer }[];
    };
    expect(options.width).toBe(size.width);
    expect(options.height).toBe(size.height);
    expect(options.fonts.map(({ name, weight, style }) => [name, weight, style])).toEqual([
      ["Manrope", 400, "normal"],
      ["Manrope", 700, "normal"],
      ["Manrope", 800, "normal"],
    ]);
    for (const font of options.fonts) {
      // Conteneur WOFF 1 (« wOFF ») : ImageResponse ne lit ni le WOFF2 ni une police variable.
      expect(font.data.subarray(0, 4).toString("latin1")).toBe("wOFF");
    }
  });

  it("garde la licence OFL de Manrope à côté des fichiers", () => {
    expect(readFileSync(resolve("src/fonts/OFL-manrope.txt"), "utf8")).toContain(
      "SIL Open Font License",
    );
  });
});
