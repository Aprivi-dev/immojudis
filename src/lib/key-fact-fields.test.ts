import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { readSaleFactClaims, readSaleFactSignals } from "./auction-fact-claims";
import { EXAMPLE_SALE } from "./example-sale";
import { getFactReliabilitiesFromClaims, type KeyFact } from "./fact-reliability";
import { KEY_FACT_FIELDS, normalizeFactKey } from "./key-fact-fields";

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const FACTS = Object.keys(KEY_FACT_FIELDS) as KeyFact[];
const ALL_KEYS = FACTS.flatMap((fact) => KEY_FACT_FIELDS[fact]);

function claimRows(rows: unknown[]) {
  const query = { select: vi.fn(), eq: vi.fn(), in: vi.fn() };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockResolvedValue({ data: rows, error: null });
  mocks.from.mockReturnValue(query);
  return query;
}

beforeEach(() => vi.resetAllMocks());

describe("clés de champ des faits clés", () => {
  it("couvrent les quatre faits clés, chaque clé désignant un seul fait, déjà normalisée", () => {
    expect([...FACTS].sort()).toEqual([
      "occupancy_status",
      "sale_date",
      "starting_price_eur",
      "surface",
    ]);
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
    for (const key of ALL_KEYS) expect(normalizeFactKey(key)).toBe(key);
  });

  it("normalise accents, casse, espaces et tirets", () => {
    expect(normalizeFactKey("Mise-à prix")).toBe("mise_a_prix");
  });

  it("le serveur lit les faits relevés sous chacune de ces clés, et sous aucune autre", async () => {
    const query = claimRows([]);

    await readSaleFactClaims(SALE_ID);

    expect(query.in).toHaveBeenCalledWith("field_key", expect.any(Array));
    expect([...query.in.mock.calls[0][1]].sort()).toEqual([...ALL_KEYS].sort());
  });

  it("le serveur et la fiche rattachent une même clé au même fait", async () => {
    for (const fact of FACTS.filter((field) => field !== "surface")) {
      for (const key of KEY_FACT_FIELDS[fact]) {
        claimRows([{ field_key: key, fact_status: "conflicted", confidence_score: 0.9 }]);
        const { signals } = await readSaleFactSignals(SALE_ID);
        const facts = getFactReliabilitiesFromClaims(EXAMPLE_SALE, [
          { field_key: key, fact_status: "conflicted", captured_at: null },
        ]);

        expect(
          signals.map((signal) => signal.field),
          key,
        ).toEqual([fact]);
        expect(facts[fact].status, key).toBe("conflict");
      }
    }
  });
});
