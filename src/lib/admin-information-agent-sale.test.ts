import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import {
  loadAdminInformationAgentSale,
  requireAdminInformationAgentSaleAccess,
} from "./admin-information-agent-sale";

const saleId = "11111111-1111-4111-8111-111111111111";
const auth = { isAdmin: true };

function baseQuery(data: unknown, error: unknown = null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data, error });
  return query;
}

function documentsQuery(data: unknown[], error: unknown = null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockResolvedValue({ data, error });
  return query;
}

function sourcePresenceQuery(data: unknown[], error: unknown = null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockResolvedValue({ data, error });
  return query;
}

function setup({
  sale,
  documents = [],
  sourcePresence = [],
  saleError = null,
  documentsError = null,
  sourcePresenceError = null,
}: {
  sale: unknown;
  documents?: unknown[];
  sourcePresence?: unknown[];
  saleError?: unknown;
  documentsError?: unknown;
  sourcePresenceError?: unknown;
}) {
  const saleQuery = baseQuery(sale, saleError);
  const docsQuery = documentsQuery(documents, documentsError);
  const sourcePresenceQueryInstance = sourcePresenceQuery(sourcePresence, sourcePresenceError);
  mocks.from.mockImplementation((table: string) => {
    if (table === "auction_sales") return saleQuery;
    if (table === "auction_documents") return docsQuery;
    if (table === "auction_sale_source_presence") return sourcePresenceQueryInstance;
    throw new Error(`unexpected table ${table}`);
  });
  return { saleQuery, docsQuery, sourcePresenceQuery: sourcePresenceQueryInstance };
}

const quarantinedInternalSale = {
  id: saleId,
  status: "upcoming",
  premium_readiness_status: "internal_only",
  raw_payload: {
    publication_quarantine: "source_detail_excluded",
    source_description: "Maître Dupont — contact dupont@example.test",
    llm_display_description: "Synthèse interne.",
    source_conflicts: [
      {
        field: "starting_price_eur",
        selected: "120000",
        alternative: "125000",
        selected_source: "primary-source",
        alternative_source: "second-source",
      },
    ],
    source_checks: {
      starting_price_eur: { checked_at: "2026-10-07T12:00:00Z" },
    },
    source_presence: {
      raw_only: {
        state: "raw-only",
        availability: "available",
        checked_at: "2026-10-07T12:00:00Z",
      },
    },
    source_blocks: {
      lawyer: "Maître Dupont dupont@example.test",
      page_text: "Conditions de vente à confirmer.",
    },
    raw_image_url: "https://assets.example.test/front.jpg",
    source_images: [
      "https://assets.example.test/front.jpg",
      "https://assets.example.test/logo.png",
      "https://assets.example.test/plan.pdf",
    ],
  },
  observations: [
    {
      source_name: "second-source",
      raw_payload: {
        source_blocks: { contact: "Etude second@example.test" },
        source_images: ["https://assets.example.test/second.jpg"],
      },
    },
  ],
  source_name: "primary-source",
  source_url: "https://source.example.test/sale/1",
  primary_source: "primary-source",
  title: "Appartement à Paris",
  description: "Description publique du lot.",
  city: "Paris",
  department: "75",
  postal_code: "75001",
  address: "1 rue de Test",
  tribunal: "Tribunal judiciaire de Paris",
  tribunal_code: "7501",
  property_type: "apartment",
  starting_price_eur: 120000,
  sale_date: "2026-12-10T09:00:00Z",
  visit_dates: ["2026-12-01T10:00:00Z"],
  lawyer_name: "Maître Dupont",
  lawyer_contact: "dupont@example.test",
  occupancy_status: "unknown",
  app_surface_m2: 42,
  rooms_count: 2,
  sale_procedure: { verification: { status: "pending" } },
  documents: [{ url: "https://source.example.test/conditions.pdf" }],
  quality_flags: [],
  sale_venue_type: "tribunal",
  sale_legal_framework: "judicial_seizure",
  sale_verification_status: "pending",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-07T00:00:00Z",
};

beforeEach(() => vi.resetAllMocks());

