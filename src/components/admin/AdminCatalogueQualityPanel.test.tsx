// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminCatalogueQualityView } from "@/lib/admin-catalogue-quality";
import { AdminCatalogueQualityPanel } from "./AdminCatalogueQualityPanel";

vi.mock("@/lib/client-api-core", () => ({
  authHeaders: async () => ({ Authorization: "Bearer admin-token" }),
  readJson: async (response: Response) => {
    if (!response.ok) throw new Error("Erreur");
    return response.json();
  },
}));

const LOT_MISMATCH = "licitor_lot_mismatch";
const POSTAL_CODE_RATIO = "missing_postal_code_ratio";

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function renderPanel(view: AdminCatalogueQualityView | null, status = 200) {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(view ?? { error: "Indisponible" }), { status }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminCatalogueQualityPanel />
    </QueryClientProvider>,
  );
}

describe("AdminCatalogueQualityPanel", () => {
  it("affiche chaque contrôle avec son nombre, son seuil et son état, puis les alertes ouvertes", async () => {
    renderPanel({
      snapshot: {
        observedAt: "2026-11-05T00:00:12Z",
        title: "Cliché du 05 novembre 2026 à 01:00",
        isToday: true,
        liveSales: "862",
        rows: [
          {
            key: LOT_MISMATCH,
            label: "Lots Licitor discordants avec leur carte",
            count: "9",
            threshold: "Alerte dès 1 vente",
            state: "alert",
            stateLabel: "Au-dessus du seuil",
            note: null,
          },
          {
            key: POSTAL_CODE_RATIO,
            label: "Ventes sans code postal",
            count: "32 (3,7 %)",
            threshold: "Alerte au-dessus de 8 % (dès 100 ventes en ligne)",
            state: "ok",
            stateLabel: "Sous le seuil",
            note: null,
          },
        ],
      },
      alerts: [
        {
          key: `catalogue.quality.${LOT_MISMATCH}`,
          label: "Lots Licitor discordants avec leur carte",
          seen: "Ouverte le 03 novembre 2026, vue le 05 novembre 2026",
          detail: "9 au dernier passage",
        },
      ],
    });

    const row = (await screen.findByRole("rowheader", { name: /Lots Licitor/ })).closest("tr")!;
    expect(within(row).getByText("9")).toBeTruthy();
    expect(within(row).getByText("Alerte dès 1 vente")).toBeTruthy();
    expect(within(row).getByText("Au-dessus du seuil").className).toContain("text-danger");
    const postal = screen
      .getByRole("rowheader", { name: "Ventes sans code postal" })
      .closest("tr")!;
    expect(within(postal).getByText("Sous le seuil").className).toContain("text-success");
    expect(
      screen.getByText(/Cliché du 05 novembre 2026 à 01:00 · 862 ventes en ligne/),
    ).toBeTruthy();
    expect(screen.getByText(/9 au dernier passage/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/catalogue-quality",
      expect.objectContaining({ headers: { Authorization: "Bearer admin-token" } }),
    );
  });

  it("affiche un état vide tant qu'aucun cliché n'existe", async () => {
    renderPanel({ snapshot: null, alerts: [] });
    expect(await screen.findByText(/Aucun cliché pour l’instant/)).toBeTruthy();
    expect(screen.getByText("Aucune alerte qualité ouverte.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("signale une lecture impossible", async () => {
    renderPanel(null, 500);
    expect((await screen.findByRole("alert")).textContent).toContain("Contrôles indisponibles");
  });
});
