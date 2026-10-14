import { isIP } from "node:net";
import {
  isInformationAgentExcludedAddress,
  isInformationAgentExcludedSourceUrl,
} from "@/lib/information-agent/excluded-addresses";
import { normalizeInformationAgentIdentityName } from "@/lib/information-agent/identity";
import type { AuctionSale } from "@/lib/types";

/**
 * Extraction pure (aucun réseau) pour la recherche d'adresse sur le site du cabinet ou de l'étude :
 * URL de départ tirées de l'annonce, liens internes utiles, adresses publiées en clair et choix
 * prudent d'une seule adresse. Le moindre doute donne `ambiguous` ou `none` : rien n'est retenu.
 */

export type FirmSiteSale = Pick<
  AuctionSale,
  "lawyer_contact" | "source_blocks" | "source_blocks_by_source" | "source_url" | "source_urls"
>;

// ---------------------------------------------------------------------------
// URL de départ : uniquement celles que l'annonce publie
// ---------------------------------------------------------------------------

const MAX_BLOCK_DEPTH = 6;
/** Clés des blocs source qui portent le site du cabinet ou les coordonnées de l'avocat. */
const SITE_KEYS = /^(?:cabinet_site|site_web|website|site|contact_avocat)$/i;
const URL_IN_TEXT = /(?:https?:\/\/|\bwww\.)[^\s|<>"'`·,;]+/gi;
const INFRASTRUCTURE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
  ".arpa",
];

/** Nom d'hôte public : ni adresse IP, ni `localhost`, ni suffixe d'infrastructure privée. */
export function isPublicFirmHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (!host || isIP(host) !== 0 || !host.includes(".")) return false;
  if (host === "localhost" || INFRASTRUCTURE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return false;
  }
  return /^[a-z0-9.-]+$/.test(host);
}

/** `www.` ôté : `www.cabinet.fr` et `cabinet.fr` désignent le même site. */
export function siteHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

function hostMatches(host: string, other: string): boolean {
  return host === other || host.endsWith(`.${other}`) || other.endsWith(`.${host}`);
}

function walkSiteStrings(value: unknown, depth: number, keyMatches: boolean, out: string[]): void {
  if (depth > MAX_BLOCK_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (keyMatches) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkSiteStrings(item, depth + 1, keyMatches, out);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkSiteStrings(child, depth + 1, SITE_KEYS.test(key), out);
    }
  }
}

function listingHosts(sale: FirmSiteSale): Set<string> {
  const hosts = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") {
      try {
        hosts.add(siteHost(new URL(value.trim()).hostname));
      } catch {
        // URL de l'annonce illisible : rien à exclure.
      }
    } else if (Array.isArray(value)) {
      value.forEach(add);
    } else if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(add);
    }
  };
  add(sale.source_url);
  add(sale.source_urls);
  return hosts;
}

function cleanTrailing(raw: string): string {
  return raw.replace(/[).\]}>!?:]+$/g, "");
}

/**
 * Pages web de départ publiées par l'annonce (champ `lawyer_contact` et blocs source du site ou du
 * contact de l'avocat). Jamais un moteur de recherche : une URL absente de l'annonce n'est pas
 * essayée. Sont écartés : réseaux sociaux, annuaires et sites exclus, site de l'annonce elle-même,
 * hôtes non publics. Une adresse `http` est consultée en `https` (la source stockée l'exige). Au
 * plus une page par site.
 */
export function firmSiteStartUrls(sale: FirmSiteSale): string[] {
  const texts: string[] = [];
  if (typeof sale.lawyer_contact === "string") texts.push(sale.lawyer_contact);
  walkSiteStrings(sale.source_blocks, 0, false, texts);
  walkSiteStrings(sale.source_blocks_by_source, 0, false, texts);

  const own = listingHosts(sale);
  const bySite = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.match(URL_IN_TEXT) ?? []) {
      const candidate = cleanTrailing(match);
      let url: URL;
      try {
        url = new URL(/^www\./i.test(candidate) ? `https://${candidate}` : candidate);
      } catch {
        continue;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (url.username || url.password) continue;
      if (url.port && url.port !== "80" && url.port !== "443") continue;
      if (!isPublicFirmHostname(url.hostname)) continue;
      const site = siteHost(url.hostname);
      if (own.has(site) || [...own].some((host) => hostMatches(site, host))) continue;
      url.protocol = "https:";
      url.port = "";
      url.hash = "";
      if (isInformationAgentExcludedSourceUrl(url.toString())) continue;
      if (!bySite.has(site)) bySite.set(site, url.toString());
    }
  }
  return [...bySite.values()];
}

