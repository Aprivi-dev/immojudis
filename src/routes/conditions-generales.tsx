"use client";

import type { ReactNode } from "react";
import { createFileRoute, Link } from "@/lib/router-compat";
import {
  LEGAL_DOCUMENTS,
  legalValue,
  publicLegalPublisher,
  type LegalPublisher,
} from "@/lib/legal-documents";
import { ANALYSIS_TRIAL_DAYS, resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import { PAST_DUE_GRACE_DAYS } from "@/lib/plans";
import { MONTHLY_SALE_UNLOCKS } from "@/lib/sale-unlocks";

/** Notice given before the free-offer benefits are changed or withdrawn for the future. */
const FREE_BENEFIT_NOTICE_DAYS = 30;

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
              Découverte est gratuite, sans limite de durée et sans carte bancaire. Elle fournit les
              informations essentielles accessibles après création d’un compte : l’accès aux fiches
              des ventes, trois favoris au maximum, une alerte avec un email hebdomadaire et, chaque
              mois civil, {MONTHLY_SALE_UNLOCKS} déblocages. Un déblocage ouvre, pour une vente de
              votre choix, les éléments suivants de l’offre Analyse lorsque cette vente les comporte
              : l’enchère plafond chiffrée, la lecture des pièces, l’historique de la vente, les
              statistiques du tribunal compétent pour cette vente et les pièces du dossier. Les
              autres fonctions de l’offre Analyse, notamment l’export PDF ou CSV, les rapports
              enregistrés, le budget travaux, les alertes avancées et la mise en relation avec un
              avocat référencé, restent réservées à cette offre. Le déblocage est consommé quand
              vous le confirmez, après affichage du nombre restant ; il n’est pas consommé en cas
              d’erreur technique, ni si la vente est déjà débloquée. Il n’est pas restitué si la
              vente est ensuite reportée ou adjugée, ni si elle est retirée par la juridiction ou la
              source. Si Immojudis retire elle-même la vente pour une raison qui lui est imputable,
              le déblocage est restitué sur simple demande depuis{" "}
              <Link to="/mes-droits" className="text-gold underline">
                Mes droits
              </Link>{" "}
              ou à l’adresse de contact. Les déblocages non utilisés ne sont pas reportés. Le
              compteur est remis à {MONTHLY_SALE_UNLOCKS} le 1er de chaque mois à 00 h 00, heure de
              Paris. Une vente débloquée reste consultable avec ces éléments tant qu’elle est en
              ligne sur Immojudis, dans la limite de 24 mois après le déblocage, et tant que votre
              compte existe. Les déblocages sont personnels (article 9). Pendant un abonnement
              Analyse, essai compris, aucun déblocage n’est consommé. À la fin de l’abonnement, le
              compte revient à Découverte : les ventes que vous aviez déjà débloquées restent
              accessibles ; les autres ventes consultées pendant l’abonnement redeviennent soumises
              aux déblocages.
            </p>
            <p className="mt-3">
              Immojudis peut modifier ou supprimer les déblocages mensuels pour l’avenir, en vous
              prévenant au moins {FREE_BENEFIT_NOTICE_DAYS} jours à l’avance par un message dans
              l’application ou à l’adresse email de votre compte. Les ventes que vous avez déjà
              débloquées restent accessibles dans les conditions ci-dessus, et les déblocages déjà
              consommés ne sont pas affectés. Si la modification ne vous convient pas, vous pouvez
              fermer votre compte gratuitement depuis{" "}
              <Link to="/mes-droits" className="text-gold underline">
                Mes droits
              </Link>
              .
            </p>
            <p className="mt-3">
              Analyse est un abonnement aux outils d’analyse : statistiques des tribunaux et
              scénarios d’enchères (disponibles lorsque l’historique des ventes du tribunal est
              suffisant), enchère plafond, estimation des travaux, valeur du bien et autres analyses
              présentées sur la page d’offre. La couverture varie selon les tribunaux, les biens et
              les pièces disponibles ; elle est indiquée sur chaque fiche. L’abonnement est conclu
              pour une durée indéterminée et facturé chaque mois. Vous pouvez le résilier à tout
              moment, sans frais ni préavis ; la résiliation prend effet à la fin de la période
              mensuelle en cours. Lorsqu’il est proposé (une seule fois par compte), un essai
              gratuit de {ANALYSIS_TRIAL_DAYS} jours nécessite l’enregistrement d’une carte bancaire
              auprès de Stripe. À son terme, l’abonnement devient payant et se renouvelle
              automatiquement, sauf résiliation avant la fin de l’essai. Les conditions
              d’éligibilité et le tarif applicable sont présentés avant la confirmation de la
              souscription.
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
              <li>
                Le client ouvre le récapitulatif Stripe et vérifie le montant récurrent, la
                périodicité, la fin de l’essai et la date du premier prélèvement.
              </li>
              <li>
                La souscription est conclue après sa confirmation dans Stripe. L’essai n’entraîne
                pas de prélèvement du prix de l’abonnement avant son échéance.
              </li>
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
              Prix de l’abonnement Analyse : {resolveAnalysisOfferLabel()}, précédé d’un essai
              gratuit de {ANALYSIS_TRIAL_DAYS} jours lorsque celui-ci est proposé. Le montant TTC et
              la périodicité sont précisés dans le récapitulatif avant toute souscription. Après
              l’essai, Stripe prélève ce montant à chaque échéance tant que l’abonnement n’est pas
              résilié. Immojudis ne reçoit ni ne conserve le numéro complet de la carte.
            </p>
            <p className="mt-3">
              En cas d’échec de paiement, Stripe retente le prélèvement. Votre accès Analyse reste
              ouvert {PAST_DUE_GRACE_DAYS} jours à compter de la fin de la période payée pour vous
              permettre de mettre à jour votre moyen de paiement ; la mensualité reste due. Passé ce
              délai sans paiement, l’accès est suspendu. Votre compte Découverte et vos données
              restent accessibles.
            </p>
          </TermsSection>

          <TermsSection title="5. Exécution et disponibilité">
            <p>
              À la demande expresse du client, l’accès Analyse commence après confirmation de la
              souscription, pendant l’essai puis les périodes payées. Une maintenance, un incident
              fournisseur ou un cas de force majeure peut interrompre temporairement certaines
              fonctions ; Immojudis met alors en œuvre les moyens raisonnables de rétablissement.
            </p>
            <p className="mt-3">
              Résiliation. Vous pouvez résilier à tout moment, gratuitement, depuis la page{" "}
              <Link to="/compte" className="text-gold underline">
                Mon compte
              </Link>
              , bouton « Résilier mon abonnement », qui ouvre directement le formulaire de
              résiliation du portail de paiement sécurisé Stripe. La date de fin d’accès est
              affichée avant confirmation. Une résiliation pendant l’essai évite le premier
              prélèvement ; après l’essai, elle empêche les prochains renouvellements et l’accès
              reste ouvert jusqu’à la fin de la période payée. Les accès précédemment achetés par
              paiement unique restent valables jusqu’à leur échéance initiale. Nous vous confirmons
              par email la réception de votre demande et la date de fin du contrat.
            </p>
          </TermsSection>

          <TermsSection title="6. Droit de rétractation">
            <p className="mb-3">
              L’essai commercial de sept jours ne remplace pas le droit légal de rétractation.
              Pendant l’essai gratuit, aucun montant n’est dû en cas de rétractation.
            </p>
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
            <WithdrawalForm publisher={publisher} />
          </TermsSection>

          <TermsSection title="7. Garantie légale de conformité">
            <p>
              Garantie légale de conformité. Vous bénéficiez de la garantie légale de conformité des
              contenus et services numériques (articles L. 224-25-12 à L. 224-25-26 du code de la
              consommation). Pour un service fourni de manière continue, nous répondons des défauts
              de conformité qui apparaissent pendant toute la durée de l’abonnement.
            </p>
          </TermsSection>

          <TermsSection title="8. Nature des analyses et responsabilité">
            <p>
              Immojudis fournit une aide à la lecture, sans conseil juridique, financier ou
              patrimonial individualisé. Le client doit vérifier les pièces officielles, faire la
              visite et solliciter les professionnels compétents avant toute enchère. Immojudis ne
              garantit ni l’exhaustivité d’une source externe, ni une adjudication, une rentabilité,
              un financement ou un prix de revente.
            </p>
          </TermsSection>

          <TermsSection title="9. Compte et usages autorisés">
            <p>
              Le client maintient ses accès confidentiels et fournit des informations exactes. Les
              déblocages de ventes sont personnels : ils ne se partagent ni ne se transmettent. Sont
              interdits l’accès automatisé abusif, le contournement des quotas, notamment la
              création de plusieurs comptes pour multiplier les déblocages, la redistribution
              massive des données, l’atteinte aux droits de tiers et l’utilisation frauduleuse. Un
              accès peut être suspendu de manière proportionnée en cas de fraude ou d’atteinte
              grave, sans priver le consommateur de ses droits légaux.
            </p>
          </TermsSection>

          <TermsSection title="10. Données personnelles">
            <p>
              Les traitements nécessaires au compte, à la commande et au service sont décrits dans
              la politique de confidentialité. Les droits d’accès, portabilité, rectification,
              effacement, limitation, opposition et retrait du consentement peuvent être exercés
              depuis l’espace Mes droits.
            </p>
          </TermsSection>

          <TermsSection title="11. Réclamations, médiation et droit applicable">
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

function WithdrawalForm({ publisher }: { publisher: LegalPublisher }) {
  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-black/10 p-4">
      <h3 className="font-semibold text-foreground">Formulaire type de rétractation</h3>
      <p className="mt-2 whitespace-pre-line text-xs leading-relaxed">
        {`À l’attention de ${legalValue(publisher.entityName)}, ${legalValue(publisher.address)}, ${legalValue(publisher.contactEmail)} :
Je vous notifie ma rétractation du contrat portant sur l’accès Analyse.
Commande du : …
Nom et email du consommateur : …
Date : …
Signature, uniquement en cas d’envoi papier : …`}
      </p>
    </div>
  );
}
