import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractInformationAgentFacts,
  factSourceAnchor,
} from "@/lib/information-agent-inbound/fact-extraction";
import { reviewLot, type LotContext } from "@/lib/information-agent-inbound/review-signals";
import { saleLotContext } from "@/lib/information-agent-inbound/attachments";

/**
 * Cas d'attaque de l'extraction (relecture du 10/11/2026), communs avec le validateur de la lecture par
 * l'IA (`services/data-pipeline/tests/test_information_agent_extraction_attack.py`). Règles TypeScript :
 * aucun fait net hors de `ts_clear`, et chaque fait de `ts_clear` reste net (pas de perte de couverture).
 */
type AttackCase = {
  id: string;
  text: string;
  lot: string | null;
  ts_clear: Array<[string, number | string]>;
};
const FIXTURE = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "services/data-pipeline/tests/fixtures/information_agent_extraction_attack.json",
    ),
    "utf8",
  ),
) as { facts: AttackCase[]; rules_only: AttackCase[] };

const LOTS: Record<string, LotContext> = {
  sold_lot_2_of_3: saleLotContext(["multi_lot_sale"], {
    status: "selected",
    lot_number: 2,
    lot_count: 3,
  }),
};

/** Faits nets des règles, après le contrôle du lot fait à l'enregistrement du candidat. */
function clearFacts(testCase: AttackCase): string[] {
  const context = testCase.lot ? (LOTS[testCase.lot] ?? null) : null;
  return extractInformationAgentFacts(testCase.text).flatMap((fact) => {
    const anchor = factSourceAnchor(fact);
    const lot = anchor
      ? reviewLot(anchor.text, [anchor.start, anchor.end], context)
      : { rejected: false, reasons: [] };
    if (lot.rejected || fact.reviewReasons?.length || lot.reasons.length) return [];
    const value = fact.proposedValue.value;
    return [`${fact.factKey}=${typeof value === "number" ? value : String(value)}`];
  });
}

describe("règles TypeScript face aux cas d'attaque", () => {
  it.each([...FIXTURE.facts, ...FIXTURE.rules_only].map((testCase) => [testCase.id, testCase]))(
    "%s : aucun faux fait net, aucune perte",
    (_id, testCase) => {
      const allowed = testCase.ts_clear.map(([key, value]) => `${key}=${value}`);
      const clear = clearFacts(testCase);
      expect(clear.filter((fact) => !allowed.includes(fact))).toEqual([]);
      expect(allowed.filter((fact) => !clear.includes(fact))).toEqual([]);
    },
  );

  it("compte les 44 cas et les 8 cas propres aux règles", () => {
    expect(FIXTURE.facts).toHaveLength(44);
    expect(FIXTURE.rules_only).toHaveLength(8);
  });

  it("lit les lots de la vente comme le worker Python", () => {
    expect(saleLotContext([], null)).toEqual({ multiLot: false, soldLot: null });
    expect(saleLotContext(["multi_lot_sale"], null)).toEqual({ multiLot: true, soldLot: null });
    expect(saleLotContext([], { status: "selected", lot_number: 4, lot_count: 3 })).toEqual({
      multiLot: false,
      soldLot: null,
    });
    expect(saleLotContext([], { status: "uncertain", lot_number: 2 })).toEqual({
      multiLot: false,
      soldLot: null,
    });
  });
});