// ---------------------------------------------------------------------------
// Liens internes : contact, mentions légales, cabinet
// ---------------------------------------------------------------------------

const SKIPPED_EXTENSIONS =
  /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|jpe?g|png|gif|webp|svg|ico|mp[34]|avi|mov|css|js|xml|json)(?:$|\?)/i;
/**
 * Le contenu des pages vient d'un site tiers : tous les motifs sont bornés (pas de `[^>]*` qui
 * traverse un `<`, texte de lien limité à 300 caractères) pour rester linéaires sur un document
 * hostile de 1 Mio.
 */
const ANCHOR = /<a\b[^<>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^<>]*>([^]{0,300}?)<\/a>/gi;
const TAG = /<[^<>]*>/g;

function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function linkPriority(path: string, label: string): number | null {
  const text = foldText(`${decodeURIComponentSafe(path)} ${label}`);
  if (/contact|nous-?joindre|nous-?ecrire/.test(text)) return 0;
  if (/mentions?[-_ ]?legales?|informations?[-_ ]?legales?/.test(text)) return 1;
  if (
    /(?:^|[^a-z])(?:le[-_ ]?cabinet|notre[-_ ]?cabinet|cabinet|l[-_ ]?etude|notre[-_ ]?etude|etude|a[-_ ]?propos|qui[-_ ]?sommes[-_ ]?nous|equipe|presentation)(?:[^a-z]|$)/.test(
      text,
    )
  ) {
    return 2;
  }
  return null;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Liens du même site vers une page de contact, de mentions légales ou de présentation du cabinet,
 * du plus utile au moins utile, sans doublon. Les liens vers un autre domaine, un fichier, un
 * `mailto:` ou `tel:` sont ignorés.
 */
export function extractFirmSiteLinks(html: string, pageUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const site = siteHost(base.hostname);
  const found: Array<{ url: string; priority: number; order: number }> = [];
  const seen = new Set<string>([normalizePageKey(base)]);
  let order = 0;
  for (const match of html.matchAll(ANCHOR)) {
    const href = (match[1] ?? match[2] ?? "").trim();
    if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript|data):/i.test(href)) continue;
    let target: URL;
    try {
      target = new URL(href, base);
    } catch {
      continue;
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") continue;
    if (siteHost(target.hostname) !== site) continue;
    if (target.port && target.port !== "443" && target.port !== "80") continue;
    if (SKIPPED_EXTENSIONS.test(target.pathname + target.search)) continue;
    const label = (match[3] ?? "").replace(TAG, " ").replace(/\s+/g, " ");
    const priority = linkPriority(target.pathname, label);
    if (priority === null) continue;
    target.protocol = "https:";
    target.port = "";
    target.hash = "";
    const key = normalizePageKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ url: target.toString(), priority, order: order++ });
  }
  return found.sort((a, b) => a.priority - b.priority || a.order - b.order).map((l) => l.url);
}

