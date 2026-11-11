// Harnais des tests d'invariants de sécurité : lance scripts/check-security-invariants.mjs sur un dépôt factice.
// Partagé par scripts/check-security-invariants.test.mjs et scripts/check-security-invariants-fact-registry.test.mjs.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxes = [];
/** À appeler dans le `afterAll` de chaque fichier de test. */
export function removeSandboxes() {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * `src/` du dépôt factice : les dossiers qui mènent à un fichier remplacé ou ajouté sont réels, tout le
 * reste est un lien vers le dépôt.
 */
function mirrorSource(root, overrides) {
  const directories = new Set(["src"]);
  for (const path of Object.keys(overrides)) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join("/"));
    }
  }
  const mirror = (relative) => {
    mkdirSync(join(root, relative), { recursive: true });
    const real = new Set(directories);
    const entries = (() => {
      try {
        return readdirSync(join(repo, relative));
      } catch {
        return [];
      }
    })();
    for (const entry of entries) {
      const child = `${relative}/${entry}`;
      if (real.has(child)) mirror(child);
      else symlinkSync(join(repo, child), join(root, child));
    }
    for (const child of directories) {
      if (child.startsWith(`${relative}/`) && !child.slice(relative.length + 1).includes("/")) {
        if (!entries.includes(child.slice(relative.length + 1))) mirror(child);
      }
    }
  };
  mirror("src");
  for (const [path, content] of Object.entries(overrides)) {
    const target = join(root, path);
    try {
      unlinkSync(target);
    } catch {
      // fichier nouveau
    }
    writeFileSync(target, content);
  }
}

/**
 * Le script lit tout par rapport à son propre emplacement : on le copie dans un dépôt factice dont
 * les migrations sont celles du dépôt, plus les fichiers `extraMigrations`. `extraFiles` ajoute des fichiers
 * (chemin relatif au dépôt) sous `scripts/`, `supabase/repairs/`, `supabase/maintenance/` ou
 * `supabase/functions/`.
 */
export function runInvariants(
  extraMigrations = {},
  omittedMigrations = [],
  sourceOverrides = {},
  extraFiles = {},
) {
  const root = mkdtempSync(join(tmpdir(), "immojudis-invariants-"));
  sandboxes.push(root);
  const overridden = Object.keys(sourceOverrides);
  for (const entry of readdirSync(repo)) {
    if (["scripts", "supabase", "node_modules", ".git", ".claude"].includes(entry)) continue;
    if (entry === "src" && overridden.length) continue;
    symlinkSync(join(repo, entry), join(root, entry));
  }
  if (overridden.length) mirrorSource(root, sourceOverrides);
  mkdirSync(join(root, "scripts"));
  // Le script et le module qu'il importe (invariants du registre des pièces).
  for (const script of [
    "check-security-invariants.mjs",
    "check-security-invariants-fact-registry.mjs",
  ]) {
    copyFileSync(join(repo, "scripts", script), join(root, "scripts", script));
  }
  mkdirSync(join(root, "supabase/migrations"), { recursive: true });
  for (const file of readdirSync(join(repo, "supabase/migrations"))) {
    if (omittedMigrations.includes(file)) continue;
    symlinkSync(join(repo, "supabase/migrations", file), join(root, "supabase/migrations", file));
  }
  for (const [name, sql] of Object.entries(extraMigrations)) {
    writeFileSync(join(root, "supabase/migrations", name), sql);
  }
  // Rattrapages, maintenance et fonctions Edge : ceux du dépôt, dans des dossiers réels où ajouter des fichiers.
  for (const directory of ["supabase/repairs", "supabase/maintenance", "supabase/functions"]) {
    mkdirSync(join(root, directory));
    for (const entry of readdirSync(join(repo, directory))) {
      symlinkSync(join(repo, directory, entry), join(root, directory, entry));
    }
  }
  for (const [path, content] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return spawnSync(process.execPath, [join(root, "scripts/check-security-invariants.mjs")], {
    encoding: "utf8",
  });
}
