import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  isInformationAgentExcludedAddress,
  isInformationAgentExcludedSourceUrl,
} from "@/lib/information-agent/excluded-addresses";
import { normalizeInformationAgentIdentityName } from "@/lib/information-agent/identity";
import { normalizedEmail } from "@/lib/information-agent/contacts";
import { emailRecallsName, isGenericEmailLocal } from "@/lib/information-agent/firm-site-extract";
import { isWithdrawnSourceUrl } from "@/lib/withdrawn-sources";

/**
 * Réemploi d'une adresse déjà publiée par le même professionnel sur une AUTRE annonce en base
 * (niveau 1, source A). Trois conditions cumulatives :
 * - même identité professionnelle : nom et au moins un autre jeton du nom, normalisés comme les
 *   clés d'opposition (`identity.ts`) ;
 * - même numéro de téléphone (normalisé) ; sans téléphone des deux côtés, pas de réemploi ;
 * - annonce d'origine récente : date de vente ou de dernière observation de moins de 6 mois.
 * Plusieurs adresses différentes chez les annonces concordantes : ambiguïté, rien n'est retenu.
 */

export const ADDRESS_REUSE_MAX_AGE_MONTHS = 6;
const MAX_ROWS = 200;
const MAX_PHONES = 3;
/** Durée maximale de la lecture en base quand l'appelant ne fixe pas de budget. */
const DEFAULT_READ_TIMEOUT_MS = 8_000;

/** Numéros français : `01 23 45 67 89`, `01.23.45.67.89`, `+33 1 23 45 67 89`, `+33 (0)1…`. */
const FRENCH_PHONE =
  /(?<!\d)(?:(?:\+|00)33[\s.-]?\(?0?\)?[\s.-]?|0)([1-9])((?:[\s.-]?\d{2}){4})(?!\d)/g;
/** Les télécopies ne comptent pas comme un numéro de ligne du professionnel. */
const FAX_SEGMENT = /fax\s*:?\s*[+\d(][\d\s.()+-]{7,}/gi;

/** Numéros de téléphone français distincts d'un texte, sous la forme `0XXXXXXXXX`. */
export function normalizedFrenchPhones(text: string | null | undefined): string[] {
  if (!text) return [];
  const numbers = new Set<string>();
  for (const match of text.replace(FAX_SEGMENT, " ").matchAll(FRENCH_PHONE)) {
    numbers.add(`0${match[1]}${(match[2] ?? "").replace(/\D/g, "")}`);
  }
  return [...numbers];
}

function nameTokens(name: string | null | undefined): string[] {
  const normalized = normalizeInformationAgentIdentityName(name);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Même professionnel : au moins deux jetons de nom (nom de famille et un autre jeton) et des
 * ensembles de jetons ÉGAUX, titres et formes sociales ôtés (« Jean Dupont » = « Me DUPONT Jean »).
 * « Jean Dupont » n'est donc pas « Jean-Louis Dupont ». Un nom d'un seul jeton ne suffit jamais.
 */
export function isSameInformationAgentProfessional(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length < 2 || b.length < 2) return false;
  return a.length === b.length && a.every((token) => b.includes(token));
}

export function addressReuseCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - ADDRESS_REUSE_MAX_AGE_MONTHS);
  return cutoff;
}

function parsedDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Date de référence d'une annonce : la plus récente de sa date de vente et de sa dernière
 * observation. Une vente à venir est donc récente.
 */
export function listingReferenceTime(row: {
  sale_date?: string | null;
  last_seen_at?: string | null;
}): number | null {
  const times = [parsedDate(row.sale_date), parsedDate(row.last_seen_at)].filter(
    (time): time is number => time !== null,
  );
  return times.length ? Math.max(...times) : null;
}

const EMAIL_IN_TEXT = /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

function publishedEmails(text: string | null | undefined): string[] {
  const emails = new Set<string>();
  for (const match of (text ?? "").matchAll(EMAIL_IN_TEXT)) {
    const email = normalizedEmail(match[0]);
    // Les adresses de juridiction, RPVA, Ordre, CARPA et techniques ne sont jamais réemployées.
    if (email && !isInformationAgentExcludedAddress(email)) emails.add(email);
  }
  return [...emails];
}

export type ReusableAddressRow = {
  id: string;
  source_name: string | null;
  source_url: string | null;
  sale_date: string | null;
  last_seen_at: string | null;
  lawyer_name: string | null;
  lawyer_contact: string | null;
};

export type ReusableAddress = {
  email: string;
  /** Annonce d'origine la plus récente qui publie cette adresse. */
  listing: { saleId: string; sourceName: string | null; sourceUrl: string; referenceAt: string };
  /** Nom du professionnel tel que l'annonce d'origine l'imprime (clés d'opposition). */
  listingLawyerName: string | null;
};

export type AddressReuseResult =
  | { status: "found"; address: ReusableAddress }
  | { status: "none"; reason: "no_name" | "no_phone" | "no_match" | "truncated" }
  | { status: "ambiguous" };

/**
 * Parmi des annonces déjà lues, l'adresse qu'une annonce récente du même professionnel (même nom,
 * même téléphone) publie. Fonction pure : `findReusableInformationAgentAddress` lit la base.
 */
