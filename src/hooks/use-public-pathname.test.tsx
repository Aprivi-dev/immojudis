// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/sales" }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));

import { usePublicPathname } from "./use-public-pathname";

describe("usePublicPathname", () => {
  beforeEach(() => {
    mocks.pathname = "/sales";
  });

  it("returns the address of the visitor on the static variant of /sales", () => {
    mocks.pathname = "/sales/defaut";
    expect(renderHook(() => usePublicPathname()).result.current).toBe("/sales");
  });

  it("returns the address of the visitor on the static variants of ?page=2 and ?page=3", () => {
    for (const pathname of ["/sales/defaut/2", "/sales/defaut/3"]) {
      mocks.pathname = pathname;
      expect(renderHook(() => usePublicPathname()).result.current).toBe("/sales");
    }
  });

  it("returns every other pathname unchanged", () => {
    for (const pathname of ["/sales", "/", "/sales/abc", "/admin/securite"]) {
      mocks.pathname = pathname;
      expect(renderHook(() => usePublicPathname()).result.current).toBe(pathname);
    }
  });
});

/**
 * Les hooks de `next/navigation` qui rendent, côté serveur, le chemin ou les segments de la page
 * CIBLE d'une réécriture (`/sales/defaut`) et non l'adresse du visiteur (`/sales`).
 */
const REWRITE_SENSITIVE_HOOKS = new Set([
  "usePathname",
  "useSelectedLayoutSegment",
  "useSelectedLayoutSegments",
  "useParams",
]);

/**
 * Ce que `source` importe de `next/navigation` parmi les hooks sensibles à la réécriture :
 * import nommé (avec ou sans alias, `type` exclu), re-export, espace de noms (`* as navigation`,
 * qui donne accès à tous), `require("next/navigation")` et `import("next/navigation")`.
 */
function rewriteSensitiveNavigationReads(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];

  const named =
    /\b(?:import|export)\s+(?!type\b)(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']next\/navigation["']/g;
  for (const match of code.matchAll(named)) {
    for (const entry of match[1].split(",")) {
      const specifier = entry.trim();
      if (!specifier || /^type\s/.test(specifier)) continue;
      const name = specifier.split(/\s+as\s+/)[0].trim();
      if (REWRITE_SENSITIVE_HOOKS.has(name)) found.push(name);
    }
  }
  if (
    /\bimport\s+(?!type\b)(?:[\w$]+\s*,\s*)?\*\s*as\s+[\w$]+\s+from\s*["']next\/navigation["']/.test(
      code,
    ) ||
    /\bexport\s+\*(?:\s+as\s+[\w$]+)?\s+from\s*["']next\/navigation["']/.test(code)
  ) {
    found.push("* (namespace)");
  }
  if (/\b(?:require|import)\s*\(\s*["']next\/navigation["']\s*\)/.test(code)) {
    found.push("require/import()");
  }
  return found;
}

describe("rewriteSensitiveNavigationReads", () => {
  it.each([
    ['import { usePathname } from "next/navigation";', ["usePathname"]],
    ["import { useRouter, usePathname as pathname } from 'next/navigation'", ["usePathname"]],
    ['import {\n  useParams,\n  useRouter,\n} from "next/navigation";', ["useParams"]],
    ['import { useSelectedLayoutSegment } from "next/navigation"', ["useSelectedLayoutSegment"]],
    ['import { useSelectedLayoutSegments } from "next/navigation"', ["useSelectedLayoutSegments"]],
    ['export { usePathname } from "next/navigation";', ["usePathname"]],
    ['import * as navigation from "next/navigation";', ["* (namespace)"]],
    ['import Default, * as navigation from "next/navigation";', ["* (namespace)"]],
    ['export * from "next/navigation";', ["* (namespace)"]],
    ['const navigation = require("next/navigation");', ["require/import()"]],
    ["const { usePathname } = require('next/navigation');", ["require/import()"]],
    ['const navigation = await import("next/navigation");', ["require/import()"]],
  ])("flags %s", (source, expected) => {
    expect(rewriteSensitiveNavigationReads(source)).toEqual(expected);
  });

  it.each([
    'import { useRouter, useSearchParams, notFound, redirect } from "next/navigation";',
    'import type { usePathname } from "next/navigation";',
    'import { type useParams, useRouter } from "next/navigation";',
    'import { usePathname } from "@/hooks/use-public-pathname";',
    'import { usePublicPathname } from "@/hooks/use-public-pathname";',
    '// import { usePathname } from "next/navigation";',
    '/* const navigation = require("next/navigation"); */',
    'const label = "usePathname";',
  ])("lets %s through", (source) => {
    expect(rewriteSensitiveNavigationReads(source)).toEqual([]);
  });
});

describe("pathname reads on /sales", () => {
  // Fichiers autorisés à lire le chemin, les segments ou les paramètres par `next/navigation`, avec
  // le hook lu. Une page qui n'a pas de variante réécrite par le proxy peut le faire : son chemin
  // serveur est celui du navigateur. Toute autre entrée est une décision à justifier ici.
  const ALLOWED = new Map<string, string[]>([
    ["src/hooks/use-public-pathname.ts", ["usePathname"]],
    ["src/app/login/login-page.tsx", ["usePathname"]],
    ["src/components/AuthGate.tsx", ["usePathname"]],
  ]);

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("goes through usePublicPathname: no other file reads the path, segments or params from next/navigation", () => {
    const root = process.cwd();
    const reads = Object.fromEntries(
      sourceFiles(resolve(root, "src"))
        .map((path) => relative(root, path))
        .map((path) => [
          path,
          rewriteSensitiveNavigationReads(readFileSync(resolve(root, path), "utf8")),
        ])
        .filter(([, found]) => found.length > 0),
    );
    // Les mentions en commentaire sont ignorées ; un import ne l'est pas, ni une entrée devenue
    // inutile dans la liste blanche.
    expect(reads).toEqual(Object.fromEntries(ALLOWED));
  });
});
