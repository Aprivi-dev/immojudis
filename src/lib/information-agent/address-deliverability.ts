import "server-only";
import { Resolver } from "node:dns/promises";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PublicApiError } from "@/lib/api-errors";
import {
  INFORMATION_AGENT_ADDRESS_HYGIENE_MESSAGES,
  informationAgentAddressHygieneIssue,
  mailDomainOf,
} from "@/lib/information-agent/address-hygiene";

/**
 * Contrôle de délivrabilité d'une adresse avant qu'elle soit proposée ou envoyée : hygiène (longueurs,
 * artefacts, domaines réservés), résolution MX puis A/AAAA du domaine, et rebonds passagers récents.
 *
 * - Domaine inexistant (NXDOMAIN) ou « null MX » (RFC 7505) : bloquant. Aucun serveur de messagerie ne
 *   répondra jamais.
 * - Erreur de résolution (SERVFAIL, délai dépassé) : NON bloquant. Une panne DNS passagère ne doit pas écarter
 *   une adresse valable ; le fournisseur d'envoi reste le dernier juge.
 * - Aucune sonde SMTP, aucun service tiers : seulement le DNS public.
 * - Cache de 24 h par domaine en mémoire du processus (un redémarrage le vide : il ne sert qu'à éviter de
 *   résoudre dix fois le même cabinet pendant un passage).
 * - Deux rebonds passagers sur 30 jours pour la même adresse (registre des contacts) : bloquant.
 *
 * Interrupteur de secours `INFORMATION_AGENT_ADDRESS_CHECK=off` (jamais activé en production ; la suite de
 * tests l'utilise pour ne pas résoudre ses domaines fictifs).
 */
export type MailDomainStatus = "ok" | "no_mail" | "unknown";
export type MailDomainResolver = {
  resolveMx: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
  resolveAddress: (domain: string) => Promise<string[]>;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Une panne DNS (« unknown ») est retenue 60 s : un domaine muet ne coûte pas un délai à chaque appel. */
const UNKNOWN_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;
/** Budget total pour MX, A et AAAA d'un domaine : le domaine vient d'une annonce, donc d'une source non fiable. */
const TOTAL_BUDGET_MS = 4_000;
const TEMPORARY_BOUNCE_LIMIT = 2;
const TEMPORARY_BOUNCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const cache = new Map<string, { status: MailDomainStatus; at: number }>();
/** Résolutions en cours par domaine : des appels simultanés partagent une seule résolution. */
const inFlight = new Map<string, Promise<MailDomainStatus>>();

export const INFORMATION_AGENT_NO_MAIL_DOMAIN_MESSAGE =
  "Le domaine de cette adresse ne reçoit pas de courrier (domaine inexistant ou sans serveur de messagerie).";
export const INFORMATION_AGENT_TEMPORARY_BOUNCES_MESSAGE =
  "Deux rebonds passagers en 30 jours pour cette adresse : elle n’est plus sollicitée.";

// Un serveur DNS muet ne doit pas bloquer la préparation ni l'envoi : 2 s par requête, un seul essai.
const dnsResolver = new Resolver({ timeout: 2_000, tries: 1 });
const defaultResolver: MailDomainResolver = {
  resolveMx: (domain) => dnsResolver.resolveMx(domain),
  resolveAddress: async (domain) => {
    const [v4, v6] = await Promise.allSettled([
      dnsResolver.resolve4(domain),
      dnsResolver.resolve6(domain),
    ]);
    const found = [
      ...(v4.status === "fulfilled" ? v4.value : []),
      ...(v6.status === "fulfilled" ? v6.value : []),
    ];
    if (found.length) return found;
    // Aucune adresse : on remonte la vraie erreur (NXDOMAIN ou NODATA), pas un tableau vide.
    const failure = v4.status === "rejected" ? v4.reason : new Error("ENODATA");
    throw failure;
  },
};

function errorCode(error: unknown): string {
  return String((error as { code?: unknown } | null)?.code ?? "");
}

async function resolveMailDomain(
  key: string,
  resolver: MailDomainResolver,
): Promise<MailDomainStatus> {
  try {
    const records = await resolver.resolveMx(key);
    // « Null MX » : un seul enregistrement dont l'hôte est vide ou « . ».
    if (
      records.length > 0 &&
      records.every((record) => !record.exchange || record.exchange === ".")
    ) {
      return "no_mail";
    }
    if (records.length > 0) return "ok";
  } catch (error) {
    // NXDOMAIN : le domaine n'existe pas. NODATA : pas de MX, on tente l'adresse A/AAAA (MX implicite).
    if (errorCode(error) === "ENOTFOUND") return "no_mail";
    if (errorCode(error) !== "ENODATA") return "unknown";
  }
  try {
    const addresses = await resolver.resolveAddress(key);
    return addresses.length > 0 ? "ok" : "no_mail";
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOTFOUND" || code === "ENODATA" ? "no_mail" : "unknown";
  }
}

export async function checkMailDomain(
  domain: string,
  deps: { resolver?: MailDomainResolver; now?: number; budgetMs?: number } = {},
): Promise<MailDomainStatus> {
  const key = domain.trim().toLowerCase().replace(/\.$/, "");
  const now = deps.now ?? Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < (cached.status === "unknown" ? UNKNOWN_TTL_MS : CACHE_TTL_MS)) {
    return cached.status;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const budgetMs = deps.budgetMs ?? TOTAL_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resolution = Promise.race([
    resolveMailDomain(key, deps.resolver ?? defaultResolver),
    new Promise<MailDomainStatus>((resolve) => {
      timer = setTimeout(() => resolve("unknown"), budgetMs);
    }),
  ])
    .catch((): MailDomainStatus => "unknown")
    .then((status) => {
      if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(key, { status, at: now });
      return status;
    })
    .finally(() => {
      clearTimeout(timer);
      inFlight.delete(key);
    });
  inFlight.set(key, resolution);
  return resolution;
}

/** Vide le cache (tests). */
export function clearMailDomainCache(): void {
  cache.clear();
  inFlight.clear();
}

export function informationAgentAddressCheckEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  // En production le contrôle ne se coupe pas : l'interrupteur ne sert qu'aux essais automatisés.
  if (env.VERCEL_ENV === "production") return true;
  return env.INFORMATION_AGENT_ADDRESS_CHECK !== "off";
}

