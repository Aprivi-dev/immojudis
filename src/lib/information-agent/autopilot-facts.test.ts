import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Faits du registre lus par le pilote : la date de relevé de la VENTE COURANTE ne doit jamais être coupée par la
 * limite de lecture, même pour un avocat relevé sur des dizaines d'autres ventes. Base simulée en mémoire : filtres
 * d'égalité, tri et limite appliqués comme en base.
 */
const db = vi.hoisted(() => ({
  contacts: [] as Array<Record<string, unknown>>,
  cases: [] as Array<Record<string, unknown>>,
  missions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Row = Record<string, unknown>;
  const tables: Record<string, () => Row[]> = {
    information_agent_contacts: () => db.contacts,
    information_agent_cases: () => db.cases,
    information_agent_missions: () => db.missions,
  };
  class Query {
    private filters: Array<(row: Row) => boolean> = [];
    private sort: { column: string; ascending: boolean } | null = null;
    private max = Number.POSITIVE_INFINITY;
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push((row) => (row[column] ?? null) === value);
      return this;
    }
    in(column: string, values: unknown[]) {
      this.filters.push((row) => values.includes(row[column] ?? null));
      return this;
    }
    not(column: string, operator: "is", value: null) {
      expect([operator, value]).toEqual(["is", null]);
      this.filters.push((row) => (row[column] ?? null) !== null);
      return this;
    }
    overlaps(column: string, values: unknown[]) {
      this.filters.push((row) =>
        ((row[column] as unknown[]) ?? []).some((v) => values.includes(v)),
      );
      return this;
    }
    order(column: string, { ascending }: { ascending: boolean }) {
      this.sort = { column, ascending };
      return this;
    }
    limit(count: number) {
      this.max = count;
      return this;
    }
    then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
      let rows = tables[this.table]().filter((row) => this.filters.every((keep) => keep(row)));
      const sort = this.sort;
      if (sort) {
        rows = [...rows].sort(
          (left, right) =>
            String(left[sort.column]).localeCompare(String(right[sort.column])) *
            (sort.ascending ? 1 : -1),
        );
      }
      return Promise.resolve({ data: rows.slice(0, this.max), error: null }).then(onFulfilled);
    }
  }
  return { supabaseAdmin: { from: (table: string) => new Query(table) } };
});

import {
  loadAutopilotAlreadyInformed,
  loadAutopilotFirstRecordedAt,
  loadAutopilotHistoryFacts,
  loadAutopilotRegistryFacts,
} from "@/lib/information-agent/autopilot-facts";
import { evaluateAutopilotCandidate } from "@/lib/information-agent/autopilot-rules";

const EMAIL = "me.dupont@cabinet-dupont.example.test";
const SALE_ID = "11111111-1111-4111-8111-111111111111";

/** 60 relevés de la même adresse sur d'autres ventes, tous antérieurs à celui de la vente courante. */
function otherSales() {
  return Array.from({ length: 60 }, (_, n) => ({
    normalized_email: EMAIL,
    scope_sale_id: `other-sale-${n}`,
    created_at: `2026-0${1 + (n % 9)}-${String(10 + (n % 18)).padStart(2, "0")}T08:00:00Z`,
    observed_at: "2026-01-01T08:00:00Z",
    source_kind: "agent_search",
    metadata: {},
  }));
}

beforeEach(() => {
  db.contacts = otherSales();
  db.cases = [];
  db.missions = [];
});

describe("faits du registre pour une vente : lus sur la vente, avant la limite", () => {
  it("avocat très actif : la date de relevé de la vente courante n'est jamais coupée", async () => {
    db.contacts.push({
      normalized_email: EMAIL,
      scope_sale_id: SALE_ID,
      created_at: "2026-11-10T08:00:00Z",
      observed_at: "2026-11-10T08:00:00Z",
      source_kind: "sale_listing",
      metadata: {},
    });
    const facts = await loadAutopilotRegistryFacts(EMAIL, SALE_ID);
    expect(facts).toEqual({
      // Premier relevé de l'adresse, toutes ventes confondues (article 14).
      firstRecordedAt: "2026-01-10T08:00:00Z",
      observedAt: "2026-11-10T08:00:00Z",
      // Origines de cette vente seulement : les recherches sur d'autres ventes ne comptent pas.
      originKinds: ["sale_listing"],
      licitorDecoded: false,
    });
  });

  it("sans date de relevé pour la vente, le pilote refuse toujours (address_stale)", async () => {
    db.contacts.push({
      normalized_email: EMAIL,
      scope_sale_id: SALE_ID,
      created_at: "2026-11-10T08:00:00Z",
      observed_at: null,
      source_kind: "sale_listing",
      metadata: {},
    });
    const facts = await loadAutopilotRegistryFacts(EMAIL, SALE_ID);
    expect(facts.observedAt).toBeNull();
    expect(
      evaluateAutopilotCandidate(
        {
          sourceKind: "sale_listing",
          recipientRole: "lawyer",
          selectedUnambiguously: true,
          identityComplete: true,
          addressHygieneIssue: null,
          consumerDomain: false,
          observationChannel: null,
          addressObservedAt: facts.observedAt,
          mailDomain: "ok",
          saleDate: "2026-12-20T10:00:00Z",
          hasUnpublishedGap: true,
          humanDraftExists: false,
          identityExcluded: false,
          contactFirstRecordedAt: facts.firstRecordedAt,
          alreadyInformed: true,
          lastReplyAt: null,
          silentSendsInSixMonths: 0,
          lastSendAt: null,
        },
        { allowLicitorDecoded: false, art14MaxAgeDays: 30 },
        new Date("2026-11-14T09:30:00Z"),
      ),
    ).toEqual({ ok: false, code: "address_stale" });
  });
});

