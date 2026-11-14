import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { SalePointsToVerify } from "@/components/sale-detail/SalePointsToVerify";
import { Badge } from "@/components/ui/primitives";
import {
  cahierConsultationLine,
  getSaleProcedure,
  saleVerificationExplanation,
  saleVerificationLabel,
} from "@/lib/sale-procedure";
import { pointsToVerify } from "@/lib/search/points-to-verify";
import type { AuctionSale } from "@/lib/types";
import styles from "./SalePublicPreview.module.css";

/**
 * Contenu de la section « Pièces et vérifications » de la fiche publique : le niveau de vérification
 * du type de vente, les points à vérifier (cible de `#points-a-verifier`, sans l'occupation, que
 * l'aperçu public ne lit pas), les pièces du dossier (verrouillées, comptées) et la source officielle
 * des risques. Chargé à part (`SalePublicPreview`), rendu par le serveur.
 */
export function SalePublicChecks({
  preview,
  saleId,
  unlockOffered,
}: {
  preview: AuctionSale;
  saleId: string;
  /** Le déblocage mensuel est proposé pour cette vente (régime de frais ouvert). */
  unlockOffered: boolean;
}) {
  const procedure = getSaleProcedure(preview);
  const verified = ["verified", "cross_checked"].includes(procedure.verificationStatus);
  const points = pointsToVerify(preview, { occupancyVisible: false });
  const documentCount = Math.max(0, preview.document_count ?? 0);
  const cahier = cahierConsultationLine(procedure);
  return (
    <>
      <div className={styles.checks}>
        <div className={styles.box}>
          <Badge
            tone={
              verified
                ? "success"
                : procedure.verificationStatus === "conflict"
                  ? "danger"
                  : "warning"
            }
          >
            {verified ? (
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <CircleAlert className="h-3.5 w-3.5" aria-hidden />
            )}
            {saleVerificationLabel(procedure.verificationStatus)}
          </Badge>
          <p>{saleVerificationExplanation(procedure.verificationStatus)}</p>
        </div>
        {/* Cible de `#points-a-verifier` ; l'occupation n'est pas lue sur l'aperçu public. */}
        <SalePointsToVerify points={points} saleId={saleId} className={styles.points} />
      </div>
      <ul className={styles.docs} aria-label="Pièces et sources">
        {/* Cible du lien « Où consulter le cahier » des mentions de l'avocat poursuivant : le cahier se
            consulte sans compte (même ligne que la fiche des comptes, selon le type de vente). */}
        {cahier ? (
          <li>
            <FileText aria-hidden />
            <b>Cahier des conditions de vente</b>
            <span>{cahier}</span>
          </li>
        ) : null}
        {documentCount > 0 ? (
          <li>
            <FileText aria-hidden />
            <b>Pièces du dossier</b>
            <span>
              {documentCount} pièce{documentCount > 1 ? "s" : ""}, avec l’offre Analyse
              {unlockOffered ? " ou un déblocage" : ""}
            </span>
          </li>
        ) : null}
        <li>
          <FileText aria-hidden />
          <b>Risques naturels et technologiques</b>
          <a href="https://www.georisques.gouv.fr/" target="_blank" rel="noopener noreferrer">
            Consulter Géorisques
          </a>
        </li>
      </ul>
      <p className={styles.officialSources}>
        Les sources officielles restent consultables librement.
      </p>
    </>
  );
}
