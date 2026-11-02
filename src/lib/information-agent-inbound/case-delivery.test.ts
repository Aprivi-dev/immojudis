import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: {} as Record<string, Array<{ id: string; metadata: unknown }>>,
  updates: [] as Array<{ table: string; id: string; metadata: unknown }>,
  selectedWith: [] as Array<{ table: string; column: string; value: string }>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: string) => {
          db.selectedWith.push({ table, column, value });
          return { limit: async () => ({ data: db.rows[table] ?? [], error: null }) };
        },
      }),
      update: (values: { metadata: unknown }) => ({
        eq: async (_column: string, id: string) => {
          db.updates.push({ table, id, metadata: values.metadata });
          return { error: null };
        },
      }),
    }),
  },
}));

import { markInformationAgentCaseDelivery } from "./case-delivery";

beforeEach(() => {
  db.rows = {
    information_agent_cases: [{ id: "case-1", metadata: { keep: true } }],
    information_agent_missions: [{ id: "mission-1", metadata: {} }],
  };
  db.updates = [];
  db.selectedWith = [];
});

describe("état de remise du dossier et de la mission", () => {
  it("marque le dossier et la mission du message rebondi, sans perdre leurs métadonnées", async () => {
    const marked = await markInformationAgentCaseDelivery({
      emailId: "email-9",
      status: "bounced",
      at: "2026-11-02T10:00:00.000Z",
    });

    expect(marked).toBe(2);
    expect(db.selectedWith).toEqual([
      { table: "information_agent_cases", column: "provider_message_id", value: "email-9" },
      { table: "information_agent_missions", column: "provider_message_id", value: "email-9" },
    ]);
    expect(db.updates).toEqual([
      {
        table: "information_agent_cases",
        id: "case-1",
        metadata: { keep: true, delivery: { status: "bounced", at: "2026-11-02T10:00:00.000Z" } },
      },
      {
        table: "information_agent_missions",
        id: "mission-1",
        metadata: { delivery: { status: "bounced", at: "2026-11-02T10:00:00.000Z" } },
      },
    ]);
  });

  it("ne rétrograde jamais un rebond définitif ou une plainte déjà posés", async () => {
    db.rows = {
      information_agent_cases: [
        {
          id: "case-1",
          metadata: { delivery: { status: "bounced", at: "2026-11-01T00:00:00.000Z" } },
        },
      ],
      information_agent_missions: [
        {
          id: "mission-1",
          metadata: { delivery: { status: "complained", at: "2026-11-01T00:00:00.000Z" } },
        },
      ],
    };

    // Évènement passager en retard : ni le dossier (rebondi) ni la mission (plainte) ne changent.
    await markInformationAgentCaseDelivery({
      emailId: "email-9",
      status: "bounced_temporary",
      at: "2026-11-02T00:00:00.000Z",
    });
    // Un rebond définitif ne remplace pas une plainte.
    await markInformationAgentCaseDelivery({
      emailId: "email-9",
      status: "bounced",
      at: "2026-11-02T00:00:00.000Z",
    });
    expect(db.updates).toEqual([]);

    // Un état plus grave remplace un état moins grave.
    await markInformationAgentCaseDelivery({
      emailId: "email-9",
      status: "complained",
      at: "2026-11-03T00:00:00.000Z",
    });
    expect(db.updates.map((update) => update.table)).toEqual(["information_agent_cases"]);
  });

  it("ne fait rien sans identifiant de message", async () => {
    expect(
      await markInformationAgentCaseDelivery({ emailId: " ", status: "bounced", at: "x" }),
    ).toBe(0);
    expect(db.selectedWith).toEqual([]);
  });

  it("ignore un message inconnu (envoi d'un autre outil du même compte)", async () => {
    db.rows = {};
    expect(
      await markInformationAgentCaseDelivery({
        emailId: "email-x",
        status: "bounced_temporary",
        at: "x",
      }),
    ).toBe(0);
    expect(db.updates).toEqual([]);
  });
});
