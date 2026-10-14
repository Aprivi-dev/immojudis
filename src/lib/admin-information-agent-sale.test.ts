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
    in: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockResolvedValue({ data, error });
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

function registryQuery(data: unknown[], error: unknown = null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.neq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockResolvedValue({ data, error });
  return query;
}

function setup({
  sale,
  documents = [],
  sourcePresence = [],
  registryContacts = [],
  saleError = null,
  documentsError = null,
  sourcePresenceError = null,
  registryError = null,
}: {
  sale: unknown;
  documents?: unknown[];
  sourcePresence?: unknown[];
  registryContacts?: unknown[];
  saleError?: unknown;
  documentsError?: unknown;
  sourcePresenceError?: unknown;
  registryError?: unknown;
}) {
  const saleQuery = baseQuery(sale, saleError);
  const docsQuery = documentsQuery(documents, documentsError);
  const sourcePresenceQueryInstance = sourcePresenceQuery(sourcePresence, sourcePresenceError);
  const registry = registryQuery(registryContacts, registryError);
  mocks.from.mockImplementation((table: string) => {
    if (table === "auction_sales") return saleQuery;
    if (table === "auction_documents") return docsQuery;
    if (table === "auction_sale_source_presence") return sourcePresenceQueryInstance;
    if (table === "information_agent_contacts") return registry;
    throw new Error(`unexpected table ${table}`);
  });
  return { saleQuery, docsQuery, sourcePresenceQuery: sourcePresenceQueryInstance, registry };
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
    pdf_occupancy_candidates: [
      {
        value: "occupied",
        evidence: "Occupé par M. Exemple, locataire",
        page_number: 14,
        document_type: "pv_huissier",
        document_label: "PV descriptif",
      },
    ],
    source_energy_diagnostics: { dpe_class: "E", ges_class: "D" },
    visit_contact: "04 00 00 00 00",
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
      source_url: "https://second.example.test/annonce/9",
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
    // Les pièces de toutes les sources de la fiche sont lues, pas seulement l'annonce principale.
    expect(docsQuery.in).toHaveBeenCalledWith("source_url", [
      quarantinedInternalSale.source_url,
      "https://second.example.test/annonce/9",
    ]);
    expect(sale.source_block_urls).toEqual({
      "primary-source:primary": quarantinedInternalSale.source_url,
      "second-source:1": "https://second.example.test/annonce/9",
    });
    expect(sale.information_agent_signals).toEqual({
      pdfFacts: {
        occupancy: { documentLabel: "PV descriptif", documentType: "pv_huissier", page: 14 },
      },
      energyClasses: { dpe: "E", ges: "D" },
      cadastre: null,
      visitContact: true,
    });
    // Les extraits des PDF (données personnelles possibles) ne sont jamais recopiés.
    expect(JSON.stringify(sale)).not.toContain("locataire");
    expect(docsQuery.select).toHaveBeenCalledWith(
      "document_url,label,document_type,extraction_status,download_status,docling_status,text_chars",
    );
    expect(sourcePresenceQuery.select).toHaveBeenCalledWith(
      "source_name,availability,state,attempted_at,checked_at,run_id,extras",
    );
    expect(sourcePresenceQuery.eq).toHaveBeenCalledWith("sale_id", saleId);
  });

  it("reads the internal registry addresses of this sale only, never the public projection", async () => {
    const { registry } = setup({
      sale: quarantinedInternalSale,
      registryContacts: [
        {
          email: "maitre@exemple.test",
          display_name: "Maître Exemple, Avocat",
          role: "lawyer",
          source_name: "licitor",
          source_url: "https://www.licitor.com/annonce/10/99/99/x/109999.html",
          observed_at: "2026-10-14T10:00:00Z",
        },
      ],
    });

    const sale = await loadAdminInformationAgentSale({ auth, saleId });

    expect(sale.registry_contacts).toEqual([
      {
        email: "maitre@exemple.test",
        displayName: "Maître Exemple, Avocat",
        role: "lawyer",
        sourceName: "licitor",
        sourceUrl: "https://www.licitor.com/annonce/10/99/99/x/109999.html",
        observedAt: "2026-10-14T10:00:00Z",
      },
    ]);
    expect(registry.eq).toHaveBeenCalledWith("scope_sale_id", saleId);
    expect(registry.eq).toHaveBeenCalledWith("source_kind", "sale_listing");
    expect(registry.eq).toHaveBeenCalledWith(
      "metadata->>observation_channel",
      "licitor_cloudflare_decoded",
    );
    expect(registry.neq).toHaveBeenCalledWith("opposition_status", "opposed");
    expect(registry.neq).toHaveBeenCalledWith("bounce_status", "permanent");
    // L'adresse du registre n'est recopiée dans aucun champ de la vente.
    const { registry_contacts: _internal, ...visible } = sale;
    expect(JSON.stringify(visible)).not.toContain("maitre@exemple.test");
  });

  it("fails closed when the internal registry cannot be read", async () => {
    setup({ sale: quarantinedInternalSale, registryError: { code: "42501", message: "denied" } });

    await expect(loadAdminInformationAgentSale({ auth, saleId })).rejects.toMatchObject({
      code: "42501",
    });
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
