"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/primitives";
import { type AnalyticsConsentChoice, setAnalyticsConsent } from "@/lib/analytics-consent";
import {
  getGoogleAnalyticsServerState,
  getGoogleAnalyticsState,
  subscribeGoogleAnalyticsState,
} from "@/lib/google-analytics-state";

/** Texte du bandeau sur téléphone (une phrase) ; le texte complet s'affiche dès `sm`. */
const MOBILE_TEXT =
  "Si vous acceptez, Google Analytics dépose des cookies de mesure d’audience, sans publicité ; refuser ne change rien à votre navigation.";

/**
 * Demande d'accord aux cookies de Google Analytics, tant qu'aucun choix n'est en cours de validité.
 * Refuser est aussi simple qu'accepter (deux boutons identiques) et le bandeau ne bloque pas la
 * navigation : sans réponse, rien n'est chargé. Le choix se modifie à tout moment sur la politique
 * de confidentialité (lien « Gérer les cookies » du pied de page).
 *
 * Rendu une fois le navigateur inactif (`DeferredGoogleAnalytics`), en surimpression : il ne
 * décale pas la page et ne concurrence pas l'affichage du contenu.
 *
 * Tant qu'il est affiché en bas de l'écran, il ne doit pas masquer l'élément qui a le focus
 * (WCAG 2.4.11) ni les barres fixes du bas : sa hauteur est mesurée et publiée dans
 * `--cookie-banner-height` (les barres fixes s'élèvent d'autant), `scroll-padding-bottom` de `html`
 * et le `padding-bottom` de `body` la réservent. Sur un écran très peu haut (moins de 30 rem), il
 * reste dans le flux, en fin de page, au lieu de recouvrir le contenu. Après le choix, le focus
 * qui était sur un bouton du bandeau passe au contenu principal au lieu de retomber sur `body`.
 */
export function CookieConsentBanner() {
  const state = useSyncExternalStore(
    subscribeGoogleAnalyticsState,
    getGoogleAnalyticsState,
    getGoogleAnalyticsServerState,
  );
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);

  const shown = state === "unset";
  useEffect(() => {
    const section = sectionRef.current;
    if (!shown || !section) return;
    const root = document.documentElement;
    const reserve = () => {
      // Dans le flux (écran peu haut), le bandeau ne recouvre rien : rien à réserver.
      const height =
        window.getComputedStyle(section).position === "fixed"
          ? Math.ceil(section.getBoundingClientRect().height)
          : 0;
      root.style.setProperty("--cookie-banner-height", `${height}px`);
      root.style.scrollPaddingBottom = height ? `${height}px` : "";
      document.body.style.paddingBottom = height ? `${height}px` : "";
    };
    reserve();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reserve);
    observer?.observe(section);
    // Le passage de `fixed` à `static` (hauteur de fenêtre) ne change pas toujours la taille.
    window.addEventListener("resize", reserve);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reserve);
      root.style.removeProperty("--cookie-banner-height");
      root.style.scrollPaddingBottom = "";
      document.body.style.paddingBottom = "";
    };
  }, [shown]);

  function choose(choice: AnalyticsConsentChoice) {
    const focusWasInside = sectionRef.current?.contains(document.activeElement) ?? false;
    setAnalyticsConsent(choice);
    if (!focusWasInside) return;
    // Le bandeau disparaît avec le bouton qui avait le focus : on le rend au contenu principal.
    const main = document.querySelector("main");
    if (!main) return;
    if (!main.id) main.id = "contenu";
    main.setAttribute("tabindex", "-1");
    main.focus({ preventScroll: true });
  }

  if (state !== "unset") return null;
  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      // La bande pleine largeur laisse passer les clics : seule la carte les reçoit.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4 [@media(max-height:30rem)]:static"
      data-testid="cookie-consent-banner"
    >
      <div className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-3 rounded-lg border border-border bg-white p-4 text-sm text-muted-foreground shadow-[0_-12px_32px_rgba(15,23,42,0.14)] sm:flex-row sm:items-center sm:gap-5">
        <div className="flex-1">
          <h2 id={headingId} className="font-sans font-semibold text-foreground">
            Cookies de mesure d’audience
          </h2>
          {/* Sur téléphone, une phrase et « En savoir plus » : un bandeau plus court ne devient pas
              le plus grand élément du premier écran (LCP). Le texte complet reste dès `sm`. */}
          <p className="mt-1 sm:hidden">
            {MOBILE_TEXT}{" "}
            <Link
              href="/privacy#cookies"
              className="font-semibold text-gold-text underline underline-offset-4"
            >
              En savoir plus
            </Link>
          </p>
          <p className="mt-1 hidden sm:block">
            Nous mesurons déjà la fréquentation sans cookie. Si vous acceptez, Google Analytics
            dépose des cookies pour nous aider à comprendre l’usage du site, sans publicité. Refuser
            ne change rien à votre navigation.{" "}
            <Link
              href="/privacy#cookies"
              className="font-semibold text-gold-text underline underline-offset-4"
            >
              En savoir plus et gérer mes choix
            </Link>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-col">
          <Button onClick={() => choose("denied")}>Refuser</Button>
          <Button onClick={() => choose("granted")}>Accepter</Button>
        </div>
      </div>
    </section>
  );
}
