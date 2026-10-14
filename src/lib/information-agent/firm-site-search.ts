import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  chooseFirmAddress,
  extractFirmSiteLinks,
  extractPageEmails,
  isChallengePage,
  isPublicFirmHostname,
  siteHost,
} from "@/lib/information-agent/firm-site-extract";
import { isInformationAgentExcludedSourceUrl } from "@/lib/information-agent/excluded-addresses";
import { evaluateRobots } from "@/lib/information-agent/robots";

/**
 * Recherche de l'adresse du professionnel sur le site de son cabinet ou de son étude (niveau 1).
 *
 * Garde-fous (avis juridique du 14/10/2026, `docs/rgpd-mise-en-balance-agent-information.md`) :
 * - la page de départ vient de l'annonce, jamais d'un moteur de recherche ;
 * - au plus 3 pages par domaine, en GET, après lecture de `robots.txt` (refus si le fichier
 *   interdit la page, est illisible ou répond autre chose que 200, 404 ou 410) ;
 * - aucune requête hors du domaine de départ (redirections comprises), jamais d'adresse IP, de
 *   port particulier ni d'hôte résolu vers un réseau privé ;
 * - arrêt immédiat sur 401, 403, 429, erreur serveur, captcha ou défi anti-robot ;
 * - user-agent qui identifie Immojudis, expiration courte par requête et budget de temps global ;
 * - aucune copie de page : seuls l'adresse retenue, l'adresse web de la page et le nombre de pages
 *   lues sont rendus. Le contenu des pages n'est ni stocké ni journalisé.
 */

/** Jeton de produit de `robots.txt` (minuscules) : les éditeurs peuvent nous exclure par ce nom. */
export const INFORMATION_AGENT_ROBOTS_TOKEN = "immojudisadresses";
export const FIRM_SITE_MAX_PAGES = 3;
const MAX_REDIRECTS = 2;
const MAX_BODY_BYTES = 1_048_576;
const MAX_ROBOTS_CRAWL_DELAY_SECONDS = 10;
const DEFAULT_BUDGET_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_PAUSE_MS = 600;

/** User-agent de l'outil : le jeton `ImmojudisAdresses` et la page de contact du site. */
export function informationAgentSearchUserAgent(siteOrigin: string): string {
  return `ImmojudisAdresses/1.0 (+${siteOrigin.replace(/\/+$/, "")}/contact)`;
}

export type FirmSiteSearchStatus =
  | "found"
  | "none"
  | "ambiguous"
  | "robots_disallowed"
  | "robots_unreadable"
  | "blocked"
  | "unreachable"
  | "budget"
  | "invalid_url";

export type FirmSiteSearchResult = {
  status: FirmSiteSearchStatus;
  /** Domaine consulté (sans `www.`), pour la trace de l'administrateur. */
  host: string | null;
  /** Pages lues, `robots.txt` exclu. Au plus `FIRM_SITE_MAX_PAGES`. */
  pagesFetched: number;
  email?: string;
  /** Page (https) où l'adresse retenue figure. */
  pageUrl?: string;
  reason?: "single" | "name" | "generic" | "offsite_name";
};

export type FirmSiteSearchDeps = {
  fetchImpl?: typeof fetch;
  lookupImpl?: (hostname: string) => Promise<Array<{ address: string }>>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const value = address.toLowerCase();
    if (value === "::" || value === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped?.[1]) return isPrivateNetworkAddress(mapped[1]);
    if (value.startsWith("::ffff:") || value.startsWith("64:ff9b:")) return true;
    const first = Number.parseInt(value.split(":")[0] || "0", 16);
    return (
      (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
    );
  }
  return true;
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string }>> {
  return dnsLookup(hostname, { all: true });
}

type FetchOutcome =
  | { kind: "ok"; url: string; body: string }
  | { kind: "blocked" }
  | { kind: "server_error" }
  | { kind: "client_error"; status: number }
  | { kind: "wrong_type" }
  | { kind: "disallowed" }
  | { kind: "offsite" }
  | { kind: "failed" }
  | { kind: "budget" };

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, MAX_BODY_BYTES);
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (received >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text + decoder.decode();
}

