"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { homePaintingUrl } from "./HomePainting";
import scenes from "./HomeScenes.module.css";

const SEEN_KEY = "immojudis-home-intro";
/** Durée de l'animation CSS (`.intro`), après laquelle le voile est retiré du document. */
const INTRO_MS = 2_700;
// Le rendu serveur ne connaît pas la session : l'effet de mise en page tranche avant l'affichage
// qui suit l'hydratation.
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * L'ouverture de l'accueil, une fois par session de navigation : le nom s'écarte, une fenêtre
 * s'ouvre sur les peintures puis grandit jusqu'à devenir le premier écran. Tout est en CSS : sans
 * script le voile s'efface seul, et il n'existe pas quand le visiteur réduit les animations. Le
 * contenu de la page est affiché dessous dès le départ (rien n'est masqué au navigateur).
 */
export function HomeIntro() {
  const [shown, setShown] = useState(true);
  const alreadySeen = useRef<boolean | null>(null);
  useBeforePaint(() => {
    // Lu une seule fois par montage : en mode strict, React rejoue l'effet, et la seconde lecture
    // trouverait la marque que la première vient de poser.
    if (alreadySeen.current === null) {
      alreadySeen.current = false;
      try {
        alreadySeen.current = sessionStorage.getItem(SEEN_KEY) === "1";
        sessionStorage.setItem(SEEN_KEY, "1");
      } catch {
        // Stockage refusé (navigation privée stricte) : l'ouverture se joue à chaque visite.
      }
    }
    if (alreadySeen.current) {
      document.documentElement.dataset.homeIntro = "seen";
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(false), INTRO_MS);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.homeIntro;
    },
    [],
  );
  if (!shown) return null;
  return (
    <div className={scenes.intro} aria-hidden>
      <div className={scenes.introRow}>
        <span>immo</span>
        <span className={scenes.introWindow}>
          {(["06-bougies", "07-audience", "01-hero"] as const).map((name) => (
            <span key={name} style={{ backgroundImage: `url(${homePaintingUrl(name)})` }} />
          ))}
        </span>
        <span>judis</span>
      </div>
    </div>
  );
}
