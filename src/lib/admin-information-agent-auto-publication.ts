import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { adminInformationAgentRpcFailure } from "@/lib/admin-information-agent-rpc-failure";
import {
  AUTO_PUBLICATION_CASE_CAP,
  AUTO_PUBLICATION_DAILY_CAP,
  AUTO_PUBLICATION_ELIGIBLE_FIELDS,
  AUTO_PUBLICATION_MODES,
  autoPublicationArbiterReasonLabel,
  autoPublicationReasonLabels,
  isAutoPublicationEligibleField,
  type AutoPublicationEligibleField,
  type AutoPublicationMode,
  type AutoPublicationReason,
} from "@/lib/information-agent/auto-publication-policy";
import {
  loadAutoPublicationMode,
  loadLatestArbiterReasons,
  loadLatestAutoPublicationDecisions,
} from "@/lib/information-agent/auto-publication-store";

/**
 * Réglage de la publication automatique (onglet Réglages) et annotations des décisions (onglet Réponses).
 * Lecture : modèle de vue mis en forme par le serveur. Écriture : deux RPC d'administration appelées avec le
 * jeton de l'administrateur (`is_admin`), chaque changement tracé en base. Depuis l'étape 6 (décision du
 * propriétaire du 27/11/2026), le mode automatique s'enregistre comme les deux autres : seul un administrateur,
 * avec son jeton, le pose ; l'arrêt d'urgence le coupe.
 */

const AUTO_PUBLICATION_MODE_LABELS: Record<AutoPublicationMode, string> = {
  off: "Arrêt",
  simulation: "Simulation",
  auto: "Automatique",
};

const FIELD_LABELS: Record<AutoPublicationEligibleField, string> = {
  surface_m2: "surface",
  land_surface_m2: "surface du terrain",
  rooms_count: "nombre de pièces",
};

export const adminAutoPublicationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_mode"), mode: z.enum(AUTO_PUBLICATION_MODES) }),
  z.object({ action: z.literal("emergency_stop") }),
]);
export type AdminAutoPublicationAction = z.output<typeof adminAutoPublicationActionSchema>;

export type AutoPublicationView = {
  mode: AutoPublicationMode;
  modeLabel: string;
  eligibleFields: string[];
  caps: { daily: number; perCase: number };
  changes: Array<{ at: string; label: string }>;
};

function modeLabel(mode: string): string {
  return (AUTO_PUBLICATION_MODES as readonly string[]).includes(mode)
    ? AUTO_PUBLICATION_MODE_LABELS[mode as AutoPublicationMode]
    : "mode inconnu";
}

export async function getAdminAutoPublicationView(authToken: string): Promise<AutoPublicationView> {
  await assertAdminAuth(authToken);
  const [mode, changes] = await Promise.all([
    loadAutoPublicationMode(),
    supabaseAdmin
      .from("information_agent_auto_publication_mode_changes")
      .select("changed_at,actor_id,previous_mode,new_mode,emergency_stop")
      .order("changed_at", { ascending: false })
      .limit(10),
  ]);
  if (changes.error) throw changes.error;
  return {
    mode,
    modeLabel: AUTO_PUBLICATION_MODE_LABELS[mode],
    eligibleFields: AUTO_PUBLICATION_ELIGIBLE_FIELDS.map((field) => FIELD_LABELS[field]),
    caps: { daily: AUTO_PUBLICATION_DAILY_CAP, perCase: AUTO_PUBLICATION_CASE_CAP },
    changes: (changes.data ?? []).map((change) => ({
      at: change.changed_at,
      label: `${modeLabel(change.previous_mode)} → ${modeLabel(change.new_mode)}${
        change.emergency_stop ? " (arrêt d’urgence)" : ""
      }, par l’administrateur ${change.actor_id.slice(0, 8)}`,
    })),
  };
}

export async function runAdminAutoPublicationAction({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminAutoPublicationAction;
}): Promise<AutoPublicationView> {
  const auth = await assertAdminAuth(authToken);
  if (input.action === "set_mode") {
    // Le mode automatique passe par la même RPC, avec le jeton de l'administrateur (tracé en base).
    const { error } = await auth.supabase.rpc("set_information_agent_auto_publication_mode", {
      p_mode: input.mode,
    });
    if (error) throw adminInformationAgentRpcFailure("admin.auto_publication", error);
  } else {
    // Arrêt d'urgence : toujours permis, sans condition.
    const { error } = await auth.supabase.rpc("stop_information_agent_auto_publication");
    if (error) throw adminInformationAgentRpcFailure("admin.auto_publication", error);
  }
  return getAdminAutoPublicationView(authToken);
}

export type AutoPublicationReviewDecision = {
  outcome: "would_publish" | "published" | "review";
  label: string;
  reasons: string[];
  /** Motif du dernier verdict de Claude Haiku, en clair, quand il refuse de publier. */
  arbiterReason: string | null;
  /** Faux : décision déduite à l'affichage (hors liste, déjà traitée), jamais écrite au journal. */
  recorded: boolean;
  /** Date de la décision du journal (ISO) ; nulle pour une décision déduite à l'affichage. */
  decidedAt: string | null;
};

