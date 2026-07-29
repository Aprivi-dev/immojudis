"use client";

import type { ReactNode } from "react";
import { createFileRoute, Link } from "@/lib/router-compat";
import { LEGAL_DOCUMENTS, legalValue, publicLegalPublisher } from "@/lib/legal-documents";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Confidentialité — Immojudis" },
      { name: "description", content: "Politique de confidentialité Immojudis." },
    ],
  }),
  component: PrivacyPage,
});

const processingRows = [
  {
    purpose: "Compte, authentification et sécurité",
    data: "Identité de compte, email, rôles, sessions, journaux nécessaires à la sécurité",
    basis: "Exécution du contrat et intérêt légitime à sécuriser le service",
    retention:
      "Pendant le compte, puis suppression ou archivage restreint selon les obligations applicables",
  },
  {
    purpose: "Fonctions Découverte et Analyse",
    data: "Favoris, alertes, zones, rapports, notes, simulations, exports et espaces collaboratifs",
    basis: "Exécution du contrat ou mesures précontractuelles",
    retention:
      "Pendant le compte ; les données d’usage expirées sont purgées selon la matrice de conservation",
  },
  {
    purpose: "Commande et accès payant",
    data: "Références Stripe, offre, prix, état du paiement et preuve d’acceptation contractuelle",
    basis: "Exécution du contrat et obligations comptables/fiscales",
    retention:
      "Preuves contractuelles et comptables jusqu’à 10 ans ; données carte conservées par Stripe, pas par Immojudis",
  },
  {
    purpose: "Alertes email",
    data: "Préférences, consentement horodaté, révocation et historique de livraison",
    basis: "Consentement ; exécution du service pour les messages strictement transactionnels",
    retention: "Jusqu’au retrait du consentement ; notifications clôturées purgées après 6 mois",
  },
  {
    purpose: "Mise en relation et publication professionnelle",
    data: "Coordonnées, message, dossier concerné, informations fournies et suivi de la demande",
    basis: "Mesures précontractuelles, exécution du service et intérêt légitime au suivi",
    retention: "Durée du traitement puis archivage limité aux délais de preuve applicables",
  },
  {
    purpose: "Mesure, qualité et exploitation",
    data: "Événements d’usage, performances, identifiants techniques, erreurs et état des traitements",
    basis: "Intérêt légitime à améliorer, sécuriser et maintenir Immojudis",
    retention:
      "Événements et journaux applicatifs jusqu’à 24 mois, sauf durée fournisseur plus courte",
  },
  {
    purpose: "Exercice des droits et rétractation",
    data: "Email, type de demande, message, vérification, décisions et dates de traitement",
    basis: "Obligation légale et défense des droits",
    retention: "Demandes clôturées supprimées après 5 ans",
  },
] as const;

