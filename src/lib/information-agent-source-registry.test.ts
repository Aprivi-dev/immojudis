import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertInformationAgentContactAllowed,
  assertInformationAgentIdentityAllowed,
  loadOpposedInformationAgentIdentityKeys,
  persistInformationAgentContactObservations,
  recordInformationAgentAdminAddressEntry,
  type InformationAgentContactCandidate,
} from "@/lib/information-agent/contacts";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  tables: {} as Record<
    string,
    {
      rows: Array<Record<string, unknown>>;
      error?: Error;
    }
  >,
  writes: [] as Array<{ table: string; op: string; values: unknown; options?: unknown }>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private inFilter: [string, unknown[]] | null = null;
  constructor(private readonly table: string) {}
  select() {
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.inFilter = [column, values];
    return this;
  }
  limit() {
    return this;
  }
  upsert(values: unknown, options?: unknown) {
    mocks.writes.push({ table: this.table, op: "upsert", values, options });
    return this;
  }
  update(values: unknown) {
    mocks.writes.push({ table: this.table, op: "update", values });
    return this;
  }
  then(onFulfilled: (value: { data: unknown; error: Error | null }) => unknown) {
    const table = mocks.tables[this.table] ?? { rows: [] };
    const data = table.rows.filter(
      (row) =>
        this.filters.every(([column, value]) => (row[column] ?? null) === value) &&
        (!this.inFilter || this.inFilter[1].includes(row[this.inFilter[0]])),
    );
    return Promise.resolve({ data, error: table.error ?? null }).then(onFulfilled);
  }
}

beforeEach(() => {
  mocks.tables = {};
  mocks.writes = [];
  mocks.from.mockReset();
  mocks.from.mockImplementation((table: string) => new FakeQuery(table));
});

function candidate(overrides: Partial<InformationAgentContactCandidate> = {}) {
  return {
    email: "Cabinet@Example.test",
    name: "Maître Dupont",
    role: "lawyer",
    recipientKind: "source_lawyer",
    confidence: "high",
    score: 100,
    provenance: [
      {
        kind: "sale_field",
        field: "lawyer_contact",
        sourceName: "licitor",
        sourceUrl: "https://www.licitor.com/annonce/1",
      },
    ],
    ...overrides,
  } satisfies InformationAgentContactCandidate;
}

