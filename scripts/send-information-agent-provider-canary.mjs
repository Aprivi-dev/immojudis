const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_DELIVERY_TEST_ADDRESS = "delivered@resend.dev";
const CANARY_CONFIRMATION = RESEND_DELIVERY_TEST_ADDRESS;
const DEFAULT_IDEMPOTENCY_PREFIX = "immojudis-provider-canary";

/**
 * Resolve the deliberately narrow configuration for the one-message provider
 * canary. This script does not import the application, Supabase, or a sale
 * record. The double opt-in is intentional: a missing flag or key must make
 * the command a no-op before any network request is attempted.
 */
export function resolveProviderCanaryConfig(env = process.env) {
  if (env.INFORMATION_AGENT_PROVIDER_CANARY !== "true") {
    throw new Error(
      "Canari fournisseur désactivé : définissez INFORMATION_AGENT_PROVIDER_CANARY=true pour l'essai explicite.",
    );
  }
  if (env.INFORMATION_AGENT_OUTBOUND_ENABLED !== "true") {
    throw new Error(
      "Canari fournisseur désactivé : définissez aussi INFORMATION_AGENT_OUTBOUND_ENABLED=true dans l'environnement isolé.",
    );
  }
  if (env.INFORMATION_AGENT_OUTBOUND_CANARY_ONLY === "false") {
    throw new Error(
      "Canari fournisseur refusé : INFORMATION_AGENT_OUTBOUND_CANARY_ONLY doit rester actif.",
    );
  }

  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("Canari fournisseur impossible : RESEND_API_KEY est absent.");

  const rawFrom = env.INFORMATION_AGENT_CANARY_FROM;
  const from = rawFrom?.trim();
  if (!from) {
    throw new Error(
      "Canari fournisseur impossible : INFORMATION_AGENT_CANARY_FROM doit être un expéditeur autorisé par Resend.",
    );
  }
  if (/[\r\n]/.test(rawFrom ?? "") || from.length > 320) {
    throw new Error("Canari fournisseur impossible : expéditeur invalide.");
  }

  const confirmation = env.INFORMATION_AGENT_CANARY_CONFIRM?.trim().toLowerCase();
  if (confirmation !== CANARY_CONFIRMATION) {
    throw new Error(
      `Canari fournisseur refusé : confirmez exactement ${CANARY_CONFIRMATION} dans INFORMATION_AGENT_CANARY_CONFIRM.`,
    );
  }

  // A clean environment is required so this one-off provider check cannot be
  // accidentally mistaken for an application/Supabase integration test.
  const configuredSupabase = [
    "SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_DB_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ].filter((name) => env[name]?.trim());
  if (configuredSupabase.length) {
    throw new Error(
      `Canari fournisseur refusé avec une configuration Supabase (${configuredSupabase.join(", ")}). Utilisez un environnement propre.`,
    );
  }

  const idempotencyKey =
    env.INFORMATION_AGENT_CANARY_IDEMPOTENCY_KEY?.trim() ||
    `${DEFAULT_IDEMPOTENCY_PREFIX}-${Date.now()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
    throw new Error("Canari fournisseur impossible : clé d'idempotence invalide.");
  }

  return {
    apiKey,
    from,
    to: RESEND_DELIVERY_TEST_ADDRESS,
    idempotencyKey,
  };
}

export function buildProviderCanaryMessage({ from, to = RESEND_DELIVERY_TEST_ADDRESS }) {
  if (to !== RESEND_DELIVERY_TEST_ADDRESS) {
    throw new Error("Le canari fournisseur ne peut cibler que l'adresse de test Resend.");
  }
  return {
    from,
    to,
    subject: "ImmoJudis — canari fournisseur de messagerie",
    text: [
      "Canari fournisseur ImmoJudis.",
      "",
      "Ce message vérifie uniquement l'envoi vers l'adresse de test de Resend.",
      "Aucune annonce, mission, donnée de contact ou base Supabase n'est utilisée.",
    ].join("\n"),
    html: [
      "<p><strong>Canari fournisseur ImmoJudis.</strong></p>",
      "<p>Ce message vérifie uniquement l'envoi vers l'adresse de test de Resend.</p>",
      "<p>Aucune annonce, mission, donnée de contact ou base Supabase n'est utilisée.</p>",
    ].join(""),
  };
}

export async function sendProviderCanary({ env = process.env, fetchImpl = fetch } = {}) {
  const config = resolveProviderCanaryConfig(env);
  const message = buildProviderCanaryMessage(config);
  const response = await fetchImpl(RESEND_EMAILS_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      "idempotency-key": config.idempotencyKey,
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    throw new Error(body.error || body.message || `Resend a refusé l'essai (${response.status}).`);
  }
  return {
    ok: true,
    provider: "resend",
    recipient: RESEND_DELIVERY_TEST_ADDRESS,
    messageId: typeof body.id === "string" ? body.id : null,
  };
}

async function readJsonBody(response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    const result = await sendProviderCanary();
    console.info(JSON.stringify(result));
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
