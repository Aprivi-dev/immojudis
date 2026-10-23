import { describe, expect, it } from "vitest";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";
import { changesSinceCeiling } from "./ceiling-staleness";

function event(overrides: Partial<SaleChangeEventSummary> = {}): SaleChangeEventSummary {
  return {
    id: "event-1",
    saleId: "sale-1",
    watchKind: "favorite",
    watchId: "watch-1",
    eventKind: "price_changed",
    severity: "important",
    fingerprint: "price_changed:startingPriceEur:120000:100000",
    summaryLabel: "Mise à prix abaissée",
    changeSummary: { field: "startingPriceEur", previousValue: 120000, currentValue: 100000 },
    detectedAt: "2026-10-14T06:45:00Z",
    readAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

describe("changesSinceCeiling", () => {
  const savedAt = "2026-10-10T08:00:00Z";

  it("liste ce qui a changé après l'enregistrement du plafond, sans doublon", () => {
    const result = changesSinceCeiling(
      [
        event({ id: "a", detectedAt: "2026-10-12T06:00:00Z" }),
        event({
          id: "b",
          eventKind: "price_changed",
          fingerprint: "autre",
          detectedAt: "2026-10-14T06:00:00Z",
        }),
        event({
          id: "c",
          eventKind: "audience_changed",
          fingerprint: "date",
          changeSummary: {
            previousValue: "2026-11-02T10:00:00Z",
            currentValue: "2026-11-20T10:00:00Z",
          },
          detectedAt: "2026-10-13T06:00:00Z",
        }),
        event({
          id: "d",
          eventKind: "documents_changed",
          fingerprint: "docs",
          summaryLabel: "Nouveau document détecté",
          detectedAt: "2026-10-11T06:00:00Z",
        }),
      ],
      savedAt,
    );
    expect(result).toEqual({
      topics: ["les documents", "la mise à prix", "la date de la vente"],
      lastDetectedAt: "2026-10-14T06:00:00.000Z",
    });
  });

  it("ignore ce qui précède l'enregistrement, le statut, le score et les dates illisibles", () => {
    expect(
      changesSinceCeiling(
        [
          event({ detectedAt: "2026-10-09T06:00:00Z" }),
          event({ detectedAt: savedAt, fingerprint: "au même instant" }),
          event({ eventKind: "status_changed", changeSummary: { currentValue: "postponed" } }),
          event({ eventKind: "score_changed", fingerprint: "score" }),
          event({ detectedAt: "pas une date", fingerprint: "illisible" }),
        ],
        savedAt,
      ),
    ).toBeNull();
  });

  it("compte un changement écarté par la personne : écarter un message ne défait pas le changement", () => {
    expect(
      changesSinceCeiling([event({ dismissedAt: "2026-10-13T00:00:00Z" })], savedAt)?.topics,
    ).toEqual(["la mise à prix"]);
  });

  it("ne dit rien sans date d'enregistrement exploitable", () => {
    expect(changesSinceCeiling([event()], null)).toBeNull();
    expect(changesSinceCeiling([event()], "hier")).toBeNull();
  });
});
