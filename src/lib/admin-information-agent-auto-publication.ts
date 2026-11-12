import "server-only";
import { PublicApiError } from "@/lib/api-errors";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import {
  AUTO_PUBLICATION_CASE_CAP,
  AUTO_PUBLICATION_DAILY_CAP,
  AUTO_PUBLICATION_ELIGIBLE_FIELDS,
  AUTO_PUBLICATION_MODES,
  autoPublicationReasonLabels,
  isAutoPublicationEligibleField,
  type AutoPublicationEligibleField,
  type AutoPublicationMode,
  type AutoPublicationReason,
} from "@/lib/information-agent/auto-publication-policy";
import {
  loadAutoPublicationMode,
  loadLatestAutoPublicationDecisions,
} from "@/lib/information-agent/auto-publication-store";

/**
 * Réglage de la publication automatique (onglet Réglages) et annotations de simulation (onglet Réponses).
 * Lecture : modèle de vue mis en forme par le serveur. Écriture : deux RPC d'administration appelées avec le
 * jeton de l'administrateur (`is_admin`), chaque changement tracé en base. Le mode automatique est verrouillé :
 * refusé ici, refusé par la RPC, et impossible à enregistrer (contrainte de la table).
 */

const AUTO_PUBLICATION_MODE_LABELS: Record<AutoPublicationMode, string> = {
  off: "Arrêt",
  simulation: "Simulation",
  auto: "Automatique",
};

/** Conditions du déverrouillage du mode automatique (étape 6 du plan d'enrichissement). */
const AUTO_PUBLICATION_LOCK_REASONS = [
  "textes juridiques mis à jour et publiés",
  "AIPD mise à jour et signée",
  "validation des huit points par un avocat",
  "jeu d’évaluation à zéro publication fausse",
  "période de simulation concluante",
] as const;

export const AUTO_PUBLICATION_LOCKED_MESSAGE = `Mode automatique verrouillé. Conditions requises : ${AUTO_PUBLICATION_LOCK_REASONS.join(" ; ")}.`;

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
  autoLocked: true;
  lockReasons: string[];
  eligibleFields: string[];
  caps: { daily: number; perCase: number };
  changes: Array<{ at: string; label: string }>;
};

/** Refus voulus par les fonctions de la base (droit, paramètre, état), écrits pour l'administrateur. */
const RPC_REFUSAL_STATUS: Readonly<Record<string, number>> = {
  "42501": 403,
  "22023": 400,
  "55000": 409,
};

function rpcFailure(error: { code?: string; message?: string }): Error {
  const status = error.code ? RPC_REFUSAL_STATUS[error.code] : undefined;
  if (status)
    return new PublicApiError(error.message ?? "Action refusée.", status, { cause: error });
  console.error(JSON.stringify({ scope: "admin.auto_publication", code: error.code ?? "unknown" }));
  return new Error("Database call failed", { cause: error });
}

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
    autoLocked: true,
    lockReasons: [...AUTO_PUBLICATION_LOCK_REASONS],
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
    // Verrou de l'étape 3 : refus avant tout appel à la base (la RPC et la contrainte refusent aussi).
    if (input.mode === "auto") throw new Error(AUTO_PUBLICATION_LOCKED_MESSAGE);
    const { error } = await auth.supabase.rpc("set_information_agent_auto_publication_mode", {
      p_mode: input.mode,
    });
    if (error) throw rpcFailure(error);
  } else {
    // Arrêt d'urgence : toujours permis, sans condition.
    const { error } = await auth.supabase.rpc("stop_information_agent_auto_publication");
    if (error) throw rpcFailure(error);
  }
  return getAdminAutoPublicationView(authToken);
}

export type AutoPublicationReviewDecision = {
  outcome: "would_publish" | "review";
  label: string;
  reasons: string[];
  /** Faux : décision déduite à l'affichage (hors liste, déjà traitée), jamais écrite au journal. */
  recorded: boolean;
  /** Date de la décision du journal (ISO) ; nulle pour une décision déduite à l'affichage. */
  decidedAt: string | null;
};

/**
 * Annotations de l'onglet Réponses. Arrêt (ou migration absente) : rien n'est lu ni affiché. Simulation :
 * dernière décision du journal de chaque fait d'un champ de la liste fermée, avec sa date, qu'il soit encore
 * en attente ou déjà traité ; à défaut de décision au journal, un fait hors liste ou déjà traité s'affiche
 * « relecture » sans écriture au journal, et un fait en attente n'a pas encore été examiné. Lecture
 * impossible ou tronquée : « unavailable » (signalé dans le journal serveur), la liste des réponses reste
 * affichée.
 */
export type AutoPublicationReviewAnnotations =
  | { mode: "off" }
  | { mode: "unavailable" }
  | { mode: "simulation"; decisions: Record<string, AutoPublicationReviewDecision> };

export async function loadAutoPublicationReviewAnnotations(
  facts: Array<{ id: string; fact_key: string; status: string }>,
): Promise<AutoPublicationReviewAnnotations> {
  try {
    const mode = await loadAutoPublicationMode();
    if (mode === "off") return { mode: "off" };
    if (mode !== "simulation") return { mode: "unavailable" };
    const decisions: Record<string, AutoPublicationReviewDecision> = {};
    const eligible = facts.filter((fact) => isAutoPublicationEligibleField(fact.fact_key));
    const latest = await loadLatestAutoPublicationDecisions(eligible.map((fact) => fact.id));
    for (const fact of facts) {
      const decision = latest.get(fact.id);
      if (decision) {
        decisions[fact.id] = {
          outcome: decision.outcome,
          label: decision.outcome === "would_publish" ? "Aurait été publié" : "Relecture",
          reasons: autoPublicationReasonLabels(decision.reasons),
          recorded: true,
          decidedAt: decision.decidedAt,
        };
      } else if (!isAutoPublicationEligibleField(fact.fact_key)) {
        decisions[fact.id] = staticReview("field_not_eligible");
      } else if (fact.status !== "pending") {
        decisions[fact.id] = staticReview("candidate_not_pending");
      }
    }
    return { mode: "simulation", decisions };
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

function staticReview(reason: AutoPublicationReason): AutoPublicationReviewDecision {
  return {
    outcome: "review",
    label: reason === "field_not_eligible" ? "Relecture (hors liste)" : "Relecture",
    reasons: autoPublicationReasonLabels([reason]),
    recorded: false,
    decidedAt: null,
  };
}
