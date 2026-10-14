import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverInformationAgentContacts,
  selectInformationAgentContact,
  type InformationAgentRegistryContact,
} from "@/lib/information-agent/contacts";
import { resolveInformationAgentAddressOrigin } from "@/lib/information-agent/address-origin";
import type { AuctionSale } from "@/lib/types";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rows: [] as Array<Record<string, unknown>> }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const LISTING_URL =
  "https://www.licitor.com/annonce/10/99/99/vente-aux-encheres/un-appartement/paris-16eme/paris/109999.html";

function registryContact(
  overrides: Partial<InformationAgentRegistryContact> = {},
): InformationAgentRegistryContact {
  return {
    email: "maitre@exemple.test",
    displayName: "Maître Jeanne Exemple, Avocat",
    role: "lawyer",
    sourceName: "licitor",
    sourceUrl: LISTING_URL,
    observedAt: "2026-10-14T10:00:00.000Z",
    ...overrides,
  };
}

function sale(overrides: Record<string, unknown> = {}): AuctionSale {
  return {
    id: SALE_ID,
    source_name: "licitor",
    source_url: LISTING_URL,
    lawyer_name: "Maître Jeanne Exemple",
    lawyer_contact: "1, rue du Palais - 75001 Paris | Tél.: 01 00 00 00 01",
    description: "Appartement à Paris.",
    ...overrides,
  } as unknown as AuctionSale;
}

describe("adresses du registre interne de l'agent (email Licitor décodé, jamais publié)", () => {
  it("sans adresse dans la vente publiée, l'agent trouve celle du registre avec son origine", () => {
    const candidates = discoverInformationAgentContacts({
      ...sale(),
      registry_contacts: [registryContact()],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      email: "maitre@exemple.test",
      name: "Maître Jeanne Exemple, Avocat",
      role: "lawyer",
      recipientKind: "source_lawyer",
      confidence: "high",
      provenance: [
        {
          kind: "source_block",
          field: "information_agent_contacts",
          sourceName: "licitor",
          sourceUrl: LISTING_URL,
        },
      ],
      source: {
        kind: "sale_listing",
        url: LISTING_URL,
        observedAt: "2026-10-14T10:00:00.000Z",
        observedBy: "agent",
      },
    });
    // Un seul candidat de confiance : l'agent le choisit seul.
    expect(selectInformationAgentContact(candidates)?.email).toBe("maitre@exemple.test");
  });

  it("sans ligne de registre, la vente publiée ne donne aucune adresse", () => {
    expect(discoverInformationAgentContacts(sale())).toEqual([]);
    expect(discoverInformationAgentContacts({ ...sale(), registry_contacts: [] })).toEqual([]);
  });

  it("écarte les adresses de juridiction, RPVA, Ordre, barreau et CARPA du registre", () => {
    const candidates = discoverInformationAgentContacts({
      ...sale(),
      registry_contacts: [
        "greffe@tj-exemple.justice.fr",
        "accueil@ta-exemple.justice.gouv.fr",
        "maitre@avocat-conseil.fr",
        "contact@ordre-avocats-exemple.test",
        "carpa@cabinet-exemple.test",
        "pas une adresse",
      ].map((email) => registryContact({ email })),
    });

    expect(candidates).toEqual([]);
  });

  it("fusionne avec la même adresse lue ailleurs sans doublon et garde l'origine du registre", () => {
    const candidates = discoverInformationAgentContacts({
      ...sale({ lawyer_contact: "Tél.: 01 00 00 00 01 | maitre@exemple.test" }),
      registry_contacts: [registryContact({ email: "Maitre@Exemple.test" })],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.provenance.map((item) => item.field).sort()).toEqual([
      "information_agent_contacts",
      "lawyer_contact",
    ]);
    expect(candidates[0]?.source?.observedAt).toBe("2026-10-14T10:00:00.000Z");
  });

  it("deux adresses du registre pour une même vente restent à départager par l'administrateur", () => {
    const candidates = discoverInformationAgentContacts({
      ...sale(),
      registry_contacts: [
        registryContact(),
        registryContact({ email: "associe@exemple.test", displayName: "Maître Associé, Avocat" }),
      ],
    });

    expect(candidates.map((item) => item.email).sort()).toEqual([
      "associe@exemple.test",
      "maitre@exemple.test",
    ]);
    expect(selectInformationAgentContact(candidates)).toBeNull();
  });
});

describe("origine affichée dans le pied du message", () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.from.mockReset();
    mocks.from.mockImplementation(() => {
      const filters: Array<[string, unknown]> = [];
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((column: string, value: unknown) => {
          filters.push([column, value]);
          return query;
        }),
        limit: vi.fn(() =>
          Promise.resolve({
            data: mocks.rows.filter((row) => filters.every(([c, v]) => row[c] === v)),
            error: null,
          }),
        ),
      };
      return query;
    });
  });

  it("cite l'annonce Licitor, son lien et la date de relevé", async () => {
    mocks.rows = [
      {
        normalized_email: "maitre@exemple.test",
        scope_sale_id: SALE_ID,
        source_kind: "sale_listing",
        source_directory_name: null,
        source_name: "licitor",
        source_url: LISTING_URL,
        observed_at: "2026-10-14T10:00:00.000Z",
        observed_by: "agent",
      },
    ];

    const result = await resolveInformationAgentAddressOrigin({
      email: "maitre@exemple.test",
      saleId: SALE_ID,
      manualOriginUrl: null,
    });

    expect(result.known).toBe(true);
    expect(result.kind).toBe("sale_listing");
    expect(result.origin.url).toBe(LISTING_URL);
    expect(result.origin.text).toContain("annonce publique de cette vente sur Licitor");
    expect(result.origin.text).toContain(LISTING_URL);
    expect(result.origin.text).toContain("14/10/2026");
  });
});
