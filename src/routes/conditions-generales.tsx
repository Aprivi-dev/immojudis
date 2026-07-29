"use client";

import type { ReactNode } from "react";
import { createFileRoute, Link } from "@/lib/router-compat";
import { LEGAL_DOCUMENTS, legalValue, publicLegalPublisher } from "@/lib/legal-documents";

export const Route = createFileRoute("/conditions-generales")({
  head: () => ({
    meta: [
      { title: "Conditions générales — Immojudis" },
      {
        name: "description",
        content: "Conditions générales d’utilisation et de vente du service Immojudis.",
      },
    ],
  }),
  component: TermsPage,
});

export function TermsPage() {
  const publisher = publicLegalPublisher();

  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <article className="mx-auto max-w-4xl">
        <header className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            Contrat et commande
          </div>
          <h1 className="mt-4 font-display text-4xl leading-tight sm:text-5xl">
            Conditions générales d’utilisation et de vente
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Version {LEGAL_DOCUMENTS.terms.version}, applicable à compter du{" "}
            {LEGAL_DOCUMENTS.terms.effectiveDate}.
          </p>
        </header>

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
          <TermsSection title="1. Éditeur et champ d’application">
            <p>
              Les présentes conditions régissent l’accès à Immojudis, édité par{" "}
              {legalValue(publisher.entityName)}, ainsi que l’achat de l’offre Analyse. Elles sont
              accessibles avant toute commande et leur version acceptée est conservée avec la preuve
              de commande. L’utilisation du service suppose également le respect des{" "}
              <Link to="/legal" className="text-gold underline">
                mentions légales
              </Link>{" "}
              et de la{" "}
              <Link to="/privacy" className="text-gold underline">
                politique de confidentialité
              </Link>
              .
            </p>
          </TermsSection>

          <TermsSection title="2. Description des offres">
            <p>
              Découverte fournit gratuitement les informations essentielles accessibles après
              création d’un compte. Analyse est un paiement unique de 29 € TTC donnant accès pendant
              30 jours aux analyses, comparables, documents, risques et outils de décision indiqués
              sur la page d’offre. Analyse n’est pas un abonnement et ne se renouvelle pas
              automatiquement. Une nouvelle période ne peut commencer qu’après une nouvelle
              commande.
            </p>
          </TermsSection>

          <TermsSection title="3. Formation de la commande">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Le client s’authentifie et consulte les caractéristiques, la durée et le prix.
              </li>
              <li>Un récapitulatif permet de relire l’offre et les documents contractuels.</li>
              <li>
                Le client accepte expressément ces conditions et les informations de rétractation.
              </li>
              <li>Le bouton « Commander avec obligation de paiement » ouvre le paiement Stripe.</li>
              <li>La commande est conclue après confirmation du paiement par Stripe.</li>
            </ol>
            <p className="mt-3">
              Avant de confirmer, le client peut fermer le récapitulatif ou interrompre le paiement.
              La langue de conclusion est le français. La preuve d’acceptation, la référence Stripe,
              le prix et les versions documentaires sont archivés ; ils peuvent être demandés depuis
              l’espace Mes droits.
            </p>
          </TermsSection>

          <TermsSection title="4. Prix et paiement">
            <p>
              Le prix affiché est de 29 € TTC pour 30 jours. Le paiement est encaissé par Stripe au
              moyen des modes proposés dans son interface sécurisée. Immojudis ne reçoit ni ne
              conserve le numéro complet de la carte. En cas de refus ou d’annulation du paiement,
              aucun nouvel accès n’est accordé.
            </p>
          </TermsSection>

          <TermsSection title="5. Exécution et disponibilité">
            <p>
              À la demande expresse du client, l’accès Analyse commence après confirmation du
              paiement, avant l’expiration du délai de rétractation. L’accès expire 30 jours après
              son activation. Une maintenance, un incident fournisseur ou un cas de force majeure
              peut interrompre temporairement certaines fonctions ; Immojudis met alors en œuvre les
              moyens raisonnables de rétablissement.
            </p>
          </TermsSection>

          <TermsSection title="6. Droit de rétractation">
            <p>
              Le consommateur dispose en principe de 14 jours à compter de la conclusion du contrat
              pour se rétracter sans motif. Lorsqu’il demande l’exécution immédiate du service, il
              reconnaît qu’un montant proportionné au service déjà fourni peut rester dû en cas de
              rétractation. Le droit n’est perdu qu’en cas d’exécution complète dans les conditions
              prévues par la loi et après accord exprès et reconnaissance correspondante.
            </p>
            <p className="mt-3">
              La demande peut être déposée depuis{" "}
              <Link to="/mes-droits" className="text-gold underline">
                Mes droits
              </Link>{" "}
              ou en envoyant le formulaire ci-dessous à {legalValue(publisher.contactEmail)}.
              Lorsqu’un remboursement est dû, il est réalisé par le même moyen de paiement, sauf
              accord contraire, dans le délai légal applicable.
            </p>
            <WithdrawalForm />
          </TermsSection>

          <TermsSection title="7. Nature des analyses et responsabilité">
            <p>
              Immojudis fournit une aide à la lecture, sans conseil juridique, financier ou
              patrimonial individualisé. Le client doit vérifier les pièces officielles, faire la
              visite et solliciter les professionnels compétents avant toute enchère. Immojudis ne
              garantit ni l’exhaustivité d’une source externe, ni une adjudication, une rentabilité,
              un financement ou un prix de revente.
            </p>
          </TermsSection>

          <TermsSection title="8. Compte et usages autorisés">
            <p>
              Le client maintient ses accès confidentiels et fournit des informations exactes. Sont
              interdits l’accès automatisé abusif, le contournement des quotas, la redistribution
              massive des données, l’atteinte aux droits de tiers et l’utilisation frauduleuse. Un
              accès peut être suspendu de manière proportionnée en cas de fraude ou d’atteinte
              grave, sans priver le consommateur de ses droits légaux.
            </p>
          </TermsSection>

          <TermsSection title="9. Données personnelles">
            <p>
              Les traitements nécessaires au compte, à la commande et au service sont décrits dans
              la politique de confidentialité. Les droits d’accès, portabilité, rectification,
              effacement, limitation, opposition et retrait du consentement peuvent être exercés
              depuis l’espace Mes droits.
            </p>
          </TermsSection>

          <TermsSection title="10. Réclamations, médiation et droit applicable">
            <p>
              Une réclamation préalable peut être adressée à {legalValue(publisher.contactEmail)} ou
              au {legalValue(publisher.contactPhone)}. En cas d’échec, le consommateur peut saisir
              gratuitement le médiateur suivant : {legalValue(publisher.mediatorName)},{" "}
              {legalValue(publisher.mediatorAddress)}
              {publisher.mediatorWebsite ? (
                <>
                  , site{" "}
                  <a
                    href={publisher.mediatorWebsite}
                    className="text-gold underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {publisher.mediatorWebsite}
                  </a>
                </>
              ) : null}
              . Les présentes conditions sont soumises au droit français, sans priver le
              consommateur des règles impératives ni de ses juridictions légalement compétentes.
            </p>
          </TermsSection>
        </div>
      </article>
    </main>
  );
}

function TermsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="liquid-panel-soft rounded-lg p-5 sm:p-6">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function WithdrawalForm() {
  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-black/10 p-4">
      <h3 className="font-semibold text-foreground">Formulaire type de rétractation</h3>
      <p className="mt-2 whitespace-pre-line text-xs leading-relaxed">
        {`À l’attention de l’éditeur Immojudis :
Je vous notifie ma rétractation du contrat portant sur l’accès Analyse.
Commande du : …
Nom et email du consommateur : …
Date : …
Signature, uniquement en cas d’envoi papier : …`}
      </p>
    </div>
  );
}
