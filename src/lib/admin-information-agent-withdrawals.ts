import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isFinalFactClaimDecision } from "@/lib/fact-claim-decisions";
import { INFORMATION_AGENT_REGISTRY_FACT_FIELDS } from "@/lib/information-agent-registry-acceptance";

/**
 * Retraits à faire après une opposition (lot C du 14/11/2026, demande de juridique-rgpd) : une opposition d'un
 * avocat vaut aussi retrait des valeurs publiées venant de ses réponses, dans un délai d'un mois au plus.
 *
 * Le retrait n'est pas automatique : une décision du registre des pièces s'écrit avec le jeton d'un
 * administrateur (la base lit l'auteur dans le jeton ; rien ne décide à sa place). Cette liste est la tâche
 * visible : chaque valeur acceptée d'un dossier dont le destinataire s'est opposé (par son adresse, ou par son
 * identité sous une autre adresse), tant que la dernière décision de son observation n'est pas définitive
 * (opposition, ou retrait pour autorisation retirée). Procédure : `docs/runbooks/information-agent.md`, section
 * du lot C.
 */

/** Délai annoncé pour retirer les valeurs après une opposition : un mois au plus. */
export const INFORMATION_AGENT_WITHDRAWAL_DELAY_DAYS = 30;

/** Bornes de lecture : les oppositions et les dossiers concernés restent peu nombreux. */
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
  opposedAt: string;
  /** Date limite du retrait : l'opposition plus un mois. */
  dueAt: string;
  overdue: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function earliest(dates: Array<string | null | undefined>): string | null {
  const times = dates
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
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
          .select("case_id,recipient_identity_keys")
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
      (row.recipient_identity_keys ?? []).map((key) => opposedKeys.get(key)),
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

  const claims = await supabaseAdmin
    .from("auction_fact_claims")
    .select("id,evidence_locator")
    .in(
      "evidence_locator->>information_agent_fact_id",
      facts.data.map((fact) => fact.id),
    )
    .limit(READ_LIMIT);
  if (claims.error) throw claims.error;
  const claimOfFact = new Map<string, string>();
  for (const claim of claims.data ?? []) {
    const locator = claim.evidence_locator;
    const factId =
      locator && typeof locator === "object" && !Array.isArray(locator)
        ? locator.information_agent_fact_id
        : null;
    if (typeof factId === "string") claimOfFact.set(factId, claim.id);
  }
  if (!claimOfFact.size) return [];

  const decisions = await supabaseAdmin
    .from("auction_fact_claim_decisions")
    .select("claim_id,decision,reason_code,seq")
    .in("claim_id", [...claimOfFact.values()])
    .order("seq", { ascending: false });
  if (decisions.error) throw decisions.error;
  const latest = new Map<string, { decision: string; reasonCode: string | null }>();
  for (const row of decisions.data ?? []) {
    if (!latest.has(row.claim_id)) {
      latest.set(row.claim_id, { decision: row.decision, reasonCode: row.reason_code });
    }
  }

  const tasks: InformationAgentWithdrawalTask[] = [];
  for (const fact of facts.data) {
    const claimId = claimOfFact.get(fact.id);
    const opposedAt = caseOpposedAt.get(fact.case_id);
    if (!claimId || !opposedAt) continue;
    const decision = latest.get(claimId) ?? null;
    // Fait : la décision définitive est au journal du registre.
    if (isFinalFactClaimDecision(decision)) continue;
    const dueAt = new Date(
      Date.parse(opposedAt) + INFORMATION_AGENT_WITHDRAWAL_DELAY_DAYS * DAY_MS,
    );
    tasks.push({
      factId: fact.id,
      factKey: fact.fact_key,
      displayValue: fact.display_value,
      saleId: fact.sale_id,
      claimId,
      latestDecision: decision?.decision ?? null,
      opposedAt,
      dueAt: dueAt.toISOString(),
      overdue: now.getTime() > dueAt.getTime(),
    });
  }
  return tasks.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}
