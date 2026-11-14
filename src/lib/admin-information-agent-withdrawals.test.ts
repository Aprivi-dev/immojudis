import { beforeEach, describe, expect, it, vi } from "vitest";

/** Retraits à faire après une opposition (lot C) : lecture seule, une ligne par valeur encore affichée. */
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  calls: [] as Array<[string, string, unknown]>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let rows = [...(db.tables[table] ?? [])];
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          db.calls.push([table, "eq", [column, value]]);
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        not: () => query,
        in: (column: string, values: unknown[]) => {
          db.calls.push([table, "in", [column, values]]);
          rows = rows.filter((row) =>
            column === "evidence_locator->>information_agent_fact_id"
              ? values.includes(
                  (row.evidence_locator as Record<string, unknown>).information_agent_fact_id,
                )
              : values.includes(row[column]),
          );
          return query;
        },
        overlaps: (column: string, values: unknown[]) => {
          rows = rows.filter((row) =>
            (row[column] as unknown[]).some((value) => values.includes(value)),
          );
          return query;
        },
        order: () => {
          rows.sort((left, right) => Number(right.seq) - Number(left.seq));
          return query;
        },
        limit: () => query,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return query;
    },
  },
}));

import {
  INFORMATION_AGENT_WITHDRAWAL_DELAY_DAYS,
  listInformationAgentWithdrawalTasks,
} from "@/lib/admin-information-agent-withdrawals";

const NOW = new Date("2026-12-20T09:00:00Z");

beforeEach(() => {
  db.calls.length = 0;
  db.tables = {
    information_agent_contacts: [
      {
        normalized_email: "avocat@cabinet.example",
        opposed_at: "2026-11-15T10:00:00Z",
        opposition_status: "opposed",
      },
    ],
    information_agent_identity_oppositions: [
      { identity_key: "lawyer|lyon|martin paul", opposed_at: "2026-12-10T08:00:00Z" },
    ],
    information_agent_cases: [
      { id: "case-a", normalized_recipient_email: "avocat@cabinet.example" },
      { id: "case-b", normalized_recipient_email: "autre@cabinet.example" },
    ],
    information_agent_missions: [
      { case_id: "case-c", recipient_identity_keys: ["lawyer|lyon|martin paul"] },
      { case_id: "case-b", recipient_identity_keys: ["lawyer|paris|durand anne"] },
    ],
    information_agent_fact_candidates: [
      {
        id: "fact-1",
        case_id: "case-a",
        sale_id: "sale-1",
        fact_key: "surface_m2",
        display_value: "54 m²",
        status: "accepted",
      },
      {
        id: "fact-2",
        case_id: "case-a",
        sale_id: "sale-1",
        fact_key: "rooms_count",
        display_value: "3 pièces",
        status: "accepted",
      },
      {
        id: "fact-3",
        case_id: "case-c",
        sale_id: "sale-3",
        fact_key: "occupancy_status",
        display_value: "Libre",
        status: "accepted",
      },
      {
        id: "fact-4",
        case_id: "case-b",
        sale_id: "sale-2",
        fact_key: "surface_m2",
        display_value: "40 m²",
        status: "accepted",
      },
      {
        id: "fact-5",
        case_id: "case-a",
        sale_id: "sale-1",
        fact_key: "surface_m2",
        display_value: "55 m²",
        status: "rejected",
      },
    ],
    auction_fact_claims: [
      { id: "claim-1", evidence_locator: { information_agent_fact_id: "fact-1" } },
      { id: "claim-2", evidence_locator: { information_agent_fact_id: "fact-2" } },
      { id: "claim-3", evidence_locator: { information_agent_fact_id: "fact-3" } },
      { id: "claim-4", evidence_locator: { information_agent_fact_id: "fact-4" } },
    ],
    auction_fact_claim_decisions: [
      { claim_id: "claim-1", decision: "accepted", reason_code: null, seq: 10 },
      // Déjà fait : opposition au registre.
      { claim_id: "claim-2", decision: "accepted", reason_code: null, seq: 11 },
      { claim_id: "claim-2", decision: "opposed", reason_code: "professional_opposition", seq: 12 },
      { claim_id: "claim-3", decision: "accepted", reason_code: null, seq: 13 },
      { claim_id: "claim-4", decision: "accepted", reason_code: null, seq: 14 },
    ],
  };
});

describe("retraits à faire après une opposition", () => {
  it("liste les valeurs acceptées d'un avocat opposé, par son adresse ou son identité, jusqu'à la décision définitive", async () => {
    const tasks = await listInformationAgentWithdrawalTasks(NOW);

    expect(INFORMATION_AGENT_WITHDRAWAL_DELAY_DAYS).toBe(30);
    expect(tasks).toEqual([
      {
        factId: "fact-1",
        factKey: "surface_m2",
        displayValue: "54 m²",
        saleId: "sale-1",
        claimId: "claim-1",
        latestDecision: "accepted",
        opposedAt: "2026-11-15T10:00:00.000Z",
        dueAt: "2026-12-15T10:00:00.000Z",
        overdue: true,
      },
      {
        factId: "fact-3",
        factKey: "occupancy_status",
        displayValue: "Libre",
        saleId: "sale-3",
        claimId: "claim-3",
        latestDecision: "accepted",
        opposedAt: "2026-12-10T08:00:00.000Z",
        dueAt: "2027-01-09T08:00:00.000Z",
        overdue: false,
      },
    ]);
  });

  it("ne lit rien de plus quand personne ne s'est opposé", async () => {
    db.tables.information_agent_contacts = [];
    db.tables.information_agent_identity_oppositions = [];
    expect(await listInformationAgentWithdrawalTasks(NOW)).toEqual([]);
    expect(db.calls.some(([table]) => table === "information_agent_fact_candidates")).toBe(false);
  });

  it("un retrait pour autorisation retirée ferme aussi la tâche", async () => {
    db.tables.auction_fact_claim_decisions!.push({
      claim_id: "claim-1",
      decision: "withdrawn",
      reason_code: "authorization_withdrawn",
      seq: 20,
    });
    const tasks = await listInformationAgentWithdrawalTasks(NOW);
    expect(tasks.map((task) => task.claimId)).toEqual(["claim-3"]);
  });
});