export async function searchFirmWebsiteAddress({
  startUrl,
  lawyerName,
  userAgent,
  budgetMs = DEFAULT_BUDGET_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  pauseMs = DEFAULT_PAUSE_MS,
  signal,
  deps = {},
}: {
  startUrl: string;
  lawyerName: string | null | undefined;
  userAgent: string;
  budgetMs?: number;
  requestTimeoutMs?: number;
  /** Pause entre deux requêtes au même site. */
  pauseMs?: number;
  signal?: AbortSignal;
  deps?: FirmSiteSearchDeps;
}): Promise<FirmSiteSearchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookupImpl = deps.lookupImpl ?? defaultLookup;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = deps.now ?? Date.now;

  let start: URL;
  try {
    start = new URL(startUrl);
  } catch {
    return { status: "invalid_url", host: null, pagesFetched: 0 };
  }
  const site = siteHost(start.hostname);
  if (
    start.protocol !== "https:" ||
    start.username ||
    start.password ||
    (start.port && start.port !== "443") ||
    !isPublicFirmHostname(start.hostname) ||
    isInformationAgentExcludedSourceUrl(start.toString())
  ) {
    return { status: "invalid_url", host: null, pagesFetched: 0 };
  }
  start.hash = "";

  const deadline = now() + budgetMs;
  const remaining = () => deadline - now();
  const result = (
    status: FirmSiteSearchStatus,
    pagesFetched: number,
    extra: Partial<FirmSiteSearchResult> = {},
  ): FirmSiteSearchResult => ({ status, host: site, pagesFetched, ...extra });

  const resolved = new Map<string, boolean>();
  async function resolvesPublicly(hostname: string): Promise<boolean> {
    const cached = resolved.get(hostname);
    if (cached !== undefined) return cached;
    let ok: boolean;
    try {
      const addresses = await lookupImpl(hostname);
      ok =
        addresses.length > 0 && addresses.every(({ address }) => !isPrivateNetworkAddress(address));
    } catch {
      ok = false;
    }
    resolved.set(hostname, ok);
    return ok;
  }

  let lastRequestAt: number | null = null;
  let currentPauseMs = pauseMs;

  async function get(
    url: string,
    expect: "html" | "robots",
    isAllowed: (target: URL) => boolean = () => true,
  ): Promise<FetchOutcome> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let target: URL;
      try {
        target = new URL(current);
      } catch {
        return { kind: "failed" };
      }
      // Jamais hors du domaine de départ, jamais en clair, jamais sur un port particulier.
      if (
        target.protocol !== "https:" ||
        siteHost(target.hostname) !== site ||
        target.username ||
        target.password ||
        (target.port && target.port !== "443")
      ) {
        return { kind: "offsite" };
      }
      // Une redirection ne contourne pas `robots.txt` : le nouveau chemin est contrôlé à son tour.
      if (!isAllowed(target)) return { kind: "disallowed" };
      if (!(await resolvesPublicly(target.hostname))) return { kind: "failed" };

      if (lastRequestAt !== null) {
        const wait = Math.min(Math.max(0, lastRequestAt + currentPauseMs - now()), remaining());
        if (wait > 0) await sleep(wait);
      }
      const timeout = Math.min(requestTimeoutMs, remaining());
      if (timeout <= 0 || signal?.aborted) return { kind: "budget" };
      lastRequestAt = now();

      let response: Response;
      try {
        const signals = [AbortSignal.timeout(timeout)];
        if (signal) signals.push(signal);
        response = await fetchImpl(target.toString(), {
          method: "GET",
          redirect: "manual",
          headers: {
            "user-agent": userAgent,
            accept: expect === "robots" ? "text/plain" : "text/html,application/xhtml+xml",
            "accept-language": "fr-FR,fr;q=0.9",
          },
          signal: AbortSignal.any(signals),
        });
      } catch {
        return remaining() <= 0 ? { kind: "budget" } : { kind: "failed" };
      }

      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) return { kind: "client_error", status };
        try {
          current = new URL(location, target).toString();
        } catch {
          return { kind: "failed" };
        }
        continue;
      }
      if (status === 401 || status === 403 || status === 429) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "blocked" };
      }
      if (status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "server_error" };
      }
      if (status < 200 || status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "client_error", status };
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const isHtml = /html/.test(contentType);
      if ((expect === "html" && !isHtml) || (expect === "robots" && isHtml)) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "wrong_type" };
      }
      try {
        return { kind: "ok", url: target.toString(), body: await readCapped(response) };
      } catch {
        return { kind: "failed" };
      }
    }
    return { kind: "offsite" };
  }

  // 1. robots.txt : refus s'il interdit la page, s'il est illisible ou si le site nous bloque.
  const robots = await get(new URL("/robots.txt", start).toString(), "robots");
  let robotsText: string | null = null;
  if (robots.kind === "ok") {
    robotsText = robots.body;
  } else if (robots.kind === "client_error" && (robots.status === 404 || robots.status === 410)) {
    robotsText = null;
  } else if (robots.kind === "blocked") {
    return result("blocked", 0);
  } else if (robots.kind === "budget") {
    return result("budget", 0);
  } else {
    return result("robots_unreadable", 0);
  }

  // 2. Au plus 3 pages : la page de départ, puis les liens internes de contact ou de présentation.
  const queue: string[] = [start.toString()];
  const visited = new Set<string>();
  const emailPages = new Map<string, string>();
  let pages = 0;
  let disallowed = 0;
  let readable = 0;
  let sawAmbiguity = false;

  while (queue.length && pages < FIRM_SITE_MAX_PAGES) {
    const pageUrl = queue.shift()!;
    const parsed = new URL(pageUrl);
    const key = `${siteHost(parsed.hostname)}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
    if (visited.has(key)) continue;
    visited.add(key);

    let crawlDelaySeconds: number | null = null;
    const pathAllowed = (target: URL): boolean => {
      if (robotsText === null) return true;
      const verdict = evaluateRobots(
        robotsText,
        `${target.pathname}${target.search}`,
        INFORMATION_AGENT_ROBOTS_TOKEN,
      );
      crawlDelaySeconds = verdict.crawlDelaySeconds;
      return verdict.allowed;
    };
    if (!pathAllowed(parsed)) {
      disallowed += 1;
      continue;
    }
    if (crawlDelaySeconds !== null) {
      if (crawlDelaySeconds > MAX_ROBOTS_CRAWL_DELAY_SECONDS) {
        return result("robots_disallowed", pages);
      }
      currentPauseMs = Math.max(currentPauseMs, crawlDelaySeconds * 1000);
    }

    pages += 1;
    const page = await get(pageUrl, "html", pathAllowed);
    if (page.kind === "disallowed") {
      disallowed += 1;
      continue;
    }
    if (page.kind === "blocked") return result("blocked", pages);
    if (page.kind === "budget") return result("budget", pages);
    if (page.kind === "server_error" || page.kind === "failed") return result("unreachable", pages);
    if (page.kind !== "ok") continue;
    if (isChallengePage(page.body)) return result("blocked", pages);

    readable += 1;
    for (const { email } of extractPageEmails(page.body)) {
      if (!emailPages.has(email)) emailPages.set(email, page.url);
    }
    if (readable === 1) {
      queue.push(...extractFirmSiteLinks(page.body, page.url).slice(0, FIRM_SITE_MAX_PAGES - 1));
    }

    const choice = chooseFirmAddress({
      emails: [...emailPages.keys()],
      siteHostname: site,
      lawyerName,
    });
    if (choice.status === "retained") {
      return result("found", pages, {
        email: choice.email,
        pageUrl: emailPages.get(choice.email),
        reason: choice.reason,
      });
    }
    if (choice.status === "ambiguous") sawAmbiguity = true;
  }

  if (!pages && disallowed) return result("robots_disallowed", 0);
  if (!readable) return result(disallowed ? "robots_disallowed" : "unreachable", pages);
  return result(sawAmbiguity ? "ambiguous" : "none", pages);
}
