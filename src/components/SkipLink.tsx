"use client";

import type { MouseEvent } from "react";

/**
 * Lien « Aller au contenu » : premier élément focalisable du site. Les pages
 * portent id="contenu" sur leur <main> ; pour celles qui ne l'ont pas (pages
 * à contenu figé), le clic repère le premier <main> et lui donne l'identifiant.
 */
export function SkipLink() {
  function skip(event: MouseEvent<HTMLAnchorElement>) {
    const main = document.querySelector("main");
    if (!main) return;
    event.preventDefault();
    if (!main.id) main.id = "contenu";
    main.setAttribute("tabindex", "-1");
    main.focus({ preventScroll: false });
  }

  return (
    <a
      href="#contenu"
      onClick={skip}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-brand-navy focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-gold"
    >
      Aller au contenu
    </a>
  );
}
