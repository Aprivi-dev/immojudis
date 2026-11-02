// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminCatalogueReadinessPanel } from "./AdminCatalogueReadinessPanel";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), action: vi.fn() }));

vi.mock("@/lib/client-api", () => ({
  fetchAdminCatalogueReadiness: mocks.fetch,
  runAdminCatalogueReadinessActionClient: mocks.action,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminCatalogueReadinessPanel", () => {
  it("opens the admin composer from a queue row in one click", async () => {
    mocks.fetch.mockResolvedValue(overview());
    const onPrepareInformationRequest = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <AdminCatalogueReadinessPanel onPrepareInformationRequest={onPrepareInformationRequest} />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ouvrir le message" }));

    expect(onPrepareInformationRequest).toHaveBeenCalledTimes(1);
    expect(onPrepareInformationRequest).toHaveBeenCalledWith({
      saleId: "11111111-1111-4111-8111-111111111111",
      title: "Appartement T3",
      recipientName: "Cabinet source",
      recipientContact: "cabinet@example.test · 01 02 03",
    });
  });

  it("désactive « Ouvrir le message » avec le motif quand aucune adresse email n'est connue", async () => {
    mocks.fetch.mockResolvedValue(
      overview({
        informationAgentBlockedReason:
          "Aucune adresse email de contact : l'agent ne peut pas écrire.",
      }),
    );
    const onPrepareInformationRequest = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <AdminCatalogueReadinessPanel onPrepareInformationRequest={onPrepareInformationRequest} />
      </QueryClientProvider>,
    );

    const button = await screen.findByRole("button", { name: "Ouvrir le message" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const reasonId = button.getAttribute("aria-describedby");
    expect(document.getElementById(reasonId ?? "")?.textContent).toBe(
      "Aucune adresse email de contact : l'agent ne peut pas écrire.",
    );
    fireEvent.click(button);
    expect(onPrepareInformationRequest).not.toHaveBeenCalled();
  });
});

describe("AdminCatalogueReadinessPanel : file de travail de l'agent", () => {
  async function renderPanel(data: unknown, onPrepare = vi.fn()) {
    mocks.fetch.mockResolvedValue(data);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminCatalogueReadinessPanel onPrepareInformationRequest={onPrepare} />
      </QueryClientProvider>,
    );
    return onPrepare;
  }

  it("indique la classe de contact et les effectifs par classe", async () => {
    await renderPanel({
      ...overview({ contactClass: "C" }),
      classCounts: { A: 4, B: 2, C: 1, D: 7 },
    });

    expect(await screen.findByText("Greffe", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/Avocat 4 · Greffe 1 · À confirmer 2/)).toBeTruthy();
  });

  it("range les contacts impossibles dans un bloc replié, avec le motif et l'action de saisie", async () => {
    const impossible = overview({
      id: "99999999-9999-4999-8999-999999999999",
      title: "Maison sans adresse",
      contactClass: "D",
      informationAgentBlockedReason: "Téléphone seul : aucune adresse email dans l’annonce.",
    }).items;
    const onPrepare = await renderPanel({
      ...overview(),
      classCounts: { A: 1, B: 0, C: 0, D: 7 },
      impossibleItems: impossible,
    });

    const summary = await screen.findByText("Contact impossible (7)");
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText("Téléphone seul : aucune adresse email dans l’annonce.")).toBeTruthy();
    const button = screen.getByRole("button", {
      name: "Saisir une adresse trouvée sur une page publique",
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onPrepare).toHaveBeenCalledWith(
      expect.objectContaining({ saleId: "99999999-9999-4999-8999-999999999999" }),
    );
  });

  it("n'affiche aucun bloc quand tous les dossiers ont un contact", async () => {
    await renderPanel({ ...overview(), classCounts: { A: 1, B: 0, C: 0, D: 0 } });
    await screen.findByRole("button", { name: "Ouvrir le message" });
    expect(screen.queryByText(/Contact impossible/)).toBeNull();
  });
});

function overview(item: Record<string, unknown> = {}) {
  return {
    policy: {
      enforcementEnabled: true,
      policyVersion: "v1",
      premiumReadyMin: 70,
      minimumScoreConfidence: 0.8,
      updatedAt: "2026-10-08T08:00:00Z",
    },
    counts: {
      unassessed: 0,
      internal_only: 1,
      needs_enrichment: 1,
      premium_ready: 3,
    },
    activeSales: 5,
    pendingEvaluations: 0,
    canEnableEnforcement: true,
    queueTotal: 1,
    queueOffset: 0,
    queueLimit: 100,
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Appartement T3",
        city: "Bordeaux",
        department: "33",
        saleDate: "2026-11-10T10:00:00Z",
        sourceName: "Source test",
        lawyerName: "Cabinet source",
        lawyerContact: "cabinet@example.test · 01 02 03",
        scoreConfidence: 0.9,
        readinessScore: 42,
        readinessStatus: "needs_enrichment",
        policyVersion: "v1",
        factors: {},
        blockers: [],
        missingFields: ["diagnostics"],
        evaluatedAt: "2026-10-08T08:00:00Z",
        override: null,
        overrideReason: null,
        overrideExpiresAt: null,
        ...item,
      },
    ],
  };
}
