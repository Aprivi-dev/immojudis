"use client";

import { useQuery } from "@tanstack/react-query";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import { DocumentsList } from "@/components/DocumentsList";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { riskEvidence } from "@/lib/risk-evidence";
import { listingSaleStatus } from "@/lib/listing-evidence";
import { LawyerReferralButton } from "@/components/LawyerReferralButton";
import { UrbanismeCadastrePanel } from "@/components/sale-detail/UrbanismeCadastrePanel";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import { fetchSaleUrbanismeCadastre } from "@/lib/client-api";
import {
  getSaleProcedure,
  lawyerRequirementLabel,
  participationModeLabel,
  saleProcedureIsConfirmed,
} from "@/lib/sale-procedure";
import type { AuctionSale } from "@/lib/types";
import { queryKeys } from "@/lib/query-keys";

export function PanelIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <header className={panelStyles.intro}>
      <p>{eyebrow}</p>
      <h2>{title}</h2>
      {description ? <span>{description}</span> : null}
    </header>
  );
}

export function UrbanismeSection({
  sale,
  mapLocation,
  loadStructuredUrbanism = false,
}: {
  sale: AuctionSale;
  mapLocation: Pick<AuctionSale, "address" | "postal_code" | "city" | "latitude" | "longitude">;
  loadStructuredUrbanism?: boolean;
}) {
  const urbanismQuery = useQuery({
    queryKey: queryKeys.saleUrbanismeCadastre(sale.id, sale.source_url),
    queryFn: () => fetchSaleUrbanismeCadastre(sale.id),
    enabled: loadStructuredUrbanism && Boolean(sale.source_url) && Boolean(sale.city),
    staleTime: 10 * 60_000,
  });

  return (
    <div id="urbanism" className="mt-6 scroll-mt-36">
      <div>
        {urbanismQuery.isPending && urbanismQuery.isFetching ? (
          <p role="status" className="mb-4 text-sm text-brand-navy/70">
            Chargement des données cadastrales et d’urbanisme collectées pour cette annonce…
          </p>
        ) : null}
        {urbanismQuery.isError ? (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          >
            <p>
              Les données cadastrales complémentaires sont momentanément indisponibles. Le bloc
              ci-dessous repose sur les pièces de l’annonce.
            </p>
            <button
              type="button"
              className="mt-2 font-semibold underline underline-offset-2"
              onClick={() => void urbanismQuery.refetch()}
            >
              Réessayer
            </button>
          </div>
        ) : null}
        <UrbanismeCadastrePanel
          sale={sale}
          mapLocation={mapLocation}
          cadastralParcels={urbanismQuery.data?.cadastralParcels}
          urbanPlanningSignals={urbanismQuery.data?.urbanPlanningSignals}
          officialLandEnabled={loadStructuredUrbanism}
        />
      </div>
    </div>
  );
}

