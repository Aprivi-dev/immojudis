import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Les constructeurs sont appelés pour de vrai ; la base et le réseau ne doivent jamais l'être.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn(), auth: { admin: {} } },
}));

// Les messages complets (expéditeur, Reply-To) sont relevés au passage des aperçus du registre.
const captured = vi.hoisted(() => [] as Array<{ key: string; message: Record<string, unknown> }>);
vi.mock("./samples", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./samples")>();
  return {
    ...actual,
    variantFromMessage: (key: string, label: string, message: Record<string, unknown>) => {
      captured.push({ key, message });
      return (actual.variantFromMessage as (...args: unknown[]) => unknown)(key, label, message);
    },
  };
});

import {
  resolveNoReplyEmailConfig,
  resolveTransactionalEmailConfig,
  sendResendEmail,
} from "@/lib/email-alerts";
import { EMAIL_TEMPLATES } from "./registry";

/**
 * Qui envoie quoi (décision du propriétaire du 02/11/2026) :
 * - « ne pas répondre » : expéditeur `NOREPLY_EMAIL_FROM`, aucun Reply-To, mention au pied ;
 * - « réponse possible » : expéditeur `TRANSACTIONAL_EMAIL_FROM`, Reply-To = adresse de contact ;
 * - inchangés : agent d'information, incident, relecture des réponses, formulaire de contact.
 */
const NO_REPLY = [
  "alert",
  "sale_reminder",
  "weekly_digest",
  "sale_result",
  "trial_end",
  "trial_ending",
  "offer_opening",
] as const;
const REPLY_POSSIBLE = [
  "payment_failed",
  "cancellation",
  "commercial_confirmation",
  "lawyer_referral",
] as const;
const UNCHANGED: Record<string, string> = {
  agent_request: "INFORMATION_AGENT_EMAIL_FROM",
  agent_court_registry: "INFORMATION_AGENT_EMAIL_FROM",
  operations_incident: "ALERT_EMAIL_FROM",
  replies_review_digest: "ALERT_EMAIL_FROM",
  contact_message: "CONTACT_EMAIL_FROM",
};

const SENTENCE = "Message automatique, merci de ne pas y répondre. Pour nous écrire :";
const CONTACT = "contact@immojudis.com";
const NO_REPLY_FROM = "Immojudis <ne-pas-repondre@immojudis.test>";
const TRANSACTIONAL_FROM = "Immojudis <contact@immojudis.test>";
const ALERT_FROM = "Immojudis <alertes@immojudis.test>";
const BASE_ENV = {
  RESEND_API_KEY: "re_FACTICE_FACTICE",
  ALERT_EMAIL_FROM: ALERT_FROM,
  SITE_URL: "https://immojudis.test",
};

function sampleOf(key: string) {
  const definition = EMAIL_TEMPLATES.find((template) => template.key === key);
  if (!definition) throw new Error(`Gabarit inconnu : ${key}`);
  return definition;
}

/** Les messages complets des aperçus d'un gabarit. */
async function messagesOf(key: string) {
  captured.length = 0;
  const variants = (await sampleOf(key).sample?.()) ?? [];
  return { variants, messages: captured.map((entry) => entry.message) };
}

