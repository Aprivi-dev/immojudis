import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isFinalFactClaimDecision } from "@/lib/fact-claim-decisions";
import {
  isInformationAgentStructureKey,
  informationAgentStructureKeyHolds,
} from "@/lib/information-agent/contact-structure";
import {
  INFORMATION_AGENT_REGISTRY_FACT_FIELDS,
  informationAgentFactHeldByRegistry,
} from "@/lib/information-agent-registry-acceptance";

/**
 * Tâches du registre des pièces de l'onglet « Réponses » (lot C du 14/11/2026), lues sans rien écrire : une
 * décision du registre s'écrit avec le jeton d'un administrateur (la base lit l'auteur dans le jeton ; rien ne
 * décide à sa place). Procédure : `docs/runbooks/information-agent.md`, section du lot C.
 *
 * 1. Retraits à faire après une opposition (demande de juridique-rgpd) : une opposition d'un avocat vaut aussi
 *    retrait des valeurs publiées venant de ses réponses, dans un délai d'un mois au plus. Chaque valeur acceptée
 *    d'un dossier dont le destinataire s'est opposé (par son adresse, ou par son identité sous une autre adresse),
 *    tant que la dernière décision de son observation n'est pas définitive (opposition, ou retrait pour
 *    autorisation retirée).
 * 2. Réponses acceptées sans décision au registre : la décision écrite juste après l'acceptation a échoué ; la
 *    réponse est acceptée, mais sa valeur n'est pas sur la fiche tant qu'un administrateur ne l'a pas décidée.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Délai interne pour retirer les valeurs après une opposition : 28 jours, pour tenir le mois annoncé quel que soit
 * le mois (le plus court en compte 28).
 */
export const INFORMATION_AGENT_WITHDRAWAL_DELAY_DAYS = 28;

/** Date limite du retrait après une opposition : celle de la tâche et celle annoncée sur la page d'opposition. */
export function informationAgentWithdrawalDueAt(opposedAt: Date): Date {
  return new Date(opposedAt.getTime() + INFORMATION_AGENT_WITHDRAWAL_DELAY_DAYS * DAY_MS);
}

/** Bornes de lecture : les oppositions, les dossiers et les décisions manquées restent peu nombreux. */
const READ_LIMIT = 1000;

export type InformationAgentWithdrawalTask = {
  factId: string;
  factKey: string;
  displayValue: string;
  saleId: string;
  /** Observation du registre à décider (« Observations à décider », vente choisie). */
  claimId: string;
  /** Dernière décision de l'observation (`accepted` le plus souvent). */
  latestDecision: string | null;
  /**
   * Le registre tient la valeur : l'opposition rend l'annonce. Sinon (mise à prix, date, type de bien), elle
   * efface la mention, et la valeur reste jusqu'à la prochaine collecte.
   */
  heldByRegistry: boolean;
  opposedAt: string;
  /** Date limite interne du retrait : l'opposition plus 28 jours. */
  dueAt: string;
  overdue: boolean;
};

export type InformationAgentPendingRegistryDecision = {
  factId: string;
  factKey: string;
  displayValue: string;
  saleId: string;
  /** Observation créée par le pont ; nulle si elle manque (la reprise passe alors par l'équipe technique). */
  claimId: string | null;
  acceptedAt: string;
};