describe("source typée des adresses retenues", () => {
  it("enregistre une adresse de l'annonce avec sa nature, son URL, sa date et son auteur", async () => {
    await persistInformationAgentContactObservations({
      saleId: SALE_ID,
      candidates: [candidate({ identityKeys: ["lawyer|bordeaux|dupont"] })],
    });
    const [write] = mocks.writes;
    expect(write?.table).toBe("information_agent_contacts");
    expect(write?.options).toMatchObject({ ignoreDuplicates: true });
    const [row] = write?.values as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      email: "cabinet@example.test",
      source_kind: "sale_listing",
      source_directory_name: null,
      source_url: "https://www.licitor.com/annonce/1",
      observed_by: "agent",
      observed_by_user_id: null,
      identity_keys: ["lawyer|bordeaux|dupont"],
      verification_status: "source_observed",
    });
    expect(Number.isNaN(Date.parse(String(row?.observed_at)))).toBe(false);
  });

  it("enregistre une adresse d'annuaire officiel avec le nom de l'annuaire et l'URL exacte", async () => {
    await persistInformationAgentContactObservations({
      saleId: SALE_ID,
      candidates: [
        candidate({
          source: {
            kind: "official_directory",
            directoryName: "annuaire du barreau de Lyon",
            url: "https://www.barreaulyon.com/annuaire/avocat/jean-dupont/",
            observedAt: "2026-10-14T10:00:00.000Z",
            observedBy: "agent",
          },
        }),
      ],
    });
    const [row] = mocks.writes[0]?.values as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      source_kind: "official_directory",
      source_directory_name: "annuaire du barreau de Lyon",
      source_url: "https://www.barreaulyon.com/annuaire/avocat/jean-dupont/",
      observed_at: "2026-10-14T10:00:00.000Z",
      observed_by: "agent",
    });
  });

  it("enregistre une saisie d'administrateur avec sa date, son auteur et ses clés d'identité", async () => {
    await recordInformationAgentAdminAddressEntry({
      saleId: SALE_ID,
      email: "Nouveau@Example.test",
      name: "Me Dupont",
      url: "https://annuaire.example.test/me-dupont",
      observedAt: "2026-10-13T09:30:00.000Z",
      adminId: ADMIN_ID,
      identityKeys: ["lawyer|bordeaux|dupont"],
    });
    const [write] = mocks.writes;
    expect(write).toMatchObject({ table: "information_agent_contacts", op: "upsert" });
    expect(write?.values).toMatchObject({
      email: "nouveau@example.test",
      scope_sale_id: SALE_ID,
      source_kind: "admin_entry",
      source_url: "https://annuaire.example.test/me-dupont",
      observed_at: "2026-10-13T09:30:00.000Z",
      observed_by: "admin",
      observed_by_user_id: ADMIN_ID,
      identity_keys: ["lawyer|bordeaux|dupont"],
    });
  });

  it("ne réécrit jamais une ligne déjà typée (annonce, annuaire) mais corrige l'URL d'une saisie", async () => {
    mocks.tables.information_agent_contacts = {
      rows: [
        {
          normalized_email: "listing@example.test",
          scope_sale_id: SALE_ID,
          source_kind: "sale_listing",
          source_url: "https://www.licitor.com/annonce/1",
        },
        {
          normalized_email: "manual@example.test",
          scope_sale_id: SALE_ID,
          source_kind: "admin_entry",
          source_url: "https://ancienne-page.example.test/",
        },
      ],
    };
    const base = {
      saleId: SALE_ID,
      name: null,
      url: "https://nouvelle-page.example.test/",
      observedAt: "2026-10-14T10:00:00.000Z",
      adminId: ADMIN_ID,
    };
    await recordInformationAgentAdminAddressEntry({ ...base, email: "listing@example.test" });
    expect(mocks.writes).toEqual([]);
    await recordInformationAgentAdminAddressEntry({ ...base, email: "manual@example.test" });
    expect(mocks.writes).toEqual([
      expect.objectContaining({
        op: "update",
        values: expect.objectContaining({ source_url: "https://nouvelle-page.example.test/" }),
      }),
    ]);
  });
});

describe("opposition par identité", () => {
  it("bloque un envoi sous une autre adresse quand la clé d'identité est opposée", async () => {
    mocks.tables.information_agent_identity_oppositions = {
      rows: [{ identity_key: "lawyer|bordeaux|dupont" }],
    };
    await expect(
      assertInformationAgentContactAllowed({
        saleId: SALE_ID,
        email: "autre-adresse@example.test",
        identityKeys: ["lawyer|bordeaux|dupont", "lawyer|bordeaux|dupont jean"],
      }),
    ).rejects.toThrow("s'est opposé à être contacté");
    await expect(assertInformationAgentIdentityAllowed(["lawyer|bordeaux|dupont"])).rejects.toThrow(
      "opposition enregistrée sous une autre adresse",
    );
  });

  it("laisse passer une identité non opposée et ne lit rien sans clé", async () => {
    mocks.tables.information_agent_identity_oppositions = {
      rows: [{ identity_key: "lawyer|lyon|martin" }],
    };
    await expect(
      assertInformationAgentContactAllowed({
        saleId: SALE_ID,
        email: "me@example.test",
        identityKeys: ["lawyer|bordeaux|dupont"],
      }),
    ).resolves.toBeUndefined();
    mocks.from.mockClear();
    expect(await loadOpposedInformationAgentIdentityKeys([])).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("n'autorise pas un envoi quand la liste d'opposition est indisponible", async () => {
    mocks.tables.information_agent_identity_oppositions = {
      rows: [],
      error: new Error("db down"),
    };
    await expect(
      assertInformationAgentContactAllowed({
        saleId: SALE_ID,
        email: "me@example.test",
        identityKeys: ["lawyer|bordeaux|dupont"],
      }),
    ).rejects.toThrow("db down");
  });

  it("refuse les adresses exclues avant toute lecture du registre", async () => {
    for (const email of [
      "greffe@tj-paris.justice.fr",
      "me@avocat-conseil.fr",
      "carpa@example.test",
      "noreply@example.test",
    ]) {
      await expect(
        assertInformationAgentContactAllowed({ saleId: SALE_ID, email }),
      ).rejects.toThrow("n’est jamais sollicitée par l’agent");
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
