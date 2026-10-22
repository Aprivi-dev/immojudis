import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { isAvailableInformationAgentStatus } from "@/lib/admin-information-agent-sale";
import { formatInformationAgentOriginDate } from "@/lib/information-agent-compliance";
import { normalizedEmail } from "@/lib/information-agent/contacts";

/**
 * Contrôles d'un brouillon de l'agent d'information avant l'aperçu et l'envoi (vente relue, au
 * moins une question, vente déjà sollicitée) et mise en forme du texte (salutation, signature,
 * titre court de l'objet). Extraits de `information-agent.ts`, réexportés par lui.
 */

type MissionRow = Database["public"]["Tables"]["information_agent_missions"]["Row"];

function asObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Relit la vente à l'aperçu et à l'envoi : un brouillon préparé lundi pour une audience jeudi ne
 * doit pas partir vendredi en demandant de « confirmer la date de l'audience ». Bloque une vente
 * retirée, vendue ou supprimée, une date passée, et une date ou une mise à prix qui ont changé
 * depuis le brouillon (`sale_snapshot`, absent des missions anciennes : pas de comparaison).
 */
export async function assertInformationAgentSaleCurrent(
  mission: Pick<MissionRow, "sale_id" | "sale_snapshot">,
  now = new Date(),
): Promise<void> {
  if (!mission.sale_id) return;
  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select("status,sale_date,starting_price_eur")
    .eq("id", mission.sale_id)
    .maybeSingle();
  if (error) throw error;
  if (!data || !isAvailableInformationAgentStatus(data.status ?? null)) {
    throw new Error(
      "La vente n’est plus disponible (retirée, vendue ou supprimée) : la demande n’a plus d’objet.",
    );
  }
  const saleTime = data.sale_date ? Date.parse(data.sale_date) : Number.NaN;
  if (Number.isFinite(saleTime) && saleTime + 24 * 60 * 60 * 1000 < now.getTime()) {
    throw new Error("La date annoncée de la vente est passée : la demande n’a plus d’objet.");
  }
  const snapshot = asObject(mission.sale_snapshot);
  const sameDate = (left: unknown, right: unknown) =>
    (left ?? null) === (right ?? null) ||
    (typeof left === "string" &&
      typeof right === "string" &&
      Date.parse(left) === Date.parse(right));
  const changed = [
    "sale_date" in snapshot && !sameDate(snapshot.sale_date, data.sale_date) ? "la date" : null,
    "starting_price_eur" in snapshot &&
    Number(snapshot.starting_price_eur ?? Number.NaN) !==
      Number(data.starting_price_eur ?? Number.NaN) &&
    !(snapshot.starting_price_eur == null && data.starting_price_eur == null)
      ? "la mise à prix"
      : null,
  ].filter(Boolean);
  if (changed.length) {
    throw new Error(
      `La vente a changé depuis la préparation du brouillon (${changed.join(" et ")}) : régénérez le brouillon pour que le message reste exact.`,
    );
  }
}

export const INFORMATION_AGENT_NO_QUESTION_MESSAGE =
  "Le message ne contient aucune question : gardez au moins une ligne commençant par « - » (une question par ligne).";

/**
 * Le message demande des précisions : sans aucune question (bloc vidé à l'édition), il annoncerait
 * « les points suivants » suivis de rien. Une question est une ligne commençant par « - » ou « • ».
 */
export function assertInformationAgentHasQuestion(bodyText: string): void {
  if (!/^\s*[-•]\s+\S/m.test(bodyText)) throw new Error(INFORMATION_AGENT_NO_QUESTION_MESSAGE);
}

/**
 * A case for this sale and address that already left the draft stage: a new mission would only
 * attach to it as an inert « subscribed » row, and nothing would be sent.
 */
export async function assertNoSentCaseForRecipient(saleId: string, email: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_cases")
    .select("status,sent_at,created_at")
    .eq("sale_id", saleId)
    .eq("normalized_recipient_email", normalizedEmail(email) ?? email)
    .in("status", ["sending", "sent", "replied", "review", "completed"])
    .limit(1);
  if (error) throw error;
  const sent = data?.[0];
  if (sent) {
    const on = formatInformationAgentOriginDate(sent.sent_at ?? sent.created_at);
    throw new Error(
      `Ce professionnel a déjà été sollicité pour cette vente${on ? ` le ${on}` : ""} : un nouveau brouillon n’enverrait rien. Rouvrez la demande existante dans la liste des missions.`,
    );
  }
}

/**
 * « Maître Jeanne Exemple, Avocat » (nom imprimé par l'annonce) → « Maître Jeanne Exemple » : la
 * fonction après la virgule donnerait « Bonjour Maître Jeanne Exemple, Avocat, ». Null si vide.
 */
export function withoutProfessionSuffix(name: string): string | null {
  const cleaned = name
    .replace(/\s+/g, " ")
    .replace(
      /\s*[,–—-]\s*(?:avocate?s?|notaires?|commissaires?\s+de\s+justice|huissiers?(?:\s+de\s+justice)?|administrateurs?\s+judiciaires?|mandataires?\s+judiciaires?)(?:\s+(?:associ[ée]e?s?|au\s+barreau\s+d[eu']\s*.+|à\s+.+))?\s*$/iu,
      "",
    )
    .trim();
  return cleaned || null;
}

/**
 * Textes repris de l'annonce dans l'objet et le corps (titre, titre court de l'objet, ville,
 * tribunal) : écartés de la garde anti-prospection, pour qu'un « local commercial avec partenaire »
 * dans le titre d'une annonce ne bloque pas l'envoi. Le reste du message reste contrôlé.
 */
export function saleSourceTexts(mission: Pick<MissionRow, "sale_snapshot">): string[] {
  const snapshot = asObject(mission.sale_snapshot);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const title = text(snapshot.title);
  const city = text(snapshot.city);
  const subjectTitle = title
    ? shortenSubjectTitle(
        city && !title.toLowerCase().includes(city.toLowerCase()) ? `${title} à ${city}` : title,
      )
    : null;
  return [subjectTitle, title, city, text(snapshot.tribunal)].filter((value): value is string =>
    Boolean(value),
  );
}

/** Titre de l'objet, court : la date qui le suit doit rester visible sur un téléphone. */
export function shortenSubjectTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (normalized.length <= 45) return normalized;
  const prefix = normalized.slice(0, 44);
  const lastSpace = prefix.lastIndexOf(" ");
  return `${(lastSpace >= 25 ? prefix.slice(0, lastSpace) : prefix).trimEnd()}…`;
}

const TEAM_SIGNATURE = "L’équipe Immojudis";

/**
 * « L’équipe Immojudis » devient « Prénom Nom / Pour l’équipe Immojudis » quand une personne signe.
 * Le texte reste modifiable dans le brouillon ; sans nom configuré, rien ne change.
 */
export function withSignature(bodyText: string, signatureName: string | null | undefined): string {
  const name = signatureName?.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name || !bodyText.trimEnd().endsWith(TEAM_SIGNATURE)) return bodyText;
  const end = bodyText.trimEnd();
  return `${end.slice(0, end.length - TEAM_SIGNATURE.length)}${name}\nPour l’équipe Immojudis`;
}
