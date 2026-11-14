// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminLawyersPage } from "./admin-lawyers-page";

const mocks = vi.hoisted(() => ({ lawyers: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { email: "admin@example.test" } }) }));
vi.mock("@/lib/client-api", () => ({ fetchAdminReferencedLawyers: mocks.lawyers }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
// Chaque panneau a son propre test : ici, seul le choix des onglets compte.
vi.mock("@/components/admin/AdminLawyerReferralRequestsPanel", () => ({
  LAWYER_REFERRAL_REQUESTS_QUERY_KEY: ["admin-lawyer-referral-requests"],
  AdminLawyerReferralRequestsPanel: () => <p>Panneau des mises en relation</p>,
}));
// Ces deux panneaux sont chargés à la demande (next/dynamic) : leur module simulé est attendu.
vi.mock("@/components/admin/AdminReferencedLawyersPanel", () => ({
  AdminReferencedLawyersPanel: () => <p>Panneau du réseau</p>,
}));
vi.mock("@/components/admin/AdminLawyerStatementPanel", () => ({
  AdminLawyerStatementPanel: () => <p>Panneau du relevé</p>,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderPage() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminLawyersPage />
    </QueryClientProvider>,
  );
}

describe("AdminLawyersPage", () => {
  it("masque le réseau et le relevé tant qu'aucun avocat n'est référencé, sans les rendre injoignables", async () => {
    mocks.lawyers.mockResolvedValue({ lawyers: [] });
    renderPage();

    expect(await screen.findByText(/Aucun avocat référencé/)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Réseau référencé" })).toBeNull();
    expect(screen.getByText("Panneau des mises en relation")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Référencer un avocat" }));
    const directory = screen.getByRole("tab", { name: "Réseau référencé" });
    expect(directory.getAttribute("aria-selected")).toBe("true");
    // Chargé à la demande : le panneau arrive après « Chargement de l’onglet… ».
    expect(await within(screen.getByRole("tabpanel")).findByText("Panneau du réseau")).toBeTruthy();
  });

  it("montre les trois onglets, accessibles, dès le premier avocat référencé", async () => {
    mocks.lawyers.mockResolvedValue({ lawyers: [{ id: "avocat-1" }] });
    renderPage();

    const list = await screen.findByRole("tablist", { name: "Rubriques des avocats" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Mises en relation",
      "Réseau référencé",
      "Relevé mensuel",
    ]);
    expect(list).toBeTruthy();
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(screen.queryByText(/Aucun avocat référencé/)).toBeNull();

    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Relevé mensuel" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await within(screen.getByRole("tabpanel")).findByText("Panneau du relevé")).toBeTruthy();
  });

  it("ne cache rien quand la liste des avocats est illisible", async () => {
    mocks.lawyers.mockRejectedValue(new Error("Indisponible"));
    renderPage();

    expect(await screen.findByRole("tab", { name: "Réseau référencé" })).toBeTruthy();
    expect(screen.queryByText(/Aucun avocat référencé/)).toBeNull();
  });
});
