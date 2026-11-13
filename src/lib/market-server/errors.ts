/** Codes d'échec d'une estimation de marché, stockés dans `auction_sale_market_estimates.last_error_code`. */
export const MARKET_ESTIMATE_ERROR_CODES = [
  "INVALID_INPUT",
  "MISSING_LOCATION",
  "MISSING_SURFACE",
  "UNSUPPORTED_SEGMENT",
  "NO_COMPARABLES",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type MarketEstimateErrorCode = (typeof MARKET_ESTIMATE_ERROR_CODES)[number];

export function isMarketEstimateErrorCode(value: unknown): value is MarketEstimateErrorCode {
  return MARKET_ESTIMATE_ERROR_CODES.includes(value as MarketEstimateErrorCode);
}

/**
 * Panne (service externe, erreur inattendue) plutôt que données insuffisantes : l'échec est journalisé comme un
 * incident, présenté comme une indisponibilité temporaire et retenté vite.
 */
export function isTransientMarketEstimateFailure(code: MarketEstimateErrorCode): boolean {
  return code === "UPSTREAM_UNAVAILABLE" || code === "INTERNAL_ERROR";
}

/**
 * Échec d'estimation dont la cause est connue. Hors pannes (`isTransientMarketEstimateFailure`), le message est
 * montré à l'utilisateur après « Estimation automatique indisponible : ».
 */
export class MarketEstimateError extends Error {
  readonly code: MarketEstimateErrorCode;

  constructor(code: MarketEstimateErrorCode, message: string) {
    super(message);
    this.name = "MarketEstimateError";
    this.code = code;
  }
}
