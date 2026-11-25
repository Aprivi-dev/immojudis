"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useAccessPlan } from "@/hooks/use-access-plan";
import { useAuth } from "@/hooks/use-auth";

/**
 * Durée d'affichage après la fin de l'essai. La fin d'un essai est une nouvelle, pas un état du
 * compte : au-delà, le catalogue n'en parle plus (Mon compte garde l'état de l'essai).
 */
export const TRIAL_ENDED_NOTE_DAYS = 60;

// Le texte lit l'offre (prix, ouverture) : chargé seulement pour un compte dont l'essai est terminé,
// pour ne pas alourdir le catalogue des autres (`scripts/check-build-budgets.mjs`).
const TrialEndedOfferOpen = dynamic(
  () => import("./TrialEndedOfferOpen").then((module) => module.TrialEndedOfferOpen),
  { ssr: false },
);

/**
 * Au-dessus de la liste des ventes, pour un compte Découverte dont l'essai gratuit est terminé
 * depuis moins de `TRIAL_ENDED_NOTE_DAYS` jours : l'offre Analyse se souscrit, à quel prix, et où
 * (décision du 25/11/2026 : un essai terminé avant l'ouverture du paiement ne l'apprenait nulle
 * part). Une ligne factuelle, comme `LaunchOfferTrialEnd` pendant
 * l'essai : ni compte à rebours, ni remise, ni appel pressant. Rien pour un abonné, ni tant que les
 * droits du compte ne sont pas lus.
 */
export function TrialEndedOfferNote() {
  const { user } = useAuth();
  const plan = useAccessPlan(user?.id);
  // L'heure de l'ouverture de la page suffit pour juger de l'ancienneté de la fin de l'essai.
  const [now] = useState(() => Date.now());
  if (!user || !plan || plan.hasAnalysisAccess || !plan.trialEndedAt) return null;
  const endedAt = Date.parse(plan.trialEndedAt);
  if (Number.isNaN(endedAt) || now - endedAt > TRIAL_ENDED_NOTE_DAYS * 86_400_000) return null;
  return <TrialEndedOfferOpen endedAt={plan.trialEndedAt} />;
}
