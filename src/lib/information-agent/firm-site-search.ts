import "server-only";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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
 *   port particulier ni d'hôte résolu vers un réseau non public : la résolution DNS se fait AU
 *   MOMENT de la connexion (option `lookup` de `https.request`), l'adresse contrôlée est celle à
 *   laquelle on se connecte (pas de réécriture DNS entre contrôle et connexion) ;
 * - arrêt immédiat sur 401, 403, 429, erreur serveur, captcha ou défi anti-robot ;
 * - user-agent qui identifie Immojudis, expiration courte par requête, budget de temps global,
 *   plafond de requêtes et de 1 Mio de contenu décompressé par page ;
 * - aucune copie de page : seuls l'adresse retenue, l'adresse web de la page et le nombre de pages
 *   lues sont rendus. Le contenu des pages n'est ni stocké ni journalisé.
 */

/** Jeton de produit de `robots.txt` (minuscules) : les éditeurs peuvent nous exclure par ce nom. */
export const INFORMATION_AGENT_ROBOTS_TOKEN = "immojudisadresses";
export const FIRM_SITE_MAX_PAGES = 3;
/** robots.txt, 3 pages et 2 redirections au plus par page : jamais plus de 8 requêtes par site. */
export const FIRM_SITE_MAX_REQUESTS = 8;
const MAX_REDIRECTS = 2;
const MAX_BODY_BYTES = 1_048_576;
const MAX_ROBOTS_CRAWL_DELAY_SECONDS = 10;
const DEFAULT_BUDGET_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_PAUSE_MS = 600;
const DNS_TIMEOUT_MS = 3_000;

/**
 * User-agent de l'outil : le jeton `ImmojudisAdresses` et la page de contact du site.
 * À REMPLACER par la page `/agent-information` quand elle sera publiée : c'est une condition
 * d'activation de la recherche (voir le runbook de l'agent d'information).
 */
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
  /** `name` : nom et prénom de l'avocat dans l'adresse ; `generic` : adresse du cabinet. */
  reason?: "name" | "generic";
};

export type FirmSiteLookup = (hostname: string) => Promise<Array<{ address: string }>>;

export type FirmSiteTransportRequest = {
  url: URL;
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Plafond de contenu décompressé, en octets. */
  maxBytes: number;
  dnsTimeoutMs: number;
};

export type FirmSiteTransportResponse = {
  status: number;
  location: string | null;
  contentType: string;
  body: string;
  /** Le contenu dépassait `maxBytes` et a été coupé. */
  truncated: boolean;
};

export type FirmSiteTransport = (
  request: FirmSiteTransportRequest,
) => Promise<FirmSiteTransportResponse>;

