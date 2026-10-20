// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  unavailablePilotage,
  type AdminPilotage,
  type PilotageEventCounts,
  type PilotagePeriod,
  type PilotageWindow,
} from "@/lib/admin-pilotage";
import { AdminPilotagePage, MASKED, NOT_MEASURED } from "./admin-pilotage-page";

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

const counts = (scale: number): PilotageEventCounts => ({
  unlocks: 3 * scale,
  quotaReached: {
    total: 5 * scale,
    unlocks: 1 * scale,
    favorites: 2 * scale,
    daily: 4 * scale,
    dailyAccount: 2 * scale,
    dailyShared: 1 * scale,
  },
  bidCeilings: 7 * scale,
  calendarExports: 0,
  emailClicks: { total: 9 * scale, alert: 6 * scale, reminder: 3 * scale },
});

const period = (scale: number, signups: number): PilotagePeriod => ({
  since: "2026-10-27T06:00:00Z",
  until: "2026-11-03T06:00:00Z",
  signups,
  signupsConfirmed: signups - 2,
  activeAccounts: 25,
  activeNew: 9,
  activeReturning: 16,
  alertsCreated: 8,
  waitlistRequests: 4,
  dossiers: 12,
  dossierAccounts: 6,
  remindersSent: 20,
  reminderAccounts: 7,
  eventsComplete: true,
  events: { ...counts(scale), accounts: counts(scale + 1) },
});

const window7: PilotageWindow = { ...period(2, 10), days: 7, previous: period(4, 15) };
const window30: PilotageWindow = {
  ...period(2, 40),
  days: 30,
  eventsComplete: false,
  events: { ...period(2, 40).events, unlocks: 12 },
  previous: null,
};
const data: AdminPilotage = {
  generatedAt: "2026-11-03T06:00:00Z",
  eventsMeasuredSince: "2026-10-25T08:00:00Z",
  waitlistActive: 12,
  snapshot: {
    accountsTotal: 45,
    accountsConfirmed: 40,
    launchOfferActive: true,
    launchOfferAccounts: 33,
    reminderConsentsActive: 14,
    dossiersTotal: 40,
    dossierAccountsTotal: 18,
  },
  windows: [window30, window7],
};

