export type TribunalListingEvidence = {
  publicationAt: string | null;
  publicationKind: "source_explicit" | "legal_notice" | null;
  overbidStatus: "filed" | "not_filed" | null;
  overbidEvidence: string[];
  procedureConflict: boolean;
};

const SOURCE_PUBLICATION_KEYS = new Set([
  "sourcepublishedat",
  "sourcepublisheddate",
  "sourcepublicationat",
  "sourcepublicationdate",
]);

const OVERBID_STATUS_KEYS = new Set([
  "overbidstatus",
  "overbid_status",
  "surencherestatus",
  "surenchere_status",
]);

const FRENCH_MONTHS: Record<string, number> = {
  janvier: 1,
  janv: 1,
  fevrier: 2,
  fevr: 2,
  mars: 3,
  avril: 4,
  avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  juil: 7,
  aout: 8,
  septembre: 9,
  sept: 9,
  octobre: 10,
  oct: 10,
  novembre: 11,
  nov: 11,
  decembre: 12,
  dec: 12,
};

const LICITOR_PUBLICATION_LABEL = /annonce\s+publiee\s+le\b/gi;
const PETITES_AFFICHES_PUBLICATION_LABEL = /pub\s*\.?\s+legale\b/gi;

const POSITIVE_OVERBID_PATTERNS = [
  /vente\s+sur\s+surenchere\b/i,
  /surenchere\s+(?:a\s+ete|est|a)\s+(?:deposee|formee|introduite|enregistree)\b/i,
  /surenchere\s+(?:deposee|formee|introduite|enregistree)\b/i,
];

const NEGATIVE_OVERBID_PATTERNS = [
  /(?:pas\s+de|aucune|absence\s+de|sans)\s+surenchere\b/i,
  /surenchere\s+non\s+(?:deposee|formee|introduite|enregistree)\s*\b/i,
  /surenchere\s+n['’]?(?:a|est)\s+pas\s+(?:ete\s+)?(?:deposee|formee|introduite|enregistree)\b/i,
];

/**
 * Extract only source-backed facts that are safe to use in the tribunal
 * listing statistics inventory. Internal collection timestamps are
 * deliberately ignored: they are not publication dates.
 */
export function extractTribunalListingEvidence(
  raw: unknown,
  sourceName: string | null,
): TribunalListingEvidence {
  const textEntries = collectSourceText(raw);
  const source = normalizeSourceName(sourceName);
  const publication = extractPublication(raw, textEntries, source);
  const overbid = extractOverbid(raw, textEntries);

  return {
    publicationAt: publication?.at ?? null,
    publicationKind: publication?.kind ?? null,
    overbidStatus: overbid.status,
    overbidEvidence: overbid.evidence,
    procedureConflict: hasProcedureConflict(textEntries),
  };
}

function extractPublication(
  raw: unknown,
  textEntries: string[],
  source: string,
): { at: string; kind: "source_explicit" | "legal_notice" } | null {
  if (isLicitorSource(source)) {
    const date = findDateAfterLabel(textEntries, LICITOR_PUBLICATION_LABEL);
    if (date) return { at: date, kind: "source_explicit" };
  }

  if (isPetitesAffichesSource(source)) {
    const date = findDateAfterLabel(textEntries, PETITES_AFFICHES_PUBLICATION_LABEL);
    if (date) return { at: date, kind: "legal_notice" };
  }

  if (isAvoVentesSource(source)) {
    const date = findExplicitSourcePublicationDate(raw);
    if (date) return { at: date, kind: "source_explicit" };
  }

  return null;
}

function findDateAfterLabel(textEntries: string[], label: RegExp): string | null {
  const candidates = [...textEntries, textEntries.join("\n")];
  for (const entry of candidates) {
    const normalized = normalizeForMatching(entry);
    label.lastIndex = 0;
    let match = label.exec(normalized);
    while (match) {
      const tail = normalized.slice(
        match.index + match[0].length,
        match.index + match[0].length + 140,
      );
      const date = isGenericPublicationContext(normalized, match.index)
        ? null
        : findDateImmediatelyAfterLabel(tail);
      if (date) return date;
      match = label.exec(normalized);
    }
  }
  return null;
}

function findDateImmediatelyAfterLabel(value: string): string | null {
  const tail = value.replace(/^[\s:;,()[\]-]+/, "");
  const patterns = [
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[tT][0-9:.+-]+(?:[zZ]|[+-]\d{2}:?\d{2})?)?\b/,
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/,
    /^(?:1er|\d{1,2})\s+[a-z.]+\s+\d{4}\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(tail);
    if (!match) continue;
    const date = parseCivilDate(match[0]);
    if (date) return date;
  }
  return null;
}

