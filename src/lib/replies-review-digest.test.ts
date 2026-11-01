import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  results: {} as Record<string, { data: unknown[]; count: number | null; error: unknown }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    constructor(private readonly table: string) {}
    private record(method: string, args: unknown[]) {
      mocks.calls.push({ table: this.table, method, args });
      return this;
    }
    select(...args: unknown[]) {
      return this.record("select", args);
    }
    eq(...args: unknown[]) {
      return this.record("eq", args);
    }
    is(...args: unknown[]) {
      return this.record("is", args);
    }
    order(...args: unknown[]) {
      return this.record("order", args);
    }
    limit(...args: unknown[]) {
      return this.record("limit", args);
    }
    then(onFulfilled: (value: unknown) => unknown) {
      return Promise.resolve(mocks.results[this.table]).then(onFulfilled);
    }
  }
  return { supabaseAdmin: { from: (table: string) => new Query(table) } };
});

import {
  assertRepliesReviewDigestComplete,
  buildRepliesReviewDigestMessage,
  loadRepliesReviewDigest,
  REPLIES_REVIEW_DIGEST_MAX_LISTED,
  repliesReviewDigestMode,
  repliesReviewDigestSubject,
  runRepliesReviewDigest,
  type RepliesReviewDigestContent,
} from "@/lib/replies-review-digest";

const ENV = {
  RESEND_API_KEY: "re_test",
  ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.com>",
  OPERATIONS_ALERT_EMAIL_TO: "owner@example.test, ops@example.test",
  SITE_URL: "https://immojudis.com",
};
// 7 h 05 UTC le 2 décembre 2026 : le 2 décembre à Paris.
const NOW = new Date("2026-12-02T07:05:00.000Z");

function content(replies = 2, unrouted = 1): RepliesReviewDigestContent {
  const entries = (count: number, prefix: string) =>
    Array.from({ length: Math.min(count, REPLIES_REVIEW_DIGEST_MAX_LISTED) }, (_, index) => ({
      sender: `${prefix}${index}@cabinet.test`,
      subject: `Re: vente ${index}`,
    }));
  return {
    replies: { total: replies, entries: entries(replies, "avocat") },
    unrouted: { total: unrouted, entries: entries(unrouted, "inconnu") },
  };
}

function okFetch() {
  return vi.fn(async (_url: unknown, _init?: RequestInit) =>
    Response.json({ id: "email-1" }, { status: 200 }),
  );
}

