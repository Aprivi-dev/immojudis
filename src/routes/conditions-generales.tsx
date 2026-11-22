"use client";

import type { ReactNode } from "react";
import { createFileRoute, Link } from "@/lib/router-compat";
import {
  FREE_UNLOCK_EFFECTIVE_DATE,
  FULL_SALE_UNLOCK_EFFECTIVE_DATE,
  LEGAL_DOCUMENTS,
  legalValue,
  publicLegalPublisher,
  type LegalPublisher,
} from "@/lib/legal-documents";
import { PREVIOUS_LEGAL_DOCUMENTS } from "@/lib/legal-documents-previous";
import { resolveAnalysisOfferLabel } from "@/lib/analysis-offer";
import { PAST_DUE_GRACE_DAYS, PLAN_LIMITS } from "@/lib/plans";
import { FREE_SALE_UNLOCKS } from "@/lib/sale-unlocks";

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
            Version {LEGAL_DOCUMENTS.terms.version}, applicable dès l’inscription pour les comptes
            créés à partir de sa mise en ligne. Pour les comptes existants, l’article 2, pour ce qui
            concerne l’offre Découverte et son déblocage, s’applique à compter du{" "}
            {FULL_SALE_UNLOCK_EFFECTIVE_DATE}, et l’article 13 à compter du{" "}
            {FREE_UNLOCK_EFFECTIVE_DATE} ; les autres stipulations s’appliquent à compter du{" "}
            {LEGAL_DOCUMENTS.terms.effectiveDate}. Jusqu’à cette date, la version précédente (
            {PREVIOUS_LEGAL_DOCUMENTS.terms.version}) reste applicable aux comptes existants pour
            ces autres stipulations ; elle est communiquée sur demande à{" "}
            {legalValue(publisher.contactEmail)}. L’article 2 bis (achat d’une vente à l’unité) ne
            produit d’effet qu’à compter de l’ouverture de cet achat sur Immojudis.
          </p>
        </header>

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
          <TermsSection title="1. Éditeur et champ d’application">
            <p>
              Les présentes conditions régissent l’accès à Immojudis, édité par{" "}
              {legalValue(publisher.entityName)}, ainsi que l’achat de l’offre Analyse et l’achat
              d’une vente à l’unité (article 2 bis). Elles sont accessibles avant toute commande et
              leur version acceptée est conservée avec la preuve de commande. L’utilisation du
              service suppose également le respect des{" "}
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
              Découverte est gratuite, sans limite de durée et sans carte bancaire. Elle fournit,
              après création d’un compte, l’accès aux fiches des ventes (adresse, photos,
              description, occupation, dates de visite et contact), un niveau d’écart entre la mise
              à prix et le marché, sans chiffre, et un aperçu chiffré de l’analyse (nombre de ventes
              comparables, de points relevés dans les pièces, de passages), lorsqu’ils sont
              disponibles, {PLAN_LIMITS.decouverte.favoriteSales} favoris au maximum, une alerte
              avec un email hebdomadaire et {FREE_SALE_UNLOCKS} déblocage de vente en tout, qui ne
              se renouvelle pas chaque mois. La valeur estimée, sa fourchette et l’écart chiffré
              avec la mise à prix ne sont pas compris dans Découverte : ils sont ouverts par un
              déblocage ou par l’offre Analyse. Un déblocage ouvre, pour une vente de votre choix,
              l’ensemble des éléments de l’offre Analyse propres à cette vente, lorsqu’elle les
              comporte : l’enchère plafond ou l’offre plafond chiffrée, selon la vente, l’estimation
              détaillée (valeur estimée et fourchette) et les ventes comparables, le budget travaux
              détaillé, les pièces du dossier et leur lecture, l’historique de la vente, les
              statistiques du tribunal compétent pour cette vente, l’urbanisme et le cadastre, le
              dossier du terrain, l’analyse du quartier, la prévision d’audience, le rapport
              enregistré et le rapport PDF de cette vente. Restent réservés à l’offre Analyse : ces
              éléments sur les autres ventes, l’export CSV, les alertes avancées et quotidiennes,
              les favoris au-delà de {PLAN_LIMITS.decouverte.favoriteSales}, les statistiques des
              autres tribunaux, le partage d’un rapport par lien et la mise en relation avec un
              avocat référencé. Le déblocage est consommé quand vous le confirmez, après affichage
              du nombre restant ; il n’est pas consommé en cas d’erreur technique, ni si la vente
              est déjà débloquée. Il est rendu automatiquement si la vente est retirée avant d’avoir
              lieu, par la juridiction, le notaire ou la source. Si Immojudis retire elle-même la
              vente ou en suspend la publication pour une raison qui lui est imputable (par exemple
              une erreur de publication ou la suspension d’une source décidée par Immojudis), le
              déblocage est rendu sur simple demande adressée à {legalValue(publisher.contactEmail)}
              , qui reçoit une réponse sous un mois. Il n’est pas rendu si la vente est reportée ou
              adjugée. Une vente débloquée reste consultable avec ces éléments tant qu’elle est en
              ligne sur Immojudis, dans la limite de 24 mois après le déblocage, et tant que votre
              compte existe. Passé ce délai de 24 mois, le déblocage n’est plus conservé et un
              déblocage redevient disponible. Le déblocage est personnel (article 9). Pendant un
              abonnement Analyse, aucun déblocage n’est consommé. À la fin de l’abonnement, le
              compte revient à Découverte : les ventes que vous aviez déjà débloquées restent
              accessibles ; les autres ventes consultées pendant l’abonnement redeviennent soumises
              au déblocage.
            </p>
            <p className="mt-3">
              Une fois le déblocage du compte gratuit utilisé, une autre vente s’ouvre avec l’offre
              Analyse ou, lorsque cet achat est proposé, par l’achat d’une vente à l’unité, dans les
              conditions de l’article 2 bis.
            </p>
            <p className="mt-3">
              Immojudis peut modifier ou supprimer le déblocage du compte gratuit pour l’avenir, en
              vous prévenant au moins {FREE_BENEFIT_NOTICE_DAYS} jours à l’avance par un message
              dans l’application ou à l’adresse email de votre compte. Les ventes que vous avez déjà
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
              suffisant), enchère plafond ou offre plafond selon la vente, estimation des travaux,
              valeur du bien et autres analyses présentées sur la page d’offre. La couverture varie
              selon les tribunaux, les biens et les pièces disponibles ; elle est indiquée sur
              chaque fiche. L’abonnement est conclu pour une durée indéterminée et facturé chaque
              mois. Vous pouvez le résilier à tout moment, sans frais ni préavis ; la résiliation
              prend effet à la fin de la période mensuelle en cours. Le prix est prélevé
              automatiquement à la souscription, puis chaque mois à la même date, jusqu’à la
              résiliation. L’abonnement ne comprend pas de période d’essai. Le tarif applicable est
              présenté avant la confirmation de la souscription.
            </p>
            <p className="mt-3">
              Lorsqu’il est attribué à une vente, le repère « Pépite » est visible par tous. Il est
              calculé automatiquement par Immojudis, à partir de critères publics décrits sur la
              page{" "}
              <Link to="/methode-pepites" className="text-gold underline">
                Comment repérons-nous les pépites ?
              </Link>
              . Le montant de l’enchère plafond ou de l’offre plafond estimée, selon la vente, et le
              détail du calcul sont réservés à l’offre Analyse ou à un déblocage, dans les
              conditions du présent article.
            </p>
          </TermsSection>

          <TermsSection title="2 bis. Achat d’une vente à l’unité">
            <p>
              Lorsque le déblocage compris dans Découverte a été utilisé, le titulaire du compte
              peut acheter le déblocage d’une autre vente. Cet achat ouvre, pour la vente choisie,
              les mêmes éléments qu’un déblocage du compte gratuit (article 2), tant que la vente
              est en ligne sur Immojudis, dans la limite de 24 mois après le déblocage, et tant que
              le compte existe. Il n’ouvre aucune autre vente ni les éléments que l’article 2
              réserve à l’offre Analyse.
            </p>
            <p className="mt-3">
              Prix : 19 € TTC par vente. Ce prix est un prix final : TVA non applicable, art. 293 B
              du CGI. Le paiement est unique, par carte bancaire, par l’intermédiaire de Stripe ;
              Immojudis ne reçoit ni ne conserve le numéro complet de la carte. Le montant est
              affiché avant la confirmation du paiement.
            </p>
            <p className="mt-3">
              L’analyse de la vente est un contenu numérique fourni dès la confirmation du paiement,
              à la demande expresse du client. Avant le paiement, le client demande cet accès
              immédiat et reconnaît perdre son droit de rétractation une fois l’accès fourni
              (article 6). L’achat est confirmé par email.
            </p>
            <p className="mt-3">
              Si la vente est retirée avant d’avoir lieu, ou si elle n’est plus disponible au moment
              où le paiement aboutit, l’achat n’est pas remboursé : il devient un crédit qui permet
              de débloquer une autre vente, dans les conditions du présent article. Les crédits
              disponibles sont indiqués dans Mon compte.
            </p>
            <p className="mt-3">
              Les achats à l’unité payés dans les 30 jours qui précèdent la souscription de l’offre
              Analyse sont déduits du prix du premier mois d’abonnement, dans la limite de ce prix.
            </p>
            <p className="mt-3">
              L’achat est personnel : la vente débloquée ne se partage ni ne se transmet (article
              9). Le présent article ne produit d’effet qu’à compter de l’ouverture de l’achat d’une
              vente à l’unité sur Immojudis.
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
                périodicité et la date du premier prélèvement.
              </li>
              <li>La souscription est conclue après sa confirmation dans Stripe.</li>
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
              Prix de l’abonnement Analyse : {resolveAnalysisOfferLabel()}. Ce prix est un prix
              final : TVA non applicable, art. 293 B du CGI. Le montant et la périodicité sont
              précisés dans le récapitulatif avant toute souscription. Stripe prélève ce montant à
              la souscription, puis à chaque échéance tant que l’abonnement n’est pas résilié.
              Immojudis ne reçoit ni ne conserve le numéro complet de la carte.
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
              souscription, pendant les périodes payées. Une maintenance, un incident fournisseur ou
              un cas de force majeure peut interrompre temporairement certaines fonctions ;
              Immojudis met alors en œuvre les moyens raisonnables de rétablissement.
            </p>
            <p className="mt-3">
              Résiliation. Vous pouvez résilier à tout moment, gratuitement, depuis la page{" "}
              <Link to="/compte" className="text-gold underline">
                Mon compte
              </Link>
              , bouton « Résilier mon abonnement », qui ouvre directement le formulaire de
              résiliation du portail de paiement sécurisé Stripe. La date de fin d’accès est
              affichée avant confirmation. La résiliation empêche les prochains renouvellements et
              l’accès reste ouvert jusqu’à la fin de la période payée. Les accès précédemment
              achetés par paiement unique restent valables jusqu’à leur échéance initiale. Nous vous
              confirmons par email la réception de votre demande et la date de fin du contrat.
            </p>
          </TermsSection>

          <TermsSection title="6. Droit de rétractation">
            <p className="mb-3">
              L’offre Découverte est sans paiement : aucun montant n’est dû, et vous pouvez demander
              la fermeture de votre compte à tout moment, gratuitement, depuis Mes droits. Le droit
              de rétractation ci-dessous s’applique à l’abonnement Analyse : le délai de 14 jours
              court à compter de la conclusion de l’abonnement. Pour l’achat d’une vente à l’unité
              (article 2 bis), l’analyse de la vente est fournie dès la confirmation du paiement, à
              la demande expresse du client, qui reconnaît avant le paiement perdre son droit de
              rétractation une fois l’accès fourni.
            </p>
            <p>
              Le consommateur dispose en principe de 14 jours à compter de la conclusion du contrat
              pour se rétracter sans motif. Lorsqu’il demande l’exécution immédiate du service, il
              reconnaît qu’un montant proportionné au service déjà fourni peut rester dû en cas de
              rétractation. Pour l’abonnement, le droit n’est perdu qu’en cas d’exécution complète
              dans les conditions prévues par la loi et après accord exprès et reconnaissance
              correspondante.
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
              patrimonial individualisé. Le repère « Pépite », les enchères et offres plafond
              estimées et les prix probables sont des aides à la lecture calculées automatiquement à
              partir des données disponibles : ce sont des hypothèses et non des résultats. Ils ne
              constituent ni un conseil, ni une recommandation d’acheter ou d’enchérir, et ne
              garantissent ni un prix, ni un rendement, ni une adjudication, ni un prix de revente.
              Le client doit vérifier les pièces officielles, faire la visite et solliciter les
              professionnels compétents avant toute enchère. Immojudis ne garantit ni l’exhaustivité
              d’une source externe, ni une adjudication, une rentabilité, un financement ou un prix
              de revente. Les rappels et avertissements sont indicatifs. Ils ne dispensent pas de
              vérifier la date et le statut de la vente auprès de l’avocat poursuivant.
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

          <TermsSection title="10. Classement, référencement et mise en avant">
            <p>
              Par défaut, les annonces dont la position sur la carte est connue passent avant les
              autres. Elles sont ensuite classées selon la quantité d’informations renseignées dans
              leur fiche, puis par date de vente la plus proche. Aucune rémunération ne peut
              améliorer le rang d’une annonce ni lui valoir un repère (« Annonce bien renseignée »,
              « Pépite »).
            </p>
            <p className="mt-3">
              Le repère « Pépite » est attribué par un calcul automatique, à partir de critères
              publics décrits sur la page{" "}
              <Link to="/methode-pepites" className="text-gold underline">
                Comment repérons-nous les pépites ?
              </Link>
              . Aucune rémunération ne peut obtenir ou améliorer une Pépite : ni les cabinets
              d’avocats qui achètent une mise en avant, ni les organisateurs, vendeurs ou
              professionnels qui publient des annonces. Le repère ne modifie pas l’ordre des
              annonces. Les encarts sponsorisés des cabinets d’avocats sont séparés des annonces et
              sans lien avec ce repère.
            </p>
            <p className="mt-3">
              Dans l’annuaire des avocats, les cabinets qui rémunèrent Immojudis, ou bénéficient
              d’une période d’essai de cette offre de mise en avant, sont affichés en premier dans
              une section distincte, signalés « Publicité · Sponsorisé » ; ils ne sont ni
              recommandés ni notés. Un encart d’un cabinet d’avocats, signalé de la même façon, peut
              aussi apparaître dans la liste des ventes pour une zone géographique ; il ne modifie
              pas l’ordre des annonces et n’est ni une recommandation, ni une notation, ni une
              garantie de résultat.
            </p>
            <p className="mt-3">
              Les annonces proviennent de sources publiques et d’organisateurs de ventes, ou de
              professionnels disposant d’un compte validé : Immojudis ne les rédige pas et ne
              garantit pas leur exactitude. Une vente passée, annulée ou retirée n’est plus affichée
              dès que cette information est connue d’Immojudis. Le détail figure sur la page{" "}
              <Link to="/classement-des-annonces" className="text-gold underline">
                Comment sont classées les annonces ?
              </Link>
              .
            </p>
          </TermsSection>

          <TermsSection title="11. Données personnelles">
            <p>
              Les traitements nécessaires au compte, à la commande et au service sont décrits dans
              la politique de confidentialité. Les droits d’accès, portabilité, rectification,
              effacement, limitation, opposition et retrait du consentement peuvent être exercés
              depuis l’espace Mes droits.
            </p>
          </TermsSection>

          <TermsSection title="12. Réclamations, médiation et droit applicable">
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

          <TermsSection title="13. Fin de l’essai gratuit à l’inscription">
            <p>
              L’essai gratuit de l’offre Analyse à l’inscription n’est plus proposé depuis le{" "}
              {FREE_UNLOCK_EFFECTIVE_DATE}, date d’entrée en vigueur de cet article. Les comptes qui
              en bénéficiaient à cette date sont revenus à l’offre Découverte, sans frais, sans
              paiement automatique et sans suppression des données. Leurs données (favoris, alertes,
              rapports enregistrés) restent conservées dans les conditions de la politique de
              confidentialité.
            </p>
          </TermsSection>

          <TermsSection title="14. Modification des conditions">
            <p>
              Immojudis peut modifier les présentes conditions pour tenir compte de l’évolution du
              service, du droit ou de contraintes techniques. Les titulaires de compte en sont
              informés par email ou par message dans l’application au moins{" "}
              {FREE_BENEFIT_NOTICE_DAYS} jours avant l’entrée en vigueur, sauf obligation légale ou
              impératif de sécurité. Une modification n’est jamais appliquée à un abonnement en
              cours sans l’accord du client. Le titulaire peut fermer son compte gratuitement avant
              l’entrée en vigueur.
            </p>
          </TermsSection>
        </div>
      </article>
    </main>
  );
}

function TermsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="liquid-panel-flat rounded-lg p-5 sm:p-6">
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
