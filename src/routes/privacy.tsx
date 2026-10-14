"use client";

import type { ReactNode } from "react";
import { createFileRoute, Link } from "@/lib/router-compat";
import { AudienceOptOutSwitch } from "@/components/AudienceOptOutSwitch";
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
      "Pendant le compte ; le journal d’usage est conservé 24 mois au plus ; les autres données d’usage expirées sont purgées selon la matrice de conservation",
  },
  {
    purpose: "Commande et accès payant",
    data: "Références Stripe, offre, prix, état du paiement et preuve d’acceptation contractuelle",
    basis: "Exécution du contrat et obligations comptables/fiscales",
    retention:
      "Preuves contractuelles et comptables jusqu’à 10 ans ; données carte conservées par Stripe, pas par Immojudis",
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
    data: "Informations sur les biens, parfois sur les personnes citées (noms remplacés par leur rôle)",
    basis: "Intérêt légitime à informer le public",
    retention:
      "Tant que la vente est consultable, puis archivage ; opposition et demande de retrait par email, sans compte",
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
    data: "Nom, fonction, adresse professionnelle, source de l’adresse (type, lien et date de relevé), annonce, questions, messages, réponses, pièces et décisions de validation",
    basis:
      "Intérêt légitime à publier des informations exactes sur les ventes ; les échanges sont déclenchés et chaque message envoyé est validé par un administrateur. Les messages ne contiennent aucune offre commerciale. Les oppositions, par adresse et par identité du professionnel, sont conservées pour être respectées.",
    retention:
      "30 jours si aucun message n’est envoyé, 12 mois sans réponse, 24 mois après le dernier échange ; liste d’opposition conservée tant que le traitement existe",
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
    data: "Événements de parcours agrégés, sans identifiant de personne, performances, identifiants techniques, erreurs et état des traitements",
    basis: "Intérêt légitime à améliorer, sécuriser et maintenir Immojudis",
    retention:
      "Événements d’usage et journaux applicatifs : 24 mois au plus, conformément à la matrice de conservation ; données de mesure conservées par Vercel selon sa propre durée",
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

          <PrivacySection title="Professionnels contactés par Immojudis (avocats, notaires, commissaires de justice, gestionnaires)">
            <p>
              Pour obtenir une information sur une vente, Immojudis peut écrire à l’avocat, au
              notaire, au commissaire de justice ou au gestionnaire qui la mène. Nous utilisons son
              nom, sa fonction et son adresse professionnelle, relevés dans l’annonce publique de la
              vente, dans un annuaire professionnel officiel (annuaire des avocats du CNB, sites des
              barreaux, annuaire des notaires, annuaire des commissaires de justice) ou sur le site
              de son cabinet ou de son étude. La source et la date de relevé sont indiquées dans
              chaque message. Base juridique : intérêt légitime à publier des informations exactes
              sur les ventes. Les messages ne contiennent aucune offre commerciale. Chaque message
              est validé par un administrateur. Les données sont conservées 30 jours si aucun
              message n’est envoyé, 12 mois sans réponse, 24 mois après le dernier échange. Vous
              pouvez vous opposer à tout moment, sans motif, par le lien « Ne plus être contacté »
              de chaque message ou à {legalValue(publisher.contactEmail)}. Votre opposition est
              enregistrée et vaut pour tous nos canaux. Vous pouvez aussi demander l’accès, la
              rectification ou l’effacement, et saisir la CNIL.
            </p>
            <p className="mt-3">
              Un outil de recherche automatisé consulte ponctuellement, pour une vente précise, une
              page publique du professionnel concerné. Aucune copie d’annuaire n’est conservée. Une
              page décrit cet outil et la façon de s’y opposer :{" "}
              <Link to="/agent-information" className="text-gold underline">
                outil de recherche d’adresses d’Immojudis
              </Link>
              .
            </p>
          </PrivacySection>

          <PrivacySection title="Personnes citées dans une annonce">
            <p>
              Les annonces de vente et leurs pièces publiques concernent des biens, mais peuvent
              citer des personnes. Dans les textes affichés, les noms de particuliers sont remplacés
              par leur rôle. Si vous êtes cité dans une annonce, vous pouvez demander la
              rectification ou le retrait à {legalValue(publisher.contactEmail)}, sans créer de
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
              performance), Stripe (paiement), Resend (emails), Mapbox (cartes, vignettes et
              géocodage), l’Institut national de l’information géographique et forestière (IGN :
              Base Adresse Nationale en repli du géocodage, Géoplateforme pour les cartes
              cadastrales), le prestataire d’IA utilisé pour lire les annonces et les pièces, ainsi
              que les réponses des professionnels contactés (Replicate, États-Unis), le service de
              rapport d’erreurs lorsqu’il est configuré (sans cookie, en-tête, paramètre d’adresse
              ni contenu de requête), aux avocats référencés uniquement lorsqu’une mise en relation
              est demandée et à l’intermédiaire professionnel contacté par Immojudis après
              validation par un administrateur. Dans ce dernier cas, seules les informations
              nécessaires à l’enrichissement du dossier et au suivi de la réponse sont transmises.
              Les prestataires agissent dans la limite de leurs missions contractuelles.
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
              Certains fournisseurs peuvent traiter des données aux États-Unis ou dans d’autres
              pays. Ces transferts reposent, selon le fournisseur et le service, sur une décision
              d’adéquation telle que le cadre UE–États-Unis applicable, des clauses contractuelles
              types ou une autre garantie prévue par le RGPD. Les garanties pertinentes peuvent être
              demandées depuis l’espace Mes droits. C’est notamment le cas du prestataire d’IA
              (Replicate), établi aux États-Unis.
            </p>
          </PrivacySection>

          <PrivacySection title="Cookies, stockage local et mesure d’audience">
            <p>
              Supabase utilise les éléments strictement nécessaires à la session. Le navigateur peut
              conserver des préférences fonctionnelles, comme des paramètres de simulation ou les
              annonces consultées, ou votre choix d’opposition à la mesure d’audience. Nous mesurons
              la fréquentation avec Vercel Analytics et Speed Insights, sans cookie et sans suivi
              entre sites, et des événements de parcours agrégés, sans identifiant de personne. Les
              données ne servent qu’à des statistiques de notre service. Vous pouvez vous opposer à
              la mesure d’audience depuis cette page (votre choix est mémorisé dans ce navigateur)
              ou en nous écrivant à {legalValue(publisher.contactEmail)}. Immojudis n’active pas de
              publicité ciblée ni de traceur publicitaire. Toute future finalité non nécessaire
              soumise au consentement devra être désactivée par défaut jusqu’au choix de
              l’utilisateur.
            </p>
            <AudienceOptOutSwitch />
          </PrivacySection>

          <PrivacySection title="Décisions automatisées et enrichissements">
            <p>
              Les scores, estimations et synthèses automatisées assistent la lecture d’un dossier,
              mais ne produisent aucune décision juridique ou financière opposable et n’empêchent
              pas l’accès à une vente. Ils doivent être vérifiés à partir des sources affichées et
              des pièces officielles. Des outils d’IA peuvent détecter des informations manquantes
              et préparer un projet d’email pour revue administrative. Tout contact externe et toute
              intégration d’information sont déclenchés puis validés par un administrateur ; aucune
              demande n’est lancée directement par un utilisateur Analyse. Le message précise qu’une
              IA aide à lire et classer les réponses et que l’équipe vérifie les informations avant
              toute mise à jour de la fiche ; il reste purement informatif et ne contient aucune
              sollicitation commerciale.
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
