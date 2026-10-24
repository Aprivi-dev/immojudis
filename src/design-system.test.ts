import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

// Plafonds du cliquet, relevés le 24/10/2026 (526 couleurs brutes, puis 514 après la fiche publique) :
// à abaisser à chaque page migrée, jamais à relever.
const RAW_PALETTE_CLASSES_MAX = 514;
const TINY_TEXT_CLASSES_MAX = 116;

// Couleurs qui ne peuvent pas passer par une classe ou une variable CSS :
// e-mails (styles en ligne), image Open Graph, page d'erreur globale (sans feuille de style),
// styles de la carte Mapbox (valeurs JavaScript) et pages légales à contenu figé.
const EXEMPT = [
  /^src\/app\/opengraph-image\.tsx$/,
  /^src\/app\/global-error\.tsx$/,
  /^src\/app\/api\//,
  /^src\/integrations\//,
  /^src\/lib\//,
  /^src\/routes\/(legal|conditions-generales|privacy)\.tsx$/,
  /\.test\./,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(css|tsx?)$/.test(name) ? [path] : [];
  });
}

describe("système visuel", () => {
  it("garde moins de 20 couleurs en dur hors des jetons", () => {
    const colors = new Set<string>();
    for (const path of files(join(ROOT, "src"))) {
      const rel = relative(ROOT, path);
      if (EXEMPT.some((pattern) => pattern.test(rel))) continue;
      let text = readFileSync(path, "utf8");
      if (rel === "src/styles.css") {
        // Les jetons eux-mêmes sont définis dans le premier bloc :root.
        const start = text.indexOf(":root {");
        text = text.slice(0, start) + text.slice(text.indexOf("\n}\n", start));
      }
      for (const match of text.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
        colors.add(match[0].toLowerCase());
      }
    }
    colors.delete("#ffffff");
    expect([...colors].length).toBeLessThan(20);
  });

  it("n'utilise plus le sarcelle #0f766e dans les classes ni les feuilles de style", () => {
    const offenders = files(join(ROOT, "src"))
      .filter((path) =>
        /src\/(components|routes)\/|src\/styles\.css$|src\/app\/.*page\.tsx$/.test(path),
      )
      .filter((path) => !/\.test\./.test(path) && !path.endsWith("MapPanel.tsx"))
      .filter((path) => /#0f766e/i.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });

  it("interdit les couleurs [#hex] dans les classes (règle ESLint)", async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const [bad] = await eslint.lintText(
      `export const A = () => <p className="text-[#132238] bg-[#fff]">x</p>;\n`,
      { filePath: join(ROOT, "src/components/Fake.tsx") },
    );
    expect(bad.messages.some((message) => message.ruleId === "no-restricted-syntax")).toBe(true);
    const [good] = await eslint.lintText(
      `export const A = () => <p className="text-brand-navy bg-surface-tint">x</p>;\n`,
      { filePath: join(ROOT, "src/components/Fake.tsx") },
    );
    expect(good.messages.filter((message) => message.ruleId === "no-restricted-syntax")).toEqual(
      [],
    );
  });

  // Cliquet des fondations (docs/design/fondations.md) : la dette existante est comptée et ne peut
  // que baisser. Une page migrée fait descendre ces plafonds ; une nouvelle classe brute fait
  // échouer ce test. Utiliser les jetons (danger, warning, success, info, ink-soft, line…) et
  // l'échelle de texte (12 px minimum, `text-caption` pour 13 px).
  const productionFiles = () =>
    files(join(ROOT, "src")).filter((path) => /\.tsx?$/.test(path) && !/\.test\./.test(path));
  const count = (pattern: RegExp) =>
    productionFiles().reduce(
      (total, path) => total + [...readFileSync(path, "utf8").matchAll(pattern)].length,
      0,
    );

  it("ne gagne aucune classe de couleur Tailwind brute (rouge, ambre, ardoise…)", () => {
    const raw =
      /\b(?:bg|text|border|ring|from|to|divide|outline|decoration|fill|stroke|placeholder)-(?:emerald|red|amber|green|orange|yellow|rose|sky|blue|slate|gray|zinc|teal|stone|neutral|indigo|violet|purple|pink|lime|cyan|fuchsia)-\d{2,3}\b/g;
    expect(count(raw)).toBeLessThanOrEqual(RAW_PALETTE_CLASSES_MAX);
  });

  it("ne gagne aucun texte de moins de 12 px", () => {
    expect(count(/\btext-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/g)).toBeLessThanOrEqual(
      TINY_TEXT_CLASSES_MAX,
    );
  });

  it("n'a plus de couche qui traduit les classes sombres de l'administration", () => {
    const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
    expect(css).not.toMatch(/\.admin-console \.(liquid-panel|border-white|text-emerald-100)/);
  });
});
