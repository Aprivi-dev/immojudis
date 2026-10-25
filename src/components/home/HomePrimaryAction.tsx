"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
import { loginPathWithRedirect } from "@/lib/navigation";
import { FREE_ACCESS_LINE } from "@/lib/sale-unlocks";
import { ArrowRight, ShieldCheck } from "./HomeIcons";
import styles from "./HomePage.module.css";

/** Sous le bouton d'inscription, pendant l'essai à l'inscription. */
export const HOME_TRIAL_NOTE = `${ANALYSIS_TRIAL_DAYS} jours d’accès complet à l’offre Analyse, sans carte bancaire.`;

/**
 * L'action principale de l'accueil, la même en haut et en bas de page : pour un visiteur, créer son
 * compte gratuit, avec en dessous l'essai de 7 jours (ou, l'essai fermé, la ligne du compte
 * gratuit) ; pour un compte connecté, explorer les ventes. Le rendu serveur est celui du visiteur.
 * Les règles complètes de l'essai sont dans la carte Analyse des offres, sur la même page.
 */
export function HomePrimaryAction() {
  const { user } = useAuth();
  const trialOpen = useLaunchOffer().active;
  if (user) {
    return (
      <div className={styles.ctaBlock}>
        <Link href="/sales" prefetch={false} className={styles.button}>
          Explorer les ventes <ArrowRight aria-hidden size={20} />
        </Link>
      </div>
    );
  }
  return (
    <div className={styles.ctaBlock}>
      <Link href={loginPathWithRedirect(undefined)} prefetch={false} className={styles.button}>
        Créer mon compte gratuit <ArrowRight aria-hidden size={20} />
      </Link>
      <p className={styles.ctaNote}>
        <ShieldCheck aria-hidden size={16} />
        {trialOpen ? HOME_TRIAL_NOTE : FREE_ACCESS_LINE}
      </p>
    </div>
  );
}

/** Lien discret vers le catalogue, sous l'action principale du dernier écran (visiteurs). */
export function HomeBrowseWithoutAccount({ className }: { className?: string }) {
  const { user } = useAuth();
  if (user) return null;
  return (
    <Link href="/sales" prefetch={false} className={className}>
      Ou explorez les ventes sans compte
    </Link>
  );
}

/** Première étape du « comment ça marche » : ce que donne la confirmation de l'adresse email. */
export function HomeSignupStepText() {
  const trialOpen = useLaunchOffer().active;
  return (
    <p>
      {trialOpen
        ? `Confirmez votre adresse email : vos ${ANALYSIS_TRIAL_DAYS} jours d’offre Analyse commencent. Aucune carte bancaire demandée.`
        : "Confirmez votre adresse email : votre compte Découverte est ouvert, gratuit et sans carte bancaire."}
    </p>
  );
}