export function SaleDocumentsSection({
  sale,
  open,
  onOpenChange,
}: {
  sale: AuctionSale;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const documents = collectSaleDocuments(sale);
  return (
    <section
      id="documents"
      aria-label="Pièces du dossier"
      className="mx-auto max-w-[1260px] scroll-mt-36 px-4 pb-8 sm:px-6 lg:px-8"
    >
      <details
        className="group mt-4 rounded-lg border border-brand-navy/12 bg-white shadow-sm"
        open={open}
      >
        <summary
          className="flex cursor-pointer list-none items-center gap-4 px-5 py-5 sm:px-7"
          onClick={(event) => {
            event.preventDefault();
            onOpenChange(!open);
          }}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-text">
            <FileText className="h-5 w-5" aria-hidden />
          </span>
          <span>
            <span className="block font-display text-2xl font-semibold text-brand-navy">
              Consulter les pièces du dossier
            </span>
            <span className="mt-1 block text-sm text-brand-navy/65">
              {documents.length > 0
                ? "Consultez les pièces jointes ; vérifiez leur nature et leur date."
                : "Aucune pièce attachée à cette annonce pour le moment."}
            </span>
          </span>
          <ChevronDown className="ml-auto h-5 w-5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-brand-navy/10 px-5 py-3 sm:px-7">
          {documents.length > 0 ? (
            <DocumentsList documents={documents} />
          ) : (
            <p role="status" className="text-sm text-brand-navy/70">
              Les pièces vérifiées apparaîtront ici lorsqu’elles seront disponibles.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}

export function RisksAndDocuments({ sale }: { sale: AuctionSale }) {
  const risks = sale.risks ?? [];
  const documentCount = collectSaleDocuments(sale).length;
  const preview = risks.slice(0, 2);

  return (
    <section id="risks" className={panelStyles.riskCard} aria-labelledby="risk-summary-title">
      <h2 id="risk-summary-title">Points à vérifier</h2>
      {preview.length ? (
        <ul className={panelStyles.riskPreview}>
          {preview.map((risk) => (
            <li key={`${risk.risk_type}-${risk.risk_label}`}>
              <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
              <span>{risk.risk_label}</span>
              <strong>
                {risk.severity != null && risk.severity >= 4 ? "Prioritaire" : "À vérifier"}
              </strong>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          Aucun point particulier n’est décrit dans les éléments disponibles. Vérifiez le dossier
          officiel.
        </p>
      )}
      {risks.length > 2 ? (
        <p>
          {risks.length - 2} autre{risks.length > 3 ? "s" : ""} point{risks.length > 3 ? "s" : ""}{" "}
          dans le dossier.
        </p>
      ) : null}
      <p>
        {documentCount > 0 ? `${documentCount} pièce(s) consultable(s)` : "Aucune pièce attachée"}
        {" · "}
        <a href="#documents">Consulter les pièces du dossier</a>
      </p>
      {risks.length ? (
        <details className={panelStyles.riskEvidence}>
          <summary>Voir les sources et actions à confirmer</summary>
          <div>
            {risks.map((risk) => {
              const evidence = riskEvidence(risk);
              return (
                <article key={`${risk.risk_type}-${risk.risk_label}`}>
                  <h3>{risk.risk_label}</h3>
                  <p>{evidence.action}</p>
                  {evidence.proofs.map((proof, index) => (
                    <div key={`${index}-${proof.label}`}>
                      {proof.url ? (
                        <a href={proof.url} target="_blank" rel="noopener noreferrer">
                          {proof.label} (nouvel onglet)
                        </a>
                      ) : (
                        <span>{proof.label}</span>
                      )}
                      {proof.page != null ? <span> · page {proof.page}</span> : null}
                      {proof.excerpt ? <blockquote>{proof.excerpt}</blockquote> : null}
                    </div>
                  ))}
                </article>
              );
            })}
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function LawyerSection({ sale }: { sale: AuctionSale }) {
  const procedure = getSaleProcedure(sale);
  const saleStatus = listingSaleStatus(sale);
  const isJudicial = procedure.venueType === "tribunal" && saleProcedureIsConfirmed(procedure);
  const showLawyerDirectory = isJudicial && !saleStatus;
  const organizerName = procedure.organizerName?.trim() || null;
  const hasOrganizerContact = Boolean(procedure.organizerContact?.trim());
  const isPersistedSale =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sale.id);
  const directoryHref = isPersistedSale
    ? `/avocats?saleId=${encodeURIComponent(sale.id)}&city=${encodeURIComponent(sale.city ?? "")}`
    : `/avocats?city=${encodeURIComponent(sale.city ?? "")}`;

  return (
    <section id="lawyer" className="scroll-mt-36 bg-white">
      <div className="mx-auto max-w-[1380px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="grid gap-7 rounded-lg border border-line bg-background p-6 sm:p-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(420px,1.15fr)] lg:items-center">
          <div>
            <h2 className="font-display text-3xl font-medium leading-tight text-brand-navy sm:text-4xl">
              {saleStatus
                ? saleStatus
                : isJudicial
                  ? "Prêt à enchérir ? Mandatez l’avocat compétent."
                  : "Préparez votre participation avec l’organisateur."}
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-brand-navy/70 sm:text-base">
              {saleStatus
                ? "Contactez l’organisateur pour confirmer le résultat ou les suites de la vente avant de préparer une participation."
                : isJudicial
                  ? "La représentation par avocat est obligatoire : il vérifie le dossier, reçoit votre mandat et porte les enchères."
                  : `${lawyerRequirementLabel(procedure)}. Participation ${participationModeLabel(procedure.participationMode).toLowerCase()} selon les conditions de la vente.`}
            </p>
          </div>
          <div className="rounded-lg border border-brand-navy/14 bg-white p-5 shadow-sm sm:flex sm:items-center sm:gap-5">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-text">
              <Scale className="h-6 w-6" aria-hidden />
            </span>
            <div className="mt-3 min-w-0 flex-1 sm:mt-0">
              <p className="font-display text-2xl font-semibold text-brand-navy">
                {showLawyerDirectory
                  ? (procedure.eligibleBar ?? sale.tribunal_city ?? "Barreau compétent")
                  : (organizerName ?? "Organisateur à confirmer")}
              </p>
              <p className="mt-1 text-sm text-brand-navy/70">
                {showLawyerDirectory
                  ? "Avocats référencés par Immojudis"
                  : hasOrganizerContact
                    ? "Coordonnées mentionnées dans le dossier"
                    : "Coordonnées non renseignées"}
              </p>
            </div>
            {showLawyerDirectory ? (
              <a
                href={directoryHref}
                className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gold-soft sm:mt-0"
              >
                Voir les avocats disponibles
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            ) : hasOrganizerContact ? (
              <a
                href="#rendez-vous"
                className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gold-soft sm:mt-0"
              >
                Consulter les coordonnées du dossier
              </a>
            ) : (
              <p className="mt-4 text-sm text-brand-navy/70 sm:mt-0">
                Coordonnées à confirmer par Immojudis.
              </p>
            )}
          </div>
          {isPersistedSale && isJudicial && !saleStatus ? (
            <div className="lg:col-start-2">
              <LawyerReferralButton saleId={sale.id} className="min-h-11 w-full sm:w-auto" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function InformationAvailabilityNotice() {
  return (
    <section
      aria-labelledby="information-availability-title"
      className="border-b border-brand-navy/10 bg-background"
    >
      <div className="mx-auto max-w-[1260px] px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-lg border border-line bg-white p-5 shadow-sm sm:p-7">
          <h2
            id="information-availability-title"
            className="font-display text-2xl font-semibold text-brand-navy"
          >
            Informations complémentaires
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-brand-navy/70">
            Les enrichissements sont initiés et validés par Immojudis. Les informations et pièces
            confirmées seront ajoutées à cette annonce lorsqu’elles seront disponibles.
          </p>
        </div>
      </div>
    </section>
  );
}
