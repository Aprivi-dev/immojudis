import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
// La console d'administration est réservée à l'équipe : elle garde les détails techniques.
const EXCLUDED = ["components/admin/", "app/admin/", "app/api/"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

describe("messages d'erreur visibles", () => {
  it("ne montrent jamais error.message tel quel hors administration", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !EXCLUDED.some((part) => file.includes(part)))
      .filter((file) =>
        /instanceof Error\s*\?\s*[\w.]+\.message\s*:/.test(readFileSync(file, "utf8")),
      )
      .map((file) => file.replace(SRC, "src"));
    expect(offenders).toEqual([]);
  });
});
