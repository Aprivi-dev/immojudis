import type {
  LandProviderOptions,
  LandPlanningDocument,
  LandPlanningResult,
  LandRuleEvidence,
  LandRulesResult,
  LandSourceCheck,
  LandSourceStatus,
} from "./land-report-types";

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_HTML_REDIRECT_BYTES = 512 * 1024;
const MAX_SNIPPET_LENGTH = 1_200;
const MAX_SNIPPET_CONTEXT_LINES = 16;
const TRUNCATED_SNIPPET_MARKER = "[extrait tronqué – consulter la page]";
const OFFICIAL_HOSTS = new Set([
  "geoportail-urbanisme.gouv.fr",
  "www.geoportail-urbanisme.gouv.fr",
  "data.geopf.fr",
]);

export type LandPdfPageText = {
  page: number;
  gpuPage?: number | null;
  text: string;
};

export type LandRuleExtractionInput = {
  documentId: string;
  documentName: string;
  sourceUrl: string;
  targetZoneLabels: string[];
  pages: LandPdfPageText[];
  totalPages?: number | null;
  /** Set only when the caller has deliberately selected a complete document range. */
  coverageComplete?: boolean;
  checkedAt?: string;
  version?: string | null;
};

type PdfSource = {
  url: string;
  documentId: string;
  documentName: string;
  zoneLabels: string[];
  startPage: number | null;
  version: string | null;
};

type DownloadedPdf = {
  bytes: Uint8Array;
  sourceUrl: string;
};

type PdfPageExtraction = {
  pages: LandPdfPageText[];
  totalPages: number;
  firstPage: number;
  lastPage: number;
};

type RuleTopicDefinition = {
  topic: LandRuleEvidence["topic"];
  label: string;
  patterns: RegExp[];
};

