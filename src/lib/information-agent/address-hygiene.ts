/**
 * Hygiène des adresses que l'agent d'information peut solliciter : longueurs, artefacts d'extraction
 * (lien `mailto:`, nom de fichier image pris pour une adresse, entité HTML), domaines réservés
 * (RFC 2606 et 6761 : `.test`, `.example`, `.invalid`, `.local`, `.localhost`, `example.com|org|net`)
 * et domaines de messagerie grand public.
 *
 * Module pur (aucun accès réseau ni base) : testable sans environnement. La résolution DNS est dans
 * `address-deliverability.ts`.
 */
export type InformationAgentAddressHygieneIssue =
  | "too_long"
  | "artifact"
  | "reserved_domain"
  | "invalid_domain";

const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost", "local", "internal"]);
const RESERVED_DOMAINS = new Set(["example.com", "example.org", "example.net", "localhost"]);
/** Extensions de fichiers : `logo@2x.png` est un nom d'image, pas une adresse. */
const FILE_EXTENSION_TLDS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
  "pdf",
  "css",
  "js",
  "woff",
  "woff2",
  "ttf",
  "eot",
]);
const ARTIFACT_PATTERN = /%|\.\.|&|[<>"\\\s,;:()[\]{}]|mailto|u003[cde]|&#|^[.-]|[.-]$/i;

export function informationAgentAddressHygieneIssue(
  email: string,
): InformationAgentAddressHygieneIssue | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return "invalid_domain";
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const labels = domain.split(".");
  if (
    normalized.length > MAX_ADDRESS_LENGTH ||
    local.length > MAX_LOCAL_LENGTH ||
    domain.length > MAX_DOMAIN_LENGTH ||
    labels.some((label) => label.length > MAX_LABEL_LENGTH)
  ) {
    return "too_long";
  }
  const tld = labels[labels.length - 1] ?? "";
  if (
    ARTIFACT_PATTERN.test(local) ||
    ARTIFACT_PATTERN.test(domain) ||
    FILE_EXTENSION_TLDS.has(tld) ||
    labels.some((label) => !label || label.startsWith("-") || label.endsWith("-"))
  ) {
    return "artifact";
  }
  if (labels.length < 2) return "invalid_domain";
  if (RESERVED_TLDS.has(tld) || RESERVED_DOMAINS.has(domain)) return "reserved_domain";
  return null;
}

export const INFORMATION_AGENT_ADDRESS_HYGIENE_MESSAGES: Record<
  InformationAgentAddressHygieneIssue,
  string
> = {
  too_long: "Adresse trop longue pour être valide : l’agent ne l’utilise pas.",
  artifact:
    "Adresse issue d’une extraction défectueuse (caractère parasite, lien, nom de fichier) : vérifiez-la à la source.",
  reserved_domain:
    "Adresse d’un domaine réservé (test, exemple, local) : elle ne peut pas exister.",
  invalid_domain: "Adresse sans domaine valide : l’agent ne l’utilise pas.",
};

/**
 * Messageries grand public : une adresse personnelle n'est pas une adresse professionnelle. Exclues du
 * pilote automatique (la validation manuelle reste possible). Comparaison sur le premier libellé du
 * domaine (`gmail.com`, `orange.fr`, `yahoo.co.uk`…).
 */
export const INFORMATION_AGENT_CONSUMER_MAIL_BRANDS: readonly string[] = [
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "yahoo",
  "orange",
  "wanadoo",
  "free",
  "sfr",
  "neuf",
  "laposte",
  "icloud",
  "me",
  "aol",
  "proton",
  "protonmail",
  "gmx",
  "bbox",
];

const CONSUMER_BRANDS = new Set(INFORMATION_AGENT_CONSUMER_MAIL_BRANDS);

export function isConsumerMailAddress(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  const labels = domain.split(".").filter(Boolean);
  if (labels.length === 2) return CONSUMER_BRANDS.has(labels[0]);
  return (
    labels.length === 3 &&
    (labels[1] === "co" || labels[1] === "com") &&
    CONSUMER_BRANDS.has(labels[0])
  );
}

export function mailDomainOf(email: string): string {
  return email.trim().toLowerCase().split("@").pop() ?? "";
}
