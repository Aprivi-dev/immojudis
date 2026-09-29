import { TOKEN_SHA256 } from "./auth.ts";
import { SECTIGO_INTERMEDIATE } from "./certificate.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECT_LOG_PATH = 512;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const PETITES_AFFICHES_HOST = "www.petitesaffiches.fr";
const PETITES_AFFICHES_LIST_PATH = "/encheres-immobilieres/";
const PETITES_AFFICHES_LEGACY_DETAIL_PATH =
  /^\/encheres-immobilieres\/vente\/immobiliere\/(?:judiciaire|volontaire)\/[a-z0-9-]+-\d+\.html$/;
const PETITES_AFFICHES_CANONICAL_DETAIL_PATH =
  /^\/vente\/immobiliere\/(?:judiciaire|volontaire)\/[a-z0-9-]+-\d+\.html$/;
const CESSIONS_HOST = "cessions.immobilier-etat.gouv.fr";
const hosts = new Set([PETITES_AFFICHES_HOST, CESSIONS_HOST]);
const cessionsClient = Deno.createHttpClient({
  caCerts: [SECTIGO_INTERMEDIATE],
});

type RedirectDiagnostic = {
  status: number;
  destinationHost: string | null;
  destinationPath: string | null;
};

/**
 * Keep redirect diagnostics useful without copying a source Location header
 * into logs. Queries, fragments and opaque paths are deliberately discarded
 * because source publishers may put tokens or other request state there.
 */
function safeRedirectPath(host: string, path: string): string | null {
  if (
    host === PETITES_AFFICHES_HOST &&
    (path === "/robots.txt" ||
      path === PETITES_AFFICHES_LIST_PATH ||
      /^\/encheres-immobilieres\/ventes-aux-encheres-immobilieres-p\d+\.html$/.test(path))
  ) {
    return path;
  }
  if (host === PETITES_AFFICHES_HOST && PETITES_AFFICHES_CANONICAL_DETAIL_PATH.test(path)) {
    return "/vente/immobiliere/";
  }
  if (host === CESSIONS_HOST && path.startsWith("/biens/")) {
    return "/biens/";
  }
  if (host === CESSIONS_HOST && (path === "/" || path === "/robots.txt")) {
    return path;
  }
  return null;
}

function safeRedirectHost(host: string): string | null {
  return hosts.has(host) ? host : null;
}

export function redirectDiagnostic(
  status: number,
  location: string | null,
  currentUrl: string,
): RedirectDiagnostic {
  if (!location) {
    return { status, destinationHost: null, destinationPath: null };
  }
  try {
    const destination = new URL(location, currentUrl);
    if (
      !["http:", "https:"].includes(destination.protocol) ||
      destination.username ||
      destination.password ||
      !destination.hostname
    ) {
      return { status, destinationHost: null, destinationPath: null };
    }
    const destinationHost = safeRedirectHost(destination.hostname);
    if (!destinationHost) {
      return { status, destinationHost: null, destinationPath: null };
    }
    const path = destination.pathname || "/";
    if (path.length > MAX_REDIRECT_LOG_PATH) {
      return {
        status,
        destinationHost,
        destinationPath: null,
      };
    }
    return {
      status,
      destinationHost,
      destinationPath: safeRedirectPath(destinationHost, path),
    };
  } catch {
    return { status, destinationHost: null, destinationPath: null };
  }
}

function logRedirect(status: number, location: string | null, currentUrl: string): void {
  // Do not log the source URL or raw Location. The structured fields are the
  // complete diagnostic payload and contain no query, fragment, credentials,
  // or bearer token.
  console.warn("source relay upstream redirect", redirectDiagnostic(status, location, currentUrl));
}

/**
 * Upgrade observed same-host Petites Affiches HTTP canonical redirects before
 * they reach the caller. The relay still accepts HTTPS targets only; this is
 * a response-header rewrite, never an HTTP fetch. Query-bearing redirects
 * are left untouched so their semantics are not changed silently.
 */