function sentPayloads(fetchImpl: ReturnType<typeof okFetch>) {
  return fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.results = {};
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("interrupteur REPLIES_REVIEW_DIGEST_MODE", () => {
  it("est fermé par défaut et pour toute valeur inconnue", () => {
    expect(repliesReviewDigestMode({})).toBe("off");
    expect(repliesReviewDigestMode({ REPLIES_REVIEW_DIGEST_MODE: "oui" })).toBe("off");
    expect(repliesReviewDigestMode({ REPLIES_REVIEW_DIGEST_MODE: "internal" })).toBe("off");
    expect(repliesReviewDigestMode({ REPLIES_REVIEW_DIGEST_MODE: " Preview " })).toBe("preview");
    expect(repliesReviewDigestMode({ REPLIES_REVIEW_DIGEST_MODE: "ON" })).toBe("on");
  });
});

describe("runRepliesReviewDigest", () => {
  it("ne lit ni n'envoie rien quand l'interrupteur est fermé", async () => {
    const load = vi.fn();
    const fetchImpl = okFetch();

    const summary = await runRepliesReviewDigest({ mode: "off", env: ENV, load, fetchImpl });

    expect(summary).toMatchObject({ mode: "off", replies: 0, unrouted: 0, sent: 0 });
    expect(load).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("en aperçu, compte sans rien envoyer", async () => {
    const fetchImpl = okFetch();

    const summary = await runRepliesReviewDigest({
      mode: "preview",
      env: ENV,
      load: async () => content(3, 2),
      fetchImpl,
    });

    expect(summary).toMatchObject({ mode: "preview", replies: 3, unrouted: 2, due: 0, sent: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("n'envoie rien quand il n'y a rien à relire", async () => {
    const fetchImpl = okFetch();

    const summary = await runRepliesReviewDigest({
      mode: "on",
      env: ENV,
      load: async () => content(0, 0),
      fetchImpl,
    });

    expect(summary).toMatchObject({ replies: 0, unrouted: 0, due: 0, sent: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => assertRepliesReviewDigestComplete(summary)).not.toThrow();
  });

  it("envoie un seul email par adresse d'exploitation, jamais à un expéditeur", async () => {
    const fetchImpl = okFetch();

    const summary = await runRepliesReviewDigest({
      mode: "on",
      env: ENV,
      now: NOW,
      load: async () => content(2, 1),
      fetchImpl,
    });

    expect(summary).toMatchObject({ replies: 2, unrouted: 1, due: 2, sent: 2, failed: 0 });
    const payloads = sentPayloads(fetchImpl);
    expect(payloads.map((payload) => payload.to)).toEqual([
      ["owner@example.test"],
      ["ops@example.test"],
    ]);
    for (const payload of payloads) {
      expect(payload.subject).toBe("[Immojudis] 3 réponses à relire");
      expect(payload.from).toBe("Immojudis <alertes@immojudis.com>");
      expect(payload.reply_to).toBeUndefined();
      expect(payload.tags).toEqual([{ name: "category", value: "operations" }]);
      // Aucun expéditeur de message n'est destinataire.
      expect(JSON.stringify(payload.to)).not.toMatch(/cabinet\.test/);
    }
    // Une clé d'idempotence par adresse et par jour de Paris : un passage rejoué ne renvoie rien.
    expect(
      fetchImpl.mock.calls.map(
        ([, init]) => (init?.headers as Record<string, string>)["idempotency-key"],
      ),
    ).toEqual([
      "replies-review-digest-2026-12-02-owner@example.test",
      "replies-review-digest-2026-12-02-ops@example.test",
    ]);
  });

  it("fait échouer le passage quand un résumé est dû et que le canal email n'est pas configuré", async () => {
    const fetchImpl = okFetch();

    const summary = await runRepliesReviewDigest({
      mode: "on",
      env: { SITE_URL: "https://immojudis.com" },
      load: async () => content(1, 0),
      fetchImpl,
    });

    expect(summary).toMatchObject({ configured: false, sent: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => assertRepliesReviewDigestComplete(summary)).toThrow("n’est pas configuré");
  });

  it("compte un envoi en échec et fait échouer le passage", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ message: "refusé" }, { status: 422 }));

    const summary = await runRepliesReviewDigest({
      mode: "on",
      env: ENV,
      load: async () => content(1, 0),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(summary).toMatchObject({ sent: 0, failed: 2 });
    expect(() => assertRepliesReviewDigestComplete(summary)).toThrow("2 envoi(s) en échec");
  });
});

describe("contenu de l'email", () => {
  const message = (digest: RepliesReviewDigestContent) =>
    buildRepliesReviewDigestMessage(digest, {
      from: "Immojudis <alertes@immojudis.com>",
      to: "owner@example.test",
      panelUrl: "https://immojudis.com/admin/agent-ia",
    });

  it("accorde l'objet au nombre", () => {
    expect(repliesReviewDigestSubject(1)).toBe("1 réponse à relire");
    expect(repliesReviewDigestSubject(5)).toBe("5 réponses à relire");
  });

  it("donne le nombre, l'expéditeur, l'objet et le lien vers le panneau, sans corps de message", () => {
    const built = message({
      replies: {
        total: 1,
        entries: [{ sender: "Maître Dupont <maitre@cabinet.test>", subject: "Re: Vente du 12" }],
      },
      unrouted: {
        total: 1,
        entries: [{ sender: "inconnu@example.test", subject: "Question sur une vente" }],
      },
    });

    expect(built.subject).toBe("[Immojudis] 2 réponses à relire");
    for (const body of [built.text, built.html]) {
      expect(body).toContain("Maître Dupont");
      expect(body).toContain("Re: Vente du 12");
      expect(body).toContain("inconnu@example.test");
      expect(body).toContain("https://immojudis.com/admin/agent-ia");
    }
    expect(built.replyTo).toBeNull();
    // Interne : ni désinscription, ni opposition.
    expect(built.unsubscribeUrl).toBeUndefined();
    expect(built.html).not.toMatch(/désinscri|se désabonner/i);
  });

  it("n'écrit que les sections non vides", () => {
    const built = message(content(0, 2));

    expect(built.text).toContain("Messages non rattachés à un dossier (2)");
    expect(built.text).not.toContain("Réponses de l’agent en relecture");
  });

  it("échappe le HTML d'un expéditeur ou d'un objet hostile", () => {
    const built = message({
      replies: {
        total: 1,
        entries: [
          { sender: "<script>alert(1)</script>", subject: `"><img src=x onerror=alert(1)>` },
        ],
      },
      unrouted: { total: 0, entries: [] },
    });

    expect(built.html).not.toContain("<script>");
    expect(built.html).not.toContain("<img");
    expect(built.html).toContain("&lt;script&gt;");
  });

  it("borne chaque liste et annonce le reste", () => {
    const built = message({ ...content(0, 0), replies: { ...content(25, 0).replies } });

    expect(built.text.match(/^- avocat/gm)).toHaveLength(REPLIES_REVIEW_DIGEST_MAX_LISTED);
    expect(built.text).toContain("… et 15 de plus");
  });
});

describe("loadRepliesReviewDigest", () => {
  it("ne sélectionne que l'expéditeur et l'objet, jamais le corps, et nettoie les valeurs", async () => {
    mocks.results = {
      information_agent_messages: {
        data: [
          {
            from_email: "Maître\u0000 Dupont <maitre@cabinet.test>",
            subject: "Voir https://exemple.test/lien\nRe: vente",
          },
        ],
        count: 4,
        error: null,
      },
      information_agent_unrouted_messages: {
        data: [{ sender: "inconnu@example.test", subject: "" }],
        count: 1,
        error: null,
      },
    };

    const digest = await loadRepliesReviewDigest();

    expect(digest.replies.total).toBe(4);
    expect(digest.replies.entries).toEqual([
      {
        sender: "Maître Dupont <maitre@cabinet.test>",
        subject: "Voir exemple.test/lien Re: vente",
      },
    ]);
    expect(digest.unrouted.entries).toEqual([
      { sender: "inconnu@example.test", subject: "(sans objet)" },
    ]);
    const selects = mocks.calls.filter((call) => call.method === "select");
    expect(selects.map((call) => [call.table, call.args[0]])).toEqual([
      ["information_agent_messages", "from_email,subject"],
      ["information_agent_unrouted_messages", "sender,subject"],
    ]);
    const filters = mocks.calls.filter((call) => call.method === "eq" || call.method === "is");
    expect(filters.map((call) => call.args)).toEqual(
      expect.arrayContaining([
        ["metadata->inbound_processing->>status", "review"],
        ["metadata->>admin_handled_at", null],
        ["status", "pending"],
      ]),
    );
  });

  it("propage une erreur de lecture, pour que la supervision la voie", async () => {
    mocks.results = {
      information_agent_messages: { data: [], count: 0, error: new Error("lecture impossible") },
      information_agent_unrouted_messages: { data: [], count: 0, error: null },
    };

    await expect(loadRepliesReviewDigest()).rejects.toThrow("lecture impossible");
  });
});
