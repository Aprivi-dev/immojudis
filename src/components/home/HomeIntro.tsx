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
 * s'ouvre sur les peintures, et la dernière va se poser sur la peinture du premier écran. Le
 * mouvement est en CSS, le script ne fait que mesurer la place de cette peinture : sans script le
 * voile s'efface seul, et il n'existe pas quand le visiteur réduit les animations. Le
 * contenu de la page est affiché dessous dès le départ (rien n'est masqué au navigateur).
 */
export function HomeIntro() {
  const [shown, setShown] = useState(true);
  const alreadySeen = useRef<boolean | null>(null);
  const veil = useRef<HTMLDivElement>(null);
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
    // La dernière vue se range sur la vraie peinture du premier écran : sa place est relue à chaque
    // image (elle bouge quand une police arrive ou que la fenêtre change de taille).
    const painting = document.querySelector<HTMLElement>(`.${scenes.heroPainting} img`);
    let frame = 0;
    const follow = () => {
      const style = veil.current?.style;
      if (style && painting) {
        const { left, top, width, height } = painting.getBoundingClientRect();
        style.setProperty("--intro-landing-x", `${left}px`);
        style.setProperty("--intro-landing-y", `${top}px`);
        style.setProperty("--intro-landing-w", `${width}px`);
        style.setProperty("--intro-landing-h", `${height}px`);
        style.setProperty("--intro-landing-position", getComputedStyle(painting).objectPosition);
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    const timer = window.setTimeout(() => setShown(false), INTRO_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.homeIntro;
    },
    [],
  );
  if (!shown) return null;
  return (
    <div ref={veil} className={scenes.intro} aria-hidden>
      <div className={scenes.introRow}>
        <span>immo</span>
        <span className={scenes.introWindow}>
          {(["06-bougies", "07-audience"] as const).map((name) => (
            <span key={name} style={{ backgroundImage: `url(${homePaintingUrl(name)})` }} />
          ))}
        </span>
        <span>judis</span>
      </div>
      <span
        className={scenes.introLanding}
        style={{ backgroundImage: `url(${homePaintingUrl("01-hero")})` }}
      />
    </div>
  );
}