/** Rebonds passagers de l'adresse sur 30 jours, lus dans le registre des contacts (`metadata.temporary_bounces`). */
export async function countRecentTemporaryBounces(
  email: string,
  now = new Date(),
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_contacts")
    .select("metadata")
    .is("scope_sale_id", null)
    .eq("normalized_email", email.trim().toLowerCase())
    .maybeSingle();
  if (error) throw error;
  const dates = (data?.metadata as { temporary_bounces?: unknown } | null)?.temporary_bounces;
  return (Array.isArray(dates) ? dates : []).filter(
    (value) =>
      typeof value === "string" && now.getTime() - Date.parse(value) < TEMPORARY_BOUNCE_WINDOW_MS,
  ).length;
}

export type AddressDeliverabilityDeps = {
  env?: Readonly<Record<string, string | undefined>>;
  resolver?: MailDomainResolver;
  countTemporaryBounces?: (email: string) => Promise<number>;
};

/**
 * Lève une erreur au motif lisible si l'adresse est inutilisable. Une lecture impossible du registre des contacts
 * ne bloque pas (le compteur est un complément).
 */
export async function assertInformationAgentAddressDeliverable(
  email: string,
  deps: AddressDeliverabilityDeps = {},
): Promise<void> {
  if (!informationAgentAddressCheckEnabled(deps.env ?? process.env)) return;
  const issue = informationAgentAddressHygieneIssue(email);
  if (issue) throw new PublicApiError(INFORMATION_AGENT_ADDRESS_HYGIENE_MESSAGES[issue], 400);
  const status = await checkMailDomain(mailDomainOf(email), { resolver: deps.resolver });
  if (status === "no_mail") throw new PublicApiError(INFORMATION_AGENT_NO_MAIL_DOMAIN_MESSAGE, 400);
  let bounces: number;
  try {
    bounces = await (deps.countTemporaryBounces ?? countRecentTemporaryBounces)(email);
  } catch {
    return;
  }
  if (bounces >= TEMPORARY_BOUNCE_LIMIT) {
    throw new PublicApiError(INFORMATION_AGENT_TEMPORARY_BOUNCES_MESSAGE, 409);
  }
}
