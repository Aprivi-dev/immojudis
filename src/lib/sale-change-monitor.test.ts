import { describe, expect, it } from "vitest";
import {
  buildSaleChangeSnapshot,
  detectSaleChanges,
  saleChangeEventActionSchema,
} from "@/lib/sale-change-monitor";
import type { AuctionSale } from "@/lib/types";

const NOW = new Date("2026-07-06T08:00:00.000Z");

describe("sale change monitor", () => {
  it("detects investor-relevant changes on a tracked sale", () => {
    const previous = buildSaleChangeSnapshot(
      saleFixture({
        starting_price_eur: 150_000,
        sale_date: "2026-08-20T09:00:00.000Z",
        status: "active",
        investment_score: 62,
        documents_rich: [
          {
            url: "https://example.test/cahier.pdf",
            label: "Cahier des conditions",
            type: "conditions",
            extraction_status: "completed",
          },
        ],
      }),
    );
    const current = buildSaleChangeSnapshot(
      saleFixture({
        starting_price_eur: 135_000,
        sale_date: "2026-07-12T09:00:00.000Z",
        status: "reportée",
        investment_score: 76,
        documents_rich: [
          {
            url: "https://example.test/cahier.pdf",
            label: "Cahier des conditions",
            type: "conditions",
            extraction_status: "completed",
          },
          {
            url: "https://example.test/diagnostic.pdf",
            label: "Diagnostics",
            type: "diagnostics",
            extraction_status: "completed",
          },
        ],
      }),
    );

    const changes = detectSaleChanges({ previous, current, now: NOW });

    expect(changes.map((change) => change.eventKind)).toEqual([
      "price_changed",
      "audience_changed",
      "status_changed",
      "documents_changed",
      "score_changed",
    ]);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventKind: "price_changed",
          severity: "important",
          summaryLabel: "Mise à prix abaissée",
        }),
        expect.objectContaining({
          eventKind: "audience_changed",
          severity: "urgent",
        }),
        expect.objectContaining({
          eventKind: "documents_changed",
          summaryLabel: "Nouveau document détecté",
        }),
      ]),
    );
  });

  it("does not create noisy changes when no comparable previous value exists", () => {
    const previous = buildSaleChangeSnapshot(
      saleFixture({
        starting_price_eur: null,
        sale_date: null,
        documents_rich: [],
      }),
    );
    const current = buildSaleChangeSnapshot(
      saleFixture({
        starting_price_eur: 120_000,
        sale_date: "2026-08-20T09:00:00.000Z",
        documents_rich: [
          {
            url: "https://example.test/cahier.pdf",
            label: "Cahier",
            type: "conditions",
            extraction_status: "completed",
          },
        ],
      }),
    );

    expect(detectSaleChanges({ previous, current, now: NOW })).toEqual([]);
  });

  it("validates sale change event actions", () => {
    expect(
      saleChangeEventActionSchema.parse({
        eventId: "7d335032-e935-4550-9347-ed22b0f63449",
        action: "dismiss",
      }),
    ).toEqual({
      eventId: "7d335032-e935-4550-9347-ed22b0f63449",
      action: "dismiss",
    });

    expect(() =>
      saleChangeEventActionSchema.parse({
        eventId: "not-a-uuid",
        action: "delete",
      }),
    ).toThrow();
  });
});

function saleFixture(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "018c5dc8-cb2e-49d1-9ac8-1b69e6400367",
    title: "Appartement suivi",
    city: "Lyon",
    department: "69",
    starting_price_eur: 150_000,
    sale_date: "2026-08-20T09:00:00.000Z",
    status: "active",
    investment_score: 62,
    documents_rich: [],
    documents: null,
    updated_at: "2026-07-06T08:00:00.000Z",
    source_url: "https://example.test/vente",
    ...overrides,
  } as AuctionSale;
}
