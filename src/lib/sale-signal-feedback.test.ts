import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SALE_SIGNALS,
  SALE_SIGNAL_REASONS,
  SALE_SIGNAL_REASON_LABELS,
  SALE_SIGNAL_VALUES,
  SALE_SIGNAL_VALUE_LABELS,
  isReasonOfSignal,
} from "./sale-signal-feedback";
import { saleSignalFeedbackSchema } from "./sale-signal-feedback-schema";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261030110100_sale_signal_feedback.sql"),
  "utf8",
);

describe("listes fermées du retour sur un signal", () => {
  it("reprennent exactement celles de la migration", () => {
    const quoted = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    // Le texte d'une contrainte : de son nom jusqu'à la suivante (ou la fin de la table).
    const section = (name: string) =>
      new RegExp(`constraint ${name} check([\\s\\S]*?)(?=\\n  constraint |\\n\\);)`, "i").exec(
        migration,
      )![1];

    expect(quoted(section("sale_signal_feedback_signal_check"))).toEqual([...SALE_SIGNALS]);
    expect(quoted(section("sale_signal_feedback_value_check"))).toEqual([...SALE_SIGNAL_VALUES]);
    const reasons = quoted(section("sale_signal_feedback_reason_check")).filter(
      (word) => !(SALE_SIGNALS as readonly string[]).includes(word) && word !== "not_relevant",
    );
    expect(reasons.sort()).toEqual(
      [...SALE_SIGNAL_REASONS.market_gap_band, ...SALE_SIGNAL_REASONS.points_to_verify].sort(),
    );
  });

  it("donnent un libellé à chaque valeur et à chaque motif", () => {
    for (const value of SALE_SIGNAL_VALUES) {
      expect(SALE_SIGNAL_VALUE_LABELS[value]).toBeTruthy();
    }
    for (const reason of [
      ...SALE_SIGNAL_REASONS.market_gap_band,
      ...SALE_SIGNAL_REASONS.points_to_verify,
    ]) {
      expect(SALE_SIGNAL_REASON_LABELS[reason]).toBeTruthy();
    }
  });

  it("rattachent chaque motif à un seul signal", () => {
    expect(isReasonOfSignal("market_gap_band", "estimate_too_high")).toBe(true);
    expect(isReasonOfSignal("market_gap_band", "point_wrong")).toBe(false);
    expect(isReasonOfSignal("points_to_verify", "point_missing")).toBe(true);
    expect(isReasonOfSignal("points_to_verify", "estimate_too_low")).toBe(false);
  });
});

describe("saleSignalFeedbackSchema", () => {
  it("accepte un « Utile » sans motif et un « Pas pertinent » avec son motif", () => {
    expect(saleSignalFeedbackSchema.parse({ signal: "market_gap_band", value: "useful" })).toEqual({
      signal: "market_gap_band",
      value: "useful",
    });
    expect(
      saleSignalFeedbackSchema.parse({
        signal: "market_gap_band",
        value: "not_relevant",
        reason: "estimate_too_low",
      }),
    ).toEqual({ signal: "market_gap_band", value: "not_relevant", reason: "estimate_too_low" });
  });

  it("refuse tout texte libre : champ en plus, motif hors liste, motif sur « Utile »", () => {
    const refused = [
      { signal: "market_gap_band", value: "useful", comment: "libre" },
      { signal: "points_to_verify", value: "not_relevant", reason: "la cave manque" },
      { signal: "market_gap_band", value: "not_relevant", reason: "point_missing" },
      { signal: "points_to_verify", value: "useful", reason: "point_wrong" },
      { signal: "autre", value: "useful" },
      { signal: "points_to_verify" },
    ];
    for (const body of refused) {
      expect(saleSignalFeedbackSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
