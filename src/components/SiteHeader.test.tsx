// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Navbar } from "./Navbar";
import { SiteHeader } from "./SiteHeader";

const state = vi.hoisted(() => ({
  pathname: "/avocats",
  user: null as null | { id: string },
  profile: null as null | { account_type: string },
}));

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: state.user, profile: state.profile, loading: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

beforeEach(() => {
  state.pathname = "/avocats";
  state.user = null;
  state.profile = null;
});
afterEach(cleanup);

describe("SiteHeader", () => {
  it("expose les mêmes cinq entrées quel que soit le thème", () => {
    const labels = ["Ventes", "Tribunaux", "Avocats", "Ressources", "Offres"];
    for (const theme of ["light", "dark"] as const) {
      const { unmount } = render(<SiteHeader theme={theme} />);
      const nav = within(screen.getByRole("navigation", { name: "Navigation principale" }));
      expect(nav.getAllByRole("link").map((link) => link.textContent)).toEqual(labels);
      unmount();
    }
  });

  it("écrit Immojudis d'une seule façon", () => {
    render(<SiteHeader />);
    expect(screen.getByRole("link", { name: "Immojudis, accueil" }).textContent).toContain(
      "Immojudis",
    );
  });

  it("marque la page courante", () => {
    render(<SiteHeader />);
    const nav = within(screen.getByRole("navigation", { name: "Navigation principale" }));
    expect(nav.getByRole("link", { name: "Avocats" }).getAttribute("aria-current")).toBe("page");
    expect(nav.getByRole("link", { name: "Offres" }).getAttribute("aria-current")).toBeNull();
  });

  it("propose Connexion à un visiteur et Mon compte à une personne connectée", () => {
    const { unmount } = render(<SiteHeader />);
    expect(screen.getByRole("link", { name: "Connexion" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByRole("button", { name: /Mon compte/ })).toBeNull();
    unmount();

    state.user = { id: "user-1" };
    render(<SiteHeader />);
    expect(screen.getByRole("button", { name: /Mon compte/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Connexion" })).toBeNull();
  });

  it("donne accès, depuis le menu mobile, à Connexion, Ressources et aux pages légales", () => {
    state.pathname = "/sales";
    render(<SiteHeader placement="sticky" center={<input aria-label="Ville" />} />);
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le menu" }));

    const menu = within(screen.getByRole("navigation", { name: "Navigation mobile" }));
    expect(menu.getByRole("link", { name: "Ressources" }).getAttribute("href")).toBe("/ressources");
    expect(menu.getByRole("link", { name: "Mentions légales" }).getAttribute("href")).toBe(
      "/legal",
    );
    expect(menu.getByRole("link", { name: "Conditions générales" })).toBeTruthy();
    expect(menu.getByRole("link", { name: "Confidentialité" })).toBeTruthy();
    expect(menu.getByRole("link", { name: "Mes droits" })).toBeTruthy();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("link", { name: "Connexion" }).getAttribute("href")).toBe("/login");
  });

  it("ajoute les pages de l'espace personnel au menu mobile d'une personne connectée", () => {
    state.user = { id: "user-1" };
    render(<SiteHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le menu" }));
    const menu = within(screen.getByRole("navigation", { name: "Navigation mobile" }));
    for (const label of ["Mes favoris", "Mes alertes", "Mes comparaisons", "Mon compte"]) {
      expect(menu.getByRole("link", { name: label })).toBeTruthy();
    }
  });
});

describe("Navbar", () => {
  it("laisse le catalogue et la console d'administration afficher leur propre en-tête", () => {
    for (const pathname of ["/sales", "/admin", "/admin/quality"]) {
      state.pathname = pathname;
      const { container, unmount } = render(<Navbar />);
      expect(container.querySelector("header")).toBeNull();
      unmount();
    }
  });

  it("utilise le thème sombre uniquement sur l'accueil", () => {
    state.pathname = "/";
    const { container, unmount } = render(<Navbar />);
    expect(container.querySelector("header")?.getAttribute("data-theme")).toBe("dark");
    unmount();
    state.pathname = "/offres";
    const second = render(<Navbar />);
    expect(second.container.querySelector("header")?.getAttribute("data-theme")).toBe("light");
  });
});