function isGenericPublicationContext(text: string, index: number): boolean {
  const context = text.slice(Math.max(0, index - 90), index);
  return /\b(?:immojudis|actualite|actualites|news|article)\b/i.test(context);
}

function findExplicitSourcePublicationDate(raw: unknown): string | null {
  const values: string[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, path: string[]) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, path);
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = normalizeKey(key);
      const childPath = [...path, normalizedKey];
      if (SOURCE_PUBLICATION_KEYS.has(normalizedKey) && !hasInternalDateContainer(path)) {
        if (typeof child === "string") values.push(child);
        continue;
      }
      visit(child, childPath);
    }
  };

  visit(raw, []);
  for (const value of values) {
    const parsed = parseStructuredCivilDate(value);
    if (parsed) return parsed;
  }
  return null;
}

function parseStructuredCivilDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(trimmed);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (!civilDate(year, month, day)) return null;
    if (!isoMatch[4]) return civilDate(year, month, day);
    const parsed = new Date(trimmed);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  return parseCivilDate(trimmed);
}

function parseCivilDate(value: string): string | null {
  const trimmed = value.trim();
  const isoMatch = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[tT].*)?$/.exec(trimmed);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (!civilDate(year, month, day)) return null;
    if (!/[tT]/.test(trimmed)) return civilDate(year, month, day);
    const parsed = new Date(trimmed);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  const numericMatch = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(trimmed);
  if (numericMatch) {
    return civilDate(Number(numericMatch[3]), Number(numericMatch[2]), Number(numericMatch[1]));
  }

  const frenchMatch = /^(1er|\d{1,2})\s+([a-z.]+)\s+(\d{4})$/i.exec(normalizeForMatching(trimmed));
  if (!frenchMatch) return null;
  const month = FRENCH_MONTHS[frenchMatch[2].replace(/\.$/, "")];
  if (!month) return null;
  const day = frenchMatch[1] === "1er" ? 1 : Number(frenchMatch[1]);
  return civilDate(Number(frenchMatch[3]), month, day);
}

function civilDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return candidate.toISOString();
}

function extractOverbid(
  raw: unknown,
  textEntries: string[],
): { status: "filed" | "not_filed" | null; evidence: string[] } {
  const textFacts = findTextOverbidFacts(textEntries);
  if (textFacts.status) return textFacts;

  const structured = findStructuredOverbidStatus(raw);
  if (!structured) return textFacts;
  return structured;
}

function findTextOverbidFacts(textEntries: string[]): {
  status: "filed" | "not_filed" | null;
  evidence: string[];
} {
  const positive: string[] = [];
  const negative: string[] = [];

  for (const entry of textEntries) {
    const normalized = normalizeForMatching(entry);
    for (const pattern of POSITIVE_OVERBID_PATTERNS) {
      const match = pattern.exec(normalized);
      if (!match) continue;
      if (
        !isStrongPositiveOverbidFact(match[0]) &&
        isLegalOverbidWindowNote(normalized, match.index)
      ) {
        continue;
      }
      positive.push(evidenceSnippet(entry, normalized, match.index, match[0].length));
    }
    for (const pattern of NEGATIVE_OVERBID_PATTERNS) {
      const match = pattern.exec(normalized);
      if (!match) continue;
      if (isLegalOverbidWindowNote(normalized, match.index)) continue;
      negative.push(evidenceSnippet(entry, normalized, match.index, match[0].length));
    }
  }

  const evidence = uniqueEvidence([...positive, ...negative]);
  if (positive.length) return { status: "filed", evidence };
  if (negative.length) return { status: "not_filed", evidence };
  return { status: null, evidence: [] };
}

function isStrongPositiveOverbidFact(match: string): boolean {
  return /vente\s+sur\s+surenchere|(?:a\s+ete|a)\s+(?:deposee|formee|introduite|enregistree)/i.test(
    match,
  );
}

/*
 * A phrase explaining the legal mechanism is not an observed overbid. In
 * particular, “la surenchère est formée par acte d’avocat” describes the
 * procedure and must stay unknown.
 */
function isLegalOverbidWindowNote(text: string, index: number): boolean {
  const context = text.slice(Math.max(0, index - 100), Math.min(text.length, index + 160));
  return /\b(?:delai\s+legal|delai|faculte|peut|pourra|doit|possible|dans\s+les|sous\s+les?|par\s+acte|acte\s+d['’]avocat)\b/i.test(
    context,
  );
}

function findStructuredOverbidStatus(
  raw: unknown,
): { status: "filed" | "not_filed"; evidence: string[] } | null {
  const values: Array<{ key: string; value: unknown }> = [];
  const seen = new Set<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = normalizeKey(key);
      if (OVERBID_STATUS_KEYS.has(normalizedKey)) values.push({ key, value: child });
      visit(child);
    }
  };
  visit(raw);

  for (const candidate of values) {
    const status = normalizeOverbidStatus(candidate.value);
    if (!status) continue;
    const printable =
      typeof candidate.value === "string" || typeof candidate.value === "number"
        ? String(candidate.value)
        : JSON.stringify(candidate.value);
    return {
      status,
      evidence: [`${candidate.key}: ${printable ?? status}`],
    };
  }
  return null;
}

