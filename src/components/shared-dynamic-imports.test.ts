import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deux composants lourds ne se chargent que par un module partagé (`*Lazy.tsx`) : un import statique
 * (ou un second import dynamique) en recopierait le code dans chaque route qui l'importe.
 */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

function importersOf(specifier: string): string[] {
  const pattern = new RegExp(`(?:from|import\\()\\s*["']${specifier}["']`);
  return sourceFiles(join(process.cwd(), "src"))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(join(process.cwd(), "src").length + 1).replaceAll("\\", "/"));
}

describe("imports dynamiques partagés", () => {
  it("OfferOpeningRequest (et son questionnaire) n'est importé que par OfferOpeningRequestLazy", () => {
    expect(importersOf("@/components/OfferOpeningRequest")).toEqual([
      "components/OfferOpeningRequestLazy.tsx",
    ]);
    expect(importersOf("@/components/OfferOpeningSurvey")).toEqual([
      "components/OfferOpeningRequest.tsx",
    ]);
  });

  it("SectorAlertForm n'est importé que par SectorAlertFormLazy", () => {
    expect(importersOf("@/components/SectorAlertForm")).toEqual([
      "components/SectorAlertFormLazy.tsx",
    ]);
  });
});