function normalizePageKey(url: URL): string {
  return `${siteHost(url.hostname)}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

// ---------------------------------------------------------------------------
// Adresses publiées en clair
// ---------------------------------------------------------------------------

const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const FILE_LIKE_TLDS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "css",
  "js",
  "woff",
  "woff2",
  "ico",
  "pdf",
  "avif",
  "map",
]);
/** Boîtes qui ne désignent pas l'interlocuteur d'une vente (technique, comptabilité, presse…). */
const NON_INTERLOCUTOR_LOCAL =
  /^(?:webmaster|postmaster|hostmaster|abuse|root|admin|administrateur|support|compta|comptabilite|facturation|rh|recrutement|candidatures?|presse|marketing|commercial|newsletter|unsubscribe|bounce|mailer-daemon|privacy)(?:[._+-]|$)/;

export type PageEmail = { email: string; via: "mailto" | "text" };

/**
 * Retire commentaires, scripts et styles en un seul passage linéaire. Une balise ouvrante sans
 * fermeture (document hostile ou tronqué) retire tout ce qui suit, comme le ferait un navigateur ;
 * la fermeture accepte les espaces, retours à la ligne et attributs (`</script >`, `</SCRIPT\n>`)
 * et les commentaires fermés par `--!>`.
 */
function stripNonContent(html: string): string {
  const opener = /<!--|<script\b|<style\b/gi;
  let output = "";
  let position = 0;
  for (;;) {
    opener.lastIndex = position;
    const open = opener.exec(html);
    if (!open) break;
    output += `${html.slice(position, open.index)} `;
    const kind = open[0].toLowerCase();
    const closer =
      kind === "<!--" ? /--!?>/g : kind === "<script" ? /<\/script\b/gi : /<\/style\b/gi;
    closer.lastIndex = open.index + open[0].length;
    const close = closer.exec(html);
    if (!close) return output;
    let end = close.index + close[0].length;
    if (kind !== "<!--") {
      const tagEnd = html.indexOf(">", end);
      if (tagEnd < 0) return output;
      end = tagEnd + 1;
    }
    position = end;
  }
  return output + html.slice(position);
}

function cleanEmail(value: string): string | null {
  const email = value
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, "");
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) return null;
  const tld = email.slice(email.lastIndexOf(".") + 1);
  if (FILE_LIKE_TLDS.has(tld)) return null;
  const local = email.slice(0, email.lastIndexOf("@"));
  if (local.length > 64 || email.length > 254) return null;
  return email;
}

/**
 * Adresses écrites en clair dans la page : liens `mailto:` et texte visible. Les adresses masquées
 * (Cloudflare `[email protected]`, `data-cfemail`) ne sont jamais décodées, et aucune adresse n'est
 * devinée ou recomposée. Les adresses qui ne peuvent pas être sollicitées (juridiction, RPVA,
 * Ordre, CARPA, noreply, dpo, rgpd) et les boîtes sans rapport avec une vente sont écartées.
 */
export function extractPageEmails(html: string): PageEmail[] {
  const content = stripNonContent(html);
  const result = new Map<string, PageEmail>();
  const add = (raw: string, via: PageEmail["via"]) => {
    const email = cleanEmail(raw);
    if (!email || result.has(email)) return;
    if (isInformationAgentExcludedAddress(email)) return;
    if (NON_INTERLOCUTOR_LOCAL.test(email.slice(0, email.lastIndexOf("@")))) return;
    result.set(email, { email, via });
  };
  for (const match of content.matchAll(/\bhref\s*=\s*(?:"mailto:([^"]*)"|'mailto:([^']*)')/gi)) {
    const target = (match[1] ?? match[2] ?? "").split("?")[0] ?? "";
    for (const part of decodeURIComponentSafe(target).split(/[,;]/)) add(part, "mailto");
  }
  const text = content.replace(TAG, " ");
  for (const match of text.matchAll(EMAIL)) add(match[0], "text");
  return [...result.values()];
}

// ---------------------------------------------------------------------------
// Choix d'une adresse : une seule, ou rien
// ---------------------------------------------------------------------------

const GENERIC_LOCAL =
  /^(?:contact|cabinet|accueil|secretariat|etude|office|avocat|avocats|notaire|notaires|info|infos|reception)$/;

export type FirmAddressChoice =
  | { status: "retained"; email: string; reason: "name" | "generic" }
  | { status: "ambiguous" }
  | { status: "none" };

/**
 * L'adresse est sur le domaine exact du site ou sur l'un de ses sous-domaines (`www.` ôté). Le
 * domaine parent n'est jamais admis : `cabinet.over-blog.com` ne donne pas droit aux adresses de
 * `over-blog.com`.
 */
export function isFirmDomainEmail(email: string, host: string): boolean {
  const domain = siteHost(email.slice(email.lastIndexOf("@") + 1));
  const site = siteHost(host);
  return domain === site || domain.endsWith(`.${site}`);
}

function localSegments(email: string): string[] {
  return foldText(email.slice(0, email.lastIndexOf("@")))
    .split(/[._+-]+/)
    .filter(Boolean);
}

function nameTokens(name: string | null | undefined): string[] {
  return normalizeInformationAgentIdentityName(name)
    .split(" ")
    .filter((token) => token.length >= 3);
}

/**
 * Le nom ET le prénom figurent dans la partie locale, en segments entiers (séparés par `.`, `-`, `_`
 * ou `+`), accolés (`jeandupont`) ou avec l'initiale du prénom (`jdupont`, `j.dupont`). Jamais par
 * simple inclusion : `luc` n'est pas dans `lucie`, `anne` n'est pas dans `jeanne`.
 */
function strongNameMatch(segments: readonly string[], tokens: readonly string[]): boolean {
  const whole = new Set(segments);
  if (tokens.filter((token) => whole.has(token)).length >= 2) return true;
  for (const first of tokens) {
    for (const second of tokens) {
      if (first === second) continue;
      if (segments.some((segment) => segment === first + second)) return true;
      if (first.length < 4) continue;
      const initial = second.charAt(0);
      if (segments.some((segment) => segment === initial + first || segment === first + initial)) {
        return true;
      }
      if (whole.has(first) && segments.some((segment) => segment === initial)) return true;
    }
  }
  return false;
}

/** Vrai quand la partie locale de l'adresse porte le nom et le prénom du professionnel. */
export function emailRecallsName(email: string, name: string | null | undefined): boolean {
  return strongNameMatch(localSegments(email), nameTokens(name));
}

/** `contact@`, `cabinet@`, `secretariat@`… : l'adresse du cabinet ou de l'étude, pas d'une personne. */
export function isGenericEmailLocal(email: string): boolean {
  return GENERIC_LOCAL.test(localSegments(email).join(""));
}

/**
 * Choisit l'adresse du cabinet parmi celles publiées sur ses pages. Seules comptent les adresses du
 * domaine du site ou d'un sous-domaine : une adresse hors de ce domaine (messagerie grand public,
 * agence web) est écartée, elle peut être personnelle. Plusieurs adresses : celle qui porte le nom et
 * le prénom de l'avocat, sinon `contact@`, `cabinet@` et assimilées, à condition qu'une seule
 * convienne. Une adresse unique n'est retenue que si elle est générique ou porte le nom et le prénom
 * de l'avocat (sinon elle peut désigner un autre professionnel). Tout autre cas est une ambiguïté.
 */
export function chooseFirmAddress({
  emails,
  siteHostname,
  lawyerName,
}: {
  emails: readonly string[];
  siteHostname: string;
  lawyerName: string | null | undefined;
}): FirmAddressChoice {
  const inFirm = [...new Set(emails)].filter((email) => isFirmDomainEmail(email, siteHostname));
  if (!inFirm.length) return { status: "none" };
  const named = inFirm.filter((email) => emailRecallsName(email, lawyerName));
  if (named.length === 1) return { status: "retained", email: named[0]!, reason: "name" };
  if (named.length > 1) return { status: "ambiguous" };
  const generic = inFirm.filter(isGenericEmailLocal);
  if (generic.length === 1) return { status: "retained", email: generic[0]!, reason: "generic" };
  return { status: "ambiguous" };
}

// ---------------------------------------------------------------------------
// Page d'obstacle (captcha, défi anti-robot)
// ---------------------------------------------------------------------------

/**
 * Vrai pour une page de vérification anti-robot (défi Cloudflare, captcha plein écran). Un
 * formulaire de contact qui embarque un captcha n'est pas un obstacle : la page garde son contenu.
 */
export function isChallengePage(html: string): boolean {
  const head = html.slice(0, 200_000);
  if (/__cf_chl|cf-chl-|challenge-platform|cf-browser-verification/i.test(head)) return true;
  const title = /<title[^<>]*>([^<]{0,300})/i.exec(head)?.[1] ?? "";
  if (
    /just a moment|attention required|access denied|verify(?:ing)? you are (?:a )?human|are you a robot|vérification de sécurité|verification de securite/i.test(
      title,
    )
  ) {
    return true;
  }
  const visibleText = stripNonContent(head).replace(TAG, " ").replace(/\s+/g, " ").trim();
  return /captcha|recaptcha|hcaptcha|turnstile/i.test(head) && visibleText.length < 600;
}
