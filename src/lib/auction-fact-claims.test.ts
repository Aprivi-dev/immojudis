import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { readSaleFactClaims, readSaleFactSignals } from "./auction-fact-claims";

const saleId = "11111111-1111-4111-8111-111111111111";

function setup(data: unknown[] | null, error: { code?: string; message?: string } | null = null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockResolvedValue({ data, error });
  mocks.from.mockReturnValue(query);
  return query;
}

beforeEach(() => vi.resetAllMocks());

describe("auction fact claim server contract", () => {
  it("reduces claim rows to field, status, confidence and conflict", async () => {
    setup([
      {
        field_key: "starting_price_eur",
        fact_status: "candidate",
        confidence_score: 0.82,
        value_jsonb: 120000,
        source_url: "https://private.example/source.pdf",
      },
      {
        field_key: "surface_m2",
        fact_status: "conflicted",
        confidence_score: 0.95,
        value_jsonb: 60,
        raw_artifact_id: "private-artifact",
      },
      {
        field_key: "occupancy_status",
        fact_status: "accepted",
        confidence_score: 0.91,
        value_jsonb: "vacant",
      },
    ]);

    const result = await readSaleFactSignals(saleId);

    expect(result.claimsBacked).toBe(true);
    expect(result.signals).toEqual([
      {
        saleId,
        field: "starting_price_eur",
        status: "to_confirm",
        confidence: 0.82,
        conflict: false,
      },
      {
        saleId,
        field: "surface",
        status: "conflict",
        confidence: 0.95,
        conflict: true,
      },
      {
        saleId,
        field: "occupancy_status",
        status: "observed",
        confidence: 0.91,
        conflict: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private.example");
    expect(JSON.stringify(result)).not.toContain("private-artifact");
  });

  it("keeps accepted plus candidate conservative and uses the highest valid score", async () => {
    setup([
      {
        field_key: "sale_date",
        fact_status: "accepted",
        confidence_score: 0.65,
        value_jsonb: "2026-10-10T10:00:00Z",
      },
      {
        field_key: "date",
        fact_status: "candidate",
        confidence_score: 0.88,
        value_jsonb: "2026-10-11T10:00:00Z",
      },
    ]);

    const result = await readSaleFactSignals(saleId);

    expect(result.signals).toEqual([
      {
        saleId,
        field: "sale_date",
        status: "to_confirm",
        confidence: 0.88,
        conflict: false,
      },
    ]);
  });

  it("reads the canonical field keys emitted by the Python fact writer", async () => {
    const query = setup([
      {
        field_key: "sale.sale_date",
        fact_status: "accepted",
        value_jsonb: "2026-10-10T10:00:00Z",
        confidence_score: 0.94,
        captured_at: "2026-09-28T09:00:00Z",
      },
      {
        field_key: "sale.starting_price_eur",
        fact_status: "candidate",
        value_jsonb: 120000,
        confidence_score: 0.92,
        captured_at: "2026-09-28T09:00:00Z",
      },
      {
        field_key: "property.surface_m2",
        fact_status: "conflicted",
        value_jsonb: 62,
        confidence_score: 0.88,
        captured_at: "2026-09-28T09:00:00Z",
      },
      {
        field_key: "property.occupancy_status",
        fact_status: "accepted",
        value_jsonb: "vacant",
        confidence_score: 0.87,
        captured_at: "2026-09-28T09:00:00Z",
      },
    ]);

    const result = await readSaleFactSignals(saleId);

    expect(result.signals).toEqual([
      {
        saleId,
        field: "sale_date",
        status: "observed",
        confidence: 0.94,
        conflict: false,
      },
      {
        saleId,
        field: "starting_price_eur",
        status: "to_confirm",
        confidence: 0.92,
        conflict: false,
      },
      {
        saleId,
        field: "surface",
        status: "conflict",
        confidence: 0.88,
        conflict: true,
      },
      {
        saleId,
        field: "occupancy_status",
        status: "observed",
        confidence: 0.87,
        conflict: false,
      },
    ]);

    const fieldKeys = query.in.mock.calls[0]?.[1] as string[];
    expect(fieldKeys).toEqual(
      expect.arrayContaining([
        "sale.sale_date",
        "sale.starting_price_eur",
        "property.surface_m2",
        "property.occupancy_status",
      ]),
    );
  });

  it("ignores an agent observation whose latest registry decision is not a holding acceptance", async () => {
    const claims = [
      // Acceptée au registre, lot unique : comptée.
      {
        claim_id: "claim-held",
        field_key: "property.occupancy_status",
        fact_status: "accepted",
        value_jsonb: "vacant",
        evidence_locator: { information_agent_fact_id: "fact-held" },
      },
      // Décision jamais écrite (échec après l'acceptation) : ignorée.
      {
        claim_id: "claim-undecided",
        field_key: "property.surface_m2",
        fact_status: "accepted",
        value_jsonb: 54,
        evidence_locator: { information_agent_fact_id: "fact-undecided" },
      },
      // Opposition après l'acceptation : ignorée.
      {
        claim_id: "claim-opposed",
        field_key: "sale.starting_price_eur",
        fact_status: "accepted",
        value_jsonb: 95000,
        evidence_locator: { information_agent_fact_id: "fact-opposed" },
      },
      // Lot inconnu : la valeur n'est pas affichée, ignorée.
      {
        claim_id: "claim-unknown-lot",
        field_key: "property.surface_m2",
        fact_status: "accepted",
        value_jsonb: 56,
        evidence_locator: { information_agent_fact_id: "fact-unknown-lot" },
      },
      // Observation de la collecte : jamais filtrée.
      { claim_id: "claim-listing", field_key: "sale.sale_date", fact_status: "accepted" },
    ];
    const decisions = [
      { claim_id: "claim-opposed", decision: "opposed", lot_attachment: "single_lot", seq: 9 },
      { claim_id: "claim-opposed", decision: "accepted", lot_attachment: "single_lot", seq: 8 },
      { claim_id: "claim-held", decision: "accepted", lot_attachment: "single_lot", seq: 7 },
      { claim_id: "claim-unknown-lot", decision: "accepted", lot_attachment: "unknown", seq: 6 },
    ];
    const decisionQuery = { select: vi.fn(), in: vi.fn(), order: vi.fn() };
    decisionQuery.select.mockReturnValue(decisionQuery);
    decisionQuery.in.mockReturnValue(decisionQuery);
    decisionQuery.order.mockResolvedValue({ data: decisions, error: null });
    const claimQuery = setup(claims);
    mocks.from.mockImplementation((table: string) =>
      table === "auction_fact_claim_decisions" ? decisionQuery : claimQuery,
    );

    const result = await readSaleFactClaims(saleId);

    expect(result.claims.map((claim) => claim.field_key)).toEqual([
      "property.occupancy_status",
      "sale.sale_date",
    ]);
    expect(decisionQuery.in).toHaveBeenCalledWith("claim_id", [
      "claim-held",
      "claim-undecided",
      "claim-opposed",
      "claim-unknown-lot",
    ]);
    expect(JSON.stringify(result)).not.toContain("fact-held");
  });

  it("throws a failed read instead of reporting a sale without claims", async () => {
    const failure = { code: "PGRST205", message: "view missing" };
    setup(null, failure);

    await expect(readSaleFactClaims(saleId)).rejects.toBe(failure);
    await expect(readSaleFactSignals(saleId)).rejects.toBe(failure);
  });
});