function earliest(dates: Array<string | null | undefined>): string | null {
  const times = dates
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

type LatestDecision = { decision: string; reasonCode: string | null };

/** L'observation du pont de chaque fait, et la dernière décision de chaque observation. */
async function registryDecisionsOfFacts(factIds: string[]): Promise<{
  claimOfFact: Map<string, string>;
  latest: Map<string, LatestDecision>;
}> {
  const claimOfFact = new Map<string, string>();
  const latest = new Map<string, LatestDecision>();
  if (!factIds.length) return { claimOfFact, latest };
  const claims = await supabaseAdmin
    .from("auction_fact_claims")
    .select("id,evidence_locator")
    .in("evidence_locator->>information_agent_fact_id", factIds)
    .limit(READ_LIMIT);
  if (claims.error) throw claims.error;
  for (const claim of claims.data ?? []) {
    const locator = claim.evidence_locator;
    const factId =
      locator && typeof locator === "object" && !Array.isArray(locator)
        ? locator.information_agent_fact_id
        : null;
    if (typeof factId === "string") claimOfFact.set(factId, claim.id);
  }
  if (!claimOfFact.size) return { claimOfFact, latest };

  const decisions = await supabaseAdmin
    .from("auction_fact_claim_decisions")
    .select("claim_id,decision,reason_code,seq")
    .in("claim_id", [...claimOfFact.values()])
    .order("seq", { ascending: false });
  if (decisions.error) throw decisions.error;
  for (const row of decisions.data ?? []) {
    if (!latest.has(row.claim_id)) {
      latest.set(row.claim_id, { decision: row.decision, reasonCode: row.reason_code });
    }
  }
  return { claimOfFact, latest };
}

export async function listInformationAgentWithdrawalTasks(
  now: Date = new Date(),
): Promise<InformationAgentWithdrawalTask[]> {
  const [contacts, identities] = await Promise.all([
    supabaseAdmin
      .from("information_agent_contacts")
      .select("normalized_email,opposed_at")
      .eq("opposition_status", "opposed")
      .not("normalized_email", "is", null)
      .limit(READ_LIMIT),
    supabaseAdmin
      .from("information_agent_identity_oppositions")
      .select("identity_key,opposed_at")
      .limit(READ_LIMIT),
  ]);
  if (contacts.error) throw contacts.error;
  if (identities.error) throw identities.error;

  const opposedEmails = new Map<string, string | null>();
  for (const row of contacts.data ?? []) {
    if (row.normalized_email) opposedEmails.set(row.normalized_email, row.opposed_at);
  }
  const opposedKeys = new Map(
    (identities.data ?? []).map((row) => [row.identity_key, row.opposed_at]),
  );
  if (!opposedEmails.size && !opposedKeys.size) return [];

  const [byEmail, byIdentity] = await Promise.all([
    opposedEmails.size
      ? supabaseAdmin
          .from("information_agent_cases")
          .select("id,normalized_recipient_email")
          .in("normalized_recipient_email", [...opposedEmails.keys()])
          .limit(READ_LIMIT)
      : { data: [], error: null },
    opposedKeys.size
      ? supabaseAdmin
          .from("information_agent_missions")
          .select("case_id,recipient_email,recipient_identity_keys")
          .overlaps("recipient_identity_keys", [...opposedKeys.keys()])
          .limit(READ_LIMIT)
      : { data: [], error: null },
  ]);
  if (byEmail.error) throw byEmail.error;
  if (byIdentity.error) throw byIdentity.error;

  // Date de l'opposition de chaque dossier : la plus ancienne qui le vise.
  const caseOpposedAt = new Map<string, string>();
  const note = (caseId: string | null, dates: Array<string | null | undefined>) => {
    if (!caseId) return;
    const date = earliest([caseOpposedAt.get(caseId), ...dates]);
    if (date) caseOpposedAt.set(caseId, date);
  };
  for (const row of byEmail.data ?? []) {
    note(row.id, [opposedEmails.get(row.normalized_recipient_email)]);
  }
  for (const row of byIdentity.data ?? []) {
    note(
      row.case_id,
      (row.recipient_identity_keys ?? [])
        // Une clé de structure ne vaut que si elle tient pour l'adresse de ce dossier : une clé enregistrée sous
        // une règle plus ancienne (messagerie de profession comme avocat.fr, domaine partagé) mêlerait d'autres
        // avocats, et pousserait à une décision définitive à tort.
        .filter(
          (key) =>
            !isInformationAgentStructureKey(key) ||
            informationAgentStructureKeyHolds(key, row.recipient_email ?? ""),
        )
        .map((key) => opposedKeys.get(key)),
    );
  }
  if (!caseOpposedAt.size) return [];

  const facts = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("id,case_id,sale_id,fact_key,display_value")
    .eq("status", "accepted")
    .in("case_id", [...caseOpposedAt.keys()])
    .in("fact_key", Object.keys(INFORMATION_AGENT_REGISTRY_FACT_FIELDS))
    .limit(READ_LIMIT);
  if (facts.error) throw facts.error;
  if (!facts.data?.length) return [];

  const { claimOfFact, latest } = await registryDecisionsOfFacts(facts.data.map((fact) => fact.id));

  const tasks: InformationAgentWithdrawalTask[] = [];
  for (const fact of facts.data) {
    const claimId = claimOfFact.get(fact.id);
    const opposedAt = caseOpposedAt.get(fact.case_id);
    if (!claimId || !opposedAt) continue;
    const decision = latest.get(claimId) ?? null;
    // Fait : la décision définitive est au journal du registre, et la mention a quitté la fiche.
    if (isFinalFactClaimDecision(decision)) continue;
    const dueAt = informationAgentWithdrawalDueAt(new Date(opposedAt));
    tasks.push({
      factId: fact.id,
      factKey: fact.fact_key,
      displayValue: fact.display_value,
      saleId: fact.sale_id,
      claimId,
      latestDecision: decision?.decision ?? null,
      heldByRegistry: informationAgentFactHeldByRegistry(fact.fact_key),
      opposedAt,
      dueAt: dueAt.toISOString(),
      overdue: now.getTime() > dueAt.getTime(),
    });
  }
  return tasks.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}

/**
 * Réponses acceptées dont la valeur attend sa décision au registre : le journal de l'agent dit que la valeur va au
 * registre (`new_values.fact_registry`, champ tenu), et l'observation du pont n'a encore aucune décision.
 */
export async function listInformationAgentPendingRegistryDecisions(): Promise<
  InformationAgentPendingRegistryDecision[]
> {
  const publications = await supabaseAdmin
    .from("information_agent_fact_publications")
    .select("fact_id,sale_id,fact_key,published_at")
    .not("new_values->fact_registry", "is", null)
    .order("published_at", { ascending: false })
    .limit(READ_LIMIT);
  if (publications.error) throw publications.error;
  if (!publications.data?.length) return [];

  const { claimOfFact, latest } = await registryDecisionsOfFacts(
    publications.data.map((publication) => publication.fact_id),
  );
  const pending = publications.data.filter((publication) => {
    const claimId = claimOfFact.get(publication.fact_id);
    return !claimId || !latest.has(claimId);
  });
  if (!pending.length) return [];

  const facts = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("id,display_value")
    .in(
      "id",
      pending.map((publication) => publication.fact_id),
    );
  if (facts.error) throw facts.error;
  const displayValues = new Map((facts.data ?? []).map((fact) => [fact.id, fact.display_value]));

  return pending.map((publication) => ({
    factId: publication.fact_id,
    factKey: publication.fact_key,
    displayValue: displayValues.get(publication.fact_id) ?? "",
    saleId: publication.sale_id,
    claimId: claimOfFact.get(publication.fact_id) ?? null,
    acceptedAt: publication.published_at,
  }));
}
