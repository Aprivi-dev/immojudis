// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestOpenNotifications } from "@/lib/notification-center-events";
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
const signOut = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut } },
}));
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

beforeEach(() => {
  state.pathname = "/avocats";
  state.user = null;
  state.profile = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    expect(
      screen.getByRole("link", { name: /^Immo\s*judis\s*,\s*accueil$/ }).textContent,
    ).toContain("Immojudis");
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

  it("ne monte pas le menu mobile avant le premier appui, puis le ferme et rend le focus au bouton", async () => {
    render(<SiteHeader />);
    const button = screen.getByRole("button", { name: "Ouvrir le menu" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(button);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe("site-mobile-navigation");

    fireEvent.click(screen.getByRole("button", { name: "Fermer le menu" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("ouvre le menu « Mon compte » avec les pages de l'espace personnel et la déconnexion", async () => {
    state.user = { id: "user-1" };
    render(<SiteHeader />);
    const trigger = await waitFor(() => {
      const found = screen.getByRole("button", { name: /Mon compte/ });
      expect(found.getAttribute("aria-haspopup")).toBe("dialog");
      return found;
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    const link = await screen.findByRole("link", { name: "Mes favoris" });
    expect(link.getAttribute("href")).toBe("/favoris");

    fireEvent.click(screen.getByRole("button", { name: "Déconnexion" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("donne accès, depuis le menu mobile, à Connexion, Ressources et aux pages légales", async () => {
    state.pathname = "/sales";
    render(<SiteHeader placement="sticky" center={<input aria-label="Ville" />} />);
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le menu" }));

    const menu = within(await screen.findByRole("navigation", { name: "Navigation mobile" }));
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

  it("ajoute les pages de l'espace personnel au menu mobile d'une personne connectée", async () => {
    state.user = { id: "user-1" };
    render(<SiteHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le menu" }));
    const menu = within(await screen.findByRole("navigation", { name: "Navigation mobile" }));
    for (const label of ["Mes favoris", "Mes alertes", "Mes comparaisons", "Mon compte"]) {
      expect(menu.getByRole("link", { name: label })).toBeTruthy();
    }
  });
});

describe("SiteHeader : notifications sur mobile", () => {
  it("relie le bouton du menu au texte des non-lus seulement pour une personne connectée", () => {
    const { unmount } = render(<SiteHeader />);
    expect(
      screen.getByRole("button", { name: "Ouvrir le menu" }).getAttribute("aria-describedby"),
    ).toBeNull();
    unmount();

    state.user = { id: "user-1" };
    render(<SiteHeader />);
    expect(
      screen.getByRole("button", { name: "Ouvrir le menu" }).getAttribute("aria-describedby"),
    ).toBe("site-mobile-menu-unread");
  });

  it("ouvre le menu mobile quand un message demande de voir les notifications sous lg", async () => {
    state.user = { id: "user-1" };
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    render(<SiteHeader />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => requestOpenNotifications());
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("laisse la cloche de la barre répondre à partir de lg, sans ouvrir le menu mobile", () => {
    state.user = { id: "user-1" };
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    render(<SiteHeader />);
    act(() => requestOpenNotifications());
    expect(screen.queryByRole("dialog")).toBeNull();
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