/** Le corps de la requête que `sendResendEmail` envoie à Resend pour ce message. */
async function resendPayload(message: Record<string, unknown>, category: string) {
  let body = "";
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ id: "re_FACTICE_FACTICE" }), { status: 200 });
  }) as unknown as typeof fetch;
  await sendResendEmail({
    apiKey: "re_FACTICE_FACTICE",
    message: message as never,
    idempotencyKey: "cle-politique",
    fetchImpl,
    category: category as never,
  });
  return JSON.parse(body) as Record<string, unknown>;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.test");
  vi.stubEnv("EMAIL_REPLY_TO", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("expéditeur affiché par gabarit dans le registre", () => {
  it.each(NO_REPLY)("%s part de NOREPLY_EMAIL_FROM", (key) => {
    expect(sampleOf(key).sender).toBe("NOREPLY_EMAIL_FROM");
  });
  it.each(REPLY_POSSIBLE)("%s part de TRANSACTIONAL_EMAIL_FROM", (key) => {
    expect(sampleOf(key).sender).toBe("TRANSACTIONAL_EMAIL_FROM");
  });
  it.each(Object.entries(UNCHANGED))("%s reste sur %s", (key, sender) => {
    expect(sampleOf(key).sender).toBe(sender);
  });
});

describe("catégories « ne pas répondre » : expéditeur NOREPLY_EMAIL_FROM, aucun Reply-To", () => {
  it("utilise NOREPLY_EMAIL_FROM quand la variable est posée", () => {
    const env = { ...BASE_ENV, NOREPLY_EMAIL_FROM: NO_REPLY_FROM };
    expect(resolveNoReplyEmailConfig(env).from).toBe(NO_REPLY_FROM);
    // L'expéditeur des alertes n'est plus requis pour ces messages.
    const { ALERT_EMAIL_FROM: _alert, ...withoutAlert } = env;
    void _alert;
    expect(resolveNoReplyEmailConfig(withoutAlert)).toMatchObject({
      from: NO_REPLY_FROM,
      configured: true,
      missing: [],
    });
  });

  it("garde l'expéditeur actuel quand la variable est absente ou vide", () => {
    expect(resolveNoReplyEmailConfig(BASE_ENV).from).toBe(ALERT_FROM);
    expect(resolveNoReplyEmailConfig({ ...BASE_ENV, NOREPLY_EMAIL_FROM: "  " }).from).toBe(
      ALERT_FROM,
    );
    // Le rappel de fin d'essai payant repli sur l'expéditeur de la facturation, comme avant.
    const transactional = { ...BASE_ENV, TRANSACTIONAL_EMAIL_FROM: TRANSACTIONAL_FROM };
    expect(
      resolveNoReplyEmailConfig(transactional, resolveTransactionalEmailConfig(transactional)).from,
    ).toBe(TRANSACTIONAL_FROM);
  });

  it.each(NO_REPLY.filter((key) => sampleOf(key).sample))(
    "%s : le message n'a pas de Reply-To, la requête Resend non plus, même avec une adresse de contact",
    async (key) => {
      const { messages } = await messagesOf(key);
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        expect(message.replyTo).toBeNull();
        const payload = await resendPayload(message, sampleOf(key).category as string);
        expect(payload).not.toHaveProperty("reply_to");
      }
    },
  );

  it("la désinscription en un clic reste inchangée", async () => {
    const { messages } = await messagesOf("alert");
    const payload = await resendPayload(messages[0], "alert");
    expect(payload.headers).toMatchObject({
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(String((payload.headers as Record<string, string>)["List-Unsubscribe"])).toMatch(
      /^<https:\/\/.*unsubscribe/,
    );
  });
});

describe("catégories avec réponse possible : TRANSACTIONAL_EMAIL_FROM et Reply-To de contact", () => {
  it("utilise TRANSACTIONAL_EMAIL_FROM quand la variable est posée, l'expéditeur actuel sinon", () => {
    const env = { ...BASE_ENV, TRANSACTIONAL_EMAIL_FROM: TRANSACTIONAL_FROM };
    expect(resolveTransactionalEmailConfig(env).from).toBe(TRANSACTIONAL_FROM);
    expect(resolveTransactionalEmailConfig(BASE_ENV).from).toBe(ALERT_FROM);
  });

  it.each(REPLY_POSSIBLE.filter((key) => sampleOf(key).sample))(
    "%s : la requête Resend porte reply_to = adresse de contact",
    async (key) => {
      const { messages } = await messagesOf(key);
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        expect(message.replyTo).toBeUndefined();
        const payload = await resendPayload(message, sampleOf(key).category as string);
        expect(payload.reply_to).toBe("contact@immojudis.test");
      }
    },
  );

  it("commercial_confirmation (sans aperçu) n'impose aucun Reply-To : celui du site s'applique", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/commercial-acceptance.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/replyTo/);
    expect(source).toMatch(/resolveTransactionalEmailConfig\(/);
  });
});

