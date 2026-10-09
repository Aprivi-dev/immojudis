/**
 * Default rate-limit policies for the first-party API (plan P4-02). Kept free of
 * server-only imports so tests and documentation can reference the numbers.
 */
export const RATE_LIMIT_POLICIES = {
  /** Authenticated calculations and data lookups: 30 per minute per user. */
  compute: { limit: 30, windowSeconds: 60 },
  /** Authenticated form submissions that create records or send emails: 10 per hour per user. */
  formSubmit: { limit: 10, windowSeconds: 3600 },
  /** Anonymous public routes and third-party proxies: 60 per minute per IP. */
  publicIp: { limit: 60, windowSeconds: 60 },
  /** New Meteostat upstream requests (cache misses): 5 per day per user. */
  weatherUpstream: { limit: 5, windowSeconds: 86_400 },
} as const;

/** Maximum number of lawyer profiles returned by one directory call. */
export const LAWYER_DIRECTORY_PAGE_SIZE = 50;

/** Edge cache lifetime of the public directory and offer responses, in seconds. */
export const PUBLIC_DIRECTORY_CACHE_SECONDS = 3600;
export const BILLING_OFFER_CACHE_SECONDS = 300;
