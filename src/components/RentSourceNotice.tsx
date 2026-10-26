import {
  ANIL_CURRENT_EDITION,
  RENT_ATTRIBUTION,
  RENT_SOURCE_URL,
  rentSourceDetail,
} from "@/lib/rent-source-notice";
import type { RentReference } from "@/lib/rent-reference";

/**
 * Mention de source de la carte des loyers de l'ANIL (Licence Ouverte 2.0), avec le lien vers la
 * source. À afficher partout où un loyer ou un rendement issu de l'ANIL est montré. Rien hors donnée
 * ANIL. Sans `reference` (filtre, alertes : plusieurs communes), seule la mention générale s'affiche.
 */
export function RentSourceNotice({
  reference,
  className = "text-xs leading-relaxed text-muted-foreground",
}: {
  reference?: Pick<RentReference, "source" | "vintage" | "sourceUpdatedOn"> | null;
  className?: string;
}) {
  if (reference && !reference.source.startsWith("anil_")) return null;
  const detail = rentSourceDetail(reference ?? { source: "anil_commune", ...ANIL_CURRENT_EDITION });
  return (
    <p className={className} data-rent-source-notice>
      {RENT_ATTRIBUTION} {detail}{" "}
      <a href={RENT_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline">
        Source : data.gouv.fr
      </a>
    </p>
  );
}
