"use client";

import Link from "next/link";
import { useEffect } from "react";
import { buttonClasses } from "@/components/ui/primitives";
import { loginPathWithRedirect } from "@/lib/navigation";
import { trackProductEvent, type SharedReportState } from "@/lib/product-events";

/**
 * Bas de la page d'un rapport partagé : propose au destinataire de créer un compte gratuit (motif de
 * connexion dédié `rapport`, qui devient l'origine `entry: "rapport"` de l'inscription), et mesure
 * l'ouverture de la page par l'événement agrégé `shared_report_viewed` (`open` : rapport lisible ;
 * `unavailable` : lien fermé). L'événement ne porte ni le jeton, ni l'identifiant du rapport ou de la
 * vente, ni celui de la personne (liste fermée de `product-events.ts`).
 */
export function SharedReportSignup({ state }: { state: SharedReportState }) {
  useEffect(() => {
    trackProductEvent("shared_report_viewed", { state });
  }, [state]);

  return (
    <section
      aria-labelledby="shared-report-signup-title"
      className="mt-6 rounded-lg border border-border bg-white p-5"
    >
      <h2 id="shared-report-signup-title" className="font-display text-xl text-brand-navy">
        Suivre vos propres ventes
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Créez un compte gratuit, sans carte bancaire, pour garder des ventes en favori et être
        prévenu des nouvelles annonces de votre département.
      </p>
      <Link
        href={loginPathWithRedirect(undefined, { reason: "rapport" })}
        prefetch={false}
        className={`${buttonClasses({ variant: "primary" })} mt-3`}
      >
        Créer mon compte gratuit
      </Link>
    </section>
  );
}
