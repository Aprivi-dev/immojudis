import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Metadata } from "next";
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
        "/admin/comptes",
        "/admin/emails",
        "/admin/inscriptions",
        "/admin/lawyers",
        "/admin/operations",
        "/admin/pepites",
        "/admin/pilotage",
        "/admin/publications",
        "/admin/quality",
        "/admin/securite",
        "/admin/settings",
      ].sort(),
    );
  });

  it("n’indexe aucune vue admin", async () => {
    const { metadata: layout } = await import("./layout");
    for (const page of adminPages) {
      const { metadata } = (await import(/* @vite-ignore */ page)) as { metadata: Metadata };
      // Règle de Next.js : les métadonnées des segments sont fusionnées clé par clé, la page en
      // dernier ; une clé `robots` dans une page remplacerait celle du layout.
      const rendered: Metadata = { ...layout, ...metadata };
      expect(rendered.robots, relative(ADMIN_DIR, page)).toEqual({ index: false, follow: false });
    }
  }, 60_000);

  it("a une page pour chaque lien de la navigation latérale", () => {
    const shell = readFileSync(join(process.cwd(), "src/components/admin/AdminShell.tsx"), "utf8");
    const hrefs = [...shell.matchAll(/href: "(\/admin[^"]*)"/g)].map((match) => match[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(9);
    for (const href of hrefs) {
      const segment = href === "/admin" ? "" : href.replace("/admin/", "");
      expect(existsSync(join(ADMIN_DIR, segment, "page.tsx")), href).toBe(true);
    }
  });

  it.each([
    ["inscriptions", "/admin/comptes?onglet=inscriptions"],
    ["clients", "/admin/comptes?onglet=clients"],
    ["pepites", "/admin/quality?onglet=pepites"],
  ])("redirige l’ancienne adresse /admin/%s vers son onglet", async (segment, target) => {
    const { default: Page } = (await import(
      /* @vite-ignore */ join(ADMIN_DIR, segment, "page.tsx")
    )) as { default: () => unknown };
    let thrown: unknown;
    try {
      Page();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { digest?: string } | undefined)?.digest).toMatch(
      new RegExp(`^NEXT_REDIRECT;[a-z]+;${target.replace(/[?]/g, "\\?")};307;`),
    );
  });

  it("ne charge dans chaque page que sa propre vue (plus de module admin unique)", () => {
    const own: Record<string, string> = {
      "page.tsx": "./admin-home-page",
      "operations/page.tsx": "./admin-operations-page",
      "agent-ia/page.tsx": "./admin-agent-page",
      "emails/page.tsx": "./admin-emails-page",
      "publications/page.tsx": "./admin-publications-page",
      "comptes/page.tsx": "./admin-accounts-page",
      "lawyers/page.tsx": "./admin-lawyers-page",
      "compliance/page.tsx": "./admin-compliance-page",
      "quality/page.tsx": "./admin-quality-page",
      "pilotage/page.tsx": "./admin-pilotage-page",
    };
    for (const [file, module] of Object.entries(own)) {
      const source = readFileSync(join(ADMIN_DIR, file), "utf8");
      const imports = [...source.matchAll(/from "(\.\/[^"]+)"/g)].map((match) => match[1]);
      expect(imports, file).toEqual([module]);
    }
  });
});
