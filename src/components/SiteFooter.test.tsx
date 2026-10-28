// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SiteFooter, showsSiteFooter } from "./SiteFooter";

const pathname = vi.hoisted(() => ({ current: "/sales" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

beforeEach(() => {
  pathname.current = "/sales";
});
afterEach(cleanup);

it("gives every public page access to the legal documents", () => {
  render(<SiteFooter />);
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

it("renvoie, depuis toutes les pages, vers l'explication du classement des annonces", () => {
  render(<SiteFooter />);
  const legal = within(screen.getByRole("navigation", { name: "Informations légales" }));
  expect(legal.getByRole("link", { name: "Classement des annonces" }).getAttribute("href")).toBe(
    "/classement-des-annonces",
  );
});

it("renvoie vers l'index des ventes par département, et non vers chaque département", () => {
  render(<SiteFooter />);
  const main = within(screen.getByRole("navigation", { name: "Navigation pied de page" }));
  expect(main.getByRole("link", { name: "Par département" }).getAttribute("href")).toBe(
    "/ventes-encheres-immobilieres",
  );
  expect(main.getAllByRole("link").map((link) => link.getAttribute("href"))).not.toContain(
    "/ventes-encheres-immobilieres/gironde",
  );
});

it("renvoie vers les audiences à venir", () => {
  render(<SiteFooter />);
  const main = within(screen.getByRole("navigation", { name: "Navigation pied de page" }));
  expect(main.getByRole("link", { name: "Audiences à venir" }).getAttribute("href")).toBe(
    "/audiences-a-venir",
  );
});

it("groupe les pages de transparence : à propos, guide, simulateur et méthodes", () => {
  render(<SiteFooter />);
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

it("reprend le pictogramme du favicon (le temple) et l'accroche unique", () => {
  const { container } = render(<SiteFooter />);
  expect(container.textContent).toContain("Les enchères immobilières, en toute clarté.");
  expect(container.querySelector("svg path[stroke='#c98d45']")).not.toBeNull();
  expect(container.querySelector(".lucide")).toBeNull();
});

it("stays out of the admin console", () => {
  expect(showsSiteFooter("/admin")).toBe(false);
  expect(showsSiteFooter("/admin/operations")).toBe(false);
  expect(showsSiteFooter("/administration-publique")).toBe(true);
  pathname.current = "/admin/quality";
  const { container } = render(<SiteFooter />);
  expect(container.querySelector("footer")).toBeNull();
});
