import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN_DIR = join(process.cwd(), "src/app/admin");

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

const adminPages = pages(ADMIN_DIR);

describe("arborescence /admin", () => {
  it("protège toutes les vues par une seule barrière d’accès (connexion, rôle, TOTP)", () => {
    const layout = readFileSync(join(ADMIN_DIR, "layout.tsx"), "utf8");
    expect(layout).toMatch(/import \{ AuthGate \} from "@\/components\/AuthGate"/);
    expect(layout).toMatch(/<AuthGate>\{children\}<\/AuthGate>/);
    // Une seconde barrière dans une page rejouerait le contrôle TOTP à chaque navigation.
    for (const page of adminPages) {
      expect(readFileSync(page, "utf8"), relative(ADMIN_DIR, page)).not.toContain("AuthGate");
    }
  });

  it("garde toutes les URL historiques de la console", () => {
    const routes = adminPages.map((page) =>
      `/admin/${relative(ADMIN_DIR, dirname(page))}`.replace(/\/\.$/, ""),
    );
    expect(routes.sort()).toEqual(
      [
        "/admin/",
        "/admin/agent-ia",
        "/admin/clients",
        "/admin/compliance",
        "/admin/lawyers",
        "/admin/operations",
        "/admin/publications",
        "/admin/quality",
        "/admin/securite",
        "/admin/settings",
      ].sort(),
    );
  });

  it("n’indexe aucune vue admin", () => {
    for (const page of adminPages) {
      expect(readFileSync(page, "utf8"), relative(ADMIN_DIR, page)).toMatch(
        /robots: \{ index: false, follow: false \}/,
      );
    }
  });

  it("a une page pour chaque lien de la navigation latérale", () => {
    const shell = readFileSync(join(process.cwd(), "src/components/admin/AdminShell.tsx"), "utf8");
    const hrefs = [...shell.matchAll(/href: "(\/admin[^"]*)"/g)].map((match) => match[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(9);
    for (const href of hrefs) {
      const segment = href === "/admin" ? "" : href.replace("/admin/", "");
      expect(existsSync(join(ADMIN_DIR, segment, "page.tsx")), href).toBe(true);
    }
  });

  it("ne charge dans chaque page que sa propre vue (plus de module admin unique)", () => {
    const own: Record<string, string> = {
      "page.tsx": "./admin-home-page",
      "operations/page.tsx": "./admin-operations-page",
      "agent-ia/page.tsx": "./admin-agent-page",
      "publications/page.tsx": "./admin-publications-page",
      "clients/page.tsx": "./admin-clients-page",
      "lawyers/page.tsx": "./admin-lawyers-page",
      "compliance/page.tsx": "./admin-compliance-page",
      "quality/page.tsx": "./admin-quality-page",
    };
    for (const [file, module] of Object.entries(own)) {
      const source = readFileSync(join(ADMIN_DIR, file), "utf8");
      const imports = [...source.matchAll(/from "(\.\/[^"]+)"/g)].map((match) => match[1]);
      expect(imports, file).toEqual([module]);
    }
  });
});