export function PrivacyPage() {
  const publisher = publicLegalPublisher();

  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <article className="mx-auto max-w-5xl">
        <header className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            Données personnelles
          </div>
          <h1 className="mt-4 font-display text-4xl leading-tight sm:text-5xl">
            Politique de confidentialité
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Version {LEGAL_DOCUMENTS.privacy.version}, en vigueur le{" "}
            {LEGAL_DOCUMENTS.privacy.effectiveDate}. Cette page explique quelles données sont
            utilisées, pourquoi, pendant combien de temps et comment exercer vos droits.
          </p>
        </header>

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
          <PrivacySection title="Responsable du traitement et contact">
            <p>
              Le responsable du traitement est {legalValue(publisher.entityName)}, situé à{" "}
              {legalValue(publisher.address)}. Pour toute question :{" "}
              {legalValue(publisher.contactEmail)} ou {legalValue(publisher.contactPhone)}. Les{" "}
              <Link to="/legal" className="text-gold underline">
                mentions légales
              </Link>{" "}
              complètent cette identification.
            </p>
          </PrivacySection>

          <PrivacySection title="Traitements, bases juridiques et durées">
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Tableau des traitements, bases juridiques et durées de conservation"
            >
              <table className="min-w-[760px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-white/15 text-foreground">
                    <th className="px-2 py-3">Finalité</th>
                    <th className="px-2 py-3">Données principales</th>
                    <th className="px-2 py-3">Base juridique</th>
                    <th className="px-2 py-3">Conservation</th>
                  </tr>
                </thead>
                <tbody>
                  {processingRows.map((row) => (
                    <tr key={row.purpose} className="border-b border-white/10 align-top">
                      <td className="px-2 py-3 font-semibold text-foreground">{row.purpose}</td>
                      <td className="px-2 py-3">{row.data}</td>
                      <td className="px-2 py-3">{row.basis}</td>
                      <td className="px-2 py-3">{row.retention}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PrivacySection>

          <PrivacySection title="Données obligatoires et conséquences">
            <p>
              L’email et les informations d’authentification sont nécessaires au compte. Les
              références de paiement et acceptations contractuelles sont nécessaires à l’achat
              Analyse. Les autres informations de profil, alertes ou dossiers sont facultatives,
              mais leur absence peut empêcher la fonctionnalité correspondante. Aucune donnée de
              carte complète n’est transmise à Immojudis.
            </p>
          </PrivacySection>

          <PrivacySection title="Destinataires et sous-traitants">
            <p>
              Les données sont accessibles aux personnes habilitées d’Immojudis et, selon le besoin,
              à Supabase (authentification et base), Vercel (hébergement, journaux et mesure de
              performance), Stripe (paiement), Resend (emails) et aux avocats référencés uniquement
              lorsqu’une mise en relation est demandée. Les prestataires agissent dans la limite de
              leurs missions contractuelles.
            </p>
          </PrivacySection>

          <PrivacySection title="Transferts hors de l’Espace économique européen">
            <p>
              Certains fournisseurs peuvent traiter des données aux États-Unis ou dans d’autres
              pays. Ces transferts reposent, selon le fournisseur et le service, sur une décision
              d’adéquation telle que le cadre UE–États-Unis applicable, des clauses contractuelles
              types ou une autre garantie prévue par le RGPD. Les garanties pertinentes peuvent être
              demandées depuis l’espace Mes droits.
            </p>
          </PrivacySection>

          <PrivacySection title="Cookies, stockage local et mesure d’audience">
            <p>
              Supabase utilise les éléments strictement nécessaires à la session. Le navigateur peut
              conserver des préférences fonctionnelles, comme des paramètres de simulation ou les
              annonces consultées. Vercel Analytics et Speed Insights servent à mesurer de façon
              agrégée la fréquentation et les performances. Immojudis n’active pas de publicité
              ciblée ni de traceur publicitaire. Toute future finalité non nécessaire soumise au
              consentement devra être désactivée par défaut jusqu’au choix de l’utilisateur.
            </p>
          </PrivacySection>

          <PrivacySection title="Décisions automatisées et enrichissements">
            <p>
              Les scores, estimations et synthèses automatisées assistent la lecture d’un dossier,
              mais ne produisent aucune décision juridique ou financière opposable et n’empêchent
              pas l’accès à une vente. Ils doivent être vérifiés à partir des sources affichées et
              des pièces officielles.
            </p>
          </PrivacySection>

          <PrivacySection title="Vos droits">
            <p>
              Selon votre situation, vous pouvez demander l’accès, la portabilité, la rectification,
              l’effacement, la limitation ou vous opposer à un traitement fondé sur l’intérêt
              légitime. Vous pouvez retirer un consentement à tout moment sans remettre en cause les
              traitements antérieurs. Une demande simple reçoit une réponse au plus tard sous un
              mois ; une prolongation motivée peut être notifiée lorsque la demande est complexe.
            </p>
            <p className="mt-3">
              Le moyen le plus direct est l’espace authentifié{" "}
              <Link to="/mes-droits" className="text-gold underline">
                Mes droits
              </Link>
              , qui établit l’identité du compte sans demander automatiquement une pièce d’identité.
              En cas de doute raisonnable, une vérification complémentaire proportionnée peut être
              demandée. Vous pouvez également saisir la{" "}
              <a
                href="https://www.cnil.fr/fr/plaintes"
                className="text-gold underline"
                target="_blank"
                rel="noreferrer"
              >
                CNIL
              </a>
              .
            </p>
          </PrivacySection>

          <PrivacySection title="Effacement du compte et exceptions">
            <p>
              La suppression du compte entraîne la suppression en cascade des favoris, alertes,
              rapports, notes et principaux espaces personnels. Les données strictement nécessaires
              à une obligation comptable, à la preuve d’un contrat, au traitement d’une demande ou à
              la défense d’un droit sont isolées et conservées jusqu’à l’expiration de leur durée,
              puis purgées automatiquement.
            </p>
          </PrivacySection>
        </div>
      </article>
    </main>
  );
}

function PrivacySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="liquid-panel-soft rounded-lg p-5 sm:p-6">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