describe("lectures groupées du tri de la file : même définition que les lectures par candidat", () => {
  const OTHER = "me.martin@cabinet-martin.example.test";
  const NOW = new Date("2026-11-14T09:30:00Z");

  it("premier enregistrement : la date de la vérification complète, absente pour une adresse inconnue", async () => {
    db.contacts.push({
      normalized_email: OTHER,
      scope_sale_id: SALE_ID,
      created_at: "2026-11-02T08:00:00Z",
      observed_at: "2026-11-02T08:00:00Z",
      source_kind: "sale_listing",
      metadata: {},
    });
    const first = await loadAutopilotFirstRecordedAt([
      EMAIL,
      OTHER,
      "inconnue@cabinet.example.test",
    ]);
    expect(first).toEqual(
      new Map([
        [EMAIL, (await loadAutopilotRegistryFacts(EMAIL, SALE_ID)).firstRecordedAt],
        [OTHER, (await loadAutopilotRegistryFacts(OTHER, SALE_ID)).firstRecordedAt],
      ]),
    );
  });

  it("lecture coupée par la limite : une adresse coupée est absente, jamais datée plus tard", async () => {
    // 600 relevés plus anciens d'une autre adresse occupent toute la lecture.
    db.contacts.push(
      ...Array.from({ length: 600 }, (_, n) => ({
        normalized_email: OTHER,
        scope_sale_id: `old-sale-${n}`,
        created_at: `2025-0${1 + (n % 9)}-10T08:00:00Z`,
        observed_at: null,
        source_kind: "sale_listing",
        metadata: {},
      })),
    );
    const first = await loadAutopilotFirstRecordedAt([EMAIL, OTHER]);
    expect(first).toEqual(new Map([[OTHER, "2025-01-10T08:00:00Z"]]));
  });

  it("déjà informé : même réponse que l'historique de chaque destinataire", async () => {
    db.cases = [
      { normalized_recipient_email: EMAIL, sent_at: "2026-10-01T08:00:00Z", replied_at: null },
      { normalized_recipient_email: OTHER, sent_at: null, replied_at: null },
    ];
    db.missions = [
      {
        recipient_identity_keys: ["lawyer|bordeaux|martin paul"],
        sent_at: "2026-09-01T08:00:00Z",
        replied_at: null,
      },
      { recipient_identity_keys: ["lawyer|bordeaux|durand luc"], sent_at: null, replied_at: null },
    ];
    const recipients = [
      { email: EMAIL, identityKeys: ["lawyer|bordeaux|dupont jean"] },
      { email: OTHER, identityKeys: ["lawyer|bordeaux|durand luc"] },
      { email: "autre@cabinet-martin.example.test", identityKeys: ["lawyer|bordeaux|martin paul"] },
    ];
    const informed = await loadAutopilotAlreadyInformed(recipients);
    expect(informed).toEqual([true, false, true]);
    for (const [index, recipient] of recipients.entries()) {
      const history = await loadAutopilotHistoryFacts(recipient.email, recipient.identityKeys, NOW);
      expect(history.alreadyInformed).toBe(informed?.[index]);
    }
  });

  it("déjà informé, lecture pleine : aucune réponse (personne n'est dit jamais informé)", async () => {
    db.cases = Array.from({ length: 500 }, () => ({
      normalized_recipient_email: OTHER,
      sent_at: "2026-10-01T08:00:00Z",
    }));
    expect(
      await loadAutopilotAlreadyInformed([
        { email: EMAIL, identityKeys: ["lawyer|bordeaux|dupont jean"] },
        { email: OTHER, identityKeys: [] },
      ]),
    ).toBeNull();
  });
});