export function normalizeRedirectLocation(
  status: number,
  location: string | null,
  currentUrl: string,
): string | null {
  if (!location || status !== 301) return location;
  try {
    const source = new URL(currentUrl);
    const destination = new URL(location, currentUrl);
    if (
      source.protocol !== "https:" ||
      source.hostname !== PETITES_AFFICHES_HOST ||
      source.port ||
      source.username ||
      source.password ||
      destination.protocol !== "http:" ||
      destination.hostname !== PETITES_AFFICHES_HOST ||
      destination.port ||
      destination.username ||
      destination.password ||
      destination.search ||
      destination.hash
    ) {
      return location;
    }
    const isListRedirect = destination.pathname === PETITES_AFFICHES_LIST_PATH;
    const isDetailRedirect =
      PETITES_AFFICHES_LEGACY_DETAIL_PATH.test(source.pathname) &&
      PETITES_AFFICHES_CANONICAL_DETAIL_PATH.test(destination.pathname) &&
      !source.search &&
      !source.hash;
    if (!isListRedirect && !isDetailRedirect) return location;
    const normalized = `https://${PETITES_AFFICHES_HOST}${destination.pathname}`;
    // A source redirecting an already canonical URL back to itself would
    // otherwise make the caller repeat the same request indefinitely.
    if (source.pathname === destination.pathname && !source.search && !source.hash) {
      return location;
    }
    return normalized;
  } catch {
    return location;
  }
}

export function allowedTarget(value: string, method: string, body: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.port || u.username || u.password || !hosts.has(u.hostname)) {
      return false;
    }
    if (method === "GET") {
      return (
        !body &&
        (u.hostname === CESSIONS_HOST ||
          u.pathname === "/robots.txt" ||
          u.pathname.startsWith(PETITES_AFFICHES_LIST_PATH) ||
          (u.hostname === PETITES_AFFICHES_HOST &&
            PETITES_AFFICHES_CANONICAL_DETAIL_PATH.test(u.pathname) &&
            !u.search &&
            !u.hash))
      );
    }
    if (
      method !== "POST" ||
      u.hostname !== PETITES_AFFICHES_HOST ||
      !u.pathname.startsWith(PETITES_AFFICHES_LIST_PATH)
    ) {
      return false;
    }
    const form = new URLSearchParams(body);
    return (
      form.get("historique") === "0" &&
      [...form].every(
        ([k, v]) =>
          (k === "historique" && v === "0") ||
          (k === "select_dep" && /^(?:\d{2,3}|2A|2B)$/.test(v)),
      )
    );
  } catch {
    return false;
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.length > 256) {
    return new Response("Unauthorized", { status: 401 });
  }
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.slice(7))),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== TOKEN_SHA256) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const raw = await req.text();
    if (raw.length > 16384) {
      return new Response("Request too large", { status: 413 });
    }
    const input = JSON.parse(raw);
    const { url, method = "GET", body = "" } = input;
    if (typeof url !== "string" || typeof body !== "string" || !allowedTarget(url, method, body)) {
      return new Response("Target not allowed", { status: 400 });
    }
    const headers = new Headers();
    for (const name of ["user-agent", "accept", "accept-language"]) {
      if (typeof input.headers?.[name] === "string") {
        headers.set(name, input.headers[name]);
      }
    }
    if (method === "POST") {
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        redirect: "manual",
        signal: controller.signal,
        ...(new URL(url).hostname === CESSIONS_HOST ? { client: cessionsClient } : {}),
      });
      if (REDIRECT_STATUS_CODES.has(response.status)) {
        logRedirect(response.status, response.headers.get("location"), url);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BYTES) {
            await reader.cancel();
            return new Response("Source response too large", { status: 502 });
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const out = new Headers({
        "x-immojudis-source-relay": "1",
        "cache-control": "no-store",
      });
      const location = response.headers.get("location");
      const normalizedLocation = normalizeRedirectLocation(response.status, location, url);
      for (const name of ["content-type", "location", "retry-after", "cf-mitigated"]) {
        if (response.headers.has(name)) {
          out.set(
            name,
            name === "location" && normalizedLocation !== null
              ? normalizedLocation
              : response.headers.get(name)!,
          );
        }
      }
      const blocked =
        response.headers.get("cf-mitigated") === "challenge" ||
        /<title>\s*(?:Just a moment|Un instant|Access Denied)/i.test(
          new TextDecoder().decode(bytes),
        );
      const status = blocked ? 403 : response.status;
      return new Response([204, 205, 304].includes(status) ? null : bytes, {
        status,
        headers: out,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return new Response("Source fetch failed", { status: 502 });
  }
}
