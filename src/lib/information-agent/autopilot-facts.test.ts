import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Faits du registre lus par le pilote : la date de relevé de la VENTE COURANTE ne doit jamais être coupée par la
 * limite de lecture, même pour un avocat relevé sur des dizaines d'autres ventes. Base simulée en mémoire : filtres
 * d'égalité, tri et limite appliqués comme en base.
 */
const db = vi.hoisted(() => ({ contacts: [] as Array<Record<string, unknown>> }));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Array<[string, unknown]> = [];
    private sort: { column: string; ascending: boolean } | null = null;
    private max = Number.POSITIVE_INFINITY;
    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
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
      let rows = db.contacts.filter((row) =>
        this.filters.every(([column, value]) => (row[column] ?? null) === value),
      );
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
  return { supabaseAdmin: { from: () => new Query() } };
});

import { loadAutopilotRegistryFacts } from "@/lib/information-agent/autopilot-facts";
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
