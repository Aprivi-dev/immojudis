import { describe, expect, it } from "vitest";
import {
  buildSaleChangeSnapshot,
  detectSaleChanges,
  selectRotatingMonitorCandidates,
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

  it("marque urgent un statut retiré ou annulé", () => {
    const previous = buildSaleChangeSnapshot(saleFixture({ status: "upcoming" }));
    for (const status of ["withdrawn", "cancelled", "adjudicated"]) {
      const current = buildSaleChangeSnapshot(saleFixture({ status }));
      const [change] = detectSaleChanges({ previous, current, now: NOW });
      expect(change).toMatchObject({ eventKind: "status_changed", severity: "urgent" });
    }
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

describe("rotation du lot de suivi des changements", () => {
  const candidate = (index: number, priority = false) => ({
    userId: `user-${String(index).padStart(3, "0")}`,
    userRole: "user" as const,
    priority,
  });
  const day = (offset: number) => new Date(Date.UTC(2026, 9, 20 + offset, 6, 45));
  const ids = (list: Array<{ userId: string }>) => list.map((item) => item.userId);

  it("deux passages successifs couvrent des profils différents, puis tout le monde est vu", () => {
    const candidates = Array.from({ length: 60 }, (_, index) => candidate(index));
    const first = ids(selectRotatingMonitorCandidates({ candidates, limit: 20, now: day(0) }));
    const second = ids(selectRotatingMonitorCandidates({ candidates, limit: 20, now: day(1) }));
    const third = ids(selectRotatingMonitorCandidates({ candidates, limit: 20, now: day(2) }));

    expect(first).toHaveLength(20);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
    expect(new Set([...first, ...second, ...third]).size).toBe(60);
  });

  it("le rattrapage du même jour retombe sur le même lot", () => {
    const candidates = Array.from({ length: 60 }, (_, index) => candidate(index));
    const morning = new Date(Date.UTC(2026, 9, 20, 6, 45));
    const catchUp = new Date(Date.UTC(2026, 9, 20, 8, 45));
    expect(selectRotatingMonitorCandidates({ candidates, limit: 20, now: morning })).toEqual(
      selectRotatingMonitorCandidates({ candidates, limit: 20, now: catchUp }),
    );
  });

  it("l'ordre d'arrivée des candidats ne change pas le lot", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => candidate(index));
    expect(ids(selectRotatingMonitorCandidates({ candidates, limit: 10, now: day(0) }))).toEqual(
      ids(
        selectRotatingMonitorCandidates({
          candidates: [...candidates].reverse(),
          limit: 10,
          now: day(0),
        }),
      ),
    );
  });

  it("les comptes prioritaires passent d'abord, un quart du lot reste aux autres", () => {
    const priority = Array.from({ length: 30 }, (_, index) => candidate(index, true));
    const rest = Array.from({ length: 30 }, (_, index) => candidate(100 + index));
    const selected = selectRotatingMonitorCandidates({
      candidates: [...rest, ...priority],
      limit: 20,
      now: day(0),
    });

    expect(selected).toHaveLength(20);
    expect(ids(selected).filter((id) => Number(id.slice(5)) < 100)).toHaveLength(15);
    expect(ids(selected).filter((id) => Number(id.slice(5)) >= 100)).toHaveLength(5);
  });

  it("quand les prioritaires sont peu nombreux, ils sont tous pris et les autres complètent", () => {
    const priority = Array.from({ length: 3 }, (_, index) => candidate(index, true));
    const rest = Array.from({ length: 30 }, (_, index) => candidate(100 + index));
    const selected = selectRotatingMonitorCandidates({
      candidates: [...rest, ...priority],
      limit: 20,
      now: day(0),
    });

    expect(selected).toHaveLength(20);
    expect(ids(selected)).toEqual(expect.arrayContaining(ids(priority)));
  });

  it("examine chaque jour tous les comptes ayant consenti aux rappels, même au-delà du lot", () => {
    // 30 comptes consentants pour un lot de 25 (19 places prioritaires, 6 réservées aux autres).
    const consenting = Array.from({ length: 30 }, (_, index) => ({
      ...candidate(index, true),
      consented: true,
    }));
    const others = [
      ...Array.from({ length: 10 }, (_, index) => candidate(100 + index, true)),
      ...Array.from({ length: 40 }, (_, index) => candidate(200 + index)),
    ];
    for (let offset = 0; offset < 4; offset += 1) {
      const selected = ids(
        selectRotatingMonitorCandidates({
          candidates: [...others, ...consenting],
          limit: 25,
          now: day(offset),
        }),
      );
      expect(selected).toEqual(expect.arrayContaining(ids(consenting)));
      // Le lot tourné des autres comptes reste de 25 : les consentants s'y ajoutent.
      expect(selected).toHaveLength(55);
      expect(new Set(selected).size).toBe(55);
    }
  });

  it("garde le lot tourné des autres comptes quand personne n'a consenti", () => {
    const others = Array.from({ length: 60 }, (_, index) => candidate(index));
    expect(
      selectRotatingMonitorCandidates({ candidates: others, limit: 25, now: day(0) }),
    ).toHaveLength(25);
  });

  it("rend tout le monde quand le lot suffit", () => {
    const candidates = [candidate(1, true), candidate(2)];
    expect(selectRotatingMonitorCandidates({ candidates, limit: 25, now: day(3) })).toHaveLength(2);
  });
});
