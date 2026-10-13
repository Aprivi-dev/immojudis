/**
 * « Lecture des pièces » : points a buyer must know, read in the case documents
 * by the pipeline, each with a quote verified word for word in the cited page.
 * Shared by the API route (server) and the sale page (browser).
 */

export type DocumentReadingTheme =
  | "occupation"
  | "etat_travaux"
  | "diagnostics"
  | "copropriete"
  | "urbanisme_servitudes"
  | "conditions_vente"
  | "juridique"
  | "autre";

export type DocumentReadingImportance = "alerte" | "attention" | "info";

export type DocumentReadingPoint = {
  theme: DocumentReadingTheme;
  importance: DocumentReadingImportance;
  title: string;
  explanation: string | null;
  quote: string;
  page: number;
  document: { label: string; url: string | null; documentType: string } | null;
};

export type DocumentReadingResponse =
  | {
      access: "full";
      status: "completed" | "no_text" | "failed" | "pending";
      points: DocumentReadingPoint[];
      generatedAt: string | null;
      /** The dossier was longer than one reading: the most useful pages were read. */
      partial: boolean;
    }
  /** Free accounts: how much was found, never what. */
  | { access: "teaser"; pointCount: number; alertCount: number; themes: DocumentReadingTheme[] };

export const DOCUMENT_READING_THEMES: Record<DocumentReadingTheme, string> = {
  occupation: "Occupation",
  etat_travaux: "État et travaux",
  diagnostics: "Diagnostics",
  copropriete: "Copropriété",
  urbanisme_servitudes: "Urbanisme et servitudes",
  conditions_vente: "Conditions de la vente",
  juridique: "Points juridiques",
  autre: "Autres points",
};

export const DOCUMENT_READING_IMPORTANCE: Record<DocumentReadingImportance, string> = {
  alerte: "À vérifier en priorité",
  attention: "À prendre en compte",
  info: "Bon à savoir",
};

type RawReading = {
  status?: string | null;
  points?: unknown;
  documents?: unknown;
  generated_at?: string | null;
  input_truncated?: boolean | null;
} | null;

type RawDocument = { index?: number; label?: string; url?: string | null; document_type?: string };

const THEMES = new Set(Object.keys(DOCUMENT_READING_THEMES));
const IMPORTANCE = new Set(Object.keys(DOCUMENT_READING_IMPORTANCE));
const STATUSES = new Set(["completed", "no_text", "failed"]);

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Only http(s) links are rendered: a document URL comes from a third-party site. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function mapDocumentReading(
  raw: RawReading,
): Extract<DocumentReadingResponse, { access: "full" }> {
  if (!raw)
    return { access: "full", status: "pending", points: [], generatedAt: null, partial: false };
  const documents = new Map<number, DocumentReadingPoint["document"]>();
  for (const item of Array.isArray(raw.documents) ? (raw.documents as RawDocument[]) : []) {
    if (typeof item?.index !== "number") continue;
    documents.set(item.index, {
      label: text(item.label, 160) ?? "Pièce du dossier",
      url: safeUrl(item.url),
      documentType: text(item.document_type, 60) ?? "autre",
    });
  }
  const points: DocumentReadingPoint[] = [];
  for (const item of Array.isArray(raw.points) ? raw.points : []) {
    if (!item || typeof item !== "object") continue;
    const point = item as Record<string, unknown>;
    const title = text(point.title, 120);
    const quote = text(point.quote, 400);
    const page = Number(point.page);
    if (!title || !quote || !Number.isInteger(page) || page < 1) continue;
    points.push({
      theme: (THEMES.has(String(point.theme)) ? point.theme : "autre") as DocumentReadingTheme,
      importance: (IMPORTANCE.has(String(point.importance))
        ? point.importance
        : "info") as DocumentReadingImportance,
      title,
      explanation: text(point.explanation, 400),
      quote,
      page,
      document: documents.get(Number(point.document_index)) ?? null,
    });
  }
  return {
    access: "full",
    status: (STATUSES.has(String(raw.status)) ? raw.status : "pending") as Extract<
      DocumentReadingResponse,
      { access: "full" }
    >["status"],
    points,
    generatedAt: raw.generated_at ?? null,
    partial: raw.input_truncated === true,
  };
}

export function documentReadingTeaser(
  reading: Extract<DocumentReadingResponse, { access: "full" }>,
): Extract<DocumentReadingResponse, { access: "teaser" }> {
  return {
    access: "teaser",
    pointCount: reading.points.length,
    alertCount: reading.points.filter((point) => point.importance === "alerte").length,
    themes: [...new Set(reading.points.map((point) => point.theme))],
  };
}

/** Link straight to the cited page (PDF viewers honour #page=N). */
export function documentPageHref(url: string | null, page: number): string | null {
  if (!url) return null;
  return /\.pdf(?:$|[?#])/i.test(url) ? `${url.split("#")[0]}#page=${page}` : url;
}

/** Points grouped by theme, themes in the order of their most important point. */
export function groupReadingPoints(
  points: DocumentReadingPoint[],
): Array<{ theme: DocumentReadingTheme; points: DocumentReadingPoint[] }> {
  const groups = new Map<DocumentReadingTheme, DocumentReadingPoint[]>();
  for (const point of points) {
    groups.set(point.theme, [...(groups.get(point.theme) ?? []), point]);
  }
  return [...groups.entries()].map(([theme, items]) => ({ theme, points: items }));
}
