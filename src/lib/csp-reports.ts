export type CspReportSummary = {
  directive: string | null;
  blockedUri: string | null;
  documentUri: string | null;
  disposition: string | null;
  sourceFile: string | null;
  line: number | null;
};

function text(value: unknown, max = 300): string | null {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

function strip(value: string | null): string | null {
  // Reports may carry full URLs with query strings: keep origin and path only.
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return value;
  }
}

function summarize(raw: Record<string, unknown>): CspReportSummary {
  return {
    directive: text(
      raw["effective-directive"] ?? raw.effectiveDirective ?? raw["violated-directive"],
    ),
    blockedUri: strip(text(raw["blocked-uri"] ?? raw.blockedURL)),
    documentUri: strip(text(raw["document-uri"] ?? raw.documentURL)),
    disposition: text(raw.disposition),
    sourceFile: strip(text(raw["source-file"] ?? raw.sourceFile)),
    line:
      typeof (raw["line-number"] ?? raw.lineNumber) === "number"
        ? ((raw["line-number"] ?? raw.lineNumber) as number)
        : null,
  };
}

/**
 * Accepts both report formats: the legacy `{ "csp-report": {...} }` (application/csp-report)
 * and the Reporting API array `[ { type: "csp-violation", body: {...} } ]`. Anything else, and
 * anything unparsable, yields no entries.
 */
export function summarizeCspReports(body: string): CspReportSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const summaries: CspReportSummary[] = [];
  for (const entry of entries.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const legacy = record["csp-report"];
    if (legacy && typeof legacy === "object") {
      summaries.push(summarize(legacy as Record<string, unknown>));
    } else if (record.type === "csp-violation" && record.body && typeof record.body === "object") {
      summaries.push(summarize(record.body as Record<string, unknown>));
    }
  }
  return summaries;
}