/**
 * Annotations de l'onglet Réponses. Arrêt : rien n'est lu ni affiché (les publications faites sont listées à
 * part, `listRecentAutoPublications`). Simulation et automatique : dernière décision du journal de chaque fait d'un champ de la liste fermée, avec sa date, qu'il soit encore en attente ou déjà
 * traité ; à défaut de décision au journal, un fait hors liste ou déjà traité s'affiche « relecture » sans
 * écriture au journal, et un fait en attente n'a pas encore été examiné. Lecture impossible ou tronquée :
 * « unavailable » (signalé dans le journal serveur), la liste des réponses reste affichée.
 */
export type AutoPublicationReviewAnnotations =
  | { mode: "unavailable" }
  | { mode: AutoPublicationMode; decisions: Record<string, AutoPublicationReviewDecision> };

const OUTCOME_LABELS: Record<AutoPublicationReviewDecision["outcome"], string> = {
  would_publish: "Aurait été publié",
  published: "Publié automatiquement",
  review: "À relire",
};

export async function loadAutoPublicationReviewAnnotations(
  facts: Array<{ id: string; fact_key: string; status: string }>,
): Promise<AutoPublicationReviewAnnotations> {
  try {
    const mode = await loadAutoPublicationMode();
    const decisions: Record<string, AutoPublicationReviewDecision> = {};
    if (mode === "off") return { mode, decisions };
    const eligibleIds = facts
      .filter((fact) => isAutoPublicationEligibleField(fact.fact_key))
      .map((fact) => fact.id);
    const [latest, arbiterReasons] = await Promise.all([
      loadLatestAutoPublicationDecisions(eligibleIds),
      loadLatestArbiterReasons(eligibleIds),
    ]);
    for (const fact of facts) {
      const decision = latest.get(fact.id);
      if (decision) {
        decisions[fact.id] = annotation(
          decision,
          decision.reasons.includes("arbiter_declined")
            ? autoPublicationArbiterReasonLabel(arbiterReasons.get(fact.id) ?? null)
            : null,
        );
      } else if (!isAutoPublicationEligibleField(fact.fact_key)) {
        decisions[fact.id] = staticReview("field_not_eligible");
      } else if (fact.status !== "pending") {
        decisions[fact.id] = staticReview("candidate_not_pending");
      }
    }
    return { mode, decisions };
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "admin.auto_publication.review",
        code:
          error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
      }),
    );
    return { mode: "unavailable" };
  }
}

function annotation(
  decision: {
    outcome: AutoPublicationReviewDecision["outcome"];
    reasons: string[];
    decidedAt: string;
  },
  arbiterReason: string | null,
): AutoPublicationReviewDecision {
  return {
    outcome: decision.outcome,
    label: OUTCOME_LABELS[decision.outcome],
    reasons: autoPublicationReasonLabels(decision.reasons),
    arbiterReason,
    recorded: true,
    decidedAt: decision.decidedAt,
  };
}

function staticReview(reason: AutoPublicationReason): AutoPublicationReviewDecision {
  return {
    outcome: "review",
    label: reason === "field_not_eligible" ? "À relire (hors liste)" : "À relire",
    reasons: autoPublicationReasonLabels([reason]),
    arbiterReason: null,
    recorded: false,
    decidedAt: null,
  };
}

/** Fenêtre et plafond de la liste « Publiées automatiquement » de l'onglet Réponses. */
const RECENT_AUTO_PUBLICATION_DAYS = 30;
const RECENT_AUTO_PUBLICATION_LIMIT = 100;

export type RecentAutoPublication = {
  factId: string;
  factKey: string;
  /** Valeur affichée du fait ; nulle si le fait a été purgé avec ses messages. */
  displayValue: string | null;
  saleId: string;
  publishedAt: string;
};

/**
 * Publications automatiques des 30 derniers jours (journal du moteur, issue « published »), la plus récente
 * d'abord : l'onglet Réponses les liste pour qu'un administrateur puisse les retirer par le chemin existant
 * (« Retirer » dans les observations de la vente). Lecture seule ; une erreur remonte.
 */
export async function listRecentAutoPublications(
  now = new Date(),
): Promise<RecentAutoPublication[]> {
  const since = new Date(now.getTime() - RECENT_AUTO_PUBLICATION_DAYS * 24 * 60 * 60 * 1000);
  const { data, error } = await supabaseAdmin
    .from("information_agent_auto_publication_decisions")
    .select("fact_id,fact_key,sale_id,decided_at")
    .eq("outcome", "published")
    .gte("decided_at", since.toISOString())
    .order("decided_at", { ascending: false })
    .limit(RECENT_AUTO_PUBLICATION_LIMIT);
  if (error) throw error;
  const rows = data ?? [];
  if (!rows.length) return [];
  const { data: facts, error: factsError } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("id,display_value")
    .in(
      "id",
      rows.map((row) => row.fact_id),
    );
  if (factsError) throw factsError;
  const values = new Map((facts ?? []).map((fact) => [fact.id, fact.display_value]));
  return rows.map((row) => ({
    factId: row.fact_id,
    factKey: row.fact_key,
    displayValue: values.get(row.fact_id) ?? null,
    saleId: row.sale_id,
    publishedAt: row.decided_at,
  }));
}
