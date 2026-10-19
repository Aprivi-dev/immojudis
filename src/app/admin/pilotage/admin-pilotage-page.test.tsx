// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unavailablePilotage, type AdminPilotage, type PilotageWindow } from "@/lib/admin-pilotage";
import { AdminPilotagePage, NOT_MEASURED } from "./admin-pilotage-page";

const mocks = vi.hoisted(() => ({ fetchPilotage: vi.fn() }));
vi.mock("@/lib/client-api/admin", () => ({ fetchAdminPilotage: mocks.fetchPilotage }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { email: "admin@example.test" } }) }));
vi.mock("@/components/admin/AdminShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/admin/AdminShell")>()),
  AdminShell: ({ children, title }: { children: ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
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
      <AdminPilotagePage />
    </QueryClientProvider>,
  );
}

const window7: PilotageWindow = {
  days: 7,
  since: "2026-10-27T06:00:00Z",
  signups: 10,
  activeAccounts: 25,
  alertsCreated: 8,
  waitlistRequests: 4,
  eventsComplete: true,
  events: {
    unlocks: 3,
    quotaReached: { total: 5, unlocks: 1, favorites: 2, daily: 2 },
    bidCeilings: 7,
    calendarExports: 0,
    emailClicks: { total: 9, alert: 6, reminder: 3 },
  },
};
const window30: PilotageWindow = {
  ...window7,
  days: 30,
  signups: 40,
  eventsComplete: false,
  events: { ...window7.events, unlocks: 12 },
};
const data: AdminPilotage = {
  generatedAt: "2026-11-03T06:00:00Z",
  eventsMeasuredSince: "2026-10-25T08:00:00Z",
  waitlistActive: 12,
  windows: [window30, window7],
};

/** Cellules (7 jours, 30 jours) de la ligne dont l'en-tête est ce libellé. */
function cells(label: string) {
  const row = screen.getByRole("rowheader", { name: label }).closest("tr")!;
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

describe("page admin Pilotage", () => {
  it("shows the exact figures for 7 and 30 days, columns in that order", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByRole("rowheader", { name: "Inscriptions (comptes créés)" });
    expect(screen.getByRole("heading", { name: "Pilotage" })).toBeTruthy();
    const heads = screen.getAllByRole("columnheader").map((head) => head.textContent);
    expect(heads).toEqual(["Mesure", "7 jours", "30 jours"]);

    expect(cells("Inscriptions (comptes créés)")).toEqual(["10", "40"]);
    expect(cells("Comptes actifs (au moins une connexion)")).toEqual(["25", "25"]);
    expect(cells("Alertes créées")).toEqual(["8", "8"]);
    expect(cells("Demandes « Me prévenir de l’ouverture »")).toEqual(["4", "4"]);
    expect(cells("Quotas atteints")[0]).toBe("5");
    expect(cells("dont favoris")[0]).toBe("2");
    expect(cells("Plafonds d’enchère calculés")[0]).toBe("7");
    expect(cells("Clics d’email")[0]).toBe("9");
    expect(cells("dont rappels d’audience")[0]).toBe("3");
    // Un vrai zéro reste un zéro.
    expect(cells("Exports agenda (.ics)")[0]).toBe("0");
    expect(
      screen.getByText(/Demandes de liste d’attente actives à cet instant/).textContent,
    ).toContain("12");
  });

  it("says when the 30-day window is only partly measured, with the start date", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByRole("rowheader", { name: "Déblocages de ventes" });
    const [week, month] = cells("Déblocages de ventes");
    expect(week).toBe("3");
    expect(month).toContain("12");
    expect(month).toMatch(/depuis le 25 octobre 2026/);
    expect(week).not.toMatch(/depuis le/);
    // Les chiffres qui ne viennent pas des événements ne portent pas cette mention.
    expect(cells("Inscriptions (comptes créés)")[1]).toBe("40");
  });

  it("shows « non mesuré » for every absent figure, never a zero", async () => {
    mocks.fetchPilotage.mockResolvedValue(unavailablePilotage());
    renderPage();

    await screen.findByRole("rowheader", { name: "Inscriptions (comptes créés)" });
    for (const label of [
      "Inscriptions (comptes créés)",
      "Comptes actifs (au moins une connexion)",
      "Déblocages de ventes",
      "Quotas atteints",
      "Plafonds d’enchère calculés",
      "Exports agenda (.ics)",
      "Clics d’email",
      "Alertes créées",
      "Demandes « Me prévenir de l’ouverture »",
    ]) {
      expect(cells(label), label).toEqual([NOT_MEASURED, NOT_MEASURED]);
    }
    expect(screen.queryByText("0")).toBeNull();
  });

  it("lists aggregates only: no person, no email address", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByRole("rowheader", { name: "Alertes créées" });
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/@/);
  });

  it("reports a loading failure and lets the administrator retry", async () => {
    mocks.fetchPilotage.mockRejectedValue(new Error("Pilotage indisponible"));
    renderPage();

    expect((await screen.findByRole("alert")).textContent).toContain("Pilotage indisponible");
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
