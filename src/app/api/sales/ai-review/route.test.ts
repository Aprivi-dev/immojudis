import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  adminFrom: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: () => "token",
  requireSupabaseAuthContext: mocks.auth,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.adminFrom },
}));

import { GET } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const secondSaleId = "22222222-2222-4222-8222-222222222222";

function setup({
  visibleIds = [saleId],
  projections = [] as unknown[],
  caseStatuses = [] as unknown[],
  publishableRows = [] as unknown[],
  canonicalRows,
  unlockedRows = [] as unknown[],
  unlockedError = null as { code: string } | null,
}: {
  unlockedRows?: unknown[];
  unlockedError?: { code: string } | null;
  visibleIds?: string[];
  projections?: unknown[];
  caseStatuses?: unknown[];
  publishableRows?: unknown[];
  canonicalRows?: unknown[];
} = {}) {
  const saleQuery = {
    select: vi.fn(),
    in: vi.fn(),
  };
  saleQuery.select.mockReturnValue(saleQuery);
  saleQuery.in.mockResolvedValue({
    data: canonicalRows ?? visibleIds.map((id) => ({ id })),
    error: null,
  });

  const projectionQuery = {
    select: vi.fn(),
    in: vi.fn(),
  };
  projectionQuery.select.mockReturnValue(projectionQuery);
  projectionQuery.in.mockResolvedValue({ data: projections, error: null });

  const caseStatusQuery = {
    select: vi.fn(),
    in: vi.fn(),
  };
  caseStatusQuery.select.mockReturnValue(caseStatusQuery);
  caseStatusQuery.in.mockResolvedValue({ data: caseStatuses, error: null });

  const publishableQuery = {
    select: vi.fn(),
    in: vi.fn(),
  };
  publishableQuery.select.mockReturnValue(publishableQuery);
  publishableQuery.in.mockResolvedValue({ data: publishableRows, error: null });

  // The sales the account unlocked, through their own view (a Découverte account).
  const unlockedQuery = { select: vi.fn(), in: vi.fn() };
  unlockedQuery.select.mockReturnValue(unlockedQuery);
  unlockedQuery.in.mockResolvedValue({
    data: unlockedError ? null : unlockedRows,
    error: unlockedError,
  });
  const userFrom = vi.fn((table: string) =>
    table === "v_auction_sales_unlocked" ? unlockedQuery : saleQuery,
  );
  mocks.auth.mockResolvedValue({ supabase: { from: userFrom } });
  mocks.adminFrom.mockImplementation((table: string) =>
    table === "v_auction_ai_review_publishable"
      ? publishableQuery
      : table === "auction_ai_review_case_status"
        ? caseStatusQuery
        : projectionQuery,
  );
  return { saleQuery, unlockedQuery, userFrom, projectionQuery, caseStatusQuery, publishableQuery };
}

function request(ids: string[] = [saleId]) {
  const params = new URLSearchParams();
  ids.forEach((id) => params.append("id", id));
  return GET(new Request(`https://example.test/api/sales/ai-review?${params.toString()}`));
}

beforeEach(() => vi.resetAllMocks());

