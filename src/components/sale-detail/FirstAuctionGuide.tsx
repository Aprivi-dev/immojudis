"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import X from "lucide-react/dist/esm/icons/x.js";
import styles from "./SaleOverview.module.css";

const STORAGE_KEY = "immojudis:guide-premiere-vente";
const HIDDEN = "masque";
export const FIRST_AUCTION_GUIDE_TITLE_ID = "guide-premiere-vente-title";

/**
 * Le guide de première vente est masqué une fois pour toutes sur cet appareil quand le visiteur le
 * ferme ; un lien en bas de l'Aperçu le réaffiche. `visible` reste faux jusqu'à la lecture du
 * stockage, pour ne pas le montrer un instant à qui l'a déjà fermé.
 */
export function useFirstAuctionGuide() {
  const [hidden, setHidden] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(STORAGE_KEY) === HIDDEN);
    } catch {
      setHidden(false);
    }
  }, []);
  const hide = useCallback(() => {
    setHidden(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, HIDDEN);
    } catch {
      // Stockage indisponible (navigation privée) : le guide reste masqué pour cette page.
    }
  }, []);
  const show = useCallback(() => {
    setHidden(false);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Rien à faire : le guide est affiché.
    }
  }, []);
  return { visible: hidden === false, hidden: hidden === true, hide, show };
}

/**
 * « Première vente aux enchères ? » : le parcours d'une vente au tribunal en quatre étapes, pour le
 * visiteur qui découvre. Chaque étape mène à l'endroit de la fiche qui l'aide.
 */
export function FirstAuctionGuide({
  ceilingHref,
  eligibleBar,
  onHide,
}: {
  /** Où se prépare le plafond (`#calculation`, ou le panneau de prix sans calcul ouvert). */
  ceilingHref: string;
  /** « Barreau de Bordeaux » quand il est connu. */
  eligibleBar: string | null;
  onHide: () => void;
}) {
  return (
    <section className={styles.guide} aria-labelledby={FIRST_AUCTION_GUIDE_TITLE_ID}>
      <div>
        <h2 id={FIRST_AUCTION_GUIDE_TITLE_ID} tabIndex={-1}>
          Première vente aux enchères ?
        </h2>
        <ol className={styles.guideSteps}>
          <li>
            <a href="#rendez-vous">Visiter le bien</a>
            aux dates annoncées
          </li>
          <li>
            <a href={ceilingHref}>Fixer votre plafond</a>
            le prix à ne pas dépasser
          </li>
          <li>
            <a href="#lawyer">Mandater un avocat</a>
            {eligibleBar ? `du ${lowerFirst(eligibleBar)}` : "du barreau du tribunal"}
          </li>
          <li>
            <strong>Enchérir à l’audience</strong>
            votre avocat porte les enchères
          </li>
        </ol>
        <p className={`${styles.muted} mt-3`}>
          <Link href="/ventes-immobilieres-judiciaires" className="underline underline-offset-4">
            Le guide des ventes judiciaires
          </Link>
        </p>
      </div>
      <button
        type="button"
        className={styles.guideClose}
        aria-label="Masquer le guide de première vente"
        onClick={onHide}
      >
        <X aria-hidden className="h-5 w-5" />
      </button>
    </section>
  );
}

export function lowerFirst(text: string): string {
  return text ? text[0].toLocaleLowerCase("fr-FR") + text.slice(1) : text;
}