const TOPICS: RuleTopicDefinition[] = [
  {
    topic: "destination",
    label: "Destination et sous-destination",
    patterns: [
      /\bdestination(?:s)?\b/iu,
      /\bsous[- ]destination(?:s)?\b/iu,
      /\bhabitation\b/iu,
      /\bcommerce(?:s)?\b/iu,
      /\bartisanat\b/iu,
      /\béquipement(?:s)?\s+public(?:s)?\b/iu,
    ],
  },
  {
    topic: "footprint",
    label: "Emprise au sol",
    patterns: [/\bemprise(?:s)?\s+au\s+sol\b/iu, /\bcoefficient\s+d['’]?emprise\b/iu],
  },
  {
    topic: "height",
    label: "Hauteur et niveaux",
    patterns: [
      /\bhauteur(?:s)?\b/iu,
      /\bnive(?:au|aux)\b/iu,
      /\bR\s*\+\s*\d\b/iu,
      /\bfa(?:î|i)tage\b/iu,
      /\b(?:égout|acrotère)\b/iu,
    ],
  },
  {
    topic: "setbacks",
    label: "Implantation et reculs",
    patterns: [
      /\bimplantation\b/iu,
      /\brecul(?:s)?\b/iu,
      /\blimite(?:s)?\s+(?:séparative|parcellaire|de propriété)\b/iu,
      /\balignement\b/iu,
      /\bdistance(?:s)?\s+(?:aux|des)\s+limite/iu,
    ],
  },
  {
    topic: "green_space",
    label: "Espaces libres et végétalisation",
    patterns: [
      /\bespace(?:s)?\s+libre(?:s)?\b/iu,
      /\bpleine\s+terre\b/iu,
      /\bvégétalis(?:ation|é|és|ées|er)\b/iu,
      /\bplantation(?:s)?\b/iu,
    ],
  },
  {
    topic: "parking",
    label: "Stationnement",
    patterns: [/\bstationnement\b/iu, /\bplace(?:s)?\s+de\s+stationnement\b/iu],
  },
  {
    topic: "access_networks",
    label: "Accès, desserte et réseaux",
    patterns: [
      /\baccès\b/iu,
      /\bdesserte\b/iu,
      /\bvoirie\b/iu,
      /\bréseau(?:x)?\b/iu,
      /\bvoie(?:s)?\s+publique(?:s)?\b/iu,
    ],
  },
  {
    topic: "appearance",
    label: "Aspect extérieur",
    patterns: [
      /\baspect\s+extérieur\b/iu,
      /\btoiture(?:s)?\b/iu,
      /\bfaçade(?:s)?\b/iu,
      /\bclôture(?:s)?\b/iu,
    ],
  },
];

/**
 * Extracts only verbatim, zone-validated snippets from already extracted PDF pages.
 * It deliberately does not calculate buildable area, infer missing values, or turn a
 * document rule into a permission.
 */
export function extractLandRulesFromPages(input: LandRuleExtractionInput): LandRulesResult {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const warnings: string[] = [];
  const sourceUrl = input.sourceUrl.trim();

  if (!isOfficialSourceUrl(sourceUrl)) {
    return emptyRulesResult({
      input,
      checkedAt,
      status: "unavailable",
      warning:
        "Source PDF refusée : seules les URLs de l'allowlist officielle GPU ou data.geopf.fr sont acceptées.",
    });
  }

  const targetZones = dedupeStrings(input.targetZoneLabels);
  if (targetZones.length === 0) {
    return emptyRulesResult({
      input,
      checkedAt,
      status: "partial",
      warning:
        "Aucune zone cible n'est fournie : les règles ne peuvent pas être attribuées sans risque à une parcelle.",
    });
  }

  const pages = [...input.pages]
    .filter((page) => Number.isInteger(page.page) && page.page > 0)
    .sort((left, right) => left.page - right.page);
  if (pages.length === 0) {
    return emptyRulesResult({
      input,
      checkedAt,
      status: "unavailable",
      warning:
        "Le document PDF est illisible ou aucune page n'a pu être extraite ; les limites restent inconnues.",
    });
  }

  const rules: LandRuleEvidence[] = [];
  let pagesWithText = 0;
  let pagesWithTargetZone = 0;

  for (const page of pages) {
    const text = cleanPageText(page.text);
    if (text.length > 0) pagesWithText += 1;
    if (!text) continue;

    const pageZoneLabels = findZoneLabels(text, targetZones);
    if (pageZoneLabels.length > 0) pagesWithTargetZone += 1;

    for (const definition of TOPICS) {
      const snippets = snippetsForTopic(text, definition, targetZones);
      snippets.forEach((snippet, index) => {
        // A page can contain several neighbouring sectors. Attribute a proof only
        // when the extracted excerpt itself names the target zone.
        const explicitZoneLabels = findZoneLabels(snippet, targetZones);
        const zoneLabels =
          explicitZoneLabels.length > 0
            ? explicitZoneLabels
            : pageZoneLabels.length === 1 && !hasCompetingZoneContext(snippet, targetZones)
              ? pageZoneLabels
              : [];
        if (zoneLabels.length === 0) return;
        const pageNumber = page.gpuPage ?? page.page;
        rules.push({
          id: `${input.documentId}:${pageNumber}:${definition.topic}:${index}`,
          topic: definition.topic,
          title: definition.label,
          text: snippet,
          zoneLabels,
          documentId: input.documentId,
          sourceUrl,
          page: pageNumber,
          article: extractArticle(snippet),
          conditions: extractConditions(snippet),
          confidence: "extracted",
        });
      });
    }
  }

  if (pagesWithText < pages.length) {
    warnings.push(
      "Au moins une page ciblée est sans texte exploitable ; son contenu ne peut pas être présenté comme vérifié.",
    );
  }
  if (pagesWithTargetZone === 0) {
    warnings.push(
      `Aucune page extraite ne contient explicitement une zone cible (${targetZones.join(", ")}) ; aucune règle de zone n'a été attribuée.`,
    );
  }
  if (rules.some((rule) => rule.text.includes(TRUNCATED_SNIPPET_MARKER))) {
    warnings.push(
      "Au moins un extrait de règle dépasse 1 200 caractères ; consulter la page PDF pour le texte complet.",
    );
  }
  const totalPages = input.totalPages ?? null;
  const selectedAllPages = totalPages == null || pages.length >= totalPages;
  const completeCoverage =
    input.coverageComplete === true && selectedAllPages && pagesWithText === pages.length;
  if (!completeCoverage) {
    warnings.push(
      "Extraction partielle : la couverture documentaire ne permet pas de conclure sur l'ensemble des règles du document.",
    );
  }
  if (rules.length === 0 && pagesWithText > 0) {
    warnings.push(
      "Aucune règle exploitable n'a été extraite dans les pages et zones ciblées ; les limites restent inconnues.",
    );
  }

  const status: LandSourceStatus =
    rules.length === 0 ? "partial" : completeCoverage ? "available" : "partial";
  const check: LandSourceCheck = {
    key: `plu-rules:${input.documentId}`,
    label: `Règles PLU · ${input.documentName}`,
    status,
    scope: "document",
    sourceUrl,
    checkedAt,
    message:
      rules.length > 0
        ? `${rules.length} extrait(s) verbatim validé(s) par zone et page.`
        : "Aucune règle zone validée dans les pages extraites.",
    version: input.version ?? undefined,
  };

  return {
    rules: dedupeRules(rules),
    checks: [check],
    warnings: dedupeStrings(warnings),
    completeCoverage,
  };
}

/**
 * Fetches official GPU/data.geopf PDF rules for the zones already identified by the
 * planning result. The parser intentionally caps extraction to a small page window
 * around the GPU page supplied by the source.
 */
export async function fetchLandRules(
  planning: LandPlanningResult,
  options: LandProviderOptions = {},
): Promise<LandRulesResult> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const maxPages = DEFAULT_MAX_PAGES;
  const sourceResolution = resolvePdfSources(planning);
  const warnings = [...sourceResolution.warnings];
  if (sourceResolution.sources.length === 0) {
    return {
      rules: [],
      checks: [
        {
          key: "plu-rules:source",
          label: "Règles PLU · document officiel",
          status: "not_checked",
          scope: "document",
          sourceUrl: "https://www.geoportail-urbanisme.gouv.fr/",
          checkedAt,
          message: "Aucun règlement PDF ciblé par une zone n'est disponible.",
        },
      ],
      warnings: dedupeStrings([
        ...warnings,
        "Le règlement officiel n'est pas disponible pour les zones identifiées ; aucun droit ou interdit n'est déduit.",
      ]),
      completeCoverage: false,
    };
  }

  const results: LandRulesResult[] = [];
  const fetcher = options.fetcher ?? fetch;
  for (const source of sourceResolution.sources) {
    try {
      if (!isOfficialSourceUrl(source.url)) {
        results.push(
          unavailableRulesResult(source, checkedAt, "URL de règlement hors allowlist officielle."),
        );
        continue;
      }
      const downloaded = await downloadPdf(
        source.url,
        fetcher,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const extracted = await extractPdfPageTexts(downloaded.bytes, {
        startPage: source.startPage,
        maxPages,
      });
      const parsed = extractLandRulesFromPages({
        documentId: source.documentId,
        documentName: source.documentName,
        sourceUrl: downloaded.sourceUrl,
        targetZoneLabels: source.zoneLabels,
        pages: extracted.pages,
        totalPages: extracted.totalPages,
        coverageComplete: extracted.firstPage === 1 && extracted.lastPage === extracted.totalPages,
        checkedAt,
        version: source.version,
      });
      results.push(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur inconnue";
      results.push(unavailableRulesResult(source, checkedAt, message));
    }
  }

  const merged = mergeRulesResults(results);
  warnings.push(...merged.warnings);
  return {
    rules: merged.rules,
    checks: merged.checks,
    warnings: dedupeStrings(warnings),
    completeCoverage: sourceResolution.sources.length > 0 && merged.completeCoverage,
  };
}

function resolvePdfSources(planning: LandPlanningResult): {
  sources: PdfSource[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const sources: PdfSource[] = [];
  const documents = planning.documents;

  for (const zone of planning.zones) {
    const document = documents.find((candidate) => candidate.id === zone.documentId);
    const file = findDocumentFile(document, zone.regulationFile, zone.regulationUrl);
    const url = zone.regulationUrl?.trim() || file?.url?.trim() || "";
    if (!url) {
      warnings.push(`Aucun PDF officiel ciblé pour la zone ${zone.label || zone.id}.`);
      continue;
    }
    const existing = sources.find((source) => source.url === url);
    if (existing) {
      existing.zoneLabels = dedupeStrings(
        [...existing.zoneLabels, zone.label, zone.type].filter(isSpecificZoneLabel),
      );
      existing.startPage = existing.startPage ?? positivePage(zone.startPage);
      existing.version = existing.version ?? document?.updatedAt ?? null;
      continue;
    }
    sources.push({
      url,
      documentId: zone.documentId || document?.id || zone.id,
      documentName: document?.name || zone.documentName || zone.label || "Règlement PLU",
      zoneLabels: dedupeStrings([zone.label, zone.type].filter(isSpecificZoneLabel)),
      startPage: positivePage(zone.startPage),
      version: document?.updatedAt ?? null,
    });
  }

  if (planning.zones.length === 0) {
    warnings.push("Aucune zone GPU n'est disponible pour cibler un règlement PLU.");
  }
  return { sources, warnings };
}

function findDocumentFile(
  document: LandPlanningDocument | undefined,
  regulationFile: string | null | undefined,
  regulationUrl: string | null | undefined,
): { name: string; url: string } | null {
  if (!document) return null;
  if (regulationUrl) {
    const exact = document.files.find((file) => file.url === regulationUrl);
    if (exact) return exact;
  }
  if (regulationFile) {
    const wanted = normalizeFileName(regulationFile);
    const exact = document.files.find((file) => normalizeFileName(file.name) === wanted);
    if (exact) return exact;
    const partial = document.files.find((file) => normalizeFileName(file.name).includes(wanted));
    if (partial) return partial;
  }
  return (
    document.files.find((file) => /\.(?:pdf)(?:[?#].*)?$/iu.test(file.url)) ??
    document.files[0] ??
    null
  );
}

async function downloadPdf(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<DownloadedPdf> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  let currentUrl = url;
  let redirectCount = 0;
  try {
    while (true) {
      if (!isOfficialSourceUrl(currentUrl)) {
        throw new Error("Téléchargement refusé : l'URL sort de l'allowlist officielle.");
      }
      const response = await fetcher(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/pdf,application/octet-stream;q=0.9" },
      });
      if (response.status >= 300 && response.status < 400) {
        if (redirectCount >= MAX_REDIRECTS) {
          throw new Error("Téléchargement refusé : trop de redirections du PDF.");
        }
        currentUrl = resolveOfficialRedirect(currentUrl, response.headers.get("location"));
        redirectCount += 1;
        continue;
      }
      if (!response.ok)
        throw new Error(`Téléchargement du PDF impossible (HTTP ${response.status}).`);
      const responseUrl = response.url || currentUrl;
      if (!isOfficialSourceUrl(responseUrl)) {
        throw new Error("Téléchargement refusé : l'URL finale sort de l'allowlist officielle.");
      }
      const contentLength = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
        throw new Error("PDF refusé : taille supérieure à 32 Mo.");
      }
      const bytes = await readResponseBytes(response);
      if (bytes.byteLength > MAX_PDF_BYTES)
        throw new Error("PDF refusé : taille supérieure à 32 Mo.");
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("html") || isHtmlBytes(bytes)) {
        const metaRedirect = extractMetaRedirect(bytes, responseUrl);
        if (metaRedirect) {
          if (redirectCount >= MAX_REDIRECTS) {
            throw new Error("Téléchargement refusé : trop de redirections du PDF.");
          }
          currentUrl = metaRedirect;
          redirectCount += 1;
          continue;
        }
      }
      if (contentType && !contentType.includes("pdf") && !contentType.includes("octet-stream")) {
        throw new Error(`PDF refusé : type MIME inattendu (${contentType}).`);
      }
      if (!isPdfBytes(bytes)) throw new Error("PDF refusé : signature PDF absente.");
      return { bytes, sourceUrl: responseUrl };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function resolveOfficialRedirect(baseUrl: string, location: string | null): string {
  if (!location?.trim()) {
    throw new Error("Téléchargement refusé : redirection sans destination.");
  }
  let resolved: string;
  try {
    resolved = new URL(location.trim(), baseUrl).toString();
  } catch {
    throw new Error("Téléchargement refusé : destination de redirection invalide.");
  }
  if (!isOfficialSourceUrl(resolved)) {
    throw new Error("Téléchargement refusé : la redirection sort de l'allowlist officielle.");
  }
  return resolved;
}

function extractMetaRedirect(bytes: Uint8Array, baseUrl: string): string | null {
  const preview = new TextDecoder().decode(bytes.slice(0, MAX_HTML_REDIRECT_BYTES));
  const tags = preview.match(/<meta\b[^>]*>/giu) ?? [];
  for (const tag of tags) {
    const httpEquiv = htmlAttribute(tag, "http-equiv");
    if (httpEquiv?.toLowerCase() !== "refresh") continue;
    const content = htmlAttribute(tag, "content");
    const destination = content
      ?.match(/^\s*\d+\s*;\s*url\s*=\s*(.+?)\s*$/iu)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/gu, "")
      .replace(/&amp;/gu, "&");
    if (!destination) continue;
    return resolveOfficialRedirect(baseUrl, destination);
  }
  return null;
}

function htmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > MAX_PDF_BYTES) throw new Error("PDF refusé : taille supérieure à 32 Mo.");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function extractPdfPageTexts(
  bytes: Uint8Array,
  options: { startPage: number | null; maxPages: number },
): Promise<PdfPageExtraction> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
  });
  const document = await loadingTask.promise;
  try {
    const totalPages = document.numPages;
    const firstPage = options.startPage ? Math.min(Math.max(1, options.startPage), totalPages) : 1;
    const lastPage = Math.min(totalPages, firstPage + options.maxPages - 1);
    const pages: LandPdfPageText[] = [];
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = textContentToPageText(content.items);
      pages.push({ page: pageNumber, text });
    }
    return { pages, totalPages, firstPage, lastPage };
  } finally {
    await loadingTask.destroy();
  }
}

function textContentToPageText(items: readonly unknown[]): string {
  let previousY: number | null = null;
  let text = "";
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item) || typeof item.str !== "string") {
      continue;
    }
    const transform = "transform" in item && Array.isArray(item.transform) ? item.transform : null;
    const y = transform && typeof transform[5] === "number" ? transform[5] : null;
    if (text) {
      text += y != null && previousY != null && Math.abs(y - previousY) > 1 ? "\n" : " ";
    }
    text += item.str;
    previousY = y;
  }
  return text;
}

