import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve("src/components/home/HomePage.module.css"), "utf8");

/** Déclarations du premier bloc dont le sélecteur est exactement `selector`. */
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} absent de HomePage.module.css`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("accueil : cibles tactiles (repasse design n° 20)", () => {
  it.each([
    ".textLink",
    ".quietLink",
    ".proof a",
    ".presetButtons button",
    ".pauseButton",
    ".segmented button",
  ])("%s mesure au moins 44 px de haut", (selector) => {
    expect(block(selector)).toMatch(/min-height:\s*44px;/);
  });
});