function normalizeOverbidStatus(value: unknown): "filed" | "not_filed" | null {
  if (value === true) return "filed";
  if (value === false) return "not_filed";
  if (typeof value !== "string") return null;
  const normalized = normalizeKey(value);
  if (["filed", "observed", "surencherefiled", "overbidfiled"].includes(normalized)) {
    return "filed";
  }
  if (
    ["notfiled", "none", "deadlineexpired", "nosurenchere", "surencherenotfiled"].includes(
      normalized,
    )
  ) {
    return "not_filed";
  }
  return null;
}

function evidenceSnippet(
  original: string,
  normalized: string,
  index: number,
  length: number,
): string {
  const lines = original
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const phrase = normalized.slice(index, index + length);
  const line = lines.find((candidate) => normalizeForMatching(candidate).includes(phrase));
  if (line) return line.slice(0, 320);

  const approximateIndex = Math.min(original.length, index);
  const start = Math.max(0, approximateIndex - 100);
  const end = Math.min(original.length, approximateIndex + length + 100);
  return original.slice(start, end).trim().replace(/\s+/g, " ").slice(0, 320);
}

function hasProcedureConflict(textEntries: string[]): boolean {
  const normalized = normalizeForMatching(textEntries.join("\n"));
  const notariale = /type\s+de\s+vente\s*[:-]?\s*notariale\b/i.test(normalized);
  if (!notariale) return false;
  const knownTribunal =
    /\btribunal\s+(?:judiciaire|de\s+grande\s+instance|de\s+[a-z][a-z' -]+)\b/i.test(normalized) ||
    /\btj\s+[a-z][a-z' -]+\b/i.test(normalized);
  return knownTribunal;
}

function collectSourceText(raw: unknown): string[] {
  const values: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, key: string, sourceContainer: boolean) => {
    if (typeof value === "string") {
      if (!key || sourceContainer || isEvidenceTextKey(key)) values.push(value.trim());
      return;
    }
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, sourceContainer);
      return;
    }
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = normalizeKey(childKey);
      if (isIgnoredMetadataKey(normalizedKey)) continue;
      const childIsSourceContainer =
        sourceContainer ||
        ["sourceblocks", "sourcelots", "rawpayload", "sourceevidence"].includes(normalizedKey);
      if (
        childIsSourceContainer ||
        isEvidenceTextKey(normalizedKey) ||
        isEvidenceContainer(normalizedKey)
      ) {
        visit(child, normalizedKey, childIsSourceContainer);
      }
    }
  };

  visit(raw, "", false);
  return [...new Set(values.filter(Boolean))];
}

function isEvidenceContainer(key: string): boolean {
  return ["sourceblocks", "sourcelots", "rawpayload", "sourceevidence", "data", "payload"].includes(
    key,
  );
}

function isEvidenceTextKey(key: string): boolean {
  return /(?:rawtext|sourcetext|sourcedescription|sourcetitle|pagetext|detailtext|detailtitle|titredetail|title|description|text|texte|tribunal|court|typedevente|typevente|saletype|venue|procedure|surench|overbid|lot)/i.test(
    key,
  );
}

function isIgnoredMetadataKey(key: string): boolean {
  return /(?:created|updated|discovered|firstseen|captured|internal|document|publication|published|sourcepublished|sourcepublication|url|href|uuid|hash|fingerprint|timestamp|^id$|_id$|status$|latitude|longitude|^date$|_date$|^at$|_at$)/i.test(
    key,
  );
}

function hasInternalDateContainer(path: string[]): boolean {
  return path.some((key) => /(?:document|internal|collection|immojudis|news|court)/i.test(key));
}

function normalizeSourceName(value: string | null): string {
  return value ? normalizeKey(value) : "";
}

function isLicitorSource(value: string): boolean {
  return value.includes("licitor");
}

function isPetitesAffichesSource(value: string): boolean {
  return value.includes("petitesaffiches") || value.includes("petitesaffiche");
}

function isAvoVentesSource(value: string): boolean {
  return value.includes("avoventes") || value.includes("avovente");
}

function normalizeKey(value: string): string {
  return normalizeForMatching(value).replace(/[^a-z0-9]+/g, "");
}

function normalizeForMatching(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueEvidence(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