/** Cellules (7 jours, 7 jours précédents, 30 jours) de la ligne dont l'en-tête est ce libellé. */
function cells(label: string) {
  const row = screen.getByRole("rowheader", { name: label }).closest("tr")!;
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

describe("page admin Pilotage", () => {
  it("shows the week, the previous week and 30 days, columns in that order", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByRole("rowheader", { name: "Inscriptions (comptes créés)" });
    expect(screen.getByRole("heading", { name: "Pilotage" })).toBeTruthy();
    const heads = screen.getAllByRole("columnheader").map((head) => head.textContent);
    expect(heads).toEqual(["Mesure", "7 jours", "7 jours précédents", "30 jours"]);

    expect(cells("Inscriptions (comptes créés)")).toEqual(["10", "15", "40"]);
    expect(cells("dont adresse email confirmée")).toEqual(["8", "13", "38"]);
    expect(cells("Comptes actifs (au moins une connexion)")).toEqual(["25", "25", "25"]);
    expect(cells("dont nouveaux (créés dans la période)")).toEqual(["9", "9", "9"]);
    expect(cells("dont revenus (créés avant la période)")).toEqual(["16", "16", "16"]);
    expect(cells("Alertes créées")).toEqual(["8", "8", "8"]);
    // La semaine précédente est calculée pour la semaine seulement.
    expect(cells("Demandes « Me prévenir de l’ouverture »")).toEqual([MASKED, MASKED, MASKED]);
    expect(cells("Dossiers enregistrés (statut ou enchère plafond sur un favori)")[0]).toContain(
      "12",
    );
    expect(cells("Rappels d’audience envoyés")[0]).toContain("20");
  });

  it("shows occurrences and distinct accounts side by side", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByRole("rowheader", { name: "Déblocages de ventes" });
    const [week, previous] = cells("Déblocages de ventes");
    expect(week).toBe("69 comptes");
    expect(previous).toBe("1215 comptes");
    expect(cells("Quotas atteints")[0]).toBe("1015 comptes");
  });

  it("splits the daily cap between the account limit and the address or site limit", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByRole("rowheader", { name: "dont plafonds quotidiens" });
    // Occurrences puis comptes : 8 plafonds par 12 comptes, dont 4 / 6 pour le compte et 2 / 3 partagés.
    expect(cells("dont plafonds quotidiens")[0]).toBe("812 comptes");
    expect(cells("plafond quotidien du compte (limite par compte)")[0]).toBe(`${MASKED}6 comptes`);
    expect(cells("plafond quotidien de l’adresse ou du site (limite partagée)")[0]).toBe(
      `${MASKED}${MASKED} comptes`,
    );
    // 8 - 4 - 2 = 2 plafonds d'avant la distinction : sous 5, masqués.
    expect(cells("plafond quotidien, avant la distinction compte / adresse")[0]).toBe(MASKED);
  });

  it("masks every value under 5 as « moins de 5 », a zero included, and keeps the others exact", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByRole("rowheader", { name: "Exports agenda (.ics)" });
    // calendarExports vaut 0 : masqué comme les autres valeurs inférieures à 5.
    expect(cells("Exports agenda (.ics)")[0]).toBe(`${MASKED}${MASKED} comptes`);
    expect(cells("dont déblocages du mois")[0]).toBe(`${MASKED}${MASKED} comptes`);
    expect(cells("Plafonds d’enchère calculés")[0]).toBe("1421 comptes");
    expect(screen.queryByText(/^[0-4]$/)).toBeNull();
  });

  it("warns that under about 30 accounts the figures cannot support a conclusion", async () => {
    mocks.fetchPilotage.mockResolvedValue({
      ...data,
      snapshot: { ...data.snapshot, accountsTotal: 12 },
    });
    renderPage();

    const note = await screen.findByRole("note");
    expect(note.textContent).toContain(
      "Sous environ 30 comptes, ces chiffres ne permettent pas de conclure",
    );
  });

  it("does not warn from 30 accounts", async () => {
    mocks.fetchPilotage.mockResolvedValue({
      ...data,
      snapshot: { ...data.snapshot, accountsTotal: 30 },
    });
    renderPage();

    await screen.findByRole("rowheader", { name: "Alertes créées" });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows the snapshot: consents, dossiers, launch offer accounts", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByText("État à cet instant");
    const term = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(term("Consentements actifs aux rappels d’audience")).toBe("14");
    expect(term("Dossiers enregistrés en tout")).toBe("40");
    expect(term("Comptes sous l’offre de lancement")).toBe("33");
    expect(term("Demandes de liste d’attente actives")).toBe("12");
  });

  it("says when the 30-day window is only partly measured, with the start date", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByRole("rowheader", { name: "Déblocages de ventes" });
    const [week, , month] = cells("Déblocages de ventes");
    expect(month).toMatch(/depuis le 25 octobre 2026/);
    expect(week).not.toMatch(/depuis le/);
    expect(cells("Inscriptions (comptes créés)")[2]).toBe("40");
  });

  it("keeps the secondary text at /70 contrast or more", async () => {
    mocks.fetchPilotage.mockResolvedValue(data);
    renderPage();

    await screen.findByRole("rowheader", { name: "Alertes créées" });
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/text-brand-navy\/(?:[1-6]\d|[1-9])(?!\d)/);
    expect(html).toContain("text-brand-navy/70");
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
      expect(cells(label), label).toEqual([NOT_MEASURED, NOT_MEASURED, NOT_MEASURED]);
    }
    expect(screen.queryByText("0")).toBeNull();
    // Sans nombre de comptes, l'avertissement s'affiche.
    expect(screen.getByRole("note")).toBeTruthy();
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
