import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TAGLINE = "Les enchères immobilières, en toute clarté";
const WITHOUT_COMMA = "Les enchères immobilières en toute clarté";

describe("accroche unique (avec virgule)", () => {
  it.each(["src/app/layout.tsx", "src/app/ressources/page.tsx"])("%s", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).toContain(TAGLINE);
    expect(source).not.toContain(WITHOUT_COMMA);
  });

  it("le titre du site et celui du partage reprennent la même accroche", () => {
    const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(layout.match(new RegExp(`Immojudis - ${TAGLINE}`, "g"))).toHaveLength(2);
  });
});