describe("GET /api/sales/ai-review", () => {
  it("returns only the safe review status and provenance contract", async () => {
    const { projectionQuery } = setup({
      projections: [
        {
          auction_sale_id: saleId,
          field_key: "property.property_type",
          review_state: "unverified",
          citation_status: "unverified",
          is_publishable: false,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
          value_jsonb: "private value",
          evidence_locator: { excerpt: "private evidence" },
        },
        {
          auction_sale_id: saleId,
          field_key: "private.capture_text",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: true,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
          value_jsonb: "must not be returned",
        },
      ],
    });

    const response = await request();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    expect(payload).toEqual({
      projections: [
        {
          auction_sale_id: saleId,
          field_key: "property.property_type",
          review_state: "unverified",
          citation_status: "unverified",
          is_publishable: false,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("private evidence");
    expect(JSON.stringify(payload)).not.toContain("private value");
    expect(projectionQuery.select).toHaveBeenCalledWith(
      "auction_sale_id,field_key,review_state,citation_status,is_publishable,source_name,source_url",
    );
  });

  it("blocks every reviewed field without reading private projections when the sale is not visible", async () => {
    setup({ visibleIds: [] });

    const response = await request();

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.projections).toHaveLength(12);
    expect(payload.projections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          auction_sale_id: saleId,
          field_key: "sale.starting_price_eur",
          is_publishable: false,
          sale_unavailable: true,
          source_name: null,
          source_url: null,
        }),
      ]),
    );
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("keeps the review on a sale the account unlocked, without its citation links or source names", async () => {
    const { userFrom, unlockedQuery } = setup({
      visibleIds: [],
      unlockedRows: [{ id: saleId }],
      projections: [
        {
          auction_sale_id: saleId,
          field_key: "property.property_type",
          review_state: "unverified",
          citation_status: "unverified",
          is_publishable: false,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
        },
      ],
    });

    const payload = await (await request()).json();

    expect(userFrom).toHaveBeenCalledWith("v_auction_sales_app");
    expect(userFrom).toHaveBeenCalledWith("v_auction_sales_unlocked");
    expect(unlockedQuery.in).toHaveBeenCalledWith("id", [saleId]);
    expect(payload.projections).toEqual([
      expect.objectContaining({
        auction_sale_id: saleId,
        field_key: "property.property_type",
        is_publishable: false,
        source_name: null,
        source_url: null,
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("sale_unavailable");
  });

  it("keeps the blocking rows of an unlocked sale outside the ceiling, and drops the publishable ones", async () => {
    const row = (field_key: string, blocking: boolean) => ({
      auction_sale_id: saleId,
      field_key,
      review_state: blocking ? "unverified" : "resolved",
      citation_status: blocking ? "unverified" : "verified",
      is_publishable: !blocking,
      source_name: "AGRASC",
      source_url: "https://example.test/source/1",
    });
    setup({
      visibleIds: [],
      unlockedRows: [{ id: saleId, starting_price_eur: 80000, parking_count: 1 }],
      publishableRows: [
        {
          auction_sale_id: saleId,
          field_key: "sale.starting_price_eur",
          is_publishable: true,
          value_jsonb: 80000,
        },
        {
          auction_sale_id: saleId,
          field_key: "property.parking_count",
          is_publishable: true,
          value_jsonb: 1,
        },
      ],
      // Only the listed fields have a row; the others are not sampled (no « missing projection »).
      projections: [
        row("sale.starting_price_eur", false),
        row("property.habitable_surface_m2", true),
        row("property.city", true),
        row("sale.sale_date", true),
        row("property.parking_count", false),
      ],
    });

    const payload = await (await request()).json();
    const rows = payload.projections as {
      field_key: string;
      source_name: string | null;
      source_url: string | null;
    }[];
    const keys = rows.map((p) => p.field_key).sort();

    // The ceiling fields stay as they are; the city and the date, blocked, keep masking the
    // address and the date the unlocked view exposes; the publishable parking row goes.
    expect(new Set(keys)).toEqual(
      new Set([
        "sale.starting_price_eur",
        "property.habitable_surface_m2",
        "property.city",
        "sale.sale_date",
      ]),
    );
    expect(keys).not.toContain("property.parking_count");
    for (const projection of rows) {
      expect(projection.source_name).toBeNull();
      expect(projection.source_url).toBeNull();
    }
  });

  it("keeps the « missing projection » blocks of an unlocked sampled sale on every field", async () => {
    setup({
      visibleIds: [],
      unlockedRows: [{ id: saleId }],
      caseStatuses: [{ auction_sale_id: saleId, mapping_status: "exact" }],
      projections: [],
    });

    const payload = await (await request()).json();
    const rows = payload.projections as { field_key: string; projection_missing?: boolean }[];

    expect(rows).toHaveLength(12);
    expect(rows.every((projection) => projection.projection_missing === true)).toBe(true);
    expect(rows.map((projection) => projection.field_key)).toContain("property.city");
  });

  it("keeps the whole review for a sale the account can read in full (Analyse)", async () => {
    setup({
      visibleIds: [saleId],
      projections: [
        {
          auction_sale_id: saleId,
          field_key: "property.city",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: false,
          source_name: null,
          source_url: null,
        },
      ],
    });
    const payload = await (await request()).json();
    expect(payload.projections.map((p: { field_key: string }) => p.field_key)).toContain(
      "property.city",
    );
  });

  it("does not read the unlocked view for sales the full view already shows", async () => {
    const { userFrom } = setup({ visibleIds: [saleId] });
    await request();
    expect(userFrom).not.toHaveBeenCalledWith("v_auction_sales_unlocked");
  });

  it("treats a database without the unlocked view as having no unlocked sale", async () => {
    setup({ visibleIds: [], unlockedError: { code: "PGRST205" } });
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).projections[0]).toMatchObject({ sale_unavailable: true });
  });

  it("blocks every field when a sampled visible sale has no AI projection row", async () => {
    const { caseStatusQuery } = setup({
      visibleIds: [saleId],
      projections: [],
      caseStatuses: [
        { auction_sale_id: saleId, mapping_status: "exact", access_state: "captured" },
      ],
    });

    const response = await request();

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.projections).toHaveLength(12);
    expect(payload.projections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          auction_sale_id: saleId,
          field_key: "property.city",
          review_state: "unresolved",
          is_publishable: false,
          projection_missing: true,
        }),
      ]),
    );
    expect(JSON.stringify(payload)).not.toContain("not_reviewed");
    expect(caseStatusQuery.select).toHaveBeenCalledWith(
      "auction_sale_id,mapping_status,access_state",
    );
  });

  it("leaves an unsampled visible sale explicitly not_reviewed when it has no projection", async () => {
    setup({ visibleIds: [saleId], projections: [], caseStatuses: [] });

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projections: [] });
  });

  it("blocks only the missing fields when a sampled sale has a partial projection", async () => {
    setup({
      visibleIds: [saleId],
      projections: [
        {
          auction_sale_id: saleId,
          field_key: "property.property_type",
          review_state: "unresolved",
          citation_status: "not_required",
          is_publishable: false,
          source_name: null,
          source_url: null,
        },
      ],
      caseStatuses: [
        { auction_sale_id: saleId, mapping_status: "exact", access_state: "captured" },
      ],
    });

    const response = await request();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.projections).toHaveLength(12);
    const propertyTypeProjection = payload.projections.find(
      (projection: { field_key?: string }) => projection.field_key === "property.property_type",
    );
    const cityProjection = payload.projections.find(
      (projection: { field_key?: string }) => projection.field_key === "property.city",
    );
    expect(propertyTypeProjection).toMatchObject({
      auction_sale_id: saleId,
      is_publishable: false,
    });
    expect(propertyTypeProjection).not.toHaveProperty("projection_missing");
    expect(cityProjection).toMatchObject({
      auction_sale_id: saleId,
      projection_missing: true,
    });
  });

  it("returns unauthorized without touching the private projection reader", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized: session required"));

    const response = await request();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentification requise.",
    });
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("blocks a hidden sale in a mixed visibility response without leaking its private data", async () => {
    const { projectionQuery, publishableQuery, saleQuery } = setup({
      visibleIds: [saleId],
      canonicalRows: [{ id: saleId, city: "Paris" }],
      projections: [
        {
          auction_sale_id: saleId,
          field_key: "property.city",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: true,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
        },
        {
          auction_sale_id: secondSaleId,
          field_key: "property.city",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: true,
          source_name: "private",
          source_url: "https://example.test/private",
        },
      ],
      publishableRows: [
        {
          auction_sale_id: saleId,
          field_key: "property.city",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: true,
          value_jsonb: "Paris",
        },
      ],
    });

    saleQuery.in.mockResolvedValue({
      data: [{ id: saleId, city: "Paris" }],
      error: null,
    });

    const response = await request([saleId, secondSaleId]);

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.projections).toHaveLength(13);
    expect(payload.projections).toEqual(
      expect.arrayContaining([
        {
          auction_sale_id: saleId,
          field_key: "property.city",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: true,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
        },
        expect.objectContaining({
          auction_sale_id: secondSaleId,
          field_key: "property.city",
          is_publishable: false,
          sale_unavailable: true,
          source_name: null,
          source_url: null,
        }),
      ]),
    );
    expect(JSON.stringify(payload)).not.toContain("https://example.test/private");
    expect(saleQuery.in).toHaveBeenCalledWith("id", [saleId, secondSaleId]);
    expect(projectionQuery.in).toHaveBeenCalledWith("auction_sale_id", [saleId]);
    expect(publishableQuery.in).toHaveBeenCalledWith("auction_sale_id", [saleId]);
  });

  it("blocks a publishable projection when its value diverges from the canonical sale row", async () => {
    const { publishableQuery } = setup({
      canonicalRows: [{ id: saleId, city: "Paris" }],
      projections: [
        {
          auction_sale_id: saleId,
          field_key: "property.city",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: true,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
        },
      ],
      publishableRows: [
        {
          auction_sale_id: saleId,
          field_key: "property.city",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: true,
          value_jsonb: "Lyon",
          evidence_locator: { excerpt: "private" },
        },
      ],
    });

    const response = await request();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      projections: [
        {
          auction_sale_id: saleId,
          field_key: "property.city",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: false,
          canonical_value_matches: false,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("Lyon");
    expect(JSON.stringify(payload)).not.toContain("private");
    expect(publishableQuery.select).toHaveBeenCalledWith(
      "auction_sale_id,field_key,review_state,citation_status,is_publishable,source_name,source_url,value_jsonb",
    );
  });

  it("does not treat two invalid energy classes as a verified match", async () => {
    setup({
      canonicalRows: [{ id: saleId, source_blocks: { dpe: "X" } }],
      projections: [
        {
          auction_sale_id: saleId,
          field_key: "property.source_energy_dpe_class",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: true,
          source_name: "AGRASC",
          source_url: "https://example.test/source/1",
        },
      ],
      publishableRows: [
        {
          auction_sale_id: saleId,
          field_key: "property.source_energy_dpe_class",
          review_state: "resolved",
          citation_status: "verified",
          is_publishable: true,
          value_jsonb: "X",
        },
      ],
    });

    const response = await request();
    const payload = await response.json();

    expect(payload.projections[0]).toMatchObject({
      is_publishable: false,
      canonical_value_matches: false,
    });
  });

  it("rejects malformed ids before authentication", async () => {
    const response = await request(["not-a-uuid"]);

    expect(response.status).toBe(400);
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("does not expose a database error as a projection payload", async () => {
    const { projectionQuery } = setup({
      visibleIds: [saleId, secondSaleId],
    });
    projectionQuery.in.mockResolvedValue({
      data: null,
      error: { message: "relation is unavailable" },
    });

    const response = await request([saleId, secondSaleId]);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "La relecture IA de cette annonce est momentanément indisponible.",
    });
  });
});
