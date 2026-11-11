import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sélection des candidats du pilote : une adresse générique porte la clé de sa structure parmi ses clés
 * d'opposition, mais cette clé ne dit pas QUI est le professionnel. La règle « identité complète » et
 * l'identité rendue au pilote ne retiennent donc que les clés de la personne.
 */
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  classify: vi.fn(),
  sale: vi.fn(),
  allowed: vi.fn(),
  persist: vi.fn(),
  registry: vi.fn(),
  history: vi.fn(),
  excluded: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "in"]) query[name] = () => query;
  query.limit = async () => ({ data: [], error: null });
  return { supabaseAdmin: { rpc: mocks.rpc, from: () => query } };
});
vi.mock("@/lib/admin-information-agent-sale", () => ({
  classifyInformationAgentSaleContacts: mocks.classify,
  loadAdminInformationAgentSale: mocks.sale,
}));
vi.mock("@/lib/auction-fact-claims", () => ({
  readSaleFactClaims: async () => ({ claims: [], claimsBacked: true }),
}));
vi.mock("@/lib/information-agent/address-deliverability", () => ({
  checkMailDomain: async () => "ok",
  informationAgentAddressCheckEnabled: () => false,
}));
vi.mock("@/lib/information-agent/autopilot-facts", () => ({
  loadAutopilotRegistryFacts: mocks.registry,
  loadAutopilotHistoryFacts: mocks.history,
}));
vi.mock("@/lib/information-agent/autopilot-settings", () => ({
  loadExcludedIdentityKeys: mocks.excluded,
}));
vi.mock("@/lib/information-agent/contacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent/contacts")>()),
  assertInformationAgentContactAllowed: mocks.allowed,
  persistInformationAgentContactObservations: mocks.persist,
}));

import { findAutopilotCandidates } from "@/lib/information-agent/autopilot-candidates";
import type { AutopilotSettings } from "@/lib/information-agent/autopilot-rules";

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-03T09:30:00Z");
const settings = {
  mode: "simulation",
  allowLicitorDecoded: false,
  art14RuleEnabled: true,
  art14MaxAgeDays: 30,
} as AutopilotSettings;

function sale(overrides: Record<string, unknown>) {
  return {
    id: SALE_ID,
    title: "Appartement Bordeaux",
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    tribunal_code: "bordeaux",
    sale_date: "2026-12-20T10:00:00Z",
    starting_price_eur: null,
    source_name: "avoventes",
    source_url: "https://annonces.example.test/avoventes/lot-4",
    sale_procedure: { organizer_type: "pursuing_lawyer" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValue({ data: { items: [{ id: SALE_ID }] }, error: null });
  mocks.classify.mockResolvedValue(new Map([[SALE_ID, "A"]]));
  mocks.allowed.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue(undefined);
  mocks.excluded.mockResolvedValue(new Set());
  mocks.registry.mockResolvedValue({
    firstRecordedAt: "2026-11-01T10:00:00Z",
    observedAt: "2026-11-01T10:00:00Z",
    originKinds: ["sale_listing"],
    licitorDecoded: false,
  });
  mocks.history.mockResolvedValue({
    alreadyInformed: false,
    lastReplyAt: null,
    silentSendsInSixMonths: 0,
    lastSendAt: null,
  });
});

const search = () => findAutopilotCandidates({ settings, now: NOW, limit: 3, env: {} });

describe("sélection du pilote : identité du professionnel et clé de structure", () => {
  it("adresse générique d'un cabinet sans nom de personne : identité incomplète, écartée", async () => {
    mocks.sale.mockResolvedValue(
      sale({ lawyer_name: "Cabinet", lawyer_contact: "contact@cabinet-durand.example.test" }),
    );
    const result = await search();
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual({ identity_incomplete: 1 });
    // L'opposition de la structure reste contrôlée, avec sa clé.
    expect(mocks.allowed).toHaveBeenCalledExactlyOnceWith({
      saleId: SALE_ID,
      email: "contact@cabinet-durand.example.test",
      identityKeys: ["structure|domain|cabinet-durand.example.test"],
      // Le domaine et son domaine parent (un cabinet opposé l'est aussi pour ses sous-domaines).
      checkKeys: ["structure|domain|cabinet-durand.example.test", "structure|domain|example.test"],
    });
    // Ni l'historique ni les exclusions ne sont lus avec une clé de structure.
    expect(mocks.history).toHaveBeenCalledWith("contact@cabinet-durand.example.test", [], NOW);
    expect(mocks.excluded).toHaveBeenCalledWith([]);
  });

  it("adresse générique d'un avocat nommé : retenue, avec les seules clés de la personne", async () => {
    mocks.sale.mockResolvedValue(
      sale({
        lawyer_name: "Maître Jean Dupont",
        lawyer_contact: "contact@cabinet-durand.example.test",
      }),
    );
    const result = await search();
    expect(result.skipped).toEqual({});
    expect(result.candidates).toEqual([
      {
        saleId: SALE_ID,
        tribunalCode: "bordeaux",
        email: "contact@cabinet-durand.example.test",
        domain: "cabinet-durand.example.test",
        officeCode: null,
        identityKeys: ["lawyer|bordeaux|dupont jean"],
      },
    ]);
    expect(mocks.allowed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        identityKeys: [
          "lawyer|bordeaux|dupont jean",
          "structure|domain|cabinet-durand.example.test",
        ],
        checkKeys: [
          "lawyer|bordeaux|dupont jean",
          "structure|domain|cabinet-durand.example.test",
          "structure|domain|example.test",
        ],
      }),
    );
  });
});
