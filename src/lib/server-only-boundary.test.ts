import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
// Owned by the billing workstream; it reaches the service-role client only through
// client.server.ts, which itself carries `import "server-only"`.
const TRANSITIVE_ONLY = new Set(["src/lib/billing.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(process.cwd(), path),
  text: readFileSync(path, "utf8"),
}));
const importsServiceRole = files.filter(
  ({ path, text }) =>
    path !== "src/integrations/supabase/client.server.ts" &&
    /from\s+["']@\/integrations\/supabase\/client\.server["']/.test(text),
);

describe("service-role client boundary", () => {
  it("marks the service-role client module as server-only", () => {
    const client = files.find((file) => file.path === "src/integrations/supabase/client.server.ts");
    expect(client?.text).toMatch(/^import "server-only";$/m);
  });

  it("marks every module that imports the service-role client as server-only", () => {
    expect(importsServiceRole.length).toBeGreaterThan(30);
    const missing = importsServiceRole
      .filter(
        ({ path, text }) => !TRANSITIVE_ONLY.has(path) && !/^import "server-only";$/m.test(text),
      )
      .map(({ path }) => path);
    expect(missing).toEqual([]);
  });

  it("never imports the service-role client from a client component", () => {
    const offenders = files
      .filter(({ text }) => /^["']use client["']/m.test(text.split("\n").slice(0, 5).join("\n")))
      .filter(({ text }) => /client\.server["']/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("keeps the shared sale view constants out of the browser Supabase client module", () => {
    const aiReview = files.find((file) => file.path === "src/app/api/sales/ai-review/route.ts");
    expect(aiReview?.text).not.toContain('from "@/lib/queries"');
    const views = files.find((file) => file.path === "src/lib/sale-views.ts");
    expect(views?.text).toContain("DETAIL_VIEW");
    expect(views?.text).not.toContain("supabase/client");
  });
});
