// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SalePassagesSection } from "./SalePassagesSection";

const mocks = vi.hoisted(() => ({ fetchSalePassages: vi.fn() }));
vi.mock("@/lib/client-api", () => ({ fetchSalePassages: mocks.fetchSalePassages }));

afterEach(cleanup);

/** La section affiche d'abord son chargement : on attend l'historique lui-même. */
async function loadedSection() {
  await screen.findByRole("region", { name: "Historique de la vente" });
  await waitFor(() =>
    expect(screen.getByRole("region").textContent).not.toContain("Chargement de l’historique"),
  );
  return screen.getByRole("region");
}

function renderSection(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SalePassagesSection saleId="sale-1" startingPrice={188000} enabled={enabled} />
    </QueryClientProvider>,
  );
}

describe("SalePassagesSection", () => {
  it("shows the earlier passages and changes to an Analyse member", async () => {
    mocks.fetchSalePassages.mockResolvedValue({
      access: "full",
      timeline: [
        {
          kind: "first_seen",
          previous: null,
          value: null,
          observedAt: "2026-09-20T10:00:00Z",
          backfilled: false,
        },
        {
          kind: "starting_price_changed",
          previous: 200000,
          value: 188000,
          observedAt: "2026-10-01T10:00:00Z",
          backfilled: false,
        },
      ],
      previousPassages: [
        { saleDate: "2026-09-16T07:00:00Z", startingPriceEur: 170000, status: null },
      ],
      summary: { previousPassageCount: 1, priceChangePct: -6, postponementCount: 0 },
    });
    renderSection();
    const section = await loadedSection();
    expect(section.textContent).toContain("Ce bien est déjà passé aux enchères.");
    expect(section.textContent).toContain("La mise à prix a baissé de 6 %.");
    expect(section.textContent).toContain("Audience du 16 septembre 2026");
    expect(section.textContent).toContain("Mise à prix baissée");
  });

  it("only tells a free account that a history exists", async () => {
    mocks.fetchSalePassages.mockResolvedValue({
      access: "teaser",
      summary: { previousPassageCount: 2, priceChangePct: -20, postponementCount: 0 },
    });
    renderSection();
    const section = await loadedSection();
    expect(section.textContent).toContain("déjà passé 2 fois aux enchères");
    expect(section.textContent).not.toMatch(/septembre|€/);
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
  });

  it("stays hidden for a free account when there is nothing to tell, and without a session", async () => {
    mocks.fetchSalePassages.mockResolvedValue({
      access: "teaser",
      summary: { previousPassageCount: 0, priceChangePct: null, postponementCount: 0 },
    });
    const { container } = renderSection();
    await vi.waitFor(() => expect(mocks.fetchSalePassages).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
    cleanup();
    mocks.fetchSalePassages.mockClear();
    renderSection(false);
    expect(mocks.fetchSalePassages).not.toHaveBeenCalled();
  });

  it("reserves the place and says that the history is loading", () => {
    mocks.fetchSalePassages.mockReturnValue(new Promise(() => {}));
    renderSection();
    const section = screen.getByRole("region", { name: "Historique de la vente" });
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(section.className).toContain("placeholder");
    expect(screen.getByRole("status").textContent).toBe("Chargement de l’historique…");
  });

  it("says when the history could not be loaded and offers to try again", async () => {
    mocks.fetchSalePassages.mockReset();
    mocks.fetchSalePassages.mockRejectedValueOnce(new Error("réseau"));
    renderSection();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "L’historique de la vente n’a pas pu être chargé.",
    );
    mocks.fetchSalePassages.mockResolvedValueOnce({
      access: "full",
      timeline: [],
      previousPassages: [],
      summary: { previousPassageCount: 0, priceChangePct: null, postponementCount: 0 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() =>
      expect(screen.getByRole("region").textContent).toContain("Aucun passage précédent"),
    );
    expect(mocks.fetchSalePassages).toHaveBeenCalledTimes(2);
  });
});
