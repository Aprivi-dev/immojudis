// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/publish",
  replace: vi.fn(),
  push: vi.fn(),
  auth: { user: null, profile: null, loading: false } as {
    user: { id: string } | null;
    profile: null;
    loading: boolean;
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
