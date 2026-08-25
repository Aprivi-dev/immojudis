// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTribunalJudicialActivity } from "@/lib/tribunal-judicial-activity";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { SaleTribunalHistory } from "./SaleTribunalHistory";

const mocks = vi.hoisted(() => ({
  fetchActivity: vi.fn(),
}));

vi.mock("@/lib/tribunal-judicial-activity-client", () => ({
  fetchTribunalJudicialActivity: mocks.fetchActivity,
}));

const activity = buildTribunalJudicialActivity({
  court: {
    code: "justice_tj_1_59",
    name: "TJ Marseille",
    judicialRegion: "Aix-en-Provence",
  },
  sales: [],
  asOf: new Date("2026-08-20T12:00:00.000Z"),
  historyMonths: 36,
});

describe("SaleTribunalHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchActivity.mockResolvedValue(activity);
  });

  afterEach(cleanup);

  it("résout côté serveur le tribunal d’une vente judiciaire encore en cours de vérification", async () => {
    const sale = tribunalSaleWithoutPublishedCode();

    renderHistory(sale);

    expect(await screen.findByRole("heading", { name: "TJ Marseille" })).toBeTruthy();
    expect(mocks.fetchActivity).toHaveBeenCalledWith({
      saleId: sale.id,
      historyMonths: 36,
    });
    expect(screen.getByText(/Échantillon local encore limité/)).toBeTruthy();
  });

  it("garde une section explicite lorsque le rattachement exact n’est pas encore publiable", async () => {
    mocks.fetchActivity.mockRejectedValue(new Error("exact court assignment unavailable"));

    renderHistory(tribunalSaleWithoutPublishedCode());

    expect(
      await screen.findByRole("heading", {
        name: "Statistiques de Tribunal judiciaire de Bordeaux en cours de consolidation",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/aucune statistique approximative n’est substituée/i)).toBeTruthy();
  });
});

function tribunalSaleWithoutPublishedCode(): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    id: "11111111-1111-4111-8111-111111111111",
    tribunal_code: null,
    sale_verification_status: "pending",
    sale_procedure: null,
    source_blocks: null,
  } as AuctionSale;
}

function renderHistory(sale: AuctionSale) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SaleTribunalHistory sale={sale} />
    </QueryClientProvider>,
  );
}
