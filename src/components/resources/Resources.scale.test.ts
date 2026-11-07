import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve("src/components/resources/Resources.module.css"), "utf8");

describe("ressources : échelle de texte de la charte", () => {
  it("n'écrit plus rien sous 12 px (repasse design n° 17)", () => {
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((match) =>
      Number(match[1]),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size < 12)).toEqual([]);
  });

  it("donne aux titres de page l'échelle de PageTitle : 32 px, puis 40 px dès 640 px (n° 13)", () => {
    expect(css).toMatch(/\.hero h1,\s*\.articleHeader h1 \{[^}]*font-size: 32px;/);
    expect(css).toMatch(
      /@media \(min-width: 640px\) \{\s*\.hero h1,\s*\.articleHeader h1 \{\s*font-size: 40px;/,
    );
    expect(css).not.toMatch(/h1 \{[^}]*font-size: clamp\(/);
  });
});
