import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Glossaire Immojudis : un seul terme par notion dans les textes visibles.
 *  - « enchère plafond » (jamais « prix plafond », « mise plafond », « plafond d'enchère »,
 *    « enchère maximale », « mise maximale ») ;
 *  - « offre Analyse » (jamais « Premium ») ;
 *  - « favoris » (jamais « Mes ventes suivies ») ;
 *  - « Immojudis » (jamais « ImmoJudis »).
 */
const ROOT = process.cwd();

// Fichiers dont le texte est figé ou relève d'un autre périmètre (pages légales dont
// l'empreinte est verrouillée, routes API, facturation, e-mails d'alerte).
const EXEMPT = [
  /^src\/app\/api\//,
  /^src\/routes\/(legal|conditions-generales|privacy)\.tsx$/,
  /^src\/lib\/legal-documents/,
  /^src\/lib\/billing/,
  /^src\/lib\/email-alerts/,
  /^src\/lib\/alert-/,
  /^src\/lib\/plans/,
  /^src\/lib\/profitability/,
  /^src\/integrations\//,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const sources = [...files(join(ROOT, "src")), ...files(join(ROOT, "emails"))]
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }))
  .filter(({ path }) => !EXEMPT.some((pattern) => pattern.test(path)));

function offenders(pattern: RegExp): string[] {
  return sources.filter(({ text }) => pattern.test(text)).map(({ path }) => path);
}

describe("vocabulaire uniforme", () => {
  it("n'emploie plus « Premium » dans les textes visibles", () => {
    expect(offenders(/(?<![A-Za-z_.])Premium(?![A-Za-z])/)).toEqual([]);
  });

  it("écrit toujours Immojudis", () => {
    expect(offenders(/ImmoJudis/)).toEqual([]);
  });

  it("n'emploie qu'un terme pour l'enchère plafond", () => {
    expect(
      offenders(
        /prix plafond|mise plafond|plafond d['’]enchère|enchère maximale|mise maximale|Mise plafond/i,
      ),
    ).toEqual([]);
  });

  it("dit « favoris » et non « ventes suivies »", () => {
    expect(offenders(/Mes ventes suivies/)).toEqual([]);
  });
});