function snippetsForTopic(
  text: string,
  definition: RuleTopicDefinition,
  targetZones: string[],
): string[] {
  const lines = text
    .split(/\n+/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .map(normalizePdfLine)
    .filter((line): line is string => Boolean(line))
    .filter(Boolean);
  const snippets: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!definition.patterns.some((pattern) => pattern.test(lines[index] ?? ""))) continue;
    const rawSnippet = collectTopicContext(lines, index);
    const scopedSnippet = keepTargetZoneClauses(rawSnippet, targetZones);
    if (isHeadingOnlySnippet(scopedSnippet) || isIncidentalTopic(definition.topic, scopedSnippet)) {
      continue;
    }
    const snippet = markTruncatedSnippet(scopedSnippet);
    if (
      snippet &&
      !snippets.some(
        (existing) => normalizeEvidenceText(existing) === normalizeEvidenceText(snippet),
      )
    ) {
      snippets.push(snippet);
    }
    if (snippets.length >= 5) break;
  }
  return snippets;
}

function isSnippetHeader(line: string): boolean {
  return /^(?:article\b|art\.\s|\d+(?:\.\d+){1,}\s|communauté\b|plui\b|UC$)/iu.test(line);
}

/**
 * PDF text extraction also returns the running header/footer of the regulation.
 * Those lines contain a page number and sometimes a topic word, but are not a
 * rule. Remove them before a topic can use the line as its proof context.
 */
