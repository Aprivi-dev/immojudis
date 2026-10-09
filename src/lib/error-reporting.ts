/**
 * Minimal error reporting to a Sentry-compatible endpoint (Sentry, GlitchTip,
 * Bugsink...) over the public envelope API.  It needs no SDK, runs in the Node,
 * edge and browser runtimes, and does nothing until a DSN is configured:
 *   - server and edge: SENTRY_DSN (or NEXT_PUBLIC_SENTRY_DSN);
 *   - browser:        NEXT_PUBLIC_SENTRY_DSN.
 * Cookies, headers, query strings and request bodies are never sent.
 */

export type ErrorReportContext = {
  /** Where the error was caught, e.g. "render", "route", "action", "error-boundary". */
  source?: string;
  /** Route pattern, e.g. /sales/[id] — never the concrete URL with its query. */
  route?: string;
  requestId?: string | null;
  digest?: string | null;
  extra?: Record<string, string | number | boolean | null | undefined>;
};

type ParsedDsn = { publicKey: string; endpoint: string };

const MAX_MESSAGE_LENGTH = 1_000;
const MAX_STACK_LENGTH = 8_000;

export function parseDsn(dsn: string | null | undefined): ParsedDsn | null {
  const value = dsn?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const projectId = url.pathname.split("/").filter(Boolean).pop();
    if (!url.username || !projectId) return null;
    const prefix = url.pathname.split("/").filter(Boolean).slice(0, -1).join("/");
    const base = `${url.protocol}//${url.host}${prefix ? `/${prefix}` : ""}`;
    return {
      publicKey: url.username,
      endpoint: `${base}/api/${projectId}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(url.username)}`,
    };
  } catch {
    return null;
  }
}

function configuredDsn(): string | undefined {
  return typeof window === "undefined"
    ? process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
    : process.env.NEXT_PUBLIC_SENTRY_DSN;
}

function eventId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function stripUrl(value: string | undefined): string | undefined {
  return value?.split("?")[0]?.split("#")[0];
}

export function buildErrorEnvelope(
  error: unknown,
  context: ErrorReportContext = {},
  now: Date = new Date(),
): { body: string; eventId: string } {
  const id = eventId();
  const err = error instanceof Error ? error : new Error(String(error));
  const event = {
    event_id: id,
    timestamp: now.getTime() / 1000,
    platform: "javascript",
    level: "error",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "production",
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
    server_name: undefined,
    exception: {
      values: [
        {
          type: err.name || "Error",
          value: err.message.slice(0, MAX_MESSAGE_LENGTH),
          stacktrace: err.stack ? { raw: err.stack.slice(0, MAX_STACK_LENGTH) } : undefined,
        },
      ],
    },
    tags: {
      source: context.source,
      route: stripUrl(context.route),
      request_id: context.requestId ?? undefined,
      digest: context.digest ?? undefined,
      runtime: typeof window === "undefined" ? "server" : "browser",
    },
    extra: context.extra,
  };
  const envelopeHeader = { event_id: id, sent_at: now.toISOString() };
  const itemHeader = { type: "event" };
  return {
    eventId: id,
    body: [envelopeHeader, itemHeader, event].map((part) => JSON.stringify(part)).join("\n"),
  };
}

/**
 * Report an error.  Resolves to the event id, or null when reporting is off or
 * fails; it never throws, so a reporting outage cannot break a page or a route.
 */
export async function reportError(
  error: unknown,
  context: ErrorReportContext = {},
  { dsn = configuredDsn(), fetchImpl = fetch }: { dsn?: string; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const parsed = parseDsn(dsn);
  if (!parsed) return null;
  try {
    const { body, eventId: id } = buildErrorEnvelope(error, context);
    const response = await fetchImpl(parsed.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
      keepalive: true,
    });
    return response.ok ? id : null;
  } catch {
    return null;
  }
}
