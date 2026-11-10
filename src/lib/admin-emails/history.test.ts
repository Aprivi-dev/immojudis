import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Call = [string, unknown[]];
const state = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  calls: [] as Array<{ table: string; calls: Array<[string, unknown[]]> }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  insertError: null as { message: string } | null,
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => state.rpc(...args),
    from: (table: string) => {
      const calls: Call[] = [];
      state.calls.push({ table, calls });
      const builder: unknown = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === "then") {
              return (ok: (value: unknown) => unknown, ko: (reason: unknown) => unknown) =>
                Promise.resolve(state.results[table]).then(ok, ko);
            }
            if (property === "insert") {
              return (row: Record<string, unknown>) => {
                state.inserts.push({ table, row });
                return Promise.resolve({ error: state.insertError });
              };
            }
            if (property === "maybeSingle" || property === "single") {
              return () => Promise.resolve(state.results[table]);
            }
            return (...args: unknown[]) => {
              calls.push([String(property), args]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
  },
}));
vi.mock("@/lib/email-delivery-log", () => ({ recordEmailDeliveryEvent: vi.fn() }));

import { recordEmailDeliveryEvent } from "@/lib/email-delivery-log";
import { MASKED_LINK } from "./link-masking";
import {
  HISTORY_PAGE_SIZE,
  EmailHistoryInputError,
  listEmailHistory,
  readEmailMessage,
} from "./history";

const ADMIN = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-01T12:00:00.000Z");

function sentRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    created_at: `2026-11-01T10:${String(59 - (index % 60)).padStart(2, "0")}:00.123456+00:00`,
    template_key: "alert",
    to_address: "alice@example.test",
    subject: "Vos alertes",
    status: "sent",
    bounce_type: null,
    resend_email_id: `re_FACTICE_${index}`,
    ...overrides,
  };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  state.results = {};
  state.calls = [];
  state.inserts = [];
  state.insertError = null;
  state.rpc.mockReset();
  vi.mocked(recordEmailDeliveryEvent).mockReset();
  vi.stubEnv("RESEND_API_KEY", "re_FACTICE_FACTICE");
});

