import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageLoadingSkeleton } from "./PageLoadingSkeleton";
import SalesLoading from "@/app/sales/loading";
import LoginLoading from "@/app/login/loading";

describe("PageLoadingSkeleton", () => {
  it("garde le fond des nuages par défaut (autres pages inchangées)", () => {
    const html = renderToStaticMarkup(<PageLoadingSkeleton />);
    expect(html).toContain("liquid-page ");
    expect(html).not.toContain("liquid-page-plain");
    expect(renderToStaticMarkup(<LoginLoading />)).not.toContain("liquid-page-plain");
  });

  it("le squelette de /sales n'a pas le fond des nuages", () => {
    expect(renderToStaticMarkup(<SalesLoading />)).toContain("liquid-page-plain");
  });

  it("la variante sans nuages remplace l'image de fond de .liquid-page", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const rule = /\.liquid-page\.liquid-page-plain\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("linear-gradient");
    expect(rule).not.toContain("url(");
    // Déclarée après la règle de base pour la remplacer à spécificité égale ou supérieure.
    expect(css.indexOf(".liquid-page.liquid-page-plain")).toBeGreaterThan(
      css.indexOf(".liquid-page {"),
    );
  });
});
