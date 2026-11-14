// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminOperationalReadinessResponse } from "@/lib/admin-readiness";
import { operationalAlertLabels } from "@/lib/operational-alert-labels";
import { AdminOperationalAlerts } from "./AdminOperationalAlerts";

const mocks = vi.hoisted(() => ({ fetchReadiness: vi.fn() }));

vi.mock("@/lib/client-api", () => ({ fetchAdminReadiness: mocks.fetchReadiness }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  AdminSectionHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

type Alert = AdminOperationalReadinessResponse["operations"]["alerts"][number];

/** Alerte telle que le serveur l'envoie : ligne de la base et libellés déjà mis en forme. */
function alert(key: string, overrides: Partial<Alert> = {}): Alert {
  const row = {
    key,
    category: "import",
    severity: "warning" as const,
    status: "open" as const,
    deliveryStatus: "delivered" as const,
    lastSeenAt: "2026-11-14T08:00:00.000Z",
    ...overrides,
  };
  return { ...row, ...operationalAlertLabels(row) };
}

function readiness(
  alerts: Alert[],
  openAlertCount: number | null = alerts.filter((item) => item.status === "open").length,
) {
  return { operations: { openAlertCount, alerts } } as AdminOperationalReadinessResponse;
}

function renderAlerts() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminOperationalAlerts />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminOperationalAlerts", () => {
  it("lists open alerts with a French label, their severity and where to act", async () => {
    mocks.fetchReadiness.mockResolvedValue(
      readiness([
        alert("pipeline.enrichment.stalled", { severity: "critical" }),
        alert("information_agent.unrouted.pending"),
        alert("pipeline.source.notaires.stale_listings"),
        alert("cron.stale", { status: "resolved", deliveryStatus: "failed" }),
      ]),
    );

    renderAlerts();

    const stalled = (await screen.findByText("Enrichissement des fiches à l’arrêt")).closest("li");
    expect(stalled?.textContent).toContain("Critique");
    expect(stalled?.querySelector("a")?.getAttribute("href")).toBe("/admin/operations");
    const unrouted = screen.getByText("Messages reçus sans dossier, en attente de traitement");
    expect(unrouted.closest("li")?.textContent).toContain("Avertissement");
    expect(unrouted.closest("li")?.querySelector("a")?.getAttribute("href")).toBe(
      "/admin/agent-ia?onglet=reponses",
    );
    expect(
      screen.getByText("Source Immobilier.notaires : fiches non revérifiées à temps"),
    ).toBeTruthy();
    // Une alerte refermée dont la notification reste à livrer n'est pas « ouverte ».
    expect(screen.queryByText("Tâches planifiées en retard")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(document.body.textContent).not.toMatch(/pipeline\.|information_agent\./);
  });

  it("says in one line that nothing is open", async () => {
    mocks.fetchReadiness.mockResolvedValue(readiness([]));

    renderAlerts();

    expect(await screen.findByText("Aucune alerte ouverte")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("counts the open alerts the diagnostic did not detail", async () => {
    mocks.fetchReadiness.mockResolvedValue(readiness([alert("cron.stale")], 3));

    renderAlerts();

    expect(
      await screen.findByText("Et 2 autres alertes ouvertes, non détaillées ici."),
    ).toBeTruthy();
  });

  it("never says « no alert » when the alerts cannot be read", async () => {
    mocks.fetchReadiness.mockResolvedValue(readiness([], null));

    renderAlerts();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Alertes indisponibles pour le moment.",
    );
    expect(screen.queryByText("Aucune alerte ouverte")).toBeNull();
  });
});
