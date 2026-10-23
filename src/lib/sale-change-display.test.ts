import { describe, expect, it } from "vitest";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";
import {
  RECENT_SALE_CHANGE_DAYS,
  changesSinceCeiling,
  describeSaleChange,
  recentSaleChanges,
  saleChangeDetectedOn,
} from "./sale-change-display";

const now = new Date("2026-10-15T10:00:00Z");

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

const normalize = (value: string | null) => value?.replace(/\s/g, " ") ?? null;

describe("describeSaleChange", () => {
  it("says whether the starting price went down, up or just changed", () => {
    expect(describeSaleChange(event())?.label).toBe("Mise à prix abaissée");
    expect(normalize(describeSaleChange(event())!.detail)).toBe("120 000 € → 100 000 €");
    expect(
      describeSaleChange(event({ changeSummary: { previousValue: 100000, currentValue: 120000 } }))
        ?.label,
    ).toBe("Mise à prix augmentée");
    expect(
      describeSaleChange(event({ changeSummary: { previousValue: "x", currentValue: null } })),
    ).toMatchObject({ label: "Mise à prix modifiée", detail: null });
  });

  it("shows the previous and the new date of the sale, in Paris time", () => {
    const change = describeSaleChange(
      event({
        eventKind: "audience_changed",
        changeSummary: {
          field: "saleDate",
          previousValue: "2026-11-12T08:30:00Z",
          currentValue: "2026-12-03T23:30:00Z",
        },
      }),
    );
    expect(change).toMatchObject({
      topic: "date",
      label: "Date de la vente modifiée",
      // 23:30 UTC on 3 December is already 4 December in Paris.
      detail: "12 novembre 2026 → 4 décembre 2026",
    });
  });

  it.each([
    ["postponed", "Vente reportée"],
    ["cancelled", "Vente annulée"],
    ["canceled", "Vente annulée"],
    ["withdrawn", "Vente retirée"],
    ["adjudicated", "Vente adjugée"],
    ["past", "Date de la vente passée"],
    ["autre", "Statut de la vente modifié"],
  ])("labels a status change to %s", (status, label) => {
    expect(
      describeSaleChange(
        event({
          eventKind: "status_changed",
          changeSummary: { field: "status", previousValue: "upcoming", currentValue: status },
        }),
      )?.label,
    ).toBe(label);
  });

  it("announces a removal deduced from the source's absence as a missing announcement, not a withdrawal", () => {
    const change = describeSaleChange(
      event({
        eventKind: "status_changed",
        severity: "important",
        changeSummary: {
          field: "status",
          previousValue: "upcoming",
          currentValue: "withdrawn",
          reason: "source_absence",
        },
      }),
    );
    expect(change).toMatchObject({
      topic: "status",
      label: "Annonce disparue de la source",
      detail: "À vérifier auprès de l’avocat poursuivant.",
    });
    expect(`${change?.label} ${change?.detail}`).not.toMatch(/retir/i);
  });

  it("keeps « Vente retirée » for a withdrawal the source itself published", () => {
    expect(
      describeSaleChange(
        event({
          eventKind: "status_changed",
          changeSummary: { field: "status", previousValue: "upcoming", currentValue: "withdrawn" },
        }),
      )?.label,
    ).toBe("Vente retirée");
  });

  it("only accepts the known document labels, never free text", () => {
    const documents = (summaryLabel: string) =>
      describeSaleChange(event({ eventKind: "documents_changed", summaryLabel }))?.label;
    expect(documents("Nouveau document détecté")).toBe("Nouveau document détecté");
    expect(documents("<script>")).toBe("Documents modifiés");
  });

  it("does not show score changes", () => {
    expect(describeSaleChange(event({ eventKind: "score_changed" }))).toBeNull();
  });

  it("masks the values of a topic held back by the review of the fiche", () => {
    expect(describeSaleChange(event(), new Set(["price"]))?.detail).toBe("Montants à confirmer.");
    expect(
      describeSaleChange(
        event({
          eventKind: "audience_changed",
          changeSummary: {
            previousValue: "2026-11-12T08:30:00Z",
            currentValue: "2026-12-03T08:30:00Z",
          },
        }),
        new Set(["date"]),
      )?.detail,
    ).toBe("Dates à confirmer.");
  });
});

describe("recentSaleChanges", () => {
  const followed = new Set(["sale-1", "sale-2"]);

  it("lists the followed sales only, newest first", () => {
    const list = recentSaleChanges(
      [
        event({ id: "old", detectedAt: "2026-10-01T06:00:00Z" }),
        event({
          id: "other-sale",
          saleId: "sale-9",
          detectedAt: "2026-10-14T06:00:00Z",
        }),
        event({
          id: "new",
          saleId: "sale-2",
          fingerprint: "other",
          detectedAt: "2026-10-14T06:00:00Z",
        }),
      ],
      followed,
      { now },
    );
    expect(list.map(({ event: { id } }) => id)).toEqual(["new", "old"]);
  });

  it("lists a change once even when it was recorded for several watches", () => {
    const list = recentSaleChanges(
      [
        event({ id: "favorite", watchKind: "favorite" }),
        event({ id: "alert", watchKind: "alert_match", watchId: "watch-2" }),
        event({ id: "workspace", watchKind: "workspace", watchId: "watch-3" }),
      ],
      followed,
      { now },
    );
    expect(list).toHaveLength(1);
  });

  it("keeps two different changes of the same sale", () => {
    const list = recentSaleChanges(
      [
        event({ id: "a" }),
        event({ id: "b", fingerprint: "price_changed:startingPriceEur:100000:90000" }),
      ],
      followed,
      { now },
    );
    expect(list).toHaveLength(2);
  });

  it("leaves out dismissed, too old and hidden-kind events", () => {
    const list = recentSaleChanges(
      [
        event({ id: "dismissed", dismissedAt: "2026-10-14T08:00:00Z" }),
        event({
          id: "too-old",
          detectedAt: new Date(
            now.getTime() - (RECENT_SALE_CHANGE_DAYS + 1) * 86_400_000,
          ).toISOString(),
          fingerprint: "old",
        }),
        event({ id: "score", eventKind: "score_changed", fingerprint: "score" }),
        event({ id: "bad-date", detectedAt: "pas une date", fingerprint: "bad" }),
      ],
      followed,
      { now },
    );
    expect(list).toEqual([]);
  });

  it("applies the masked topics of each sale", () => {
    const [change] = recentSaleChanges([event()], followed, {
      now,
      hiddenTopics: (saleId) => (saleId === "sale-1" ? new Set(["price"]) : new Set()),
    });
    expect(change.detail).toBe("Montants à confirmer.");
  });
});

describe("saleChangeDetectedOn", () => {
  it("formats the detection day in Paris time", () => {
    expect(saleChangeDetectedOn("2026-10-14T22:30:00Z")).toBe("15 octobre 2026");
    expect(saleChangeDetectedOn("n'importe quoi")).toBeNull();
  });
});

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
