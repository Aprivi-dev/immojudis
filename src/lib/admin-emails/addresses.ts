import "server-only";
import { EMAIL_TEMPLATES } from "@/lib/email-templates/registry";
import { checkDomainDns, recommendedDmarc, type DnsResolver, type DomainDnsCheck } from "./dns";
import {
  EMAIL_SECRET_VARIABLES,
  readEmailAddressEnv,
  readEmailSecretsConfigured,
  readResendApiKey,
  type EmailAddressEnv,
  type EmailSecretVariable,
} from "./env";
import {
  fetchResendDomains,
  fetchResendWebhooks,
  type ResendDomain,
  type ResendFailure,
  type ResendWebhook,
} from "./resend";
import { buildAddressRows, type EmailAddressRow } from "./senders";

/**
 * Onglet « Adresses » : expéditeurs effectifs, état des secrets (booléens), domaines et DNS chez
 * Resend, vérification publique des DNS, webhooks attendus. Mise en cache 60 s dans le processus ;
 * « Revérifier » la contourne (au plus une fois toutes les 5 s). Voir `env.ts` pour la liste blanche
 * de variables et `resend.ts` pour la liste blanche de champs.
 */

const CACHE_TTL_MS = 60_000;
const MIN_REFRESH_INTERVAL_MS = 5_000;

export type EmailAlert = { id: string; severity: "error" | "warning"; message: string };

export type SecretStatus = { name: EmailSecretVariable; configured: boolean; purpose: string };

export type WebhookExpectation = {
  label: string;
  path: string;
  secret: EmailSecretVariable;
  events: readonly string[];
};

/** Routes qui reçoivent des évènements de Resend, et ce qu'elles attendent. */
export const EXPECTED_WEBHOOKS: readonly WebhookExpectation[] = [
  {
    label: "Rebonds et plaintes des emails aux comptes",
    path: "/api/webhooks/resend/account-emails",
    secret: "RESEND_ACCOUNT_WEBHOOK_SECRET",
    // Rebonds et plaintes (consentements) ; remis, différé et échec ne font qu'alimenter le journal des envois.
    events: [
      "email.bounced",
      "email.complained",
      "email.delivered",
      "email.delivery_delayed",
      "email.failed",
    ],
  },
  {
    label: "Réponses reçues par l’agent d’information",
    path: "/api/webhooks/resend/information-agent",
    secret: "RESEND_WEBHOOK_SECRET",
    events: ["email.received"],
  },
];

export type WebhookStatus = {
  label: string;
  path: string;
  /** Secret de signature renseigné côté Immojudis (booléen). */
  secretConfigured: boolean;
  /** `unknown` : la liste des webhooks n'a pas pu être lue. */
  state: "ok" | "missing" | "disabled" | "events_missing" | "unknown";
  missingEvents: string[];
};

export type EmailAddressesReport = {
  checkedAt: string;
  addresses: EmailAddressRow[];
  secrets: SecretStatus[];
  resend: { ok: true; domains: ResendDomain[] } | { ok: false; failure: ResendFailure };
  webhooks: { ok: true; items: WebhookStatus[] } | { ok: false; failure: ResendFailure };
  dns: DomainDnsCheck[];
  /** Valeur à publier pour un DMARC absent. */
  dmarcRecommended: string;
  alerts: EmailAlert[];
};

const SECRET_PURPOSES: Record<EmailSecretVariable, string> = {
  RESEND_API_KEY: "Envoi des emails et lecture de cette page",
  RESEND_WEBHOOK_SECRET: "Signature des réponses reçues par l’agent",
  RESEND_ACCOUNT_WEBHOOK_SECRET: "Signature des rebonds et plaintes des comptes",
  INFORMATION_AGENT_PORTAL_SECRET: "Liens d’opposition et de dépôt de l’agent",
};

function webhookStatuses(
  webhooks: readonly ResendWebhook[],
  secrets: Record<EmailSecretVariable, boolean>,
): WebhookStatus[] {
  return EXPECTED_WEBHOOKS.map((expected) => {
    const found = webhooks.filter((webhook) => webhook.endpoint.endsWith(expected.path));
    const active = found.filter((webhook) => webhook.enabled);
    const covered = (event: string) =>
      active.some((webhook) => webhook.events === null || webhook.events.includes(event));
    const missingEvents = expected.events.filter((event) => !covered(event));
    const state: WebhookStatus["state"] =
      found.length === 0
        ? "missing"
        : active.length === 0
          ? "disabled"
          : missingEvents.length > 0
            ? "events_missing"
            : "ok";
    return {
      label: expected.label,
      path: expected.path,
      secretConfigured: secrets[expected.secret],
      state,
      missingEvents: state === "events_missing" || state === "missing" ? missingEvents : [],
    };
  });
}

/** Lignes dont le domaine doit exister chez Resend : les expéditeurs, pas le domaine de réception. */
function sendingRows(addresses: readonly EmailAddressRow[]): EmailAddressRow[] {
  return addresses.filter(
    (row) => row.domain && row.variable !== "INFORMATION_AGENT_INBOUND_DOMAIN",
  );
}

/** Adresse de rapports DMARC proposée : le contact publié, jamais une boîte inventée. */
function contactAddress(addresses: readonly EmailAddressRow[]): string | null {
  return addresses.find((row) => row.variable === "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL")?.value ?? null;
}

