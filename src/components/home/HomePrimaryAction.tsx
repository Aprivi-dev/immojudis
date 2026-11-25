"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { HOME_TRIAL_NOTE } from "@/lib/launch-offer";
import { loginPathWithRedirect } from "@/lib/navigation";
import { trackProductEvent } from "@/lib/product-events";
import { FREE_ACCESS_LINE } from "@/lib/sale-unlocks";
import { ArrowRight, ShieldCheck } from "./HomeIcons";
import styles from "./HomePage.module.css";

/**
 * Premier écran (refonte du 24/11/2026) : le catalogue d'abord, l'analyse exemple à côté. On fait
 * goûter le produit avant de demander un compte ; pour un visiteur, l'inscription reste proposée
 * sur la ligne du dessous, avec l'essai de 7 jours (ou, l'essai fermé, la ligne du compte gratuit).
 * Le rendu serveur est celui du visiteur.
 */
export function HomeHeroActions() {
  const { user } = useAuth();
  const trialOpen = useLaunchOffer().active;
  return (
    <div className={styles.ctaBlock}>
      <div className={styles.ctaRow}>
        <Link
          href="/sales"
          prefetch={false}
          className={styles.button}
          onClick={() => trackProductEvent("home_cta_clicked", { target: "browse" })}
        >
          Voir les ventes <ArrowRight aria-hidden size={20} />
        </Link>
        <Link href="/annonce-exemple" prefetch={false} className={styles.buttonGhost}>
          Une analyse exemple
        </Link>
      </div>
      {user ? null : (
        <p className={styles.ctaNote}>
          <ShieldCheck aria-hidden size={16} />
          <span>
            <Link
              href={loginPathWithRedirect(undefined)}
              prefetch={false}
              className={styles.noteLink}
              onClick={() => trackProductEvent("home_cta_clicked", { target: "signup" })}
            >
              Créer mon compte gratuit
            </Link>
            {" · "}
            <span>{trialOpen ? HOME_TRIAL_NOTE : FREE_ACCESS_LINE}</span>
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * L'action principale du dernier écran : pour un visiteur, créer son compte gratuit, avec en dessous
 * l'essai de 7 jours (ou, l'essai fermé, la ligne du compte gratuit) ; pour un compte connecté,
 * explorer les ventes. Le rendu serveur est celui du visiteur. Les règles complètes de l'essai sont
 * dans la carte Analyse des offres, sur la même page.
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
      <Link
        href={loginPathWithRedirect(undefined)}
        prefetch={false}
        className={styles.button}
        onClick={() => trackProductEvent("home_cta_clicked", { target: "signup" })}
      >
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
    <Link
      href="/sales"
      prefetch={false}
      className={className}
      onClick={() => trackProductEvent("home_cta_clicked", { target: "browse" })}
    >
      Ou explorez les ventes sans compte
    </Link>
  );
}
