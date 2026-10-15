// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleUnlocksOverview } from "@/lib/sale-unlocks";

const mocks = vi.hoisted(() => ({ overview: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/client-api", () => ({ fetchSaleUnlocksOverview: mocks.overview }));

import { UnlockedSalesPage } from "./UnlockedSalesPage";

const overview = (sales: SaleUnlocksOverview["sales"]): SaleUnlocksOverview => ({
  status: {
    saleId: null,
    unlocked: false,
    unlockable: true,
    analysisAccess: false,
    limit: 3,
    used: 2,
    remaining: 1,
    periodStart: "2026-09-30T22:00:00.000Z",
    resetsAt: "2026-10-31T23:00:00.000Z",
  },
  sales,
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <UnlockedSalesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => mocks.overview.mockReset());
afterEach(cleanup);

describe("UnlockedSalesPage", () => {
  it("lists the unlocked sales, each linking to its sheet, with the month's counter", async () => {
    mocks.overview.mockResolvedValue(
      overview([
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Appartement à Lyon",
          city: "Lyon",
          department: "69",
          propertyType: "apartment",
          startingPriceEur: 90000,
          saleDate: "2026-11-20T09:00:00.000Z",
          status: "upcoming",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          title: null,
          city: null,
          department: null,
          propertyType: null,
          startingPriceEur: null,
          saleDate: null,
          status: null,
        },
      ]),
    );
    renderPage();

    const list = await screen.findByRole("list", { name: "Ventes débloquées" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Appartement à Lyon" }).getAttribute("href")).toBe(
      "/sales/11111111-1111-4111-8111-111111111111",
    );
    expect(list.textContent).toContain("Mise à prix à confirmer");
    expect(screen.getByRole("link", { name: "Vente sans titre" })).toBeTruthy();
    expect(
      screen.getByText("Déblocages ce mois-ci : 2 sur 3 utilisés. Remis à 3 le 1er novembre."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Retour à Mon compte" }).getAttribute("href")).toBe(
      "/compte",
    );
  });

  it("explains how to unlock when nothing is unlocked yet", async () => {
    mocks.overview.mockResolvedValue(overview([]));
    renderPage();

    expect(await screen.findByText(/aucune vente en ligne/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Explorer les ventes" }).getAttribute("href")).toBe(
      "/sales",
    );
  });

  it("reports a failed read with a retry that reads again", async () => {
    mocks.overview.mockRejectedValueOnce(new Error("indisponible"));
    mocks.overview.mockResolvedValue(overview([]));
    renderPage();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Vos ventes débloquées n’ont pas pu être chargées.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText(/aucune vente en ligne/)).toBeTruthy();
    expect(mocks.overview).toHaveBeenCalledTimes(2);
  });
});