describe("chaque émetteur lit l'expéditeur de sa catégorie", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  it.each([
    ["src/lib/email-alerts.ts", "resolveNoReplyEmailConfig(env)"],
    ["src/lib/weekly-digest.ts", "resolveNoReplyEmailConfig(env)"],
    ["src/lib/sale-reminders.ts", "resolveNoReplyEmailConfig(env)"],
    ["src/lib/sale-results.ts", "resolveNoReplyEmailConfig(env)"],
    ["src/lib/trial-end-notices.ts", "resolveNoReplyEmailConfig()"],
    ["src/lib/admin-offer-opening-notifier.ts", "resolveNoReplyEmailConfig(env)"],
    [
      "src/lib/billing-notices.ts",
      "resolveNoReplyEmailConfig(process.env, resolveTransactionalEmailConfig())",
    ],
    ["src/lib/admin-lawyer-referrals.ts", "resolveTransactionalEmailConfig(env)"],
    ["src/lib/commercial-acceptance.ts", "resolveTransactionalEmailConfig("],
  ])("%s appelle %s", (file, call) => {
    expect(read(file)).toContain(call);
  });

  it("les emails inchangés ne passent ni par NOREPLY_EMAIL_FROM ni par l'expéditeur transactionnel", () => {
    for (const file of [
      "src/lib/information-agent.ts",
      "src/lib/information-agent/send.ts",
      "src/lib/operational-alerts.ts",
      "src/lib/replies-review-digest.ts",
    ]) {
      expect(read(file), file).not.toMatch(/NoReply|NOREPLY/);
    }
    // Facturation : paiement échoué et résiliation gardent l'expéditeur transactionnel.
    const billing = read("src/lib/billing-notices.ts");
    expect(billing.match(/resolveTransactionalEmailConfig\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("mention « ne pas répondre » du pied", () => {
  const ADDRESS_LINK = new RegExp(
    `${SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} <a href="mailto:${CONTACT}"[^>]*color:#84602e;text-decoration:underline[^>]*>${CONTACT}</a>`,
  );

  it.each(NO_REPLY.filter((key) => sampleOf(key).sample))(
    "%s : même phrase en HTML (lien mailto souligné #84602e, dans le pied) et en texte",
    async (key) => {
      const { variants } = await messagesOf(key);
      expect(variants.length).toBeGreaterThan(0);
      for (const variant of variants) {
        expect(variant.html, variant.key).toMatch(ADDRESS_LINK);
        expect(variant.html?.split(SENTENCE)).toHaveLength(2);
        // Dans la zone de pied : après le filet du pied, dans la dernière cellule de la carte.
        const footer =
          variant.html?.slice(variant.html.lastIndexOf('class="ej-pad ej-rule"')) ?? "";
        expect(footer, variant.key).toContain(SENTENCE);
        expect(variant.text.trimEnd().endsWith(`${SENTENCE} ${CONTACT}`), variant.key).toBe(true);
      }
    },
  );

  it.each([...REPLY_POSSIBLE, ...Object.keys(UNCHANGED)].filter((key) => sampleOf(key).sample))(
    "%s : aucune mention « ne pas répondre »",
    async (key) => {
      const { variants } = await messagesOf(key);
      for (const variant of variants) {
        expect(variant.html ?? "").not.toContain("ne pas y répondre");
        expect(variant.text).not.toContain("ne pas y répondre");
      }
    },
  );

  it("les six gabarits Supabase portent la même phrase, sous la mention de sécurité", async () => {
    const { AUTH_EMAIL_TEMPLATES, buildAuthEmailTemplate } =
      await import("@/lib/auth-email-templates");
    expect(AUTH_EMAIL_TEMPLATES).toHaveLength(6);
    for (const definition of AUTH_EMAIL_TEMPLATES) {
      for (const variant of ["token-hash", "confirmation-url"] as const) {
        const html = buildAuthEmailTemplate(definition, variant);
        const security = html.indexOf("Il ne contient aucune offre commerciale.");
        const sentence = html.indexOf(SENTENCE);
        expect(security, definition.id).toBeGreaterThan(0);
        expect(sentence, definition.id).toBeGreaterThan(security);
        expect(html, definition.id).toMatch(ADDRESS_LINK);
      }
    }
  });
});