describe("listEmailHistory : envoyés", () => {
  it("rend 50 lignes composées, un curseur, et trace la consultation sans adresse", async () => {
    state.results.email_send_log = {
      data: Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, index) => sentRow(index + 1)),
      error: null,
    };
    const list = await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: null,
    });
    expect(list.rows).toHaveLength(HISTORY_PAGE_SIZE);
    expect(list.next).toMatch(/^2026-11-01T.*\|00000000-0000-4000-8000-000000000050$/);
    expect(list.rows[0]).toMatchObject({
      id: "log:00000000-0000-4000-8000-000000000001",
      who: "alice@example.test",
      tag: "Alerte de recherche",
      status: { text: "Envoyé", tone: "neutral" },
    });
    expect(state.inserts).toEqual([
      {
        table: "admin_email_access_log",
        row: {
          admin_user_id: ADMIN,
          scope: "admin.email.list",
          target_id: null,
          row_count: HISTORY_PAGE_SIZE,
        },
      },
    ]);
    expect(JSON.stringify(state.inserts)).not.toContain("alice");
  });

  it("n'a pas de page suivante quand il reste moins de 51 lignes", async () => {
    state.results.email_send_log = { data: [sentRow(1)], error: null };
    const list = await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: null,
    });
    expect(list.next).toBeNull();
  });

  it("cherche une adresse exacte ou par préfixe, en minuscules, caractères joker neutralisés", async () => {
    state.results.email_send_log = { data: [], error: null };
    await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: " Al_ice% ",
    });
    const query = state.calls.find((entry) => entry.table === "email_send_log")?.calls ?? [];
    expect(query).toContainEqual(["like", ["to_address", "al\\_ice\\%%"]]);
  });

  it("reprend après le curseur (created_at, id)", async () => {
    state.results.email_send_log = { data: [], error: null };
    await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: `2026-11-01T10:00:00.123456+00:00|${ID}`,
      address: null,
    });
    const query = state.calls[0].calls;
    expect(query).toContainEqual([
      "or",
      [
        `created_at.lt."2026-11-01T10:00:00.123456+00:00",and(created_at.eq."2026-11-01T10:00:00.123456+00:00",id.lt.${ID})`,
      ],
    ]);
  });

  it.each([
    ["curseur", { cursor: "pas un curseur", address: null }],
    ["adresse", { cursor: null, address: "a b" }],
    ["adresse trop courte", { cursor: null, address: "a" }],
    ["adresse avec joker *", { cursor: null, address: "al*" }],
  ])("refuse une entrée invalide : %s", async (_name, input) => {
    await expect(
      listEmailHistory({ adminUserId: ADMIN, box: "sent", ...input }),
    ).rejects.toBeInstanceOf(EmailHistoryInputError);
    expect(state.calls).toEqual([]);
  });

  it("n'affiche rien si la trace de consultation ne peut pas être écrite", async () => {
    state.results.email_send_log = { data: [sentRow(1)], error: null };
    state.insertError = { message: "indisponible" };
    await expect(
      listEmailHistory({ adminUserId: ADMIN, box: "sent", cursor: null, address: null }),
    ).rejects.toThrow("consultation refusée");
  });

  it("« Actualiser » relit chez Resend au plus 20 envois de moins de 72 h encore sans issue", async () => {
    const recent = Array.from({ length: 25 }, (_, index) => sentRow(index + 1));
    state.results.email_send_log = {
      data: [
        ...recent,
        sentRow(90, { created_at: "2026-10-20T10:00:00+00:00" }),
        sentRow(91, { status: "delivered" }),
      ],
      error: null,
    };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { last_event: "delivered" }));
    const list = await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: null,
      refresh: true,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(recordEmailDeliveryEvent).toHaveBeenCalledTimes(20);
    expect(recordEmailDeliveryEvent).toHaveBeenCalledWith({
      type: "email.delivered",
      data: { email_id: "re_FACTICE_1" },
    });
    expect(list.note).toBeUndefined();
  });

  it("« Actualiser » ne lit jamais chez Resend un email non émis par Immojudis", async () => {
    state.results.email_send_log = {
      data: [sentRow(1, { template_key: "unknown" })],
      error: null,
    };
    const fetchImpl = vi.fn();
    await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: null,
      refresh: true,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("distingue le rebond passager (transient, casse indifférente) du rebond définitif ou inconnu", async () => {
    state.results.email_send_log = {
      data: [
        sentRow(1, { status: "bounced", bounce_type: "transient" }),
        sentRow(2, { status: "bounced", bounce_type: "Transient" }),
        sentRow(3, { status: "bounced", bounce_type: "Permanent" }),
        sentRow(4, { status: "bounced", bounce_type: null }),
        sentRow(5, { status: "bounced", bounce_type: "Undetermined" }),
        sentRow(6, { status: "delivered", bounce_type: "transient" }),
        sentRow(7, { status: "failed" }),
      ],
      error: null,
    };
    const list = await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: null,
    });
    const passager = {
      text: "Rebond passager",
      tone: "warn",
      detail: "souvent une réponse automatique d’absence ; l’adresse reste utilisable",
    };
    expect(list.rows.map((row) => row.status)).toEqual([
      passager,
      passager,
      { text: "Rebond", tone: "bad" },
      { text: "Rebond", tone: "bad" },
      { text: "Rebond", tone: "bad" },
      { text: "Remis", tone: "ok" },
      { text: "Échec", tone: "bad" },
    ]);
    const select = state.calls[0].calls.find(([method]) => method === "select");
    expect(String(select?.[1][0])).toContain("bounce_type");
  });

  it("présente les emails de compte de Supabase Auth (unknown, objet d'un gabarit) en « Compte »", async () => {
    state.results.email_send_log = {
      data: [
        sentRow(1, {
          template_key: "unknown",
          subject: "Confirmez votre adresse email pour accéder à Immojudis",
        }),
        sentRow(2, {
          template_key: "unknown",
          subject: "Réinitialisation de votre mot de passe Immojudis",
        }),
        sentRow(3, { template_key: "unknown", subject: "Autre outil" }),
        // Un gabarit d'Immojudis garde son libellé, même avec un objet d'authentification.
        sentRow(4, { subject: "Confirmez votre adresse email pour accéder à Immojudis" }),
      ],
      error: null,
    };
    const list = await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: null,
    });
    expect(list.rows.map((row) => row.tag)).toEqual([
      "Compte · Confirmation d’inscription",
      "Compte · Réinitialisation du mot de passe",
      "unknown",
      "Alerte de recherche",
    ]);
  });

  it("« Actualiser » ne lit jamais chez Resend un email de compte de Supabase Auth", async () => {
    state.results.email_send_log = {
      data: [
        sentRow(1, {
          template_key: "unknown",
          subject: "Confirmez votre adresse email pour accéder à Immojudis",
        }),
      ],
      error: null,
    };
    const fetchImpl = vi.fn();
    await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: null,
      refresh: true,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recordEmailDeliveryEvent).not.toHaveBeenCalled();
  });

  it("« Actualiser » ignore les ouvertures et les clics", async () => {
    state.results.email_send_log = { data: [sentRow(1), sentRow(2)], error: null };
    let call = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { last_event: call++ === 0 ? "opened" : "clicked" }),
    );
    await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: null,
      refresh: true,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(recordEmailDeliveryEvent).not.toHaveBeenCalled();
  });

  it("« Actualiser » signale un refus de Resend sans casser la liste", async () => {
    state.results.email_send_log = { data: [sentRow(1)], error: null };
    const fetchImpl = vi.fn(async () => jsonResponse(403, { name: "restricted_api_key" }));
    const list = await listEmailHistory({
      adminUserId: ADMIN,
      box: "sent",
      cursor: null,
      address: null,
      refresh: true,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(list.note).toContain("droit de lire");
    expect(list.rows).toHaveLength(1);
  });
});

