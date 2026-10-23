// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionScenariosResponse } from "@/lib/auction-scenarios";
import { CeilingVsCourt } from "./CeilingVsCourt";

const mocks = vi.hoisted(() => ({ fetchScenarios: vi.fn() }));
vi.mock("@/lib/client-api", () => ({ fetchAuctionScenarios: mocks.fetchScenarios }));

function response(overrides: Partial<AuctionScenariosResponse> = {}): AuctionScenariosResponse {
  return {
    courtName: "tribunal judiciaire de Bordeaux",
    startingPrice: 100_000,
    propertyType: "apartment",
    unavailable: null,
    dataAsOf: "2026-10-22T14:03:00Z",
    history: { licitor: null, dvf: null },
    scenarios: {
      status: "ok",
      band: 4,
      courtSample: 42,
      nationalSample: 400,
      basis: "court",
      reliability: "good",
      priceScope: "court",
      ratioQuartiles: { q25: 1.1, q50: 1.4, q75: 2 },
      scenarios: [
        { key: "near_start", lowRatio: 0, highRatio: 1.1, probability: 0.2 },
        { key: "up_to_1_5", lowRatio: 1.1, highRatio: 1.5, probability: 0.3 },
        { key: "up_to_2", lowRatio: 1.5, highRatio: 2, probability: 0.25 },
        { key: "up_to_3", lowRatio: 2, highRatio: 3, probability: 0.15 },
        { key: "above_3", lowRatio: 3, highRatio: null, probability: 0.1 },
      ],
    },
    ...overrides,
  };
}

function renderCeiling(ceiling = 150_000) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CeilingVsCourt saleId="sale-1" ceiling={ceiling} access="analysis" userKey="user-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CeilingVsCourt (Mon plafond face au tribunal)", () => {
  it("situe le plafond par rapport aux ventes adjugées du tribunal, avec la fiabilité", async () => {
    mocks.fetchScenarios.mockResolvedValue(response());
    renderCeiling();

    const text = (await screen.findByTestId("ceiling-vs-court")).textContent ?? "";
    expect(text).toMatch(/Environ\s+50\s%/);
    expect(text).toContain("du tribunal judiciaire de Bordeaux");
    expect(text).toMatch(/150\s000\s€/);
    expect(text).toContain("×1,5 la mise à prix");
    expect(screen.getByText("bonne")).toBeTruthy();
    // Mêmes données que « Scénarios d'enchères » : une seule lecture, par la route existante.
    expect(mocks.fetchScenarios).toHaveBeenCalledOnce();
    expect(mocks.fetchScenarios).toHaveBeenCalledWith("sale-1");
    expect(screen.getByText(/Ce n’est pas une probabilité/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Voir les scénarios d’enchères" }).getAttribute("href"),
    ).toBe("#statistiques");
  });

  it("garde la mention de fiabilité faible quand le tribunal a peu de ventes", async () => {
    const base = response();
    mocks.fetchScenarios.mockResolvedValue(
      response({
        scenarios: { ...base.scenarios!, reliability: "low", basis: "national", courtSample: 3 },
      }),
    );
    renderCeiling();

    await screen.findByTestId("ceiling-vs-court");
    expect(screen.getByText("faible")).toBeTruthy();
  });

  it("dit « au moins » au-delà de 3 fois la mise à prix", async () => {
    mocks.fetchScenarios.mockResolvedValue(response());
    renderCeiling(450_000);

    const text = (await screen.findByTestId("ceiling-vs-court")).textContent ?? "";
    expect(text).toMatch(/Au moins\s+90\s%/);
  });

  it("dit qu'une enchère ne peut pas être sous la mise à prix", async () => {
    mocks.fetchScenarios.mockResolvedValue(response());
    renderCeiling(80_000);

    const text = (await screen.findByTestId("ceiling-vs-court")).textContent ?? "";
    expect(text).toContain("inférieure à la mise à prix");
    expect(text).not.toContain("%");
  });

  it("n'affiche rien quand les données sont insuffisantes", async () => {
    mocks.fetchScenarios.mockResolvedValue(
      response({
        unavailable: "insufficient_data",
        scenarios: {
          status: "insufficient",
          band: 4,
          courtSample: 2,
          nationalSample: 12,
          basis: "national",
          reliability: null,
          priceScope: "national",
          scenarios: [],
          ratioQuartiles: { q25: null, q50: null, q75: null },
        },
      }),
    );
    const { container } = renderCeiling();

    await waitFor(() => expect(mocks.fetchScenarios).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
  });

  it("n'affiche rien sans mise à prix, sans scénarios ou sur une erreur (droits compris)", async () => {
    mocks.fetchScenarios.mockResolvedValueOnce(response({ startingPrice: null }));
    const first = renderCeiling();
    await waitFor(() => expect(mocks.fetchScenarios).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(first.container.innerHTML).toBe("");
    first.unmount();

    mocks.fetchScenarios.mockRejectedValueOnce(
      Object.assign(new Error("Réservé"), { status: 403 }),
    );
    const second = renderCeiling();
    await waitFor(() => expect(mocks.fetchScenarios).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(second.container.innerHTML).toBe("");
  });
});