export function selectReusableAddress({
  lawyerName,
  lawyerContact,
  rows,
  saleId,
  now,
}: {
  lawyerName: string | null | undefined;
  lawyerContact: string | null | undefined;
  rows: readonly ReusableAddressRow[];
  saleId: string;
  now: Date;
}): AddressReuseResult {
  if (nameTokens(lawyerName).length < 2) return { status: "none", reason: "no_name" };
  const phones = new Set(normalizedFrenchPhones(lawyerContact));
  if (!phones.size) return { status: "none", reason: "no_phone" };
  const cutoff = addressReuseCutoff(now).getTime();

  const byEmail = new Map<string, ReusableAddress & { time: number }>();
  for (const row of rows) {
    if (row.id === saleId) continue;
    const time = listingReferenceTime(row);
    if (time === null || time < cutoff) continue;
    if (!isSameInformationAgentProfessional(lawyerName, row.lawyer_name)) continue;
    if (!normalizedFrenchPhones(row.lawyer_contact).some((phone) => phones.has(phone))) continue;
    // La page d'origine est citée dans le message : https, publique, jamais une source exclue.
    const sourceUrl = row.source_url?.trim() ?? "";
    if (!/^https:\/\/[^\s]+$/i.test(sourceUrl)) continue;
    if (isInformationAgentExcludedSourceUrl(sourceUrl) || isWithdrawnSourceUrl(sourceUrl)) continue;
    for (const email of publishedEmails(row.lawyer_contact)) {
      // La partie locale rappelle le nom du professionnel (segments entiers) ou est celle du cabinet.
      const recalls =
        emailRecallsName(email, lawyerName) || emailRecallsName(email, row.lawyer_name);
      if (!recalls && !isGenericEmailLocal(email)) continue;
      const current = byEmail.get(email);
      if (current && current.time >= time) continue;
      byEmail.set(email, {
        email,
        time,
        listingLawyerName: row.lawyer_name,
        listing: {
          saleId: row.id,
          sourceName: row.source_name,
          sourceUrl,
          referenceAt: new Date(time).toISOString(),
        },
      });
    }
  }
  if (byEmail.size === 0) return { status: "none", reason: "no_match" };
  if (byEmail.size > 1) return { status: "ambiguous" };
  const [match] = [...byEmail.values()];
  if (!match) return { status: "none", reason: "no_match" };
  const { email, listing, listingLawyerName } = match;
  const address: ReusableAddress = { email, listing, listingLawyerName };
  return { status: "found", address };
}

/** Motif de recherche SQL souple : les quatre dernières paires de chiffres, séparateurs libres. */
export function phoneLikePattern(phone: string): string {
  const digits = phone.slice(-8);
  return `%${digits.slice(0, 2)}%${digits.slice(2, 4)}%${digits.slice(4, 6)}%${digits.slice(6, 8)}%`;
}

/**
 * Cherche en base les annonces récentes qui portent le même téléphone, puis garde celles du même
 * professionnel. Le filtre SQL ne fait que réduire la lecture ; l'identité, le téléphone exact et
 * la date sont revérifiés ici. Une erreur de base est propagée (un contrôle indisponible ne vaut
 * pas autorisation).
 */
export async function findReusableInformationAgentAddress({
  saleId,
  lawyerName,
  lawyerContact,
  now = new Date(),
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
}: {
  saleId: string;
  lawyerName: string | null | undefined;
  lawyerContact: string | null | undefined;
  now?: Date;
  /** Temps imparti à la lecture, pris sur le budget de la recherche. */
  timeoutMs?: number;
}): Promise<AddressReuseResult> {
  if (nameTokens(lawyerName).length < 2) return { status: "none", reason: "no_name" };
  const phones = normalizedFrenchPhones(lawyerContact).slice(0, MAX_PHONES);
  if (!phones.length) return { status: "none", reason: "no_phone" };
  const since = addressReuseCutoff(now).toISOString();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Lecture des annonces du professionnel trop longue.")),
      Math.max(1, timeoutMs),
    );
  });
  const results = await Promise.race([
    Promise.all(
      phones.map((phone) =>
        supabaseAdmin
          .from("auction_sales")
          .select("id,source_name,source_url,sale_date,last_seen_at,lawyer_name,lawyer_contact")
          .neq("id", saleId)
          .eq("catalogue_quarantined", false)
          .ilike("lawyer_contact", phoneLikePattern(phone))
          .or(`last_seen_at.gte.${since},sale_date.gte.${since}`)
          .order("last_seen_at", { ascending: false, nullsFirst: false })
          .limit(MAX_ROWS),
      ),
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
  const rows = new Map<string, ReusableAddressRow>();
  for (const { data, error } of results) {
    if (error) throw error;
    if (!data) throw new Error("Annonces du professionnel indisponibles.");
    // Une lecture tronquée peut cacher une seconde adresse : on ne réemploie rien (et on le dit).
    if (data.length >= MAX_ROWS) {
      console.warn(
        JSON.stringify({
          scope: "information-agent.address-reuse",
          event: "rows_truncated",
          limit: MAX_ROWS,
        }),
      );
      return { status: "none", reason: "truncated" };
    }
    for (const row of data) rows.set(row.id, row);
  }
  return selectReusableAddress({
    lawyerName,
    lawyerContact,
    rows: [...rows.values()],
    saleId,
    now,
  });
}
