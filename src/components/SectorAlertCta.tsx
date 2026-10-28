"use client";

import Link from "next/link";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import { SectorAlertForm } from "@/components/SectorAlertFormLazy";
import { Card, buttonClasses } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { alertCreationLoginPath } from "@/lib/discovery-alerts";
import { LAUNCH_OFFER_SHORT_TEXT } from "@/lib/launch-offer";
import type { SalesSearchUrlRecord } from "@/lib/search/search-url-state";

// La création elle-même (droits, zone, consentement) n'est chargée que pour une personne
// connectée : une page publique n'en paie pas le JavaScript pour ses visiteurs (import dynamique
// partagé : `SectorAlertFormLazy`).

export const SECTOR_ALERT_LABEL = "Recevoir les nouvelles ventes de ce secteur";

/**
 * « Recevoir les nouvelles ventes de ce secteur » : alerte en un clic depuis une page publique
 * (département, tribunaux). Un visiteur passe par la connexion (motif « alerte ») et retrouve ses
 * critères sur la page de confirmation ; une personne connectée crée l'alerte ici même. L'email
 * récapitulatif est toujours un choix explicite, jamais pré-coché.
 */
export function SectorAlertCta({
  criteria,
  intro,
}: {
  criteria: SalesSearchUrlRecord;
  intro?: string;
}) {
  const { user, loading } = useAuth();
  // L'essai n'est annoncé qu'une fois son ouverture lue (comme sur le reste du site).
  const launchOffer = useLaunchOffer().active;
  if (user && !loading) {
    return <SectorAlertForm criteria={criteria} intro={intro} actionLabel={SECTOR_ALERT_LABEL} />;
  }
  return (
    <Card as="section" aria-label="Être prévenu des nouvelles ventes" className="grid gap-3">
      <h2 className="flex items-center gap-2 font-display text-2xl font-semibold">
        <Bell className="size-5 text-gold-text" aria-hidden />
        Être prévenu des nouvelles ventes
      </h2>
      {intro ? <p className="text-sm text-ink-soft">{intro}</p> : null}
      <div>
        <Link
          href={alertCreationLoginPath(criteria)}
          className={buttonClasses({ variant: "primary" })}
        >
          {SECTOR_ALERT_LABEL}
        </Link>
      </div>
      {launchOffer ? (
        <p data-testid="sector-alert-trial" className="text-sm font-medium">
          {LAUNCH_OFFER_SHORT_TEXT}
        </p>
      ) : null}
      <p className="text-xs text-ink-soft">
        Compte gratuit, sans carte bancaire. Vous retrouvez ce secteur après la connexion ; l’email
        récapitulatif reste facultatif.
      </p>
    </Card>
  );
}
