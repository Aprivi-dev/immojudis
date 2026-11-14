// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SiteFooter, showsSiteFooter } from "./SiteFooter";
import { SiteFooterSaleTypes } from "./SiteFooterSaleTypes";
import { SALE_LANDING_KEYS, SALE_LANDING_PAGES } from "@/lib/sale-landing-pages";

const pathname = vi.hoisted(() => ({ current: "/sales" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));
// Lien réduit à une ancre qui expose `prefetch` : le vrai `<Link>` ne l'écrit pas dans le HTML.
vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean;
    children: React.ReactNode;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  pathname.current = "/sales";
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

/** Le pied de page tel que le layout le compose : le groupe « Ventes par type » rendu à part. */
function renderFooter() {
  return render(<SiteFooter saleTypes={<SiteFooterSaleTypes />} />);
}

it("gives every public page access to the legal documents", () => {
  renderFooter();
  const legal = within(screen.getByRole("navigation", { name: "Informations légales" }));
  expect(legal.getByRole("link", { name: "Mentions légales" }).getAttribute("href")).toBe("/legal");
  expect(legal.getByRole("link", { name: "Conditions générales" }).getAttribute("href")).toBe(
    "/conditions-generales",
  );
  expect(legal.getByRole("link", { name: "Confidentialité" }).getAttribute("href")).toBe(
    "/privacy",
  );
  expect(legal.getByRole("link", { name: "Mes droits" }).getAttribute("href")).toBe("/mes-droits");
});

it("renvoie, depuis toutes les pages, vers la déclaration d'accessibilité (état non évalué)", () => {
  renderFooter();
  const legal = within(screen.getByRole("navigation", { name: "Informations légales" }));
  expect(legal.getByRole("link", { name: "Accessibilité : non évalué" }).getAttribute("href")).toBe(
    "/accessibilite",
  );
});

it("renvoie, depuis toutes les pages, vers l'explication du classement des annonces", () => {
  renderFooter();
  const legal = within(screen.getByRole("navigation", { name: "Informations légales" }));
  expect(legal.getByRole("link", { name: "Classement des annonces" }).getAttribute("href")).toBe(
    "/classement-des-annonces",
  );
});

it("renvoie vers l'index des ventes par département, et non vers chaque département", () => {
  renderFooter();
  const main = within(screen.getByRole("navigation", { name: "Navigation pied de page" }));
  expect(main.getByRole("link", { name: "Par département" }).getAttribute("href")).toBe(
    "/ventes-encheres-immobilieres",
  );
  expect(main.getAllByRole("link").map((link) => link.getAttribute("href"))).not.toContain(
    "/ventes-encheres-immobilieres/gironde",
  );
});

it("renvoie vers les audiences à venir", () => {
  renderFooter();
  const main = within(screen.getByRole("navigation", { name: "Navigation pied de page" }));
  expect(main.getByRole("link", { name: "Audiences à venir" }).getAttribute("href")).toBe(
    "/audiences-a-venir",
  );
});

it("groupe les pages de transparence : à propos, guide, simulateur et méthodes", () => {
  renderFooter();
  const transparency = within(screen.getByRole("navigation", { name: "Transparence" }));
  expect(
    transparency.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
  ).toEqual([
    ["À propos", "/a-propos"],
    ["Guide des ventes judiciaires", "/ventes-immobilieres-judiciaires"],
    ["Simulateur de frais", "/simulateur-frais-encheres"],
    ["Méthode de l’écart avec le marché", "/methode-ecart-marche"],
    ["Méthode Pépite", "/methode-pepites"],
  ]);
});

it("renvoie vers les pages par type de bien ou de vente, celles du registre, dans son ordre", () => {
  renderFooter();
  const types = within(screen.getByRole("navigation", { name: "Ventes par type" }));
  expect(
    types.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
  ).toEqual(
    SALE_LANDING_KEYS.map((key) => [SALE_LANDING_PAGES[key].label, SALE_LANDING_PAGES[key].path]),
  );
});

it("place le groupe « Ventes par type », rendu côté serveur, entre la navigation et la transparence", () => {
  renderFooter();
  const footer = within(screen.getByRole("contentinfo"));
  expect(footer.getAllByRole("navigation").map((nav) => nav.getAttribute("aria-label"))).toEqual([
    "Navigation pied de page",
    "Ventes par type",
    "Transparence",
    "Informations légales",
  ]);
});

it("présente le groupe « Ventes par type » comme le groupe « Transparence »", () => {
  renderFooter();
  const types = screen.getByRole("navigation", { name: "Ventes par type" });
  const transparency = screen.getByRole("navigation", { name: "Transparence" });
  expect(types.className).toBe(transparency.className);
  for (const selector of ["p", "ul", "li", "a"]) {
    expect(types.querySelector(selector)!.className, selector).toBe(
      transparency.querySelector(selector)!.className,
    );
  }
});

it("masque les pages des notaires et de l'État quand l'interrupteur des pilotes est coupé", () => {
  vi.stubEnv("NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED", "false");
  renderFooter();
  const types = within(screen.getByRole("navigation", { name: "Ventes par type" }));
  expect(types.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
    "/maison-aux-encheres",
    "/appartement-aux-encheres",
  ]);
});

it("reprend le pictogramme du favicon (le temple) et l'accroche unique", () => {
  const { container } = renderFooter();
  expect(container.textContent).toContain("Les enchères immobilières, en toute clarté.");
  expect(container.querySelector("svg path.stroke-gold")).not.toBeNull();
  expect(container.querySelector(".lucide")).toBeNull();
});

it("ne précharge aucun de ses liens : présents sur chaque page, ils lanceraient une dizaine d'appels serveur par visite", () => {
  const { container } = renderFooter();
  const links = [...container.querySelectorAll("footer a")];
  expect(links.length).toBeGreaterThan(15);
  for (const link of links) {
    expect(link.getAttribute("data-prefetch"), link.getAttribute("href") ?? "").toBe("false");
  }
});

it("donne à chaque lien du pied de page une cible tactile d'au moins 44 px", () => {
  renderFooter();
  const links = within(screen.getByRole("contentinfo")).getAllByRole("link");
  expect(links.length).toBeGreaterThan(15);
  for (const link of links) {
    expect(link.className, link.textContent ?? "").toContain("min-h-11");
  }
});

it("stays out of the admin console", () => {
  expect(showsSiteFooter("/admin")).toBe(false);
  expect(showsSiteFooter("/admin/operations")).toBe(false);
  expect(showsSiteFooter("/administration-publique")).toBe(true);
  pathname.current = "/admin/quality";
  const { container } = renderFooter();
  expect(container.querySelector("footer")).toBeNull();
});
