// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { SalePublicDeadline, saleDeadline } from "./SalePublicDeadline";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const sale = (overrides: Partial<AuctionSale>) =>
  ({ id: "sale-1", sale_venue_type: "notary", ...overrides }) as AuctionSale;

// 6 novembre 2026, 9 h à Paris.
const NOW = new Date("2026-11-06T08:00:00Z");

describe("saleDeadline", () => {
  it("dit « Aujourd'hui à 12 h 00 » le jour même, en ton urgent", () => {
    expect(saleDeadline(sale({ sale_date: "2026-11-06T11:00:00Z" }), NOW)).toEqual({
      label: "Aujourd’hui à 12 h 00",
      tone: "danger",
    });
  });

  it("dit que l'heure reste à confirmer quand seule la date est connue", () => {
    expect(saleDeadline(sale({ sale_date: "2026-11-06" }), NOW)).toEqual({
      label: "Aujourd’hui · heure à confirmer",
      tone: "danger",
    });
  });

  it("dit « Demain » puis « Dans N jours », en ton d'attention jusqu'à sept jours", () => {
    expect(saleDeadline(sale({ sale_date: "2026-11-07T09:30:00Z" }), NOW)).toEqual({
      label: "Demain à 10 h 30",
      tone: "warning",
    });
    expect(saleDeadline(sale({ sale_date: "2026-11-13" }), NOW)).toEqual({
      label: "Dans 7 jours",
      tone: "warning",
    });
    expect(saleDeadline(sale({ sale_date: "2026-11-20T09:00:00Z" }), NOW)).toEqual({
      label: "Dans 14 jours",
      tone: "neutral",
    });
  });

  it("ne dit rien d'une vente passée ni d'une vente sans date", () => {
    expect(saleDeadline(sale({ sale_date: "2026-11-05T09:00:00Z" }), NOW)).toBeNull();
    expect(saleDeadline(sale({ sale_date: null }), NOW)).toBeNull();
  });
});

describe("SalePublicDeadline", () => {
  it("n'écrit rien dans le HTML du serveur, puis la pastille apparaît après l'hydratation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const element = <SalePublicDeadline sale={sale({ sale_date: "2026-11-06T11:00:00Z" })} />;
    const html = renderToString(element);
    expect(html).toBe("");
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = html;
    const recoverable: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, element, { onRecoverableError: (error) => recoverable.push(error) });
    });
    expect(container.textContent).toBe("Aujourd’hui à 12 h 00");
    expect(recoverable).toEqual([]);
    container.remove();
  });

  it("rend la pastille dans le navigateur", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<SalePublicDeadline sale={sale({ sale_date: "2026-11-16" })} />);
    expect(screen.getByTestId("public-sale-deadline").textContent).toBe("Dans 10 jours");
  });
});
