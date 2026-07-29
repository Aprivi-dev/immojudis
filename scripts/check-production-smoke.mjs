import { randomUUID } from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEFAULT_ORIGIN = "https://immojudis.com";
const TIMEOUT_MS = 10_000;

const checks = [
  { path: "/", kind: "html", canonical: "/" },
  { path: "/sales", kind: "html", canonical: "/sales" },
  { path: "/annonce-exemple", kind: "html", canonical: "/annonce-exemple" },
  { path: "/legal", kind: "html" },
  { path: "/api/lawyers/directory?department=33", kind: "json" },
];

export async function checkProductionSmoke({ origin = DEFAULT_ORIGIN, fetchImpl = fetch } = {}) {
  const normalizedOrigin = normalizeOrigin(origin);
  const startedAt = Date.now();
  const results = await Promise.all(
    checks.map((check) => runCheck({ check, origin: normalizedOrigin, fetchImpl })),
  );

  return {
    ok: true,
    origin: normalizedOrigin,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    checks: results,
  };
}

async function runCheck({ check, origin, fetchImpl }) {
  const requestId = `smoke-${randomUUID()}`;
  const url = new URL(check.path, origin);
  const startedAt = Date.now();
  const response = await fetchImpl(url, {
    headers: {
      accept: check.kind === "json" ? "application/json" : "text/html",
      "user-agent": "immojudis-production-smoke/1.0",
      "x-request-id": requestId,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status !== 200) {
    throw new Error(`${check.path}: statut HTTP ${response.status} au lieu de 200.`);
  }

  const responseRequestId = response.headers.get("x-request-id");
  if (!responseRequestId || !REQUEST_ID_PATTERN.test(responseRequestId)) {
    throw new Error(`${check.path}: en-tête x-request-id absent ou invalide.`);
  }
  if (responseRequestId !== requestId) {
    throw new Error(`${check.path}: la corrélation x-request-id n'est pas préservée.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (check.kind === "json") {
    if (!contentType.includes("application/json")) {
      throw new Error(`${check.path}: réponse JSON attendue, reçu ${contentType || "inconnu"}.`);
    }
    const body = await response.json();
    if (!body || !Array.isArray(body.lawyers)) {
      throw new Error(`${check.path}: contrat de l'annuaire invalide.`);
    }
  } else {
    if (!contentType.includes("text/html")) {
      throw new Error(`${check.path}: réponse HTML attendue, reçu ${contentType || "inconnu"}.`);
    }
    const body = await response.text();
    if (!body.toLowerCase().includes("immojudis")) {
      throw new Error(`${check.path}: identité Immojudis absente du document.`);
    }
    if (check.canonical) {
      const canonical = new URL(check.canonical, origin).href;
      const canonicalTag = body
        .match(/<link\b[^>]*>/gi)
        ?.find((tag) => /\brel=["']canonical["']/i.test(tag));
      const canonicalHref = canonicalTag?.match(/\bhref=["']([^"']+)["']/i)?.[1];
      if (!canonicalHref || new URL(canonicalHref, origin).href !== canonical) {
        throw new Error(`${check.path}: URL canonique ${canonical} absente.`);
      }
    }
  }

  return {
    path: check.path,
    status: response.status,
    requestId: responseRequestId,
    durationMs: Date.now() - startedAt,
  };
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("L'origine de production doit utiliser HTTPS.");
  }
  return url.origin;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const originIndex = process.argv.indexOf("--origin");
  const origin =
    originIndex >= 0 ? process.argv[originIndex + 1] : process.env.IMMOJUDIS_SMOKE_ORIGIN;

  try {
    const report = await checkProductionSmoke({ origin: origin || DEFAULT_ORIGIN });
    console.info(JSON.stringify(report));
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