export type FirmSiteSearchDeps = {
  /** Transport HTTP (tests) ; par défaut `https.request` avec résolution DNS contrôlée. */
  transport?: FirmSiteTransport;
  /** Résolution DNS du transport par défaut (tests). */
  lookupImpl?: FirmSiteLookup;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Adresses réseau : liste d'autorisation
// ---------------------------------------------------------------------------

function expandIpv6(address: string): number[] | null {
  let value = address.toLowerCase().split("%")[0] ?? "";
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    value = `${value.slice(0, value.length - dotted[0].length)}${high}:${low}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const numbers = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
  );
  return numbers.length === 8 && numbers.every((n) => Number.isInteger(n)) ? numbers : null;
}

/**
 * Vrai pour toute adresse qui n'est pas une adresse publique routable. IPv4 : liste d'exclusion des
 * plages privées, locales et réservées. IPv6 : liste d'AUTORISATION, seul l'unicast global
 * (2000::/3) est admis, hors Teredo (2001::/32), documentation (2001:db8::/32) et 6to4 (2002::/16) ;
 * les formes IPv4-mappées (`::ffff:a.b.c.d`, développées ou non) suivent la règle IPv4 et les
 * IPv4-compatibles (`::7f00:1`) sont refusées. L'adresse est développée avant toute comparaison.
 */
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
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family !== 6) return true;
  const groups = expandIpv6(address);
  if (!groups) return true;
  if (groups.slice(0, 5).every((group) => group === 0)) {
    if (groups[5] !== 0xffff) return true;
    const [high = 0, low = 0] = groups.slice(6);
    return isPrivateNetworkAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = groups[0]!;
  if ((first & 0xe000) !== 0x2000) return true;
  // 2001::/23 (Teredo, protocole IETF, benchmarking, ORCHID…), 2001:db8::/32, 6to4, 3fff::/20.
  const second = groups[1]!;
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return true;
  return first === 0x2002 || (first === 0x3fff && second < 0x1000);
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string }>> {
  return dnsLookup(hostname, { all: true });
}

/**
 * Fonction `lookup` de `https.request` : résout le nom, refuse l'ensemble des adresses dès que l'une
 * n'est pas publique, et ne rend à la connexion que les adresses contrôlées. La résolution est
 * bornée dans le temps.
 */
export function createPublicOnlyLookup(
  lookupImpl: FirmSiteLookup,
  dnsTimeoutMs: number = DNS_TIMEOUT_MS,
): LookupFunction {
  return (hostname, options, callback) => {
    const wantsAll = typeof options === "object" && options !== null && options.all === true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(Object.assign(new Error("Résolution DNS trop longue."), { code: "EDNSTIMEOUT" })),
        dnsTimeoutMs,
      );
    });
    Promise.race([lookupImpl(hostname), timeout]).then(
      (addresses) => {
        clearTimeout(timer);
        if (
          !addresses.length ||
          addresses.some(({ address }) => isPrivateNetworkAddress(address))
        ) {
          callback(
            Object.assign(new Error("Adresse réseau non publique refusée."), {
              code: "EPRIVATEADDRESS",
            }) as NodeJS.ErrnoException,
            "",
            0,
          );
          return;
        }
        // La famille demandée par la connexion est respectée (après contrôle de TOUTES les adresses).
        const wanted = typeof options === "object" && options !== null ? options.family : options;
        const family =
          wanted === 4 || wanted === "IPv4" ? 4 : wanted === 6 || wanted === "IPv6" ? 6 : 0;
        const resolved = addresses
          .map(({ address }) => ({ address, family: isIP(address) }))
          .filter((entry) => !family || entry.family === family);
        if (!resolved.length) {
          callback(
            Object.assign(new Error("Aucune adresse de la famille demandée."), {
              code: "ENOTFOUND",
            }) as NodeJS.ErrnoException,
            "",
            0,
          );
          return;
        }
        if (wantsAll) callback(null, resolved);
        else callback(null, resolved[0]!.address, resolved[0]!.family);
      },
      (error: unknown) => {
        clearTimeout(timer);
        callback(error as NodeJS.ErrnoException, "", 0);
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Transport HTTPS par défaut
// ---------------------------------------------------------------------------

function decoderFor(encoding: string) {
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  return null;
}

/**
 * Transport réel : `https.request` avec résolution DNS contrôlée à la connexion, SNI et `Host`
 * d'origine, aucune redirection suivie, contenu décompressé plafonné à `maxBytes`.
 */
export function createHttpsTransport({
  lookupImpl = defaultLookup,
}: { lookupImpl?: FirmSiteLookup } = {}): FirmSiteTransport {
  return (request) =>
    new Promise<FirmSiteTransportResponse>((resolve, reject) => {
      // Défense en profondeur : le contrôle des adresses passe par la résolution d'un NOM d'hôte ;
      // une adresse IP littérale (sans crochets pour IPv6) n'est jamais jointe.
      if (isIP(request.url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
        reject(new Error("Adresse IP littérale refusée."));
        return;
      }
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        action();
      };
      const req = httpsRequest(
        {
          protocol: "https:",
          hostname: request.url.hostname,
          port: 443,
          path: `${request.url.pathname}${request.url.search}`,
          method: "GET",
          headers: { ...request.headers, "accept-encoding": "gzip, deflate, br" },
          agent: false,
          signal: request.signal,
          lookup: createPublicOnlyLookup(lookupImpl, request.dnsTimeoutMs),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = typeof res.headers.location === "string" ? res.headers.location : null;
          const contentType = String(res.headers["content-type"] ?? "");
          const head = { status, location, contentType };
          if (status < 200 || status >= 300) {
            settle(() => resolve({ ...head, body: "", truncated: false }));
            res.destroy();
            return;
          }
          const encoding = String(res.headers["content-encoding"] ?? "")
            .toLowerCase()
            .trim();
          const decoder = decoderFor(encoding);
          if (encoding && encoding !== "identity" && !decoder) {
            settle(() => reject(new Error("Encodage de contenu non pris en charge.")));
            res.destroy();
            return;
          }
          const stream: Readable = decoder ? res.pipe(decoder) : res;
          const chunks: Buffer[] = [];
          let total = 0;
          const done = (truncated: boolean) =>
            settle(() =>
              resolve({ ...head, body: Buffer.concat(chunks).toString("utf8"), truncated }),
            );
          stream.on("data", (chunk: Buffer) => {
            if (settled) return;
            const room = request.maxBytes - total;
            if (chunk.length > room) {
              chunks.push(chunk.subarray(0, room));
              total += room;
              done(true);
              res.destroy();
              stream.destroy();
              return;
            }
            chunks.push(chunk);
            total += chunk.length;
          });
          stream.on("end", () => done(false));
          stream.on("error", (error) => settle(() => reject(error)));
          res.on("error", (error) => settle(() => reject(error)));
          res.on("close", () => {
            if (!res.complete) settle(() => reject(new Error("Connexion interrompue.")));
          });
        },
      );
      req.on("error", (error) => settle(() => reject(error)));
      req.end();
    });
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

/** Rejette dès que `signal` est abandonné, même si le transport ne l'écoute pas. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Évite un rejet non traité si la requête échoue après l'abandon.
    promise.catch(() => undefined);
    const onAbort = () => reject(signal.reason ?? new Error("Requête abandonnée."));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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
  const transport = deps.transport ?? createHttpsTransport({ lookupImpl: deps.lookupImpl });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = deps.now ?? Date.now;

  let start: URL;
  try {
    start = new URL(startUrl);
  } catch {
    return { status: "invalid_url", host: null, pagesFetched: 0 };
  }
  // `cabinet.fr.` et `cabinet.fr` sont le même hôte (le point final est ôté, SNI compris).
  start.hostname = start.hostname.replace(/\.$/, "");
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

  let lastRequestAt: number | null = null;
  let currentPauseMs = pauseMs;
  let requests = 0;

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
      target.hostname = target.hostname.replace(/\.$/, "");
      // Une redirection ne contourne pas `robots.txt` : le nouveau chemin est contrôlé à son tour.
      if (!isAllowed(target)) return { kind: "disallowed" };
      // Les redirections comptent dans le plafond de requêtes.
      if (requests >= FIRM_SITE_MAX_REQUESTS) return { kind: "budget" };

      if (lastRequestAt !== null) {
        const wait = Math.min(Math.max(0, lastRequestAt + currentPauseMs - now()), remaining());
        if (wait > 0) await sleep(wait);
      }
      const timeout = Math.min(requestTimeoutMs, remaining());
      if (timeout <= 0 || signal?.aborted) return { kind: "budget" };
      requests += 1;
      lastRequestAt = now();

      let response: FirmSiteTransportResponse;
      try {
        const abort = AbortSignal.any(
          signal ? [AbortSignal.timeout(timeout), signal] : [AbortSignal.timeout(timeout)],
        );
        response = await raceAbort(
          transport({
            url: target,
            headers: {
              "user-agent": userAgent,
              accept: expect === "robots" ? "text/plain" : "text/html,application/xhtml+xml",
              "accept-language": "fr-FR,fr;q=0.9",
            },
            signal: abort,
            maxBytes: MAX_BODY_BYTES,
            dnsTimeoutMs: Math.max(1, Math.min(remaining(), DNS_TIMEOUT_MS)),
          }),
          abort,
        );
      } catch {
        return remaining() <= 0 ? { kind: "budget" } : { kind: "failed" };
      }

      const status = response.status;
      if (status >= 300 && status < 400) {
        if (!response.location) return { kind: "client_error", status };
        try {
          current = new URL(response.location, target).toString();
        } catch {
          return { kind: "failed" };
        }
        continue;
      }
      if (status === 401 || status === 403 || status === 429) return { kind: "blocked" };
      if (status >= 500) return { kind: "server_error" };
      if (status < 200 || status >= 300) return { kind: "client_error", status };
      const isHtml = /html/i.test(response.contentType);
      if ((expect === "html" && !isHtml) || (expect === "robots" && isHtml)) {
        return { kind: "wrong_type" };
      }
      // Contenu coupé à 1 Mio : le dernier mot est peut-être incomplet (adresse tronquée), on l'ôte.
      const body = response.truncated ? response.body.replace(/\S*$/, "") : response.body;
      return { kind: "ok", url: target.toString(), body };
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
  let choice: ReturnType<typeof chooseFirmAddress> = { status: "none" };

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

    choice = chooseFirmAddress({
      emails: [...emailPages.keys()],
      siteHostname: site,
      lawyerName,
    });
    // On ne s'arrête qu'à une correspondance forte (nom ET prénom de l'avocat, dans le domaine du
    // cabinet) ; une adresse générique est confirmée par la lecture des pages de contact.
    if (choice.status === "retained" && choice.reason === "name") break;
    if (choice.status === "ambiguous") sawAmbiguity = true;
  }

  if (choice.status === "retained") {
    return result("found", pages, {
      email: choice.email,
      pageUrl: emailPages.get(choice.email),
      reason: choice.reason,
    });
  }
  if (!pages && disallowed) return result("robots_disallowed", 0);
  if (!readable) return result(disallowed ? "robots_disallowed" : "unreachable", pages);
  return result(sawAmbiguity || choice.status === "ambiguous" ? "ambiguous" : "none", pages);
}