function normalizePdfLine(line: string): string | null {
  const value = line.replace(/\s+/gu, " ").trim();
  if (!value) return null;
  if (/^(?:communauté\b|plui\b|UC$)/iu.test(value)) return null;
  return value;
}

function collectTopicContext(lines: string[], topicLineIndex: number): string {
  const topicLine = lines[topicLineIndex] ?? "";
  const bulletStart = findBulletStart(lines, topicLineIndex);
  if (isSubBulletStart(lines[bulletStart] ?? "")) {
    const parentStart = findParentDash(lines, bulletStart);
    // An indented bullet without a demonstrable parent is not a safe proof:
    // displaying it would turn a condition fragment into an autonomous rule.
    if (parentStart == null) return "";
    const end = findDashBulletEnd(lines, parentStart);
    const start = findBulletContextStart(lines, parentStart);
    return lines.slice(start, end).join(" ").replace(/\s+/gu, " ").trim();
  }

  if (isDashBulletStart(lines[bulletStart] ?? "")) {
    const end = findDashBulletEnd(lines, bulletStart);
    const start = findBulletContextStart(lines, bulletStart);
    return lines.slice(start, end).join(" ").replace(/\s+/gu, " ").trim();
  }

  if (isSnippetHeader(topicLine) && !isNumberedHeading(topicLine)) {
    let end = topicLineIndex + 1;
    while (end < lines.length && !isSnippetHeader(lines[end] ?? "")) end += 1;
    return lines.slice(topicLineIndex, end).join(" ").replace(/\s+/gu, " ").trim();
  }

  if (isNumberedHeading(topicLine)) {
    const end = findSectionEnd(lines, topicLineIndex, headingLevel(topicLine));
    return lines.slice(topicLineIndex, end).join(" ").replace(/\s+/gu, " ").trim();
  }

  let end = topicLineIndex + 1;
  const limit = Math.min(lines.length, topicLineIndex + MAX_SNIPPET_CONTEXT_LINES);
  while (end < limit) {
    const previous = lines[end - 1] ?? "";
    const next = lines[end] ?? "";
    if (isSnippetHeader(next) || isBulletStart(next) || /[.!?;:]$/u.test(previous)) break;
    end += 1;
  }
  return lines.slice(topicLineIndex, end).join(" ").replace(/\s+/gu, " ").trim();
}

