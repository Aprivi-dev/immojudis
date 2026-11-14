"use client";

import type { ReactNode } from "react";
import { createFileRoute, Link } from "@/lib/router-compat";
import { AnalyticsConsentSwitch } from "@/components/AnalyticsConsentSwitch";
import { AudienceOptOutSwitch } from "@/components/AudienceOptOutSwitch";
import { COURT_REGISTRY_DAILY_CAP_DEFAULT } from "@/lib/information-agent/court-registry-fallback";
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
    data: "Favoris, alertes, zones, rapports, notes, simulations, exports et espaces collaboratifs ; journal des fonctions utilisées (compte, vente ou tribunal concerné, date), par exemple pour l’historique ou la valeur d’une vente débloquée",
    basis: "Exécution du contrat ou mesures précontractuelles",
    retention:
      "Pendant le compte ; le journal d’usage (quotas et fonctions utilisées) est conservé 24 mois au plus ; il est distinct des événements de parcours par compte, conservés 90 jours (voir plus bas) ; les autres données d’usage expirées sont purgées selon la matrice de conservation",
  },
  {
    purpose: "Profil d’investisseur (facultatif)",
    data: "Apport personnel, marge cible, budget de travaux au m² et stratégie (revendre ou louer), chacun facultatif, saisis par vous dans « Mon compte ». Ce sont des données financières personnelles : elles ne sont visibles que de vous, jamais envoyées par email ni communiquées à des tiers (seul notre hébergeur, Supabase, les stocke)",
    basis:
      "Exécution du contrat : préremplir, à votre demande, le calcul de l’enchère plafond de chaque vente (vous le modifiez ensuite vente par vente) et l’apport du simulateur de financement",
    retention:
      "Tant que le compte existe ; effacement immédiat par le bouton « Effacer mon profil » de « Mon compte » ; suppression avec le compte",
  },
  {
    purpose: "Commande et accès payant",
    data: "Références Stripe, offre, prix, état du paiement et preuve d’acceptation contractuelle",
    basis: "Exécution du contrat et obligations comptables/fiscales",
    retention:
      "Preuves contractuelles et comptables jusqu’à 10 ans ; données carte conservées par Stripe, pas par Immojudis",
  },
  {
    purpose: "Essai gratuit de l’offre Analyse à l’inscription et prévention des abus",
    data: "Date de confirmation de l’adresse email ; forme normalisée de l’adresse (sans sous-adresse ni points pour Gmail) comparée à celle des autres comptes ; domaine de l’adresse comparé à une liste d’adresses jetables. La vérification est automatique : si l’essai ne vous est pas accordé, écrivez-nous pour la faire revoir",
    basis:
      "Intérêt légitime : réserver l’essai à une fois par personne et prévenir les comptes multiples. Vous pouvez vous y opposer en nous écrivant",
    retention: "Pendant le compte ; la forme normalisée de l’adresse est supprimée avec le compte",
  },
  {
    purpose: "Déblocages mensuels de ventes (offre Découverte)",
    data: "Identifiant de compte, vente débloquée, date du déblocage",
    basis:
      "Exécution du contrat : appliquer l’avantage et sa limite prévus par les conditions générales",
    retention:
      "24 mois au plus après le déblocage, et suppression avec le compte. Si la vente est supprimée du site, le lien avec la vente est coupé : seuls l’identifiant de compte et la date du déblocage sont gardés, jusqu’à la fin du mois civil du déblocage (effacement lors de la purge hebdomadaire qui suit), pour que le compteur du mois ne soit pas remis à zéro.",
  },
  {
    purpose: "Alertes email",
    data: "Préférences, consentement horodaté, révocation et historique de livraison",
    basis: "Consentement ; exécution du service pour les messages strictement transactionnels",
    retention: "Jusqu’au retrait du consentement ; notifications clôturées purgées après 6 mois",
  },
  {
    purpose: "Rappels d’audience",
    data: "Consentement daté et versionné (date, version du texte, date de retrait) ; journal d’envoi (vente, type de rappel, date, état). L’email du compte sert à l’envoi, par Resend",
    basis:
      "Consentement (case non pré-cochée), retirable à tout moment en un clic, dans les réglages ou par le lien de désinscription de chaque email",
    retention:
      "Consentement et date de retrait : tant que le compte existe ; journal d’envoi : 180 jours après sa création, puis suppression à la purge hebdomadaire (au plus 187 jours environ), selon la matrice de conservation",
  },
  {
    purpose: "Journal des emails envoyés par Immojudis",
    data: "Pour chaque email envoyé par Immojudis (alertes, rappels, messages liés au compte, au paiement, à une demande de droits ou à une mise en relation, échanges avec des professionnels) : date d’envoi, adresse du destinataire, objet, type de message, lien avec votre compte le cas échéant et état de la remise indiqué par notre prestataire d’envoi (envoyé, remis, différé, rebond, plainte, échec). Le contenu du message n’est pas conservé dans ce journal.",
    basis:
      "Intérêt légitime : contrôler la bonne remise des messages, répondre à vos questions sur un email reçu ou non reçu, détecter les abus et prouver l’envoi. Vous pouvez vous opposer pour des raisons tenant à votre situation en écrivant à",
    basisEndsWithContact: true,
    retention:
      "90 jours après l’envoi (suppression à la purge hebdomadaire, soit 97 jours au plus) ; suppression avec le compte. Notre prestataire d’envoi conserve de son côté le contenu des messages et ses propres journaux 30 jours.",
  },
  {
    purpose: "Ventes passées suivies",
    data: "Résumé d’une vente suivie dont l’audience est passée : titre, commune (avec département et code postal), tribunal, type de bien, mise à prix, date d’audience, nom de l’avocat tel qu’il est publié, résultat connu, et votre statut et votre enchère plafond enregistrés. Si vous le notez, le prix final de l’adjudication (facultatif, seulement pour une vente marquée « Remporté » ou « Non remporté ») : c’est une donnée financière personnelle, visible de vous seul et jamais envoyée par email",
    basis:
      "Exécution du contrat : garder la trace d’une vente suivie après le retrait de sa fiche du catalogue",
    retention:
      "6 mois après la constitution du résumé, puis suppression à la purge hebdomadaire (jusqu’à 7 jours de plus) ; suppression à tout moment par la personne, depuis « Mes favoris » ; suppression avec le compte",
  },
  {
    purpose: "Prévenir de l’ouverture de l’offre Analyse",
    data: "Identifiant de compte (l’email du compte sert à l’envoi), date et version du texte de consentement, date de retrait",
    basis:
      "Consentement (clic explicite sur « Me prévenir de l’ouverture »), retirable à tout moment",
    retention:
      "Jusqu’à l’envoi de l’email d’ouverture ou au retrait, puis 30 jours ; 12 mois au plus sans ouverture",
  },
  {
    purpose: "Mise en relation avec un avocat",
    data: "Email du compte, vente concernée (titre, localisation, lien de l’annonce), mode de contact préféré et suivi de la demande",
    basis:
      "Mesures précontractuelles et exécution du service demandé ; la transmission à l’avocat n’a lieu qu’après votre confirmation, au vu du récapitulatif",
    retention:
      "Supprimée avec la vente concernée à l’échéance de conservation de celle-ci (en principe 24 heures après la vente ; une vente reportée est conservée tant qu’elle l’est) ou avec le compte ; l’avocat conserve de son côté les éléments reçus, sous sa propre responsabilité",
  },
  {
    purpose: "Publication professionnelle",
    data: "Identité, pièces et demande du professionnel",
    basis: "Mesures précontractuelles et exécution du service",
    retention: "Durée du traitement puis archivage limité aux délais de preuve applicables",
  },
  {
    purpose: "Annuaire d’avocats",
    data: "Nom, cabinet, barreau, adresse professionnelle, spécialisations, date de serment et langues des avocats inscrits ; pour les avocats référencés, coordonnées et présentation professionnelles",
    basis:
      "Intérêt légitime à informer le public sur les avocats du barreau compétent ; source : annuaire du Conseil national des barreaux (data.gouv.fr, Licence Ouverte 2.0) ; opposition et rectification par email, sans compte",
    retention:
      "Tant que l’avocat figure dans le jeu de données du CNB (mis à jour périodiquement, les fiches disparues sont supprimées) ; fiches référencées : tant que la fiche est publiée",
  },
  {
    purpose: "Annonces de ventes et pièces publiques",
    data: "Informations sur les biens, parfois sur les personnes citées (noms remplacés par leur rôle autant que possible ; en cas d’oubli, écrivez-nous pour demander le retrait). Le nom et les coordonnées professionnelles (adresse, téléphone, adresse e-mail) de l’organisateur de la vente (avocat, notaire, étude ou service), tels qu’ils sont publiés dans l’annonce d’origine (pour une vente notariale, celle d’immobilier.notaires.fr), sont visibles des personnes connectées à un compte, offre Découverte comprise. Une adresse e-mail masquée par le site d’origine n’est jamais affichée",
    basis: "Intérêt légitime à informer le public",
    retention:
      "Tant que la vente est consultable, puis archivage ; opposition et demande de retrait par email, sans compte",
  },
  {
    purpose: "Photos du bien tirées des pièces des ventes",
    data: "Photos trouvées dans les pièces jointes à l’annonce d’une vente (cahier des conditions de vente, procès-verbal descriptif dressé par un commissaire de justice, anciennement huissier de justice), ajoutées à la galerie de la vente : 12 au plus par vente, sans leurs métadonnées (ni position, ni appareil, ni date de prise de vue). Les photos d’un procès-verbal montrent l’intérieur du bien : des effets personnels, parfois une personne, peuvent y apparaître",
    basis:
      "Intérêt légitime à informer le public sur les ventes à partir des pièces publiées avec l’annonce. Si vous figurez sur une photo, ou si l’on y voit vos effets personnels, vous pouvez en demander le retrait par email, sans compte",
    retention:
      "Tant que la vente est consultable, puis suppression avec la vente ; suppression aussi quand la pièce n’est plus jointe à l’annonce ; retrait sur demande, au plus tard un mois après sa réception",
  },
  {
    purpose: "Cartographie et géocodage (Mapbox, IGN)",
    data: "Adresse ou lieu saisi pour chercher autour d’un point, position et zoom de la carte, adresse IP et données techniques du navigateur, transmises à Mapbox pour afficher cartes et vignettes. Si Mapbox ne répond pas ou ne trouve pas l’adresse, l’adresse que vous saisissez est transmise à l’API Adresse de la Base Adresse Nationale (service public exploité par l’IGN), avec votre adresse IP. Les cartes cadastrales sont chargées depuis la Géoplateforme de l’IGN (data.geopf.fr), qui reçoit votre adresse IP et la zone affichée.",
    basis:
      "Exécution du service demandé (afficher la carte, chercher autour d’une adresse) et intérêt légitime à proposer une cartographie",
    retention:
      "Pas de conservation propre à ce traitement par Immojudis ; durée de conservation de Mapbox et de l’IGN selon leurs conditions",
  },
  {
    purpose:
      "Professionnels contactés par Immojudis (avocats, notaires, commissaires de justice, gestionnaires)",
    data: "Nom, fonction, cabinet, étude ou service, adresse professionnelle, source de l’adresse (type, lien et date de relevé), annonce, questions, messages, réponses, pièces et décisions de validation ; valeurs transmises et affichées sur la fiche de la vente, sans nom ; pièces transmises publiées sous un libellé neutre (qualité de l’expéditeur et date de réception ; le type de pièce est indiqué à part), avec leur contenu tel qu’il a été transmis",
    basis:
      "Intérêt légitime à publier des informations exactes sur les ventes ; un outil peut préparer les projets de messages, mais, à ce jour, chaque message envoyé est validé par un membre de l’équipe. Les messages ne contiennent aucune offre commerciale. La liste d’opposition (adresse et identité professionnelle) est conservée en application de l’obligation de respecter le droit d’opposition (art. 21 RGPD).",
    retention:
      "Adresse relevée à la collecte de l’annonce et non utilisée pour un envoi : conservée tant que le détail de l’annonce est relu, jamais rafraîchie après la date de la vente, et supprimée au plus tard 28 jours après la dernière consultation de l’annonce (purge hebdomadaire, seuil de 21 jours) ; demande jamais envoyée : 28 jours au plus après sa création ; 12 mois si le professionnel ne répond pas, 24 mois après le dernier échange s’il répond ; adresses invalides (rebond permanent) : 12 mois ; identité signalée comme « mauvais destinataire » : 24 mois ; information affichée sur une fiche : supprimée avec la fiche, ou plus tôt sur demande de retrait ou opposition ; liste d’opposition : au moins 3 ans après l’opposition, puis tant que l’agent d’information est exploité, avec revue annuelle",
  },
  {
    purpose: "Formulaire de contact",
    data: "Nom, email, sujet et message saisis dans le formulaire",
    basis: "Intérêt légitime à répondre aux messages reçus",
    retention:
      "12 mois après le dernier échange, puis suppression ; en cas de litige ou de réclamation, le temps de la procédure puis, en archive à accès restreint, 5 ans au plus",
  },
  {
    purpose: "Mesure, qualité et exploitation",
    data: "Événements de parcours du navigateur, agrégés et à valeurs fermées, sans identifiant de personne ni de compte (mesurés avec Vercel Analytics, sans cookie) ; performances, identifiants techniques, erreurs et état des traitements",
    basis: "Intérêt légitime à améliorer, sécuriser et maintenir Immojudis",
    retention:
      "Journaux applicatifs et données techniques : 24 mois au plus, conformément à la matrice de conservation ; données de mesure conservées par Vercel selon sa propre durée",
  },
  {
    purpose: "Mesure du parcours des personnes connectées",
    data: "Identifiant de compte, type d’événement (vente débloquée, quota atteint, valeur de référence servie pour une vente, export vers un calendrier, détail d’un repère « Pépite » servi, clic sur un lien d’un email d’alerte ou de rappel), détail à valeurs fermées, vente concernée et date. Aucun texte libre, aucune adresse IP. L’équipe ne les consulte qu’en chiffres agrégés. Les liens des emails d’alertes et de rappels passent par une adresse d’Immojudis qui note le clic, puis vous envoie vers la vente ou le fichier de calendrier ; un antivirus ou l’aperçu d’une messagerie peut ouvrir le lien et compter comme un clic",
    basis:
      "Intérêt légitime à comprendre quelles fonctions servent et à améliorer le service. L’interrupteur de mesure d’audience de cette page ne couvre pas ces événements : vous pouvez vous y opposer depuis /mes-droits (demande d’opposition) ou par écrit, à l’adresse de contact indiquée en tête de cette page",
    retention:
      "90 jours après l’événement (purge hebdomadaire : au plus environ 97 jours) ; suppression avec le compte. Cette durée est propre à ces événements : le journal d’usage des quotas est conservé 24 mois",
  },
  {
    purpose: "Retours « Utile » ou « Pas pertinent » sur les signaux d’une vente",
    data: "Identifiant de compte, vente, signal concerné (écart au marché, points à vérifier ou repère « Pépite »), réponse « Utile » ou « Pas pertinent », motif choisi dans une liste fermée, date. Aucun texte libre, aucune adresse IP. Sans compte, rien n’est enregistré",
    basis:
      "Intérêt légitime à vérifier que les signaux affichés sont pertinents et à arrêter un repère dont la précision se dégrade. Vous pouvez vous y opposer depuis /mes-droits (demande d’opposition) ou par écrit, à l’adresse de contact indiquée en tête de cette page",
    retention:
      "90 jours après le retour ; suppression avec le compte ; si la vente est supprimée du site, le lien avec la vente est coupé et la ligne est gardée jusqu’à ses 90 jours",
  },
  {
    purpose: "Instantanés d’estimation de marché avant l’audience",
    data: "Type de vente, tribunal, département, type de bien, mise à prix, jour d’audience, estimation de marché et indicateurs de qualité, résultat du repère « Pépite » à cet instant ; pour une vente notariale dont la source a publié le résultat, prix d’adjudication. Ni adresse, ni identifiant de vente en clair, ni donnée de compte : ces informations sont pseudonymisées, mais elles peuvent permettre, par recoupement avec l’annonce publique, de retrouver une vente et donc, parfois, un vendeur particulier. Elles sont traitées comme des données personnelles : pour exercer vos droits sur un instantané, indiquez le lien de l’annonce dans votre demande",
    basis:
      "Intérêt légitime à mesurer la précision des estimations et du repère « Pépite » face aux prix d’adjudication. Vous pouvez vous y opposer depuis /mes-droits (demande d’opposition) ou par écrit, à l’adresse de contact indiquée en tête de cette page",
    retention:
      "36 mois après la date d’audience, puis suppression à la purge hebdomadaire (jusqu’à 7 jours de plus)",
  },
  {
    purpose: "Mesure d’audience par Google Analytics (avec votre accord)",
    data: "Identifiant aléatoire déposé en cookie, pages consultées (adresse nettoyée par le site avant envoi : sans jeton de partage ni code de connexion), provenance de la visite, appareil et navigateur, ville approximative ; aucun signal publicitaire ni recoupement avec un compte Google",
    basis:
      "Consentement, demandé par le bandeau et retirable à tout moment sur cette page ; sans accord, Google Analytics n’est pas chargé",
    retention:
      "Cookies : 13 mois au plus, sans prolongation à chaque visite ; choix d’accord ou de refus : 6 mois dans le navigateur ; données conservées par Google selon la durée réglée dans notre compte Google Analytics",
  },
  {
    purpose: "Repère « Pépite » : contrôle du risque d’inondation d’une vente",
    data: "Coordonnées géographiques d’une vente (jamais celles d’un visiteur ni les données d’un compte), transmises aux services de l’État ; résultat du contrôle conservé pour chaque vente (les coordonnées ne sont pas copiées ; la position n’est gardée que sous la forme d’une empreinte, une pseudonymisation)",
    basis:
      "Intérêt légitime à informer le public sur des ventes publiques avec un repère fiable. Opposition et retrait par email, sans compte",
    retention: "Supprimé avec la vente",
  },
  {
    purpose: "Exercice des droits et rétractation",
    data: "Email, type de demande, message, vérification, décisions et dates de traitement",
    basis: "Obligation légale et défense des droits",
    retention: "Demandes clôturées supprimées après 5 ans",
  },
] as const;

