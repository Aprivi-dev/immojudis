import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tribunalJudicialActivityQuerySchema } from "@/lib/tribunal-judicial-activity";
import { tribunalJudicialActivityDirectoryQuerySchema } from "@/lib/tribunal-judicial-activity-directory";
import { tribunalListingStatisticsQuerySchema } from "@/lib/tribunal-listing-statistics";
import { tribunalStatisticsQuerySchema } from "@/lib/tribunal-statistics-repository";

// `tribunal-statistics-repository` crée le client de base à l'import : ici on ne lit que son schéma.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const root = process.cwd();
const base = join(root, "src/app/api/v1");

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

function openApiText(): string {
  return readFileSync(join(root, "openapi.yaml"), "utf8");
}

function pathsSection(): string {
  const text = openApiText();
  return text.slice(text.indexOf("\npaths:"), text.indexOf("\ncomponents:"));
}

function openApiPaths(): string[] {
  return [...pathsSection().matchAll(/^ {2}(\/[^\s:]*):\s*$/gm)].map((match) => match[1]);
}

/** Response codes and security declared by the contract for each path. */
function openApiOperations(): Map<string, { codes: string[]; secured: boolean }> {
  const operations = new Map<string, { codes: string[]; secured: boolean }>();
  for (const chunk of pathsSection()
    .split(/\n(?= {2}\/)/)
    .slice(1)) {
    const path = chunk.match(/^ {2}(\/[^\s:]*):/)![1];
    operations.set(path, {
      codes: [...chunk.matchAll(/^ {8}"(\d{3})":/gm)].map((match) => match[1]).sort(),
      secured: /^ {6}security:\s*\n {8}- bearerAuth: \[\]/m.test(chunk),
    });
  }
  return operations;
}

/**
 * Response codes a route can produce, read from its source: the guards it calls and the status it
 * sets. The contract must declare exactly these, so a new guard or status cannot ship undocumented.
 */
function codesFromSource(source: string): { codes: string[]; secured: boolean } {
  const codes = new Set(["200"]);
  const secured = source.includes("requireSupabaseAuthContext");
  if (secured) codes.add("401");
  if (/assertFeatureEntitlement/.test(source)) codes.add("403");
  if (/enforceUserRateLimit|enforceDailyOperationLimits/.test(source)) codes.add("429");
  // Un schéma zod, un paramètre répété ou une erreur publique 400 donnent un 400.
  if (/\.parse\(|PublicApiError\(/.test(source)) codes.add("400");
  if (/saleNotFoundAsPublicError/.test(source)) codes.add("404");
  for (const status of source.matchAll(/status:\s*(\d{3})/g)) codes.add(status[1]);
  const fallback = source.match(/fallbackStatus:\s*(\d{3})/);
  codes.add(fallback ? fallback[1] : "500");
  return { codes: [...codes].sort(), secured };
}

/** Paramètres `in: query` déclarés par le contrat pour chaque chemin. */
function openApiQueryParameters(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const chunk of pathsSection()
    .split(/\n(?= {2}\/)/)
    .slice(1)) {
    const path = chunk.match(/^ {2}(\/[^\s:]*):/)![1];
    result.set(
      path,
      [...chunk.matchAll(/- name: (\w+)\n\s+in: query/g)].map((match) => match[1]).sort(),
    );
  }
  return result;
}

/** Clés d'un schéma d'objet zod (classique ou mini). */
function schemaKeys(schema: unknown): string[] {
  return Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();
}

/** Schémas de requête exportés par les modules des routes; les autres sont lus dans la route. */
const QUERY_SCHEMAS: Record<string, unknown> = {
  "/tribunals/judicial-activity": tribunalJudicialActivityQuerySchema,
  "/tribunals/judicial-activity/directory": tribunalJudicialActivityDirectoryQuerySchema,
  "/tribunals/listing-statistics": tribunalListingStatisticsQuerySchema,
  "/tribunals/statistics": tribunalStatisticsQuerySchema,
};

/** Clés du `querySchema` local d'une route (`const querySchema = z.object({ ... })`), sinon aucune. */
function localQueryKeys(source: string): string[] {
  const block = source.match(/const querySchema = z\.\w+\(\{([\s\S]*?)\n\}\)/);
  if (!block) return [];
  return [...block[1].matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]).sort();
}

describe("openapi.yaml", () => {
  const routes = routeFiles(base).map((file) => ({
    path: documentedPath("/" + relative(base, join(file, "..")).split(sep).join("/")),
    source: readFileSync(file, "utf8"),
  }));

  it("décrit exactement les routes de /api/v1", () => {
    expect(openApiPaths().sort()).toEqual(routes.map((route) => route.path).sort());
  });

  it("déclare, pour chaque route, les codes de réponse que son code peut produire", () => {
    const operations = openApiOperations();
    for (const route of routes) {
      const declared = operations.get(route.path);
      expect(declared, route.path).toBeDefined();
      expect(declared!.codes, `codes de ${route.path}`).toEqual(
        codesFromSource(route.source).codes,
      );
    }
  });

  it("déclare l'authentification Bearer sur toutes les routes qui l'exigent", () => {
    const operations = openApiOperations();
    for (const route of routes) {
      expect(operations.get(route.path)!.secured, `security de ${route.path}`).toBe(
        codesFromSource(route.source).secured,
      );
    }
  });

  it("déclare exactement les paramètres de requête que lisent les schémas de chaque route", () => {
    const declared = openApiQueryParameters();
    for (const route of routes) {
      const expected =
        route.path in QUERY_SCHEMAS
          ? schemaKeys(QUERY_SCHEMAS[route.path])
          : localQueryKeys(route.source);
      expect(declared.get(route.path), `paramètres de requête de ${route.path}`).toEqual(expected);
    }
  });

  it("déclare les en-têtes RateLimit-* de toute route qui limite le débit par compte", () => {
    const text = openApiText();
    for (const route of routes) {
      const chunk = pathsSection()
        .split(/\n(?= {2}\/)/)
        .find((part) => part.startsWith(`  ${route.path}:`))!;
      const limited = /enforceUserRateLimit\(\{[^}]*\bcontext\b/.test(route.source);
      expect(limited, `${route.path} passe son contexte à enforceUserRateLimit`).toBe(true);
      expect(chunk, route.path).toContain("RateLimit-Remaining");
    }
    expect(text).toMatch(/headers:\n {4}RateLimitLimit:/);
  });

  it("définit chaque réponse partagée qu'il référence", () => {
    const text = openApiText();
    const defined = new Set(
      [...text.slice(text.indexOf("\ncomponents:")).matchAll(/^ {4}(\w+):\s*$/gm)].map(
        (match) => match[1],
      ),
    );
    const referenced = [...text.matchAll(/#\/components\/responses\/(\w+)/g)].map(
      (match) => match[1],
    );
    for (const name of new Set(referenced)) expect(defined.has(name), name).toBe(true);
  });

  it("annonce une version au moins 1.5.1 et le changement de sens de la couche TRI du rapport foncier (land-report-v1.1)", () => {
    const text = openApiText();
    expect(text).toMatch(/^info:\n(?:.*\n)*? {2}version: 1\.(?:5\.1|[6-9]\.\d+)$/m);
    const landReport = text.slice(text.indexOf("/sales/{saleId}/land-report:"));
    expect(landReport).toContain("land-report-v1.1");
    expect(landReport).toMatch(/appartenance du point à la zone/);
  });
});
