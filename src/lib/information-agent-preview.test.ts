import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  mission: {} as Record<string, unknown>,
  contacts: [] as Array<Record<string, unknown>>,
  writes: [] as Array<[string, string, unknown]>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Array<[string, unknown]> = [];
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
    in() {
      return this;
    }
    ilike() {
      return this;
    }
    neq() {
      return this;
    }
    gte() {
      return this;
    }
    lte() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    insert(values: unknown) {
      db.writes.push([this.table, "insert", values]);
      return this;
    }
    update(values: unknown) {
      db.writes.push([this.table, "update", values]);
      return this;
    }
    upsert(values: unknown) {
      db.writes.push([this.table, "upsert", values]);
      return this;
    }
    async single() {
      return { data: { ...db.mission }, error: null };
    }
    then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
      const data =
        this.table === "information_agent_contacts"
          ? db.contacts.filter((row) =>
              this.filters.every(([column, value]) => (row[column] ?? null) === value),
            )
          : [];
      return Promise.resolve({ data, error: null }).then(onFulfilled);
    }
  }
  return {
    supabaseAdmin: {
      from: (table: string) => new Query(table),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    },
  };
});

const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email-alerts", () => ({ sendResendEmail: send }));

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE,
  previewAdminInformationAgentMission,
  runAdminInformationAgentAction,
} from "@/lib/information-agent";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = { isAdmin: true, userId: ADMIN_ID } as never;
const SALE_ID = "11111111-1111-4111-8111-111111111111";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";
const content = {
  missionId: MISSION_ID,
  recipientEmail: "cabinet@example.test",
  recipientName: "Maître Dupont",
  subject: "Appartement à Bordeaux — précisions pour Immojudis",
  bodyText:
    "Bonjour Maître Dupont,\n\nPourriez-vous nous transmettre le procès-verbal descriptif ?",
};

beforeEach(() => {
  db.writes.length = 0;
  db.contacts = [
    {
      normalized_email: "cabinet@example.test",
      scope_sale_id: SALE_ID,
      source_name: "licitor",
      source_url: "https://www.licitor.com/annonce/109972.html",
      opposition_status: "unknown",
      bounce_status: "none",
    },
  ];
  db.mission = {
    id: MISSION_ID,
    user_id: ADMIN_ID,
    sale_id: SALE_ID,
    case_id: "33333333-3333-4333-8333-333333333333",
    status: "draft",
    recipient_email: "cabinet@example.test",
    recipient_kind: "source_lawyer",
    metadata: {},
  };
  vi.stubEnv(
    "INFORMATION_AGENT_PORTAL_SECRET",
    "portal-secret-that-is-at-least-32-characters-long",
  );
  vi.stubEnv("INFORMATION_AGENT_OUTBOUND_ENABLED", "true");
  vi.stubEnv("INFORMATION_AGENT_OUTBOUND_CANARY_ONLY", "false");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("INFORMATION_AGENT_EMAIL_FROM", "agent@example.test");
  vi.stubEnv("INFORMATION_AGENT_INBOUND_DOMAIN", "reponses.example.test");
  vi.stubEnv("SITE_URL", "https://immojudis.example");
  vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_NAME", "Immojudis SAS");
  vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS", "1 rue de la Paix, 33000 Bordeaux");
  send.mockReset();
  vi.mocked(supabaseAdmin.rpc).mockClear();
});

afterEach(() => vi.unstubAllEnvs());

describe("aperçu obligatoire avant tout envoi manuel", () => {
  it("montre l'e-mail exact sans rien écrire ni envoyer", async () => {
    const result = await previewAdminInformationAgentMission({ auth: ADMIN, input: content });

    expect(result.blockers).toEqual([]);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.addressOrigin).toEqual({
      text: "Votre adresse professionnelle figure dans l’annonce publique de cette vente sur Licitor.",
      url: "https://www.licitor.com/annonce/109972.html",
      known: true,
    });
    for (const output of [result.preview.html, result.preview.text]) {
      expect(output).toContain("procès-verbal descriptif");
      expect(output).toContain("Immojudis SAS");
      expect(output).toContain("https://www.licitor.com/annonce/109972.html");
      expect(output).not.toContain("compte professionnel");
      expect(output).not.toContain("service professionnel");
      expect(output).toContain("https://immojudis.example/api/information-agent/opt-out?e=");
    }
    expect(db.writes).toEqual([]);
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("signale un contact opposé et l'absence d'origine connue comme bloquants", async () => {
    db.contacts = [
      {
        normalized_email: "autre@example.test",
        scope_sale_id: null,
        opposition_status: "opposed",
        bounce_status: "none",
      },
    ];
    const result = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: { ...content, recipientEmail: "autre@example.test" },
    });

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("opposé"),
        INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE,
      ]),
    );
    expect(db.writes).toEqual([]);
  });

  it("refuse un envoi dont le contenu a changé après l'aperçu, avant toute écriture", async () => {
    const { fingerprint } = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: content,
    });
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...content,
          bodyText: `${content.bodyText}\n\nPhrase ajoutée après l'aperçu.`,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow("depuis l’aperçu");
    expect(db.writes).toEqual([]);
    expect(supabaseAdmin.rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuse une adresse saisie à la main sans page publique d'origine", async () => {
    const input = { ...content, recipientEmail: "trouvee@example.test" };
    const { fingerprint } = await previewAdminInformationAgentMission({ auth: ADMIN, input });
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...input,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE);
    expect(db.writes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuse un envoi à un contact désinscrit même avec un aperçu valide", async () => {
    db.contacts.push({
      normalized_email: "cabinet@example.test",
      scope_sale_id: null,
      opposition_status: "opposed",
      bounce_status: "none",
    });
    const { fingerprint } = await previewAdminInformationAgentMission({
      auth: ADMIN,
      input: content,
    });
    await expect(
      runAdminInformationAgentAction({
        auth: ADMIN,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...content,
          previewFingerprint: fingerprint!,
        },
      }),
    ).rejects.toThrow("opposé");
    expect(db.writes).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
