import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));

import { sendTrackedEmail } from "@/lib/send-tracked-email";
import { EMAIL_TEMPLATES } from "@/lib/email-templates/registry";
import { GENERIC_LOG_SUBJECTS, SENT_TEMPLATE_KEYS } from "@/lib/email-templates/keys";

const message = {
  from: "Immojudis <alertes@immojudis.test>",
  to: "Alice@Example.test",
  subject: "Objet de test",
  html: "<p>Bonjour</p>",
  text: "Bonjour",
  replyTo: null,
};

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("sendTrackedEmail", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: "log-1", error: null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("envoie le message tel quel puis écrit la ligne du journal, sans corps", async () => {
    const fetchImpl = fetchReturning(200, { id: "re_FACTICE_FACTICE" });
    const result = await sendTrackedEmail({
      apiKey: "re_FACTICE_FACTICE",
      message,
      idempotencyKey: "cle-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      category: "alert",
      templateKey: "alert",
      userId: "00000000-0000-4000-8000-000000000001",
    });

    expect(result).toEqual({ id: "re_FACTICE_FACTICE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("record_email_send", {
      p_resend_email_id: "re_FACTICE_FACTICE",
      p_template_key: "alert",
      p_category: "alert",
      p_mode: "on",
      p_user_id: "00000000-0000-4000-8000-000000000001",
      p_from: message.from,
      p_to: message.to,
      p_subject: "Objet de test",
    });
    const written = JSON.stringify(mocks.rpc.mock.calls);
    expect(written).not.toContain("Bonjour");
  });

  it("n'écrit rien quand Resend refuse l'envoi, et propage l'erreur", async () => {
    const fetchImpl = fetchReturning(500, { message: "indisponible" });
    await expect(
      sendTrackedEmail({
        apiKey: "re_FACTICE_FACTICE",
        message,
        idempotencyKey: "cle-2",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        category: "alert",
        templateKey: "alert",
      }),
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("n'annule pas l'envoi quand le journal est en panne, et ne journalise aucune adresse", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("alice@example.test illisible") });
    const result = await sendTrackedEmail({
      apiKey: "re_FACTICE_FACTICE",
      message,
      idempotencyKey: "cle-3",
      fetchImpl: fetchReturning(200, { id: "re_FACTICE_2" }) as unknown as typeof fetch,
      category: "billing",
      templateKey: "payment_failed",
    });
    expect(result).toEqual({ id: "re_FACTICE_2" });
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).toContain("write_failed");
    expect(logged.toLowerCase()).not.toContain("alice");
  });

  it("tient le journal quand la base lève une exception, sans casser l'envoi", async () => {
    mocks.rpc.mockRejectedValue(new Error("réseau"));
    await expect(
      sendTrackedEmail({
        apiKey: "re_FACTICE_FACTICE",
        message,
        idempotencyKey: "cle-4",
        fetchImpl: fetchReturning(200, { id: "re_FACTICE_3" }) as unknown as typeof fetch,
        category: "alert",
        templateKey: "alert",
      }),
    ).resolves.toEqual({ id: "re_FACTICE_3" });
  });

  it("enregistre un objet générique pour les gabarits personnalisés avec des données de tiers", async () => {
    await sendTrackedEmail({
      apiKey: "re_FACTICE_FACTICE",
      message: { ...message, subject: "Maître Exemple : vente du 12 rue de la Paix" },
      idempotencyKey: "cle-5",
      fetchImpl: fetchReturning(200, { id: "re_FACTICE_4" }) as unknown as typeof fetch,
      category: "lawyer",
      templateKey: "lawyer_referral",
    });
    const [, args] = mocks.rpc.mock.calls[0];
    expect(args.p_subject).toBe(GENERIC_LOG_SUBJECTS.lawyer_referral);
    expect(JSON.stringify(args)).not.toContain("rue de la Paix");
  });
});

describe("neutralité : le message part exactement comme avant", () => {
  it("envoie à Resend la même requête, octet pour octet, que sendResendEmail seul", async () => {
    const { sendResendEmail } = await import("@/lib/email-alerts");
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const capture = (status: number) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), init: init as RequestInit });
        return new Response(JSON.stringify({ id: "re_FACTICE_FACTICE" }), { status });
      }) as unknown as typeof fetch;
    const input = {
      apiKey: "re_FACTICE_FACTICE",
      message: {
        ...message,
        unsubscribeUrl: "https://immojudis.test/api/notification-preferences/unsubscribe?token=x",
        oneClickUnsubscribe: true,
        html: "<p>Café — « accents » & entités</p>",
        text: "Café — « accents »\nligne deux",
      },
      idempotencyKey: "cle-neutralite",
      category: "weekly" as const,
    };
    await sendResendEmail({ ...input, fetchImpl: capture(200) });
    await sendTrackedEmail({
      ...input,
      fetchImpl: capture(200),
      templateKey: "weekly_digest",
      mode: "internal",
      userId: "00000000-0000-4000-8000-000000000001",
    });
    expect(sent).toHaveLength(2);
    expect(sent[1].url).toBe(sent[0].url);
    expect(sent[1].init.body).toBe(sent[0].init.body);
    expect(sent[1].init.headers).toEqual(sent[0].init.headers);
    expect(sent[1].init.method).toBe(sent[0].init.method);
  });
});

describe("clés de gabarit des envois", () => {
  it("couvrent exactement les gabarits du registre qui partent par Resend", () => {
    const sent = EMAIL_TEMPLATES.filter((template) => template.category !== null).map(
      (template) => template.key,
    );
    expect([...SENT_TEMPLATE_KEYS].sort()).toEqual(sent.sort());
  });

  it("ne donnent un objet générique qu'à des clés connues", () => {
    for (const key of Object.keys(GENERIC_LOG_SUBJECTS)) {
      expect(SENT_TEMPLATE_KEYS).toContain(key);
    }
  });
});

const ROOT = process.cwd();
function walk(relative: string): string[] {
  return readdirSync(path.join(ROOT, relative)).flatMap((entry) => {
    const child = path.join(relative, entry);
    if (statSync(path.join(ROOT, child)).isDirectory()) return walk(child);
    return /\.tsx?$/.test(entry) && !/\.(?:test|spec)\./.test(entry) ? [child] : [];
  });
}

describe("garde statique : un seul chemin d'envoi", () => {
  const files = walk("src");

  it("n'appelle sendResendEmail que depuis le wrapper (et sa définition)", () => {
    const callers = files.filter((file) =>
      /\bsendResendEmail\b/.test(readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(callers.sort()).toEqual(
      [
        path.join("src", "lib", "email-alerts.ts"),
        path.join("src", "lib", "send-tracked-email.ts"),
      ].sort(),
    );
    // email-alerts.ts ne fait que DÉFINIR la fonction : aucun appel.
    const alerts = readFileSync(path.join(ROOT, "src/lib/email-alerts.ts"), "utf8");
    expect(alerts.match(/\bsendResendEmail\s*\(/g)).toHaveLength(1);
    expect(alerts).toMatch(/export async function sendResendEmail\(/);
  });

  it("n'écrit nulle part ailleurs à api.resend.com/emails", () => {
    const direct = files.filter((file) =>
      /api\.resend\.com\/emails/.test(readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(direct.sort()).toEqual([path.join("src", "lib", "email-alerts.ts")]);
  });
});
