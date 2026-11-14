import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tâches du registre de l'onglet « Réponses » (lot C) : retraits à faire après une opposition, et réponses acceptées
 * sans décision au registre. Lecture seule.
 */
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
        not: (column: string) => {
          if (column === "new_values->fact_registry") {
            rows = rows.filter(
              (row) => (row.new_values as Record<string, unknown>).fact_registry != null,
            );
          }
          return query;
        },
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
        order: (column: string) => {
          rows.sort((left, right) =>
            column === "seq"
              ? Number(right.seq) - Number(left.seq)
              : String(right[column]).localeCompare(String(left[column])),
          );
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
  listInformationAgentPendingRegistryDecisions,
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
      {
        case_id: "case-c",
        recipient_email: "martin@cabinet-martin.example",
        recipient_identity_keys: ["lawyer|lyon|martin paul"],
      },
      {
        case_id: "case-b",
        recipient_email: "autre@cabinet.example",
        recipient_identity_keys: ["lawyer|paris|durand anne"],
      },
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

    // 28 jours : le mois annoncé est tenu quel que soit le mois.
    expect(INFORMATION_AGENT_WITHDRAWAL_DELAY_DAYS).toBe(28);
    expect(tasks).toEqual([
      {
        factId: "fact-1",
        factKey: "surface_m2",
        displayValue: "54 m²",
        saleId: "sale-1",
        claimId: "claim-1",
        latestDecision: "accepted",
        heldByRegistry: true,
        opposedAt: "2026-11-15T10:00:00.000Z",
        dueAt: "2026-12-13T10:00:00.000Z",
        overdue: true,
      },
      {
        factId: "fact-3",
        factKey: "occupancy_status",
        displayValue: "Libre",
        saleId: "sale-3",
        claimId: "claim-3",
        latestDecision: "accepted",
        heldByRegistry: true,
        opposedAt: "2026-12-10T08:00:00.000Z",
        dueAt: "2027-01-07T08:00:00.000Z",
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

  it("ne suit une clé de structure que si elle tient pour l'adresse du dossier (pas avocat.fr)", async () => {
    db.tables.information_agent_identity_oppositions = [
      { identity_key: "structure|domain|avocat.fr", opposed_at: "2026-12-10T08:00:00Z" },
      {
        identity_key: "structure|domain|cabinet-durand.example",
        opposed_at: "2026-12-11T08:00:00Z",
      },
    ];
    db.tables.information_agent_contacts = [];
    db.tables.information_agent_missions = [
      // Un autre avocat de la messagerie de la profession : la clé enregistrée ne vaut rien pour lui.
      {
        case_id: "case-c",
        recipient_email: "martin@avocat.fr",
        recipient_identity_keys: ["structure|domain|avocat.fr"],
      },
      // Le domaine propre du cabinet : la clé tient.
      {
        case_id: "case-a",
        recipient_email: "accueil@cabinet-durand.example",
        recipient_identity_keys: ["structure|domain|cabinet-durand.example"],
      },
    ];
    const tasks = await listInformationAgentWithdrawalTasks(NOW);
    expect(tasks.map((task) => task.claimId)).toEqual(["claim-1"]);
  });

  it("dit quand le registre ne tient pas la valeur (mise à prix, date, type de bien)", async () => {
    db.tables.information_agent_fact_candidates!.push({
      id: "fact-6",
      case_id: "case-a",
      sale_id: "sale-1",
      fact_key: "starting_price_eur",
      display_value: "95 000 €",
      status: "accepted",
    });
    db.tables.auction_fact_claims!.push({
      id: "claim-6",
      evidence_locator: { information_agent_fact_id: "fact-6" },
    });
    const tasks = await listInformationAgentWithdrawalTasks(NOW);
    expect(tasks.find((task) => task.claimId === "claim-6")?.heldByRegistry).toBe(false);
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

describe("réponses acceptées sans décision au registre", () => {
  beforeEach(() => {
    db.tables.information_agent_fact_publications = [
      // Valeur tenue, décision écrite : rien à faire.
      {
        fact_id: "fact-1",
        sale_id: "sale-1",
        fact_key: "surface_m2",
        published_at: "2026-11-20T10:00:00Z",
        new_values: { fact_registry: { field_key: "property.surface_m2", value: 54 } },
      },
      // Valeur tenue, décision manquée (échec après l'acceptation).
      {
        fact_id: "fact-7",
        sale_id: "sale-7",
        fact_key: "rooms_count",
        published_at: "2026-11-21T10:00:00Z",
        new_values: { fact_registry: { field_key: "property.rooms_count", value: 4 } },
      },
      // Mise à prix écrite par le noyau : hors de cette liste.
      {
        fact_id: "fact-8",
        sale_id: "sale-8",
        fact_key: "starting_price_eur",
        published_at: "2026-11-22T10:00:00Z",
        new_values: { starting_price_eur: 95000 },
      },
    ];
    db.tables.information_agent_fact_candidates!.push({
      id: "fact-7",
      case_id: "case-z",
      sale_id: "sale-7",
      fact_key: "rooms_count",
      display_value: "4 pièces",
      status: "accepted",
    });
    db.tables.auction_fact_claims!.push({
      id: "claim-7",
      evidence_locator: { information_agent_fact_id: "fact-7" },
    });
  });

  it("liste la valeur acceptée dont l'observation n'a aucune décision", async () => {
    expect(await listInformationAgentPendingRegistryDecisions()).toEqual([
      {
        factId: "fact-7",
        factKey: "rooms_count",
        displayValue: "4 pièces",
        saleId: "sale-7",
        claimId: "claim-7",
        acceptedAt: "2026-11-21T10:00:00Z",
      },
    ]);
  });

  it("sort de la liste dès qu'une décision est écrite, quelle qu'elle soit", async () => {
    db.tables.auction_fact_claim_decisions!.push({
      claim_id: "claim-7",
      decision: "rejected",
      reason_code: "other",
      seq: 30,
    });
    expect(await listInformationAgentPendingRegistryDecisions()).toEqual([]);
  });
});