export function buildAlerts(input: {
  addresses: readonly EmailAddressRow[];
  resend: EmailAddressesReport["resend"];
  webhooks: EmailAddressesReport["webhooks"];
  dns: readonly DomainDnsCheck[];
}): EmailAlert[] {
  const alerts: EmailAlert[] = [];
  if (input.resend.ok) {
    const known = new Map(input.resend.domains.map((domain) => [domain.name, domain]));
    const reported = new Set<string>();
    for (const sender of sendingRows(input.addresses)) {
      const name = sender.domain as string;
      if (reported.has(name)) continue;
      reported.add(name);
      const domain = known.get(name);
      if (!domain) {
        alerts.push({
          id: `domain-missing-${name}`,
          severity: "error",
          message: `Le domaine ${name} (${sender.variable}) n’est pas déclaré chez Resend : l’envoi sera refusé.`,
        });
      } else if (domain.status !== "verified") {
        alerts.push({
          id: `domain-unverified-${name}`,
          severity: "error",
          message: `Le domaine ${name} n’est pas vérifié chez Resend (état : ${domain.status}).`,
        });
      }
    }
  }
  if (input.webhooks.ok) {
    for (const webhook of input.webhooks.items) {
      if (webhook.state === "ok") continue;
      const detail =
        webhook.state === "missing"
          ? "aucun webhook ne pointe vers cette route"
          : webhook.state === "disabled"
            ? "le webhook est désactivé"
            : `évènement(s) manquant(s) : ${webhook.missingEvents.join(", ")}`;
      alerts.push({
        id: `webhook-${webhook.path}`,
        severity: "error",
        message: `${webhook.label} : ${detail}.`,
      });
    }
  }
  const inbound = input.addresses.find(
    (row) => row.variable === "INFORMATION_AGENT_INBOUND_DOMAIN",
  );
  for (const check of input.dns) {
    if (check.mx?.status === "absent" && check.domain === inbound?.value) {
      alerts.push({
        id: `mx-${check.domain}`,
        severity: "error",
        message: `Le domaine de réception ${check.domain} n’a aucun enregistrement MX : les réponses à l’agent n’arrivent pas.`,
      });
    }
    if (check.dmarc.status === "absent" && check.domain !== inbound?.value) {
      alerts.push({
        id: `dmarc-${check.domain}`,
        severity: "error",
        message: `Aucun DMARC publié pour ${check.domain}. Valeur recommandée pour _dmarc.${check.domain} : ${recommendedDmarc(contactAddress(input.addresses))}`,
      });
    }
  }
  return alerts;
}

async function computeReport(deps: {
  env: EmailAddressEnv;
  secrets: Record<EmailSecretVariable, boolean>;
  apiKey: string | null;
  fetchImpl: typeof fetch;
  resolver?: DnsResolver;
  now: Date;
}): Promise<EmailAddressesReport> {
  const addresses = buildAddressRows(deps.env, EMAIL_TEMPLATES);
  const senderDomains = sendingRows(addresses).map((row) => row.domain as string);
  const inbound = addresses.find((row) => row.variable === "INFORMATION_AGENT_INBOUND_DOMAIN");

  // Resend (deux lectures, l'une après l'autre : limite de débit) et DNS public en parallèle.
  const [resendPart, dns] = await Promise.all([
    (async () => {
      const domains = await fetchResendDomains(deps.apiKey, deps.fetchImpl);
      const hooks = await fetchResendWebhooks(deps.apiKey, deps.fetchImpl);
      return { domains, hooks };
    })(),
    checkDomainDns(senderDomains, inbound?.domain ?? null, deps.resolver),
  ]);

  const resend: EmailAddressesReport["resend"] = resendPart.domains.ok
    ? { ok: true, domains: resendPart.domains.data }
    : { ok: false, failure: resendPart.domains.failure };
  const webhooks: EmailAddressesReport["webhooks"] = resendPart.hooks.ok
    ? { ok: true, items: webhookStatuses(resendPart.hooks.data, deps.secrets) }
    : { ok: false, failure: resendPart.hooks.failure };

  return {
    checkedAt: deps.now.toISOString(),
    addresses,
    secrets: EMAIL_SECRET_VARIABLES.map((name) => ({
      name,
      configured: deps.secrets[name],
      purpose: SECRET_PURPOSES[name],
    })),
    resend,
    webhooks,
    dns,
    dmarcRecommended: recommendedDmarc(contactAddress(addresses)),
    alerts: buildAlerts({ addresses, resend, webhooks, dns }),
  };
}

let cache: { at: number; report: EmailAddressesReport } | null = null;

/** Pour les tests : oublie le rapport en mémoire. */
export function resetEmailAddressesCache() {
  cache = null;
}

export async function getEmailAddressesReport({
  refresh = false,
  fetchImpl = fetch,
  resolver,
  now = new Date(),
}: {
  refresh?: boolean;
  fetchImpl?: typeof fetch;
  resolver?: DnsResolver;
  now?: Date;
} = {}): Promise<EmailAddressesReport> {
  const age = cache ? now.getTime() - cache.at : Infinity;
  if (cache && age < (refresh ? MIN_REFRESH_INTERVAL_MS : CACHE_TTL_MS)) return cache.report;
  const report = await computeReport({
    env: readEmailAddressEnv(),
    secrets: readEmailSecretsConfigured(),
    apiKey: readResendApiKey(),
    fetchImpl,
    resolver,
    now,
  });
  cache = { at: now.getTime(), report };
  return report;
}
