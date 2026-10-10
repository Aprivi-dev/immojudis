import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}

/** `/sales/[id]/land-report` → `/sales/{saleId}/land-report` (the documented parameter name). */
function documentedPath(route: string): string {
  return route.replace(/\[id\]/g, "{saleId}");
}

function openApiPaths(): string[] {
  const text = readFileSync(join(root, "openapi.yaml"), "utf8");
  const paths = text.slice(text.indexOf("\npaths:"), text.indexOf("\ncomponents:"));
  return [...paths.matchAll(/^ {2}(\/[^\s:]*):\s*$/gm)].map((match) => match[1]);
}

describe("openapi.yaml", () => {
  it("décrit exactement les routes de /api/v1", () => {
    const base = join(root, "src/app/api/v1");
    const implemented = routeFiles(base)
      .map((file) => "/" + relative(base, join(file, "..")).split(sep).join("/"))
      .map(documentedPath)
      .sort();
    expect(openApiPaths().sort()).toEqual(implemented);
  });
});
