"use client";

import type { ReactNode } from "react";
import { createFileRoute, Link } from "@/lib/router-compat";
import {
  LEGAL_DOCUMENTS,
  legalValue,
  publicLegalPublisher,
  VERCEL_HOSTING_PROVIDER,
} from "@/lib/legal-documents";

export const Route = createFileRoute("/legal")({
  head: () => ({
    meta: [
      { title: "Mentions légales — Immojudis" },
      { name: "description", content: "Mentions légales de la plateforme Immojudis." },
    ],
  }),
  component: LegalPage,
});

export function LegalPage() {
  const publisher = publicLegalPublisher();
  const identityComplete = Boolean(
    publisher.entityName &&
    publisher.legalForm &&
    publisher.address &&
    publisher.registration &&
    publisher.publicationDirector &&
    publisher.contactEmail &&
    publisher.contactPhone,
  );

  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto max-w-4xl">
        <header className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            Informations de l’éditeur
          </div>
          <h1 className="mt-4 font-display text-4xl leading-tight text-foreground sm:text-5xl">
            Mentions légales
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Version {LEGAL_DOCUMENTS.legal.version}, en vigueur le{" "}
            {LEGAL_DOCUMENTS.legal.effectiveDate}.
          </p>
        </header>

        {!identityComplete ? (
          <div className="mt-6 rounded-lg border border-amber-300/30 bg-amber-400/10 p-5 text-sm leading-relaxed text-amber-100">
            Les informations d’identification de l’éditeur ne sont pas encore toutes publiées. Par
            précaution, le checkout payant est suspendu tant que cette configuration n’est pas
            complète et validée.
          </div>
        ) : null}

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
          <LegalSection title="Éditeur et responsable de publication">
            <dl className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <LegalField label="Éditeur" value={legalValue(publisher.entityName)} />
              <LegalField label="Forme juridique" value={legalValue(publisher.legalForm)} />
              <LegalField
                label="Capital social"
                value={legalValue(publisher.capital, "Non applicable ou à renseigner")}
              />
              <LegalField label="Siège" value={legalValue(publisher.address)} />
              <LegalField label="Immatriculation" value={legalValue(publisher.registration)} />
              <LegalField
                label="TVA intracommunautaire"
                value={legalValue(publisher.vatNumber, "Non applicable ou à renseigner")}
              />
              <LegalField
                label="Directeur de publication"
                value={legalValue(publisher.publicationDirector)}
              />
              <LegalField label="Email" value={legalValue(publisher.contactEmail)} />
              <LegalField label="Téléphone" value={legalValue(publisher.contactPhone)} />
            </dl>
          </LegalSection>

          <LegalSection title="Hébergement">
            <p>
              {VERCEL_HOSTING_PROVIDER.name}, {VERCEL_HOSTING_PROVIDER.address}. Site :{" "}
              <a
                className="text-gold underline"
                href={VERCEL_HOSTING_PROVIDER.website}
                target="_blank"
                rel="noreferrer"
              >
                vercel.com
              </a>
              .
            </p>
          </LegalSection>

          <LegalSection title="Objet du service et sources">
            <p>
              Immojudis est une interface de consultation et d’aide à la décision relative aux
              ventes immobilières, notamment judiciaires. Les informations proviennent de sources
              publiques ou partenaires et peuvent être rapprochées ou enrichies automatiquement. Les
              pièces officielles, le cahier des conditions de vente, les diagnostics, la visite et
              les informations du professionnel poursuivant restent les références à vérifier.
            </p>
          </LegalSection>

          <LegalSection title="Estimations, rapports et responsabilité">
            <p>
              Les scores, comparables DVF, fourchettes de valeur, rendements, analyses de risques et
              plafonds d’enchère sont des aides à la lecture fondées sur les données disponibles au
              moment du calcul. Ils ne constituent ni un conseil juridique ou financier, ni une
              expertise immobilière, ni une garantie de rentabilité, de financement, d’adjudication
              ou de revente.
            </p>
          </LegalSection>

          <LegalSection title="Mise en relation avec un avocat">
            <p>
              La mise en relation ne remplace pas le libre choix du conseil, ne crée pas de mandat
              et ne constitue pas une validation juridique du dossier. Les conditions d’intervention
              et honoraires relèvent exclusivement de l’accord conclu avec l’avocat choisi.
            </p>
          </LegalSection>

          <LegalSection title="Propriété intellectuelle et réutilisation">
            <p>
              La marque, l’interface, les textes originaux, rapports et éléments graphiques
              d’Immojudis sont protégés. Les sources tierces conservent leurs droits et sont citées
              dans les fiches lorsque disponibles. Les exports et l’API ne peuvent faire l’objet
              d’une extraction massive, d’une redistribution ou d’une présentation trompeuse sans
              autorisation.
            </p>
          </LegalSection>

          <LegalSection title="Documents contractuels et données personnelles">
            <p>
              Consultez les{" "}
              <Link to="/conditions-generales" className="text-gold underline">
                conditions générales
              </Link>{" "}
              et la{" "}
              <Link to="/privacy" className="text-gold underline">
                politique de confidentialité
              </Link>
              . Les demandes relatives aux données personnelles et à la rétractation peuvent être
              déposées depuis l’espace{" "}
              <Link to="/mes-droits" className="text-gold underline">
                Mes droits
              </Link>
              .
            </p>
          </LegalSection>
        </div>
      </div>
    </main>
  );
}

function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="liquid-panel-soft rounded-lg p-5">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function LegalField({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-semibold text-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