function isBulletStart(line: string): boolean {
  return isDashBulletStart(line) || isSubBulletStart(line);
}

function isDashBulletStart(line: string): boolean {
  return /^[-•]\s/u.test(line);
}

function isSubBulletStart(line: string): boolean {
  return /^o\s/u.test(line);
}

function findBulletStart(lines: string[], lineIndex: number): number {
  let cursor = lineIndex;
  while (
    cursor > 0 &&
    !isBulletStart(lines[cursor] ?? "") &&
    !isSnippetHeader(lines[cursor] ?? "")
  ) {
    cursor -= 1;
  }
  return isBulletStart(lines[cursor] ?? "") ? cursor : lineIndex;
}

function findParentDash(lines: string[], subBulletStart: number): number | null {
  let cursor = subBulletStart - 1;
  while (cursor >= 0) {
    const line = lines[cursor] ?? "";
    if (isDashBulletStart(line)) return cursor;
    if (isSnippetHeader(line)) return null;
    cursor -= 1;
  }
  return null;
}

function findDashBulletEnd(lines: string[], bulletStart: number): number {
  let cursor = bulletStart + 1;
  while (
    cursor < lines.length &&
    !isDashBulletStart(lines[cursor] ?? "") &&
    !isSnippetHeader(lines[cursor] ?? "")
  ) {
    cursor += 1;
  }
  return cursor;
}

