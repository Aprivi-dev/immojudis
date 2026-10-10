import { findCnbBarAssociation } from "@/lib/cnb-directory";
import { normalizeBarKey } from "@/lib/cnb-open-data";

/**
 * Bar-association rules for lawyer suggestions (plan P4-13). Only a lawyer registered at the bar of
 * the tribunal judiciaire that holds the sale may be proposed, and never the lawyer who is
 * prosecuting the sale (conflict of interest). No postal-code, city or department fallback.
 */

export function resolveCnbDatasetBarKey(value: string | null | undefined): string | null {
  const officialBar = findCnbBarAssociation(value);
  const datasetLabel = officialBar?.label.replace(/\s*\([^)]+\)\s*/g, " ") ?? value;
  const normalized = normalizeBarKey(datasetLabel);
  if (normalized === "thonon les bains du leman et du genevois") {
    return "thonon les bains leman et genevois";
  }
  return normalized;
}

/**
 * Bar of a "Tribunal judiciaire de X" (or "TJ de X", former TGI) label. Returns null when the label
 * does not name the seat: the sale's own city is deliberately NOT used as a fallback.
 */
export function tribunalBarAssociation(tribunal: string | null | undefined): string | null {
  const label = tribunal?.trim();
  if (!label) return null;
  const match = label.match(
    /(?:tribunal\s+(?:judiciaire|de\s+grande\s+instance)|\btj\b|\btgi\b)\s+(?:de\s+|du\s+|des\s+|d[’']\s*)?([^,;()]+?)(?:\s*[-–—]|$)/i,
  );
  const city = match?.[1]?.replace(/\s+/g, " ").trim();
  return city ? city : null;
}

export function isSameBar(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftKey = resolveCnbDatasetBarKey(left);
  const rightKey = resolveCnbDatasetBarKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

const TITLE_WORDS =
  /\b(?:ma[iî]tres?|mes|me|mme|madame|monsieur|mr|m|cabinet|selarl|selas|scp|aarpi|sarl|sas|associ[ée]s?|avocats?|et|&)\b/g;

function normalizeLawyerIdentity(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(TITLE_WORDS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True when a candidate lawyer is (or belongs to the firm of) the lawyer named on the sale as the
 * prosecuting party. Comparison ignores titles, accents, order of words and legal-form words.
 */
export function isProsecutingLawyer(
  candidate: { displayName?: string | null; firmName?: string | null },
  prosecutingLawyerName: string | null | undefined,
): boolean {
  const prosecuting = normalizeLawyerIdentity(prosecutingLawyerName);
  if (prosecuting.length < 4) return false;
  const prosecutingTokens = new Set(prosecuting.split(" ").filter((token) => token.length > 1));
  return [candidate.displayName, candidate.firmName].some((name) => {
    const normalized = normalizeLawyerIdentity(name);
    if (normalized.length < 4) return false;
    if (normalized === prosecuting) return true;
    if (normalized.includes(prosecuting) || prosecuting.includes(normalized)) return true;
    const tokens = normalized.split(" ").filter((token) => token.length > 1);
    return (
      tokens.length >= 2 &&
      tokens.every((token) => prosecutingTokens.has(token)) &&
      prosecutingTokens.size <= tokens.length + 1
    );
  });
}

/** Eligibility of one lawyer for one sale: same bar as the tribunal, not the prosecuting lawyer. */
export function isLawyerEligibleForSale({
  lawyer,
  saleBar,
  prosecutingLawyerName,
}: {
  lawyer: {
    displayName?: string | null;
    firmName?: string | null;
    barAssociation?: string | null;
  };
  saleBar: string | null;
  prosecutingLawyerName: string | null | undefined;
}): boolean {
  if (!saleBar) return false;
  if (!isSameBar(lawyer.barAssociation, saleBar)) return false;
  return !isProsecutingLawyer(lawyer, prosecutingLawyerName);
}
