import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Le registre `docs/architecture/machines-a-etats.md` dit où vit chaque cycle de vie. Ce test le
 * garde vrai : une machine `*-machine.ts` sans ligne dans le registre ou sans test, ou un fichier
 * cité par le registre qui n'existe plus, fait échouer la suite avec le nom du fichier à corriger.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY = "docs/architecture/machines-a-etats.md";
const registry = readFileSync(join(root, REGISTRY), "utf8");

function machineFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return machineFiles(path);
    return /-machine\.tsx?$/.test(entry.name) ? [relative(root, path).replaceAll("\\", "/")] : [];
  });
}

const machines = machineFiles(join(root, "src")).sort();

/** Chemins du dépôt cités entre accents graves dans le registre. */
const citedPaths = [
  ...new Set(
    [...registry.matchAll(/`((?:src|services|supabase|docs|scripts)\/[^`\s*]+\.[a-z]+)`/g)].map(
      (match) => match[1],
    ),
  ),
].sort();

describe("registre des machines à états", () => {
  it("trouve les machines du dépôt et des chemins dans le registre", () => {
    // Garde-fou du test lui-même : une recherche qui ne trouve rien validerait n'importe quoi.
    expect(machines.length).toBeGreaterThanOrEqual(2);
    expect(citedPaths.length).toBeGreaterThanOrEqual(40);
  });

  it.each(machines)("%s est listée dans le registre", (machine) => {
    expect(registry, `ajoutez \`${machine}\` à ${REGISTRY}, section 3`).toContain(`\`${machine}\``);
  });

  it.each(machines)("%s a un test à côté d'elle", (machine) => {
    const test = machine.replace(/\.tsx?$/, ".test.ts");
    expect(
      existsSync(join(root, test)) || existsSync(join(root, `${test}x`)),
      `test attendu : ${test}`,
    ).toBe(true);
  });

  it.each(citedPaths)("%s, cité par le registre, existe", (path) => {
    expect(
      existsSync(join(root, path)),
      `${REGISTRY} cite \`${path}\`, qui n'existe plus : mettez le registre à jour`,
    ).toBe(true);
  });
});
