import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

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

  it("n'a plus de couche qui traduit les classes sombres de l'administration", () => {
    const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
    expect(css).not.toMatch(/\.admin-console \.(liquid-panel|border-white|text-emerald-100)/);
  });
});