describe("listEmailHistory : reçus", () => {
  it("rend l'union des réponses de l'agent et des messages sans dossier", async () => {
    state.rpc.mockResolvedValue({
      data: [
        {
          source: "case",
          id: ID,
          created_at: "2026-11-01T10:00:00+00:00",
          address: "maitre@cabinet.example",
          subject: "Re: vente",
          attachment_count: 2,
        },
        {
          source: "unrouted",
          id: "00000000-0000-4000-8000-000000000002",
          created_at: "2026-11-01T09:00:00+00:00",
          address: "",
          subject: "Question",
          attachment_count: 0,
        },
      ],
      error: null,
    });
    const list = await listEmailHistory({
      adminUserId: ADMIN,
      box: "received",
      cursor: null,
      address: "Maitre",
    });
    expect(state.rpc).toHaveBeenCalledWith("admin_email_received_list", {
      p_before_at: undefined,
      p_before_id: undefined,
      p_address: "maitre",
      p_limit: 51,
    });
    expect(list.rows.map((row) => [row.id, row.tag])).toEqual([
      [`case:${ID}`, "Réponse à l’agent · 2 pièce(s)"],
      ["unrouted:00000000-0000-4000-8000-000000000002", "Sans dossier"],
    ]);
    expect(list.rows[1].who).toBe("adresse inconnue");
    expect(list.next).toBeNull();
  });
});

