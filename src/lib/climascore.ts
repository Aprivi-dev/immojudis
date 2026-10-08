export type ClimaScoreCommune = { code: string; name: string };

const COMMUNE_CODE = /^(?:\d{5}|2[AB]\d{3})$/;

export function normalizeCommuneName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Never pick the first approximate match: a postal code can cover several communes. */
export function matchClimaScoreCommune(payload: unknown, city: string): ClimaScoreCommune | null {
  if (!Array.isArray(payload)) return null;
  const matches = payload.filter(
    (item): item is { code: string; nom: string } =>
      item != null &&
      typeof item.code === "string" &&
      COMMUNE_CODE.test(item.code) &&
      typeof item.nom === "string" &&
      normalizeCommuneName(item.nom) === normalizeCommuneName(city),
  );
  return matches.length === 1 ? { code: matches[0].code, name: matches[0].nom } : null;
}

export function climaScoreWidgetDocument(code: string): string | null {
  if (!COMMUNE_CODE.test(code)) return null;
  // Provider's official widget code, isolated from the listing's DOM in a sandboxed iframe.
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>body{margin:0;padding:8px;font:15px system-ui;color:#15344a}a{color:inherit}</style></head><body><a id="climascore-widget-${code}" href="https://climascore.fr/risques/${code}" rel="noopener noreferrer">Consulter la classe climat de la commune sur ClimaScore</a><script async src="https://climascore.fr/widget/climascore-${code}.js"></script></body></html>`;
}