function findBulletContextStart(lines: string[], bulletStart: number): number {
  let cursor = bulletStart - 1;
  let distance = 0;
  // A sibling dash bullet may sit between the target bullet and its heading.
  // Walk over that sibling context, but cap the search so an unrelated page
  // section cannot be presented as the target rule's rubrique.
  while (cursor >= 0 && distance < MAX_SNIPPET_CONTEXT_LINES) {
    if (isSnippetHeader(lines[cursor] ?? "")) return cursor;
    cursor -= 1;
    distance += 1;
  }
  return bulletStart;
}

function isNumberedHeading(line: string): boolean {
  return /^\d+(?:\.\d+){1,}\s/iu.test(line);
}

function headingLevel(line: string): number {
  const match = /^(\d+(?:\.\d+)+)\s/iu.exec(line);
  return match?.[1]?.split(".").length ?? Number.MAX_SAFE_INTEGER;
}

function findSectionEnd(lines: string[], headingIndex: number, level: number): number {
  let cursor = headingIndex + 1;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    if (isNumberedHeading(line) && headingLevel(line) <= level) break;
    if (/^(?:article\b|art\.\s|communauté\b|plui\b|UC$)/iu.test(line)) break;
    cursor += 1;
  }
  return cursor;
}

function isHeadingOnlySnippet(text: string): boolean {
  if (!text) return true;
  if (/(?:^|\s)(?:-|o)\s/u.test(text)) return false;
  return !/\b(?:ne\s+peut|maximum|minimum|réglement|autorisé|interdit|condition|s'appliqu\w*|division|doit|doivent|est|sont|peut)\b/iu.test(
    text,
  );
}

