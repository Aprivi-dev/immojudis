import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Lien suivi d'un email (alertes, rappels d'audience, récapitulatif hebdomadaire, alerte de résultat) : redirection de suivi signée (point 65).
 *
 * Le lien de l'email est `/api/email/click?token=…`. Le jeton, signé et daté, porte quatre choses :
 * le compte, le type d'email, la vente et la destination (`sale` : fiche de la vente, `calendar` :
 * fichier .ics). L'adresse d'arrivée n'est jamais lue dans le jeton ni dans la requête : elle est
 * reconstruite par `emailClickPath`, à partir de ces seules valeurs fermées, sous la forme d'un chemin
 * du site. Aucun paramètre ouvert, donc aucune redirection ouverte (open redirect), même si un jeton
 * était forgé ou rejoué.
 *
 * Même clé dérivée que les liens de désinscription (`EMAIL_UNSUBSCRIBE_SECRET`, sinon la clé de service),
 * avec une étiquette propre : un jeton de désinscription ne vaut jamais jeton de suivi, et inversement.
 */
export const EMAIL_CLICK_TOKEN_TTL_DAYS = 90;

/**
 * Liste fermée des emails dont les liens sont suivis : `alert` (récapitulatif d'alertes), `reminder`
 * (rappels d'audience et avertissements), `weekly` (récapitulatif hebdomadaire « Ma semaine ») et
 * `result` (alerte de résultat ou de remise en vente). La contrainte `account_product_events_type_detail_check`
 * (migration 20261030120400) reprend la même liste.
 */
export type EmailClickKind = "alert" | "reminder" | "weekly" | "result";
export type EmailClickTarget = "sale" | "calendar";

export type EmailClickClaims = {
  userId: string;
  kind: EmailClickKind;
  target: EmailClickTarget;
  saleId: string;
  expiresAt: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: ReadonlySet<string> = new Set<EmailClickKind>([
  "alert",
  "reminder",
  "weekly",
  "result",
]);
const TARGETS: ReadonlySet<string> = new Set<EmailClickTarget>(["sale", "calendar"]);

function signingKey(env: Pick<NodeJS.ProcessEnv, string> = process.env): string {
  const dedicated = env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
  const base =
    dedicated || env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_SECRET_KEY?.trim();
  if (!base) throw new Error("Aucun secret disponible pour signer les liens suivis.");
  return createHmac("sha256", base).update("immojudis:email-click:v1").digest("hex");
}

function sign(payload: string, env?: Pick<NodeJS.ProcessEnv, string>): string {
  return createHmac("sha256", signingKey(env)).update(payload).digest("base64url");
}

export function createEmailClickToken({
  userId,
  kind,
  target,
  saleId,
  now = new Date(),
  env,
}: {
  userId: string;
  kind: EmailClickKind;
  target: EmailClickTarget;
  saleId: string;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + EMAIL_CLICK_TOKEN_TTL_DAYS * 86_400;
  const payload = Buffer.from(
    JSON.stringify({ u: userId, k: kind, t: target, s: saleId.toLowerCase(), e: expiresAt }),
  ).toString("base64url");
  return `${payload}.${sign(payload, env)}`;
}

/**
 * Lit un jeton. `null` : jeton absent, mal formé ou à la signature fausse (rien n'est cru). Sinon les
 * revendications et `expired` : un jeton authentique mais périmé reste lisible pour que la personne
 * arrive tout de même sur la vente, mais son clic n'est pas mesuré.
 */
export function readEmailClickToken(
  token: string | null | undefined,
  { now = new Date(), env }: { now?: Date; env?: Pick<NodeJS.ProcessEnv, string> } = {},
): { claims: EmailClickClaims; expired: boolean } | null {
  if (!token || token.length > 1_000) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  let expected: string;
  try {
    expected = sign(payload, env);
  } catch {
    return null;
  }
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u?: unknown;
      k?: unknown;
      t?: unknown;
      s?: unknown;
      e?: unknown;
    };
    if (typeof data.u !== "string" || !UUID_PATTERN.test(data.u)) return null;
    if (typeof data.s !== "string" || !UUID_PATTERN.test(data.s)) return null;
    if (typeof data.k !== "string" || !KINDS.has(data.k)) return null;
    if (typeof data.t !== "string" || !TARGETS.has(data.t)) return null;
    if (typeof data.e !== "number") return null;
    return {
      claims: {
        userId: data.u,
        kind: data.k as EmailClickKind,
        target: data.t as EmailClickTarget,
        saleId: data.s.toLowerCase(),
        expiresAt: data.e,
      },
      expired: data.e * 1000 < now.getTime(),
    };
  } catch {
    return null;
  }
}

/** Un identifiant de vente peut figurer dans un lien suivi s'il s'agit d'un UUID. */
export function isEmailClickSaleId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Chemin du site où mène un lien suivi : construit ici, jamais lu dans la requête. */
export function emailClickPath(claims: Pick<EmailClickClaims, "target" | "saleId">): string {
  const id = encodeURIComponent(claims.saleId.toLowerCase());
  return claims.target === "calendar" ? `/api/sales/${id}/calendar` : `/sales/${id}`;
}

/** Adresse complète du lien suivi à placer dans l'email. */
export function emailClickUrl({
  appUrl,
  ...tokenInput
}: Parameters<typeof createEmailClickToken>[0] & { appUrl: string }): string {
  return `${appUrl}/api/email/click?token=${encodeURIComponent(createEmailClickToken(tokenInput))}`;
}
