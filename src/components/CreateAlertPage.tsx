"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { SectorAlertForm } from "@/components/SectorAlertFormLazy";
import { PageShell, buttonClasses } from "@/components/ui/primitives";
import { publicAlertCriteria } from "@/lib/discovery-alerts";
import { searchParamsToRecord } from "@/lib/navigation";
import { countActiveSearchFilters } from "@/lib/search/search-filters";

/**
 * Page où l'on confirme une alerte demandée depuis une page publique (département, tribunaux) :
 * le visiteur y revient après sa connexion et retrouve ses critères. Rien n'est créé en
 * arrivant ici : l'alerte (et l'éventuel email) n'existent qu'après un clic sur le bouton.
 */
export function CreateAlertPage() {
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  // Seuls les critères publics de l'adresse sont lus (voir `publicAlertCriteria`).
  const criteria = useMemo(
    () => searchParamsToRecord(new URLSearchParams(queryString)),
    [queryString],
  );
  const hasCriteria = countActiveSearchFilters(publicAlertCriteria(criteria)) > 0;

  return (
    <PageShell
      eyebrow="Mon espace"
      title="Créer une alerte"
      description="Une alerte vous prévient quand une nouvelle vente correspond à ces critères."
    >
      {hasCriteria ? (
        <SectorAlertForm criteria={criteria} />
      ) : (
        <div className="grid gap-3">
          <p className="text-ink-soft">
            Aucun critère à enregistrer. Choisissez un département ou réglez vos filtres dans le
            catalogue, puis créez votre alerte.
          </p>
          <div>
            <Link href="/sales" className={buttonClasses({ variant: "primary" })}>
              Voir les ventes
            </Link>
          </div>
        </div>
      )}
    </PageShell>
  );
}