function isIncidentalTopic(topic: LandRuleEvidence["topic"], text: string): boolean {
  if (
    topic === "footprint" &&
    /\bannexes?\b[^.;:]{0,160}\bn['’]est pas règlementée\b/iu.test(text) &&
    !/\bimplantation\b/iu.test(text)
  ) {
    // A line about an annex's footprint can be emitted from the implantation
    // rubrique. Without that rubrique in the excerpt, do not surface it under
    // “Emprise au sol” where the scope would be ambiguous.
    return true;
  }
  if (topic !== "height") return false;
  const implantationContext =
    /\b(?:implantation|recul|limites? séparatives?|voies? et emprises? publiques?|annexes?)\b/iu.test(
      text,
    );
  if (!implantationContext) return false;

  // A height word in an implantation exception (for example, an annex under
  // 3.5 m) must not be presented as a height entitlement. Keep substantive
  // height rules that carry a ceiling, level count, or a named datum.
  const substantiveHeight =
    /\b(?:hauteur\b[^.;:]{0,80}\b(?:maximale?|minimum|minimale?|limitée?|fixée?|atteindre|niveaux?)\b|R\s*\+\s*\d|(?:fa(?:î|i)tage|égout|acrotère)\b)/iu.test(
      text,
    );
  return !substantiveHeight;
}

function markTruncatedSnippet(text: string): string {
  if (text.length <= MAX_SNIPPET_LENGTH) return text;
  const budget = Math.max(1, MAX_SNIPPET_LENGTH - TRUNCATED_SNIPPET_MARKER.length - 3);
  const head = text.slice(0, budget);
  const cut = head.lastIndexOf(" ");
  return `${(cut > 0 ? head.slice(0, cut) : head).trim()} … ${TRUNCATED_SNIPPET_MARKER}`;
}

/**
 * PDF text often places several sector bullets in one topic window. Keep the
 * target-sector bullet and shared-sector clauses verbatim, but drop a following
 * bullet that explicitly applies to another sector. Without this boundary, a
 * UCb2-only height can appear as evidence for UCa2 merely because both bullets
 * are adjacent on the same PDF page.
 */
function keepTargetZoneClauses(text: string, targetZones: string[]): string {
  if (!text || targetZones.length === 0) return text;

  const clauses = text
    .split(/\s+(?=-\s+(?=[A-ZÀ-ÖØ-Þ]))/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (
    clauses.length <= 1 ||
    !clauses.some((clause) => findZoneLabels(clause, targetZones).length)
  ) {
    return text;
  }

  const kept = clauses.filter((clause) => {
    const namesTarget = findZoneLabels(clause, targetZones).length > 0;
    const namesAnySector =
      /\b(?:zone|zones|secteur|secteurs)\b[^.;:]{0,180}\b[A-Z]{1,4}[a-z]?\d+\b/iu.test(clause);
    if (namesTarget) {
      return true;
    }
    // A heading or a continuation line can carry the scope of the target
    // clause; preserve it. A new explicit sector bullet cannot.
    if (namesAnySector) return false;
    return true;
  });

  return kept.join(" ").replace(/\s+/gu, " ").trim();
}

function extractArticle(text: string): string | null {
  const match =
    /\b(?:article|art\.?)\s+((?:[A-Z]{1,3}\s*\.?\s*\d+(?:\s*[-.]\s*\d+)*|\d+(?:\s*[-.]\s*\d+)*))\b/iu.exec(
      text,
    );
  return match?.[1] ? `Article ${match[1].replace(/\s+/gu, "")}` : null;
}

function extractConditions(text: string): string[] {
  return dedupeStrings(
    text
      .split(/(?<=[.;:])\s+/u)
      .filter((part) =>
        /\b(?:sous réserve|sous condition|à condition|sauf|except(?:é|ée|és|ées)|lorsque|si |doit|doivent|ne peut|interdit|autorisé)\b/iu.test(
          part,
        ),
      )
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 5),
  );
}

function findZoneLabels(text: string, targets: string[]): string[] {
  return targets.filter((target) => {
    const normalized = target.trim();
    if (!normalized) return false;
    const escaped = escapeRegExp(normalized).replace(/\\ /gu, "\\s+");
    return new RegExp(`(?<![A-Z0-9])${escaped}(?![A-Z0-9])`, "iu").test(text);
  });
}

function hasCompetingZoneContext(text: string, targets: string[]): boolean {
  if (!/\b(?:zone|zones|secteur|secteurs)\b/iu.test(text)) return false;
  return findZoneLabels(text, targets).length === 0;
}

function emptyRulesResult({
  input,
  checkedAt,
  status,
  warning,
}: {
  input: LandRuleExtractionInput;
  checkedAt: string;
  status: LandSourceStatus;
  warning: string;
}): LandRulesResult {
  return {
    rules: [],
    checks: [
      {
        key: `plu-rules:${input.documentId}`,
        label: `Règles PLU · ${input.documentName}`,
        status,
        scope: "document",
        sourceUrl: input.sourceUrl,
        checkedAt,
        message: warning,
        version: input.version ?? undefined,
      },
    ],
    warnings: [warning],
    completeCoverage: false,
  };
}

function unavailableRulesResult(
  source: PdfSource,
  checkedAt: string,
  message: string,
): LandRulesResult {
  return {
    rules: [],
    checks: [
      {
        key: `plu-rules:${source.documentId}`,
        label: `Règles PLU · ${source.documentName}`,
        status: "unavailable",
        scope: "document",
        sourceUrl: source.url,
        checkedAt,
        message,
      },
    ],
    warnings: [`${source.documentName} : ${message}`],
    completeCoverage: false,
  };
}

function mergeRulesResults(results: LandRulesResult[]): LandRulesResult {
  return {
    rules: dedupeRules(results.flatMap((result) => result.rules)),
    checks: results.flatMap((result) => result.checks),
    warnings: dedupeStrings(results.flatMap((result) => result.warnings)),
    completeCoverage: results.length > 0 && results.every((result) => result.completeCoverage),
  };
}

function dedupeRules(rules: LandRuleEvidence[]): LandRuleEvidence[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = [
      rule.documentId,
      rule.page,
      rule.topic,
      rule.zoneLabels.join("|").toLowerCase(),
      normalizeEvidenceText(rule.text),
      normalizeEvidenceText(rule.conditions.join(" | ")),
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isSpecificZoneLabel(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 1;
}

function cleanPageText(value: string): string {
  return Array.from(value.replace(/\r/gu, ""))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10;
    })
    .join("")
    .trim();
}

function normalizeFileName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function positivePage(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isPdfBytes(bytes: Uint8Array): boolean {
  const header = new TextDecoder().decode(bytes.slice(0, 16));
  return header.startsWith("%PDF-");
}

function isHtmlBytes(bytes: Uint8Array): boolean {
  const header = new TextDecoder().decode(bytes.slice(0, 512)).trimStart().toLowerCase();
  return (
    header.startsWith("<!doctype html") || header.startsWith("<html") || header.startsWith("<head")
  );
}

function isOfficialSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      OFFICIAL_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
