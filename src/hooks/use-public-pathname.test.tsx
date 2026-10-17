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

  it("returns every other pathname unchanged", () => {
    for (const pathname of ["/sales", "/", "/sales/abc", "/admin/securite"]) {
      mocks.pathname = pathname;
      expect(renderHook(() => usePublicPathname()).result.current).toBe(pathname);
    }
  });
});

describe("pathname reads on /sales", () => {
  // Les pages qui n'ont pas de variante réécrite par le proxy peuvent lire `usePathname` : leur
  // chemin serveur est celui du navigateur.
  const ALLOWED = new Set([
    "src/hooks/use-public-pathname.ts",
    "src/app/login/login-page.tsx",
    "src/components/AuthGate.tsx",
  ]);

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("goes through usePublicPathname: next/navigation's usePathname is read nowhere else", () => {
    const root = process.cwd();
    const offenders = sourceFiles(resolve(root, "src"))
      .map((path) => relative(root, path))
      .filter((path) => !ALLOWED.has(path))
      // Mentions in comments are fine; an import is not.
      .filter((path) =>
        /import\s*\{[^}]*\busePathname\b[^}]*\}\s*from\s*["']next\/navigation["']/.test(
          readFileSync(resolve(root, path), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
