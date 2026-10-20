// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { SalePublicPreview } from "./SalePublicPreview";

const mocks = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null, loading: false },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));

afterEach(() => {
  cleanup();
  mocks.auth = { user: null, loading: false };
});

function renderPreview(overrides: Partial<AuctionSale> = {}) {
  return render(
    <SalePublicPreview
      saleId="sale-1"
      returnTo="/sales"
      preview={
        {
          id: "sale-1",
          starting_price_eur: 59_000,
          sale_venue_type: "tribunal",
          sale_verification_status: "cross_checked",
          market_gap_band: "near",
          // Surface lue et vide : un point à vérifier.
          app_surface_m2: null,
          ...overrides,
        } as unknown as AuctionSale
      }
    />,
  );
}

describe("retour en un clic sur la fiche publique", () => {
  it("n'en propose aucun au visiteur sans compte : pas de mesure anonyme", () => {
    renderPreview();

    expect(screen.getByTestId("market-gap-band")).toBeTruthy();
    expect(screen.getByRole("region", { name: "1 point à vérifier" })).toBeTruthy();
    expect(screen.queryByTestId("sale-signal-feedback")).toBeNull();
    expect(screen.queryByRole("button", { name: "Utile" })).toBeNull();
  });

  it("le propose à un compte connecté sous la bande et sous les points à vérifier", () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    renderPreview();

    const band = within(screen.getByTestId("market-gap-band")).getByTestId("sale-signal-feedback");
    expect(band.getAttribute("data-signal")).toBe("market_gap_band");
    const points = within(screen.getByRole("region", { name: "1 point à vérifier" })).getByTestId(
      "sale-signal-feedback",
    );
    expect(points.getAttribute("data-signal")).toBe("points_to_verify");
    expect(screen.getAllByRole("button", { name: "Utile" })).toHaveLength(2);
  });

  it.each(["occupied", "insufficient", "insufficient_surface", "insufficient_type"] as const)(
    "ne le propose pas sous un message « %s » : il n'y a pas de repère à juger",
    (band) => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      renderPreview({ market_gap_band: band, app_surface_m2: 60 });

      expect(
        within(screen.getByTestId("market-gap-band")).queryByTestId("sale-signal-feedback"),
      ).toBeNull();
    },
  );
});
