import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  adminFrom: vi.fn(),
  assertPublicationVisible: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.adminFrom },
}));
vi.mock("@/lib/sale-publication-guard", () => ({
  assertSalePublicationVisible: mocks.assertPublicationVisible,
}));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";

const saleRow = {
  id: saleId,
  title: "Appartement T3",
  property_type: "apartment",
  source_checks: null,
  source_conflicts: null,
  quality_flags: [],
  sale_date: "2026-10-10T10:00:00Z",
  starting_price_eur: 120000,
  occupancy_status: "vacant",
  app_surface_m2: 62,
  habitable_surface_m2: null,
  carrez_surface_m2: null,
  land_surface_m2: null,
  app_surface_kind: "habitable",
  surface_scope: "appartement",
  surface_source: "source",
  surface_confidence: 0.95,
  surface_evidence: "62 m²",
  rooms_count: 3,
  bedrooms_count: 2,
};

function setup({
  claims = [],
  claimError = null,
  visibleSale = saleRow,
}: {
  claims?: unknown[];
  claimError?: { code?: string; message?: string } | null;
  visibleSale?: typeof saleRow | null;
} = {}) {
  const saleQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  saleQuery.select.mockReturnValue(saleQuery);
  saleQuery.eq.mockReturnValue(saleQuery);
  saleQuery.maybeSingle.mockResolvedValue({ data: visibleSale, error: null });

  const claimQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
  };
  claimQuery.select.mockReturnValue(claimQuery);
  claimQuery.eq.mockReturnValue(claimQuery);
  claimQuery.in.mockResolvedValue({ data: claims, error: claimError });

  mocks.auth.mockResolvedValue({
    supabase: { from: vi.fn().mockReturnValue(saleQuery) },
  });
  mocks.adminFrom.mockReturnValue(claimQuery);
  return { saleQuery, claimQuery };
}

const request = () => new Request(`https://example.test/api/sales/${saleId}/facts`);
const context = { params: Promise.resolve({ id: saleId }) };

beforeEach(() => vi.resetAllMocks());

describe("sale fact reliability route", () => {
  it("returns only sanitized statuses for an authorized sale", async () => {
    const { claimQuery } = setup({
      claims: [
        {
          field_key: "sale_date",
          fact_status: "accepted",
          value_jsonb: saleRow.sale_date,
          captured_at: "2026-09-28T09:00:00Z",
          source_url: "https://private.example/source.pdf",
          raw_artifact_id: "secret-artifact-id",
        },
        {
          field_key: "starting_price_eur",
          fact_status: "candidate",
          value_jsonb: 120000,
          captured_at: "2026-09-28T09:01:00Z",
        },
        { field_key: "surface_m2", fact_status: "conflicted", value_jsonb: 60, captured_at: null },
        {
          field_key: "occupancy_status",
          fact_status: "accepted",
          value_jsonb: "vacant",
          captured_at: null,
        },
      ],
    });

    const response = await GET(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.source).toBe("claims");
    expect(payload.facts).toMatchObject({
      sale_date: { status: "observed" },
      starting_price_eur: { status: "to_confirm" },
      surface: { status: "conflict" },
      occupancy_status: { status: "observed" },
    });
    expect(JSON.stringify(payload)).not.toContain("private.example");
    expect(JSON.stringify(payload)).not.toContain("secret-artifact-id");
    expect(claimQuery.select).toHaveBeenCalledWith(
      "field_key,fact_status,value_jsonb,confidence_score,captured_at",
    );
    expect(mocks.assertPublicationVisible).toHaveBeenCalledWith(saleId);
  });

  it("falls back to legacy field evidence when the additive view is unavailable", async () => {
    setup({ claims: null as unknown as unknown[], claimError: { code: "PGRST205" } });

    const response = await GET(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.source).toBe("legacy");
    expect(payload.facts.sale_date.status).toBe("to_confirm");
    expect(payload.facts.starting_price_eur.status).toBe("to_confirm");
  });

  it("does not query service-role claims when RLS hides the sale", async () => {
    setup({ visibleSale: null });

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("does not expose claims for a quarantined sale", async () => {
    const { claimQuery } = setup();
    mocks.assertPublicationVisible.mockRejectedValue(
      new Error("Vente introuvable ou inaccessible."),
    );

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    expect(claimQuery.in).not.toHaveBeenCalled();
  });

  it("rejects malformed ids before checking auth", async () => {
    const response = await GET(new Request("https://example.test/api/sales/not-a-uuid/facts"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