export function PrivacyPage({
  courtRegistryDailyCap = COURT_REGISTRY_DAILY_CAP_DEFAULT,
}: {
  /** Plafond quotidien de messages aux greffes par tribunal, lu dans la configuration par la page serveur. */
  courtRegistryDailyCap?: number;
} = {}) {
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
                      <td className="px-2 py-3">
                        {row.basis}
                        {"basisEndsWithContact" in row ? (
                          <> {legalValue(publisher.contactEmail)}.</>
                        ) : null}
                      </td>
                      <td className="px-2 py-3">{row.retention}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PrivacySection>

          <PrivacySection title="Professionnels contactés par Immojudis (avocats, notaires, commissaires de justice, gestionnaires)">
            <p>
              Pour obtenir une information sur une vente, Immojudis peut écrire à l’avocat, au
              notaire, au commissaire de justice ou au gestionnaire qui la mène. Nous utilisons son
              nom, sa fonction et son adresse professionnelle, relevés dans l’annonce publique de la
              vente, dans un annuaire professionnel officiel (annuaire des avocats du CNB, annuaires
              de certains barreaux, annuaire des commissaires de justice) ou sur le site de son
              cabinet ou de son étude. La source et la date de relevé sont indiquées dans chaque
              message. Base juridique : intérêt légitime à publier des informations exactes sur les
              ventes. Les messages ne contiennent aucune offre commerciale. À ce jour, chaque
              message est relu et validé par un membre de l’équipe avant son envoi : un outil peut
              préparer à l’avance des projets de messages, mais aucun ne part sans cette validation.
              Si nous décidions d’envoyer certains messages automatiquement, cette page serait
              modifiée avant, et ces messages le diraient. Ces adresses et nos échanges ne servent
              jamais à proposer ou vendre la mise en avant payante d’Immojudis, ni au classement des
              avocats, ni à la mise en relation.
            </p>
            <p className="mt-3">
              Les adresses professionnelles figurant dans les annonces publiées sur Licitor, dont
              l’adresse e-mail est masquée par le site, sont relevées automatiquement lors de la
              collecte de l’annonce ; elles sont conservées en interne, jamais publiées, et ne
              servent qu’à une demande d’information validée par un membre de l’équipe. Une adresse
              relevée à la collecte de l’annonce et non utilisée pour un envoi est conservée tant
              que le détail de l’annonce est relu, jamais rafraîchie après la date de la vente, et
              supprimée au plus tard 28 jours après la dernière consultation de l’annonce (purge
              hebdomadaire, seuil de 21 jours). Les données d’un échange sont conservées 12 mois si
              vous ne répondez pas, 24 mois après le dernier échange si vous répondez.
            </p>
            <p className="mt-3">
              Les informations qu’un professionnel nous transmet (par exemple la surface, le nombre
              de pièces, l’occupation, la mise à prix ou la date de la vente) peuvent compléter ou
              corriger la fiche publique de la vente, après relecture. Ces valeurs sont affichées
              sans votre nom. Pour une information venue de l’avocat poursuivant, la fiche indique
              cette qualité et la date de son message, et rappelle de la vérifier dans le cahier des
              conditions de vente : comme la fiche nomme par ailleurs l’organisateur de la vente,
              l’avocat reste identifiable. Une photo ou une pièce transmise peut aussi être ajoutée
              à la fiche, après la même relecture : une pièce transmise est publiée sous un libellé
              neutre (qualité de l’expéditeur et date de réception ; le type de pièce est indiqué à
              part) ; son contenu est publié tel qu’il a été transmis. Vous pouvez à tout moment,
              sans motif, demander le retrait de ce que vous nous avez transmis, en répondant à
              notre message ou en écrivant à {legalValue(publisher.contactEmail)} : nous le retirons
              alors de la fiche, au plus tard un mois après réception de votre demande. Ce qui est
              affiché disparaît aussi avec la fiche, en principe 24 heures après la vente. Nos
              journaux internes gardent la trace de la valeur publiée, de sa date de réception et de
              la qualité de l’expéditeur (avocat poursuivant ou autre contact), sans votre nom ni
              votre adresse, pour pouvoir répondre de son origine. Le journal des publications est
              supprimé avec la fiche ; l’historique des modifications de la fiche est conservé 12
              mois après chaque modification ; le journal des décisions et la file de relecture
              n’ont pas encore de durée fixée : nous l’indiquerons ici dès qu’elle le sera.
            </p>
            <p className="mt-3">
              Vous pouvez vous opposer à tout moment, sans motif, par le lien « Ne plus être
              contacté » de chaque message ou à {legalValue(publisher.contactEmail)}. Votre
              opposition est enregistrée et vaut pour tous nos canaux. Elle vaut pour votre adresse
              et pour votre identité professionnelle : nous ne vous écrirons pas non plus à une
              autre adresse. Faite depuis l’adresse de contact d’un cabinet, d’une étude ou d’un
              service, elle vaut pour toutes les adresses que nous pouvons rattacher avec certitude
              à cette structure : celles du même nom de domaine, pour un cabinet, une étude ou un
              service doté de son propre nom de domaine, ou, pour une étude notariale, celles du
              même numéro d’office. Elle ne s’étend pas aux autres adresses d’une messagerie
              partagée (par exemple avocat.fr, ou notaires.fr sans numéro d’office). Pour un service
              de l’État, dont les adresses partagent le domaine gouv.fr, elle vaut pour l’adresse du
              service, mais pas pour les adresses nominatives de ses agents : chacun d’eux peut
              s’opposer de la même façon. Elle vaut aussi demande de retrait des informations que
              vous nous avez transmises : nous les retirons de la fiche dans le même délai. Les
              échanges déjà intervenus sont conservés jusqu’au terme indiqué plus haut (12 ou 24
              mois), seulement pour pouvoir répondre d’une réclamation, puis supprimés. Seules votre
              adresse, votre identité professionnelle et la date de votre opposition sont gardées
              au-delà, pour ne plus vous solliciter. Si vous nous répondez que notre message ne vous
              concernait pas, votre identité professionnelle (fonction, nom, barreau ou ville) est
              gardée 24 mois, pour qu’aucun message ne vous soit plus préparé automatiquement, et un
              membre de l’équipe vérifiera avant toute nouvelle prise de contact. Pour ne plus du
              tout être contacté, utilisez le lien « Ne plus être contacté ». Vous pouvez aussi
              demander l’accès, la rectification ou l’effacement, et saisir la CNIL. Pour exercer
              ces droits, écrivez à {legalValue(publisher.contactEmail)} ; aucun compte n’est
              nécessaire.
            </p>
            <p className="mt-3">
              Lorsqu’une vente judiciaire n’indique aucune adresse d’avocat, Immojudis peut, après
              validation manuelle de chaque message, écrire à l’adresse de contact du greffe du
              tribunal concerné, tirée de son référentiel des tribunaux, pour demander qui est
              l’avocat poursuivant de la vente ou, à défaut, où et selon quelles modalités un
              candidat acquéreur peut consulter le cahier des conditions de vente. Aucune pièce
              n’est demandée au greffe. Nous envoyons au plus un message par vente et, par tribunal,
              au plus {courtRegistryDailyCap} message
              {courtRegistryDailyCap > 1 ? "s" : ""} par jour, sans relance. Base légale : intérêt
              légitime. Conservation : 12 mois sans réponse, 24 mois après le dernier échange.
              Opposition : lien dans chaque message ou {legalValue(publisher.contactEmail)}.
            </p>
            <p className="mt-3">
              Si vous écrivez à l’adresse de réponse d’Immojudis sans qu’un dossier soit ouvert,
              nous conservons votre adresse, votre nom, l’objet, la date et un extrait de votre
              message, pour le lire et vous répondre ou enregistrer votre demande. Base : intérêt
              légitime. Conservation : 12 mois si nous vous avions écrit, 21 jours sinon. Droits et
              opposition : {legalValue(publisher.contactEmail)}.
            </p>
            <p className="mt-3">
              L’adresse à laquelle nous écrivons et l’objet du message figurent aussi dans le
              journal des emails (90 jours).
            </p>
          </PrivacySection>

          <PrivacySection title="Personnes citées dans une annonce ou visibles sur une photo">
            <p>
              Les annonces de vente et leurs pièces publiques concernent des biens, mais peuvent
              citer des personnes. Dans les textes affichés, les noms de particuliers sont remplacés
              par leur rôle autant que possible : ce remplacement est automatique et peut laisser
              passer un nom. Si vous êtes cité dans une annonce, en cas d’oubli notamment, écrivez à{" "}
              {legalValue(publisher.contactEmail)} pour demander la rectification ou le retrait,
              sans créer de compte.
            </p>
            <p className="mt-3">
              Les photos du bien tirées des pièces d’une vente, notamment du procès-verbal
              descriptif dressé par un commissaire de justice, montrent souvent l’intérieur d’un
              logement. Si vous y figurez, ou si l’on y voit vos effets personnels, écrivez à{" "}
              {legalValue(publisher.contactEmail)} en indiquant le lien de la vente : la photo est
              retirée au plus tard un mois après votre demande, sans que vous ayez à créer de
              compte.
            </p>
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
              performance), Google (mesure d’audience Google Analytics, uniquement avec votre
              accord), Stripe (paiement), Resend (envoi et réception des courriels), GitHub
              (exécution des traitements automatisés), Mapbox (cartes, vignettes et géocodage),
              l’Institut national de l’information géographique et forestière (IGN : Base Adresse
              Nationale en repli du géocodage, Géoplateforme pour les cartes cadastrales), le
              prestataire d’IA utilisé pour lire les annonces et les pièces, ainsi que les réponses
              des professionnels contactés (Replicate, États-Unis), le service de rapport d’erreurs
              lorsqu’il est configuré (sans cookie, en-tête, paramètre d’adresse ni contenu de
              requête), aux avocats référencés uniquement lorsqu’une mise en relation est demandée
              et à l’intermédiaire professionnel contacté par Immojudis après validation par un
              membre de l’équipe. Dans ce dernier cas, seules les informations nécessaires à
              l’enrichissement du dossier et au suivi de la réponse sont transmises. Nos
              sous-traitants agissent sur nos instructions, dans le cadre d’un contrat, sauf les
              exceptions indiquées ci-dessous (Replicate, et Resend pour ses propres données
              d’usage).
            </p>
            <p className="mt-3">
              Resend envoie et reçoit nos courriels. Il conserve le contenu des messages et les
              journaux de remise 30 jours, aux États-Unis. Ce transfert est encadré par les clauses
              contractuelles types adoptées par la Commission européenne (décision (UE) 2021/914 du
              4 juin 2021), intégrées à son accord de sous-traitance. Resend traite aussi, en tant
              que responsable de traitement distinct, certaines données d’usage (adresses
              d’expédition et de destination, journaux d’activité) pour la sécurité de son service
              et la prévention de la fraude, selon sa propre politique de confidentialité. Resend
              est exploité par la société Plus Five Five, Inc., à San Francisco. Seuls les membres
              habilités de l’équipe d’Immojudis consultent le journal et, pour résoudre un problème
              de remise ou répondre à une demande, le contenu d’un message encore conservé par le
              prestataire. Ces consultations sont tracées pendant 6 mois, sans le contenu ni
              l’adresse.
            </p>
            <p className="mt-3">
              Replicate (Replicate, LLC, à San Francisco, États-Unis) nous donne accès au modèle
              d’IA qui lit les annonces, les pièces et les réponses des professionnels contactés. À
              la date de cette version, le modèle utilisé (référence « qwen/qwen3-7-plus » chez
              Replicate) est conçu par l’équipe Qwen du groupe Alibaba. Les textes, pièces et photos
              à lire lui sont transmis : ils peuvent contenir des données personnelles, par exemple
              le nom d’un professionnel ou d’une personne citée dans une pièce. Ces données sont
              transférées aux États-Unis. À la date de cette version, ce transfert ne repose sur
              aucune garantie prévue par le RGPD que nous ayons pu vérifier. Replicate ne figure
              pas, à notre connaissance, parmi les organisations certifiées au cadre de protection
              des données UE–États-Unis : aucune décision d’adéquation ne s’applique donc. Aucun
              accord de sous-traitance ni aucune clause contractuelle type n’est signé avec lui.
              Nous ne savons pas non plus si Replicate fait exécuter ce modèle par un autre
              prestataire, ni dans quel pays. Nous mettrons cette page à jour dès que ces points
              seront établis. Pour toute question, ou pour vous opposer à ce traitement, écrivez à{" "}
              {legalValue(publisher.contactEmail)}.
            </p>
            <p className="mt-3">
              Les coordonnées géographiques d’une vente (et non celles d’une personne) sont aussi
              transmises au Bureau de recherches géologiques et minières (Géorisques) et à
              l’Institut national de l’information géographique et forestière (API Carto, Géoportail
              de l’urbanisme) pour contrôler les risques et les servitudes du bien.
            </p>
            <p className="mt-3">
              Mise en relation avec un avocat. Si vous ne choisissez pas d’avocat, Immojudis en
              désigne un parmi les avocats bénéficiant d’une mise en avant payante (ou en période
              d’essai de cette offre) du barreau compétent. Cet avocat traite ensuite votre demande
              sous sa propre responsabilité. Le récapitulatif affiché avant l’envoi vous indique
              l’avocat destinataire, les données transmises et s’il bénéficie d’une mise en avant
              payante.
            </p>
          </PrivacySection>

          <PrivacySection title="Transferts hors de l’Espace économique européen">
            <p>
              Certains prestataires peuvent traiter des données aux États-Unis ou dans d’autres
              pays, notamment Resend, le prestataire d’IA (Replicate), GitHub et Google (Google
              Analytics, uniquement avec votre accord ; Google est certifié au cadre de protection
              des données UE–États-Unis). Pour obtenir une copie des garanties qui existent, écrivez
              à {legalValue(publisher.contactEmail)} ; aucun compte n’est nécessaire. Pour
              Replicate, aucune garantie n’est établie à ce jour (voir ci-dessus).
            </p>
          </PrivacySection>

          <PrivacySection id="cookies" title="Cookies, stockage local et mesure d’audience">
            <p>
              Supabase utilise les éléments strictement nécessaires à la session. Le navigateur peut
              conserver des préférences fonctionnelles, comme des paramètres de simulation ou les
              annonces consultées, ou vos choix sur la mesure d’audience. Nous mesurons la
              fréquentation avec Vercel Analytics et Speed Insights, sans cookie et sans suivi entre
              sites, et des événements de parcours agrégés, sans identifiant de personne. Lorsque
              vous êtes connecté, quelques événements de parcours sont en outre rattachés à votre
              compte (voir « Mesure du parcours des personnes connectées » dans le tableau),
              conservés 90 jours. Les données ne servent qu’à des statistiques de notre service.
              Vous pouvez vous opposer à la mesure d’audience depuis cette page (votre choix est
              mémorisé dans ce navigateur) ou en nous écrivant à{" "}
              {legalValue(publisher.contactEmail)}. L’interrupteur ci-dessous ne couvre pas les
              événements liés à votre compte : pour vous opposer à ceux-ci, ainsi qu’aux retours «
              Utile » ou « Pas pertinent » et aux instantanés d’estimation décrits dans le tableau,
              utilisez{" "}
              <Link to="/mes-droits" className="text-gold underline">
                Mes droits
              </Link>{" "}
              (demande d’opposition) ou écrivez à {legalValue(publisher.contactEmail)}.
            </p>
            <AudienceOptOutSwitch />
            <p className="mt-4">
              Avec votre accord seulement, nous utilisons aussi Google Analytics, qui dépose des
              cookies (« _ga » et « _ga_ » suivi de l’identifiant du flux) pour compter les visites
              et comprendre l’usage du site. Le bandeau affiché à la première visite permet
              d’accepter ou de refuser aussi simplement ; sans réponse, rien n’est chargé. Les
              adresses transmises sont nettoyées par le site (ni jeton de partage ni code de
              connexion) ; les signaux Google et la personnalisation publicitaire sont désactivés.
              Votre choix est mémorisé 6 mois dans ce navigateur, puis redemandé ; vous pouvez le
              modifier à tout moment ci-dessous ou par le lien « Gérer les cookies » du pied de
              page. Retirer votre accord arrête les envois et efface ces cookies. L’opposition à la
              mesure d’audience ci-dessus coupe aussi Google Analytics.
            </p>
            <AnalyticsConsentSwitch />
            <p className="mt-4">
              Immojudis n’active pas de publicité ciblée ni de traceur publicitaire. Toute autre
              finalité non nécessaire soumise au consentement sera désactivée par défaut jusqu’au
              choix de l’utilisateur.
            </p>
          </PrivacySection>

          <PrivacySection title="Décisions automatisées et enrichissements">
            <p>
              Les scores, estimations et synthèses automatisées assistent la lecture d’un dossier,
              mais ne produisent aucune décision juridique ou financière opposable et n’empêchent
              pas l’accès à une vente. Ils doivent être vérifiés à partir des sources affichées et
              des pièces officielles. Des outils automatiques, dont certains utilisent l’IA, peuvent
              détecter des informations manquantes et préparer un projet d’email, relu par un membre
              de l’équipe. Tout envoi à un professionnel et toute intégration d’information sur une
              fiche sont validés par un membre de l’équipe ; aucune demande n’est lancée directement
              par un utilisateur Analyse. Le message précise qu’une IA aide à lire et classer les
              réponses et que l’équipe vérifie les informations avant toute mise à jour de la fiche
              ; il reste purement informatif et ne contient aucune sollicitation commerciale.
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
              rapports, notes, journal des emails liés à votre compte et principaux espaces
              personnels. Les données strictement nécessaires à une obligation comptable, à la
              preuve d’un contrat, au traitement d’une demande ou à la défense d’un droit sont
              isolées et conservées jusqu’à l’expiration de leur durée, puis purgées
              automatiquement.
            </p>
          </PrivacySection>
        </div>
      </article>
    </main>
  );
}

function PrivacySection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="liquid-panel-soft scroll-mt-24 rounded-lg p-5 sm:p-6">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
