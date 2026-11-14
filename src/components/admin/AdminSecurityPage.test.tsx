// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listFactors: vi.fn(), level: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { email: "admin@example.test" } }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      mfa: { listFactors: mocks.listFactors, getAuthenticatorAssuranceLevel: mocks.level },
    },
  },
}));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  AdminShell: ({ children, title }: { children: ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

import { AdminSecurityPage } from "./AdminSecurityPage";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const noFactor = { data: { all: [] }, error: null };
const aal1 = { data: { currentLevel: "aal1" }, error: null };

describe("AdminSecurityPage", () => {
  it("affiche une erreur lisible avec « Réessayer » quand la lecture des facteurs échoue", async () => {
    mocks.listFactors.mockRejectedValue(new Error("JWT not in base64url format"));
    mocks.level.mockResolvedValue(aal1);
    render(<AdminSecurityPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("n’a pas pu être lu");
    expect(alert.textContent).not.toContain("JWT");
    expect(screen.queryByText("Chargement…")).toBeNull();
    // État inconnu : aucun enrôlement n'est proposé.
    expect(screen.queryByRole("button", { name: /Configurer/ })).toBeNull();

    mocks.listFactors.mockResolvedValue(noFactor);
    fireEvent.click(within(alert).getByRole("button", { name: "Réessayer" }));

    expect(
      await screen.findByRole("button", { name: "Configurer l'application d'authentification" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("traite une erreur renvoyée par Supabase comme un échec de lecture", async () => {
    mocks.listFactors.mockResolvedValue({ data: null, error: new Error("Session expirée") });
    mocks.level.mockResolvedValue(aal1);
    render(<AdminSecurityPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("n’a pas pu être lu");
    expect(screen.queryByRole("button", { name: /Configurer/ })).toBeNull();
  });

  it("garde l'habillage de l'administration et propose l'enrôlement sans facteur", async () => {
    mocks.listFactors.mockResolvedValue(noFactor);
    mocks.level.mockResolvedValue(aal1);
    render(<AdminSecurityPage />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sécurité du compte");
    expect(
      await screen.findByRole("button", { name: "Configurer l'application d'authentification" }),
    ).toBeTruthy();
  });
});