describe("readEmailMessage", () => {
  const logRow = {
    id: ID,
    created_at: "2026-11-01T10:00:00+00:00",
    template_key: "alert",
    category: "alert",
    to_address: "alice@example.test",
    subject: "Vos alertes",
    status: "delivered",
    bounce_type: null,
    resend_email_id: "re_FACTICE_1",
  };

  it("lit un email envoyé chez Resend, en document inerte sans lien d'action, et trace la lecture", async () => {
    state.results.email_send_log = { data: logRow, error: null };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        html: '<p>Bonjour</p><a href="https://immojudis.test/api/notification-preferences/unsubscribe?token=abc">Stop</a>',
        text: "Bonjour",
        last_event: "delivered",
      }),
    );
    const message = await readEmailMessage({
      adminUserId: ADMIN,
      id: `log:${ID}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(message?.kind).toBe("html");
    expect(message?.body).toContain("Bonjour");
    expect(message?.body).not.toContain("unsubscribe");
    expect(message?.body).not.toContain("token=abc");
    expect(message?.body).not.toMatch(/\shref\s*=/);
    expect(state.inserts[0].row).toEqual({
      admin_user_id: ADMIN,
      scope: "admin.email.view",
      target_id: ID,
      row_count: null,
    });
    expect(JSON.stringify(state.inserts)).not.toContain("alice");
  });

  it("dit « contenu expiré chez Resend » quand le fournisseur ne l'a plus", async () => {
    state.results.email_send_log = { data: logRow, error: null };
    const fetchImpl = vi.fn(async () => jsonResponse(404, { name: "not_found" }));
    const message = await readEmailMessage({
      adminUserId: ADMIN,
      id: `log:${ID}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(message).toMatchObject({
      kind: "note",
      body: expect.stringContaining("expiré chez Resend"),
    });
  });

  it("lit le texte d'un envoi de l'agent dans son dossier, lien masqué", async () => {
    state.results.email_send_log = { data: { ...logRow, category: "agent" }, error: null };
    state.results.information_agent_messages = {
      data: {
        subject: "Demande d’information",
        body_text:
          "Bonjour\nNe plus être contacté : https://immojudis.test/api/information-agent/opt-out?e=abc&t=def",
        attachments: [],
      },
      error: null,
    };
    const fetchImpl = vi.fn();
    const message = await readEmailMessage({
      adminUserId: ADMIN,
      id: `log:${ID}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(message?.kind).toBe("text");
    expect(message?.body).toContain(MASKED_LINK);
    expect(message?.body).not.toContain("opt-out");
  });

  it("affiche un email reçu en TEXTE seul, sans lien cliquable, pièces jointes par nom et taille", async () => {
    state.results.information_agent_messages = {
      data: {
        id: ID,
        from_email: "maitre@cabinet.example",
        to_email: "reponse@immojudis.test",
        subject: "Re: vente",
        body_text:
          '<script>alert(1)</script><a href="https://x.test/?t=1">lien</a> https://x.test/a?t=1',
        attachments: [{ filename: "pv.pdf", size: 20480 }, { name: "photo.jpg" }],
        created_at: "2026-11-01T10:00:00+00:00",
      },
      error: null,
    };
    const message = await readEmailMessage({ adminUserId: ADMIN, id: `case:${ID}` });
    expect(message?.kind).toBe("text");
    expect(message?.attachments).toEqual(["pv.pdf (20 Ko)", "photo.jpg"]);
    expect(message?.body).not.toContain("https://x.test/a?t=1");
  });

  it("lit un message sans dossier ouvert : extrait en texte, pièces sans nom", async () => {
    state.results.information_agent_unrouted_messages = {
      data: {
        id: ID,
        sender: "Maître <maitre@cabinet.example>",
        subject: "Question",
        excerpt: "Bonjour, une question.",
        reason: "no_token",
        attachment_count: 1,
        created_at: "2026-11-01T10:00:00+00:00",
      },
      error: null,
    };
    const message = await readEmailMessage({ adminUserId: ADMIN, id: `unrouted:${ID}` });
    expect(message).toMatchObject({
      kind: "text",
      body: "Bonjour, une question.",
      attachments: ["1 pièce(s), noms non conservés"],
    });
  });

  it("n'affiche jamais le contenu d'un email non émis par Immojudis, et ne le lit pas chez Resend", async () => {
    state.results.email_send_log = {
      data: { ...logRow, template_key: "unknown", category: "unknown" },
      error: null,
    };
    const fetchImpl = vi.fn();
    const message = await readEmailMessage({
      adminUserId: ADMIN,
      id: `log:${ID}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(message).toMatchObject({
      kind: "note",
      body: "Email non émis par Immojudis : contenu non affiché.",
    });
    // La consultation reste tracée.
    expect(state.inserts).toHaveLength(1);
  });

  it("présente un email de compte de Supabase Auth sans jamais lire ni afficher son contenu", async () => {
    state.results.email_send_log = {
      data: {
        ...logRow,
        template_key: "unknown",
        category: "unknown",
        subject: "Confirmez votre adresse email pour accéder à Immojudis",
        status: "bounced",
        bounce_type: "transient",
      },
      error: null,
    };
    const fetchImpl = vi.fn();
    const message = await readEmailMessage({
      adminUserId: ADMIN,
      id: `log:${ID}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(message).toMatchObject({
      kind: "note",
      body: "Email de compte envoyé par le service d’authentification : contenu non affiché.",
      attachments: [],
    });
    expect(message?.lines[1]).toContain(
      "· Compte · Confirmation d’inscription · Rebond passager (souvent une réponse automatique d’absence ; l’adresse reste utilisable)",
    );
    expect(state.inserts).toHaveLength(1);
  });

  it("affiche la version texte, masquée, quand le HTML ne laisse rien à afficher", async () => {
    state.results.email_send_log = { data: logRow, error: null };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        html: "<script>alert(1)</script>",
        text: "Bonjour https://immojudis.test/api/email/click?token=FACTICE",
        last_event: "delivered",
      }),
    );
    const message = await readEmailMessage({
      adminUserId: ADMIN,
      id: `log:${ID}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(message?.kind).toBe("text");
    expect(message?.body).toContain(MASKED_LINK);
    expect(message?.body).not.toContain("FACTICE");
  });

  it("ne lit pas to_email (il porte le jeton de réponse) d'un email reçu", async () => {
    state.results.information_agent_messages = {
      data: {
        id: ID,
        from_email: "maitre@cabinet.example",
        subject: "Re: vente",
        body_text: "Bonjour",
        attachments: [],
        created_at: "2026-11-01T10:00:00+00:00",
      },
      error: null,
    };
    await readEmailMessage({ adminUserId: ADMIN, id: `case:${ID}` });
    const select = state.calls
      .find((entry) => entry.table === "information_agent_messages")
      ?.calls.find(([method]) => method === "select");
    expect(String(select?.[1][0])).not.toContain("to_email");
  });

  it("répond null pour un message inconnu, sans tracer de consultation", async () => {
    state.results.email_send_log = { data: null, error: null };
    expect(await readEmailMessage({ adminUserId: ADMIN, id: `log:${ID}` })).toBeNull();
    expect(state.inserts).toEqual([]);
  });

  it.each(["", "log", "log:pas-un-uuid", `autre:${ID}`])("refuse l'identifiant %j", async (id) => {
    await expect(readEmailMessage({ adminUserId: ADMIN, id })).rejects.toBeInstanceOf(
      EmailHistoryInputError,
    );
  });

  it("n'affiche rien si la trace ne peut pas être écrite", async () => {
    state.results.email_send_log = { data: logRow, error: null };
    state.insertError = { message: "indisponible" };
    const fetchImpl = vi.fn();
    await expect(
      readEmailMessage({
        adminUserId: ADMIN,
        id: `log:${ID}`,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("consultation refusée");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
