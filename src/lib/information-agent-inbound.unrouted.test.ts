import { beforeEach, describe, expect, it, vi } from "vitest";
import { processInformationAgentInboundWebhook } from "@/lib/information-agent-inbound";

/**
 * Messages reçus sans dossier ouvert : conservés pour un administrateur (table
 * `information_agent_unrouted_messages`), sans extraction de faits ni réponse, et sans toucher au
 * traitement d'une opposition. Les scénarios de dossiers ouverts sont dans
 * `information-agent-inbound.scenarios.test.ts`.
 */
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  get: vi.fn(),
  from: vi.fn(),
  globalLimit: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ enforceGlobalRateLimit: mocks.globalLimit }));
// Le fournisseur n'expose volontairement AUCUN envoi : un appel à `emails.send` ferait échouer le test.
vi.mock("resend", () => ({
  Resend: class {
    webhooks = { verify: mocks.verify };
    emails = { receiving: { get: mocks.get } };
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

const CASE_A = "33333333-3333-4333-8333-333333333333";
const MISSION_A = "55555555-5555-4555-8555-555555555555";
const TOKEN_A = "77777777-7777-4777-8777-777777777777";
const TOKEN_B = "88888888-8888-4888-8888-888888888888";
const TOKEN_UNKNOWN = "99999999-9999-4999-8999-999999999999";
const DOMAIN = "reponses.immojudis.com";
const address = (token: string) => `enquete+${token}@${DOMAIN}`;

type Row = Record<string, unknown>;

function fixture({ failUnroutedWrite = false }: { failUnroutedWrite?: boolean } = {}) {
  const cases: Row[] = [
    {
      id: CASE_A,
      inbound_token: TOKEN_A,
      initiator_mission_id: MISSION_A,
      normalized_recipient_email: "maitre@example.test",
      status: "sent",
    },
  ];
  const contacts: Row[] = [];
  const unrouted: Row[] = [];
  const tables: Record<string, Row[]> = {
    information_agent_cases: cases,
    information_agent_missions: [{ id: MISSION_A, case_id: CASE_A, status: "sent" }],
    information_agent_contacts: contacts,
    information_agent_unrouted_messages: unrouted,
  };

  class Query implements PromiseLike<{ data: Row[]; error: null }> {
    private conditions: Array<(row: Row) => boolean> = [];
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(key: string, value: unknown) {
      this.conditions.push((row) => row[key] === value);
      return this;
    }
    limit() {
      return this;
    }
    upsert(row: Row, options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
      if (this.table === "information_agent_unrouted_messages") {
        if (failUnroutedWrite) {
          return Promise.resolve({ data: null, error: new Error("table indisponible") });
        }
        const duplicate = unrouted.some(
          (existing) => existing.provider_email_id === row.provider_email_id,
        );
        expect(options).toEqual({ onConflict: "provider_email_id", ignoreDuplicates: true });
        if (!duplicate) unrouted.push({ ...row });
      } else if (this.table === "information_agent_contacts") {
        contacts.push({ ...row, normalized_email: String(row.email).toLowerCase() });
      } else {
        throw new Error(`Unexpected upsert: ${this.table}`);
      }
      return Promise.resolve({ data: null, error: null });
    }
    async maybeSingle() {
      return { data: this.rows()[0] ?? null, error: null };
    }
    then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
      onfulfilled?:
        | ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve({ data: this.rows(), error: null }).then(onfulfilled, onrejected);
    }
    private rows(): Row[] {
      const rows = tables[this.table];
      if (!rows) throw new Error(`Unexpected table: ${this.table}`);
      return rows.filter((row) => this.conditions.every((condition) => condition(row)));
    }
  }
  mocks.from.mockImplementation((table: string) => new Query(table));
  return { cases, contacts, unrouted };
}

function incoming({
  to = [address(TOKEN_UNKNOWN)],
  eventFrom,
  from = "Maître Dupont <maitre@example.test>",
  subject = "Re: Vente du 12 décembre",
  text = "Bonjour, la vente est reportée.",
  authentication = { spf: "pass", dkim: "pass", dmarc: "pass" },
  attachments = [],
  fetchedTo,
}: {
  to?: string[];
  eventFrom?: string;
  from?: string;
  subject?: string;
  text?: string;
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null;
  attachments?: unknown[];
  fetchedTo?: string[];
} = {}) {
  mocks.verify.mockReturnValue({
    type: "email.received",
    created_at: "2026-12-01T09:00:00.000Z",
    data: {
      email_id: "provider-email-1",
      created_at: "2026-12-01T09:00:00.000Z",
      to,
      received_for: to,
      from: eventFrom ?? from,
      subject,
      attachments,
    },
  });
  mocks.get.mockResolvedValue({
    data: {
      from,
      to: fetchedTo ?? to,
      subject,
      text,
      html: null,
      created_at: "2026-12-01T09:00:00.000Z",
      authentication,
    },
    error: null,
  });
}

function webhook() {
  return processInformationAgentInboundWebhook({
    request: new Request("https://example.test/api/webhooks/resend/information-agent", {
      method: "POST",
      headers: { "svix-id": "id", "svix-timestamp": "timestamp", "svix-signature": "signature" },
      body: "signed local fixture",
    }),
    env: {
      NODE_ENV: "test",
      RESEND_API_KEY: "fixture-key",
      RESEND_WEBHOOK_SECRET: "fixture-secret",
      INFORMATION_AGENT_INBOUND_DOMAIN: DOMAIN,
    },
    fetchImpl: vi.fn() as unknown as typeof fetch,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("messages reçus sans dossier ouvert", () => {
  it("conserve la réponse d'un expéditeur connu, avec un extrait, le motif et les pièces", async () => {
    const state = fixture();
    state.cases[0]!.status = "completed";
    incoming({
      to: [address(TOKEN_A)],
      text: "Bonjour, la vente est reportée.",
      attachments: [{ id: "a" }, { id: "b" }],
    });

    expect(await webhook()).toMatchObject({
      accepted: true,
      ignored: true,
      ignoredReason: "case_not_open",
      oppositionRecorded: false,
    });
    expect(state.unrouted).toEqual([
      {
        provider_email_id: "provider-email-1",
        sender: "Maître Dupont <maitre@example.test>",
        sender_email: "maitre@example.test",
        subject: "Re: Vente du 12 décembre",
        received_at: "2026-12-01T09:00:00.000Z",
        excerpt: "Bonjour, la vente est reportée.",
        reason: "case_not_open",
        sender_known: true,
        sender_authentication: "pass",
        attachment_count: 2,
        opposition_recorded: false,
      },
    ]);
  });

  it("garde expéditeur, objet et date d'un inconnu sans le lire chez le fournisseur", async () => {
    const state = fixture();
    incoming({
      eventFrom: "Inconnu <inconnu@example.test>",
      from: "Inconnu <inconnu@example.test>",
    });

    expect(await webhook()).toMatchObject({ ignoredReason: "unknown_case" });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.globalLimit).not.toHaveBeenCalled();
    expect(state.unrouted).toEqual([
      expect.objectContaining({
        sender_email: "inconnu@example.test",
        subject: "Re: Vente du 12 décembre",
        received_at: "2026-12-01T09:00:00.000Z",
        excerpt: null,
        reason: "unknown_case",
        sender_known: false,
        sender_authentication: null,
        opposition_recorded: false,
      }),
    ]);
  });

  it("enregistre le motif « pas de jeton » quand l'adresse de réponse n'en porte aucun", async () => {
    const state = fixture();
    incoming({ to: [`enquete@${DOMAIN}`] });

    expect(await webhook()).toMatchObject({ ignoredReason: "no_token" });
    expect(state.unrouted).toEqual([
      expect.objectContaining({ reason: "no_token", sender_known: true }),
    ]);
  });

  it("enregistre un message adressé à deux dossiers (jetons multiples)", async () => {
    const state = fixture();
    incoming({ to: [address(TOKEN_A)], fetchedTo: [address(TOKEN_A), address(TOKEN_B)] });

    expect(await webhook()).toMatchObject({ ignoredReason: "token_mismatch" });
    expect(state.unrouted).toEqual([
      expect.objectContaining({ reason: "token_mismatch", sender_known: true }),
    ]);
  });

  it("traite toujours l'opposition d'un expéditeur connu et authentifié, et garde le message", async () => {
    const state = fixture();
    state.cases[0]!.status = "completed";
    incoming({ to: [address(TOKEN_A)], text: "STOP" });

    expect(await webhook()).toMatchObject({
      ignoredReason: "case_not_open",
      oppositionRecorded: true,
    });
    expect(state.contacts).toEqual([
      expect.objectContaining({ email: "maitre@example.test", opposition_status: "opposed" }),
    ]);
    expect(state.unrouted).toEqual([
      expect.objectContaining({ excerpt: "STOP", opposition_recorded: true }),
    ]);
  });

  it("n'enregistre pas d'opposition pour un expéditeur non authentifié, mais garde le message", async () => {
    const state = fixture();
    state.cases[0]!.status = "completed";
    incoming({ to: [address(TOKEN_A)], text: "STOP", authentication: null });

    expect(await webhook()).toMatchObject({ oppositionRecorded: false });
    expect(state.contacts).toHaveLength(0);
    expect(state.unrouted).toEqual([
      expect.objectContaining({ opposition_recorded: false, sender_authentication: "unverified" }),
    ]);
  });

  it("n'écrit qu'une ligne quand le fournisseur rejoue la livraison", async () => {
    const state = fixture();
    incoming({ eventFrom: "Inconnu <inconnu@example.test>" });

    await webhook();
    await webhook();
    expect(state.unrouted).toHaveLength(1);
  });

  it("borne l'extrait, l'objet et l'expéditeur, et retire les caractères que la base refuse", async () => {
    const state = fixture();
    state.cases[0]!.status = "completed";
    incoming({
      to: [address(TOKEN_A)],
      subject: `Re:\u0000 ${"objet ".repeat(200)}`,
      text: `Début\u0000 ${"a".repeat(5000)}\ud83d`,
    });

    await webhook();
    const row = state.unrouted[0]!;
    expect((row.excerpt as string).length).toBeLessThanOrEqual(1000);
    expect((row.subject as string).length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(row)).not.toContain("\\u0000");
    expect(String(row.excerpt).includes("\u0000")).toBe(false);
    expect(String(row.subject).includes("\u0000")).toBe(false);
  });

  it("échoue quand l'écriture échoue, pour que le fournisseur rejoue la livraison, après l'opposition", async () => {
    const state = fixture({ failUnroutedWrite: true });
    state.cases[0]!.status = "completed";
    incoming({ to: [address(TOKEN_A)], text: "STOP" });

    await expect(webhook()).rejects.toThrow("table indisponible");
    expect(state.contacts).toEqual([expect.objectContaining({ opposition_status: "opposed" })]);
  });
});
