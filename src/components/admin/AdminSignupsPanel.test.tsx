// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminSignupAccount, AdminSignupListResponse } from "@/lib/admin-signups";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  extend: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/client-api/admin-signups", () => ({
  fetchAdminSignups: mocks.list,
  extendAdminSignupTrials: mocks.extend,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  AdminSectionHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

import { AdminSignupsPanel } from "./AdminSignupsPanel";

function account(overrides: Partial<AdminSignupAccount>): AdminSignupAccount {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    email: "investisseur@exemple.fr",
    fullName: null,
    accountType: "b2c",
    createdAt: "2026-10-25T09:00:00.000Z",
    emailConfirmedAt: "2026-10-25T09:05:00.000Z",
    lastSignInAt: "2026-10-26T18:00:00.000Z",
    access: "trial",
    accessEndsAt: "2026-11-01T09:05:00.000Z",
    trialEndsAt: "2026-11-01T09:05:00.000Z",
    extendable: true,
    usage: { unlocks: 0, ceilings: 1, favorites: 2, sheetsServed: 3 },
    ...overrides,
  };
}

function listResponse(accounts: AdminSignupAccount[]): AdminSignupListResponse {
  return {
    accounts,
    summary: {
      total: accounts.length,
      confirmed: accounts.length,
      last7Days: accounts.length,
      last30Days: accounts.length,
      byAccess: {
        trial: 1,
        trial_extended: 0,
        analyse_paid: 0,
        analyse_manual: 0,
        premium: 1,
        decouverte: 0,
      },
      trialEndedIdle: 2,
    },
    filteredCount: accounts.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    launchOfferActive: true,
    truncated: false,
    usageAvailable: true,
    generatedAt: "2026-10-27T12:00:00.000Z",
  };
}

function renderPanel() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminSignupsPanel />
    </QueryClientProvider>,
  );
}

describe("AdminSignupsPanel", () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue(
      listResponse([
        account({}),
        account({
          userId: "00000000-0000-4000-8000-000000000002",
          email: "premium@exemple.fr",
          access: "premium",
          accessEndsAt: null,
          extendable: false,
        }),
      ]),
    );
    mocks.extend.mockResolvedValue({
      endsAt: "2026-11-10T22:59:00.000Z",
      results: [
        {
          userId: "00000000-0000-4000-8000-000000000001",
          email: "investisseur@exemple.fr",
          outcome: "extended",
          reason: null,
        },
      ],
    });
  });
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("affiche les comptes avec leur accès et bloque la sélection d'un compte premium", async () => {
    renderPanel();

    expect(await screen.findByText("investisseur@exemple.fr")).toBeTruthy();
    expect(screen.getAllByText("Essai 7 jours").length).toBeGreaterThan(0);
    expect(screen.getByText("Accès complet sans fin")).toBeTruthy();
    const premium = screen.getByRole("checkbox", { name: "Sélectionner premium@exemple.fr" });
    expect((premium as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("form", { name: /Prolonger/ })).toBeNull();
  });

  it("montre l'usage de chaque compte, et « non mesuré » quand il n'est pas lu", async () => {
    mocks.list.mockResolvedValue(
      listResponse([
        account({}),
        account({
          userId: "00000000-0000-4000-8000-000000000003",
          email: "sans-usage@exemple.fr",
          usage: null,
        }),
      ]),
    );
    renderPanel();

    await screen.findByText("investisseur@exemple.fr");
    for (const name of ["Déblocages", "Plafonds", "Favoris", "Fiches"]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy();
    }
    const rows = screen.getAllByRole("row");
    const cells = (row: HTMLElement) =>
      Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent);
    expect(cells(rows[1]).slice(-4)).toEqual(["0", "1", "2", "3"]);
    expect(cells(rows[2]).slice(-4)).toEqual(Array(4).fill("non mesuré"));
  });

  it("filtre les comptes dont l'essai est fini sans activité", async () => {
    renderPanel();

    await screen.findByText("investisseur@exemple.fr");
    fireEvent.change(screen.getByLabelText("Activité"), { target: { value: "trial_ended_idle" } });

    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ activity: "trial_ended_idle" }),
      ),
    );
    expect(screen.getByRole("option", { name: /Essai fini sans activité \(2\)/ })).toBeTruthy();
  });

  it("prolonge l'essai des comptes cochés jusqu'à la date choisie", async () => {
    renderPanel();

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Sélectionner investisseur@exemple.fr" }),
    );
    fireEvent.change(screen.getByLabelText("Essai prolongé jusqu’au"), {
      target: { value: "2026-11-10T23:59" },
    });
    fireEvent.change(screen.getByLabelText("Note interne (facultative)"), {
      target: { value: "Bêta-testeur" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prolonger l’essai" }));

    await waitFor(() => expect(mocks.extend).toHaveBeenCalledTimes(1));
    expect(mocks.extend).toHaveBeenCalledWith({
      userIds: ["00000000-0000-4000-8000-000000000001"],
      endsAt: new Date("2026-11-10T23:59").toISOString(),
      note: "Bêta-testeur",
    });
    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    expect(mocks.success.mock.calls[0][0]).toMatch(/Essai prolongé pour 1 compte/);
  });
});
