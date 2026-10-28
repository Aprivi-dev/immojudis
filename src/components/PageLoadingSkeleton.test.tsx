import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageLoadingSkeleton } from "./PageLoadingSkeleton";
import SalesLoading from "@/app/sales/loading";
import LoginLoading from "@/app/login/loading";

const css = () => readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("PageLoadingSkeleton", () => {
  it("utilise le fond de page commun, sans variante", () => {
    for (const html of [
      renderToStaticMarkup(<PageLoadingSkeleton />),
      renderToStaticMarkup(<SalesLoading />),
      renderToStaticMarkup(<LoginLoading />),
    ]) {
      expect(html).toContain("liquid-page ");
      expect(html).not.toContain("liquid-page-plain");
    }
  });
});

describe(".liquid-page", () => {
  it("peint le fond papier, sans nuages ni quadrillage ni ciel", () => {
    const styles = css();
    const rule = /\.liquid-page\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(rule).toContain("background: var(--background)");
    expect(rule).not.toContain("url(");
    expect(rule).not.toContain("gradient");
    expect(styles).not.toContain(".liquid-page::before");
    expect(styles).not.toContain("cloud-background");
    expect(styles).not.toContain("238 247 255");
  });

  it("n'embarque plus l'image des nuages", () => {
    expect(existsSync(resolve(process.cwd(), "public/media/landing/cloud-background.webp"))).toBe(
      false,
    );
  });

  it("les cartes de connexion sont blanches à filet, sans flou ni ombre", () => {
    const rule = /\.glass-shell\s*\{([^}]*)\}/.exec(css())?.[1] ?? "";
    expect(rule).toContain("background: #ffffff");
    expect(rule).toContain("border: 1px solid var(--line)");
    expect(rule).not.toContain("backdrop-filter");
    expect(rule).not.toContain("box-shadow");
  });
});