describe("admin information-agent sale loader", () => {
  it("loads an internal quarantined sale without using the public projection", async () => {
    const { saleQuery, docsQuery, sourcePresenceQuery } = setup({
      sale: quarantinedInternalSale,
      sourcePresence: [
        {
          source_name: "diagnostics",
          state: "missing",
          availability: "absent",
          checked_at: "2026-10-07T12:00:00Z",
          extras: { audit_error: { code: "timeout" } },
        },
      ],
      documents: [
        {
          document_url: "https://source.example.test/conditions.pdf",
          label: "Cahier des conditions",
          document_type: "conditions",
          extraction_status: "extracted",
          download_status: "downloaded",
          docling_status: "complete",
          text_chars: 4200,
        },
      ],
    });

    const sale = await loadAdminInformationAgentSale({ auth, saleId });

    expect(sale.id).toBe(saleId);
    expect(sale.status).toBe("upcoming");
    expect(sale.source_description).toContain("dupont@example.test");
    expect(sale.source_conflicts).toEqual([
      {
        field: "starting_price_eur",
        selected: "120000",
        alternative: "125000",
        selected_source: "primary-source",
        alternative_source: "second-source",
      },
    ]);
    expect(sale.source_checks).toEqual({
      starting_price_eur: { checked_at: "2026-10-07T12:00:00Z" },
    });
    expect(sale.source_presence).toEqual({
      diagnostics: {
        audit_error: { code: "timeout" },
        state: "missing",
        availability: "absent",
        checked_at: "2026-10-07T12:00:00Z",
      },
    });
    expect(sale.source_blocks).toEqual(quarantinedInternalSale.raw_payload.source_blocks);
    expect(sale.source_blocks_by_source).toEqual({
      "primary-source:primary": quarantinedInternalSale.raw_payload.source_blocks,
      "second-source:1": quarantinedInternalSale.observations[0].raw_payload.source_blocks,
    });
    expect(sale.documents_rich).toEqual([
      {
        url: "https://source.example.test/conditions.pdf",
        label: "Cahier des conditions",
        type: "conditions",
        document_type: "conditions",
        extraction_status: "extracted",
        download_status: "downloaded",
        docling_status: "complete",
        text_chars: 4200,
      },
    ]);
    expect(sale.media).toEqual([
      {
        type: "image",
        url: "https://assets.example.test/front.jpg",
        source: "primary-source",
      },
      {
        type: "image",
        url: "https://assets.example.test/second.jpg",
        source: "second-source",
      },
    ]);
    expect(sale).not.toHaveProperty("raw_payload");
    expect(sale).not.toHaveProperty("observations");

    expect(mocks.from).toHaveBeenCalledWith("auction_sales");
    expect(mocks.from).toHaveBeenCalledWith("auction_documents");
    expect(mocks.from).toHaveBeenCalledWith("auction_sale_source_presence");
    expect(mocks.from).not.toHaveBeenCalledWith("v_auction_sales_app");
    expect(saleQuery.select).toHaveBeenCalledWith(
      expect.not.stringContaining("v_auction_sales_app"),
    );
    expect(saleQuery.select).toHaveBeenCalledWith(expect.not.stringContaining("media"));
    expect(docsQuery.eq).toHaveBeenCalledWith("source_url", quarantinedInternalSale.source_url);
    expect(docsQuery.select).toHaveBeenCalledWith(
      "document_url,label,document_type,extraction_status,download_status,docling_status,text_chars",
    );
    expect(sourcePresenceQuery.select).toHaveBeenCalledWith(
      "source_name,availability,state,attempted_at,checked_at,run_id,extras",
    );
    expect(sourcePresenceQuery.eq).toHaveBeenCalledWith("sale_id", saleId);
  });

  it("refuses a non-admin before touching the service-role data", async () => {
    await expect(
      loadAdminInformationAgentSale({ auth: { isAdmin: false }, saleId }),
    ).rejects.toThrow("accès administrateur requis");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("uses raw source presence only while the projection relation is absent", async () => {
    setup({
      sale: quarantinedInternalSale,
      sourcePresenceError: {
        code: "PGRST205",
        message: "Could not find the table 'public.auction_sale_source_presence'",
      },
    });

    const sale = await loadAdminInformationAgentSale({ auth, saleId });

    expect(sale.source_presence).toEqual(quarantinedInternalSale.raw_payload.source_presence);
  });

  it("does not fall back to stale raw presence when the projection is empty", async () => {
    setup({ sale: quarantinedInternalSale, sourcePresence: [] });

    const sale = await loadAdminInformationAgentSale({ auth, saleId });

    expect(sale.source_presence).toBeNull();
  });

  it("fails closed on projection permission errors", async () => {
    setup({
      sale: quarantinedInternalSale,
      sourcePresenceError: { code: "42501", message: "permission denied" },
    });

    await expect(loadAdminInformationAgentSale({ auth, saleId })).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("rejects a sale that is no longer available for a request", async () => {
    setup({ sale: { ...quarantinedInternalSale, status: "past" } });

    await expect(loadAdminInformationAgentSale({ auth, saleId })).rejects.toThrow(
      "n'est plus disponible",
    );
  });

  it("exposes the same explicit guard for callers that already have auth context", () => {
    expect(() => requireAdminInformationAgentSaleAccess({ isAdmin: true })).not.toThrow();
    expect(() => requireAdminInformationAgentSaleAccess({ isAdmin: false })).toThrow(
      "accès administrateur requis",
    );
  });
});
