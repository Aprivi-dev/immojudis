// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminOperationalReadinessResponse } from "@/lib/admin-readiness";
import { AdminReadinessPanel } from "./AdminReadinessPanel";

const mocks = vi.hoisted(() => ({ fetchReadiness: vi.fn() }));

vi.mock("@/lib/client-api", () => ({ fetchAdminReadiness: mocks.fetchReadiness }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Nom d'alerte rangé dans une constante : un champ `key: "…"` littéral ressemble à un secret
// pour le contrôle anti-secrets.
const EXHAUSTED = "pipeline.enrichment.exhausted";
const LAND_ROOMS = "catalogue.quality.land_with_rooms";
const POSTAL = "catalogue.quality.missing_postal_code_ratio";

const READINESS: AdminOperationalReadinessResponse = {
  checkedAt: "2026-11-14T08:00:00.000Z",
  status: "warning",
  items: [],
  migrations: {
    status: "ready",
    expectedLatestVersion: "20261118100300",
    latestAppliedVersion: "20261118100300",
    appliedCount: 1,
    detail: "",
  },
  operations: {
    status: "warning",
    schedulerActive: true,
    schedulerSchedule: "*/15 * * * *",
    sloTargetPercent: 99.5,
    sloWindowDays: 30,
    successfulRunCount: 10,
    failedRunCount: 0,
    totalRunCount: 10,
    successRatePercent: 100,
    openAlertCount: 1,
    criticalOpenAlertCount: 0,
    pendingDeliveryCount: 1,
    failedDeliveryCount: 0,
    lastHealthRunAt: "2026-11-14T07:45:00.000Z",
    lastHealthRunFresh: true,
    alerts: [
      {
        key: EXHAUSTED,
        category: "import",
        severity: "warning",
        status: "open",
        deliveryStatus: "pending",
        lastSeenAt: "2026-11-14T07:45:00.000Z",
      },
      {
        key: LAND_ROOMS,
        category: "import",
        severity: "warning",
        status: "open",
        deliveryStatus: "delivered",
        lastSeenAt: "2026-11-14T07:30:00.000Z",
      },
      {
        key: POSTAL,
        category: "import",
        severity: "warning",
        status: "resolved",
        deliveryStatus: "failed",
        lastSeenAt: "2026-11-14T06:00:00.000Z",
      },
    ],
    detail: "",
  },
  webhookUrl: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminReadinessPanel", () => {
  it("shows operational incidents with French labels, never their technical key", async () => {
    mocks.fetchReadiness.mockResolvedValue(READINESS);

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <AdminReadinessPanel />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Fiches abandonnées après toutes les tentatives d’enrichissement"),
    ).toBeTruthy();
    expect(screen.getAllByText("Avertissement")).toHaveLength(3);
    expect(screen.getByText("En attente")).toBeTruthy();
    // Deux contrôles de la même famille restent distincts ; une alerte refermée le dit.
    const land = screen.getByText("Qualité du catalogue : Terrains avec un nombre de pièces");
    expect(land.parentElement?.textContent).toContain("Ouverte");
    const postal = screen.getByText("Qualité du catalogue : Ventes sans code postal");
    expect(postal.parentElement?.textContent).toContain("Refermée");
    expect(postal.parentElement?.parentElement?.textContent).toContain("En échec");
    expect(screen.queryByText(/pipeline\.enrichment/)).toBeNull();
    expect(screen.queryByText(/import ·/)).toBeNull();
  });
});
