// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/publish",
  replace: vi.fn(),
  push: vi.fn(),
  retry: vi.fn(),
  auth: { user: null, profile: null, loading: false } as {
    user: { id: string } | null;
    profile: null;
    loading: boolean;
    authError?: string | null;
    authErrorKind?: "expired" | "unavailable" | null;
    retry?: () => void;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
    refresh: vi.fn(),
    back: vi.fn(),
  }),
  // The gate must not subscribe to the query string while rendering.
  useSearchParams: () => {
    throw new Error("AuthGate must read the query string only when it redirects");
  },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/components/admin/AdminMfaGate", () => ({
  AdminMfaGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AuthGate } from "./AuthGate";

beforeEach(() => {
  mocks.pathname = "/publish";
  mocks.auth = { user: null, profile: null, loading: false };
  window.history.replaceState(null, "", "/publish?brouillon=1");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("AuthGate", () => {
  it("renvoie un visiteur non connecté vers /login en gardant la page et sa requête", () => {
    render(
      <AuthGate>
        <p>Contenu protégé</p>
      </AuthGate>,
    );
    expect(mocks.replace).toHaveBeenCalledWith("/login?redirect=%2Fpublish%3Fbrouillon%3D1");
    expect(screen.queryByText("Contenu protégé")).toBeNull();
  });

  it("ne redirige pas tant que la session est en cours de chargement", () => {
    mocks.auth = { user: null, profile: null, loading: true };
    render(
      <AuthGate>
        <p>Contenu protégé</p>
      </AuthGate>,
    );
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByText("Vérification de l'accès")).toBeTruthy();
  });

  describe("identité impossible à vérifier", () => {
    const unverified = (kind: "expired" | "unavailable") => ({
      user: null,
      profile: null,
      loading: false,
      authError: "Votre session n’a pas pu être vérifiée.",
      authErrorKind: kind,
      retry: mocks.retry,
    });

    it("affiche le bandeau au lieu de renvoyer vers /login, avec « Réessayer » et « Se reconnecter »", () => {
      mocks.pathname = "/favoris";
      mocks.auth = unverified("unavailable");
      window.history.replaceState(null, "", "/favoris");
      render(
        <AuthGate>
          <p>Contenu protégé</p>
        </AuthGate>,
      );
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(screen.queryByText("Contenu protégé")).toBeNull();
      expect(screen.getByText("Nous n’avons pas pu vérifier votre connexion.")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Se reconnecter" }).getAttribute("href")).toBe(
        "/login?redirect=%2Ffavoris",
      );
      fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
      expect(mocks.retry).toHaveBeenCalledTimes(1);
    });

    it.each(["/favoris", "/alertes", "/compte"])("couvre %s", (path) => {
      mocks.pathname = path;
      mocks.auth = unverified("unavailable");
      render(
        <AuthGate>
          <p>Contenu protégé</p>
        </AuthGate>,
      );
      expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
      expect(mocks.replace).not.toHaveBeenCalled();
    });

    it("ne propose que la reconnexion quand la session est rejetée", () => {
      mocks.pathname = "/compte";
      mocks.auth = unverified("expired");
      render(
        <AuthGate>
          <p>Contenu protégé</p>
        </AuthGate>,
      );
      expect(screen.getByText(/Votre session a expiré/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
      expect(screen.getByRole("link", { name: "Se reconnecter" })).toBeTruthy();
    });

    it("garde la page affichée, sous le bandeau, pour une identité déjà vérifiée", () => {
      mocks.pathname = "/favoris";
      mocks.auth = { ...unverified("unavailable"), user: { id: "u1" } };
      render(
        <AuthGate>
          <p>Contenu protégé</p>
        </AuthGate>,
      );
      expect(screen.getByText("Contenu protégé")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    });

    it("n'ajoute aucun bandeau sur une page publique", () => {
      mocks.pathname = "/sales";
      mocks.auth = unverified("unavailable");
      render(
        <AuthGate>
          <p>Catalogue</p>
        </AuthGate>,
      );
      expect(screen.getByText("Catalogue")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("laisse les pages publiques s'afficher sans redirection", () => {
    mocks.pathname = "/sales";
    render(
      <AuthGate>
        <p>Catalogue</p>
      </AuthGate>,
    );
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByText("Catalogue")).toBeTruthy();
  });
});
