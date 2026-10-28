import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { Card, PageShell } from "@/components/ui/primitives";
import {
  FLOOD_ADDRESS_MIN_SCORE,
  FLOOD_PARCEL_MAX_PROBES,
  FLOOD_STREET_BUFFER_METERS,
} from "@/lib/flood-risk";
import { publicLegalPublisher } from "@/lib/legal-documents";
import { MARKET_GAP_METHOD_PATH } from "@/lib/market-gap";
import { pageMetadata } from "@/lib/page-metadata";
import { activePepiteRuleVersion, pepiteV2EnabledFromEnv } from "@/lib/pepite-rule-switch.server";
import { PEPITE_METHOD_PATH, PEPITE_RULE_PARAMS, pepiteV2EffectiveClause } from "./method";

const PAGE_TITLE = "Comment repérons-nous les pépites ?";

export const metadata: Metadata = pageMetadata({
  path: PEPITE_METHOD_PATH,
  title: PAGE_TITLE,
  description:
    "Comment Immojudis attribue le repère « Pépite » : deux critères chiffrés, seuils publics, limites et indépendance vis-à-vis de la publicité.",
});

/**
 * Cette page décrit la règle appliquée, `pepite-v1.1` (`pepite-v2` quand l'interrupteur est ouvert) : seuils dans
 * `./method.ts`, qui vient des constantes de la règle, et lissage recopié du SQL. Le repère est affiché depuis le
 * 26 octobre 2026 : ce qui est en vigueur s'écrit au présent de l'indicatif. Le conditionnel est réservé à ce qui
 * est seulement prévu (archivage des résultats des ventes notariales). La page ne dit toujours pas combien de
 * pépites sont affichées. Rédaction relue par `juridique-rgpd` le 26/10/2026, reprise le 28/10/2026 (présent,
 * lissage d'après la base, « prix de référence », questions fréquentes), puis mise en accord avec `pepite-v1.1`
 * et le contrôle d'inondation corrigé (n° 28, suite) : à relire à nouveau.
 */
const NOT_LIST = [
  "Ce n’est pas un conseil en investissement, ni un conseil juridique ou financier.",
  "Ce n’est pas une recommandation d’acheter, ni d’enchérir.",
  "Ce n’est pas une garantie de prix, de rendement, d’adjudication ni de revente.",
  "Ce n’est ni une expertise du bien, ni une estimation officielle de sa valeur.",
] as const;

const GUARDRAILS = [
  `L’estimation de valeur du bien est jugée exploitable et fiable (fiabilité forte ou correcte), s’appuie sur au moins ${PEPITE_RULE_PARAMS.minValueComparables} ventes comparables, repose sur une surface connue et ne présente pas d’écart aberrant avec la mise à prix : une mise à prix inférieure à ${PEPITE_RULE_PARAMS.extremeStartingPriceBelowPct} % ou supérieure à ${PEPITE_RULE_PARAMS.extremeStartingPriceAbovePct} % de la valeur estimée signale le plus souvent une erreur de données, et la vente est alors écartée. Quand la mise à prix est inférieure à ${PEPITE_RULE_PARAMS.lowStartingPricePct} % de la valeur estimée, un tel écart se confond souvent avec une erreur de valeur : seule une fiabilité forte est alors admise. L’estimation suit la méthode décrite sur la page « Comment est calculé l’écart avec le marché ». Un terrain seul et un bien mixte n’ont pas de repère.`,
  "L’occupation du bien est connue. Un bien libre comme un bien occupé est admis, car le coût de libération est intégré à l’enchère plafond estimée. Une occupation inconnue ou un squat excluent le repère.",
  "Aucun signal bloquant n’est présent : valeurs d’estimation qui se contredisent, information essentielle mise en doute par la relecture automatique de l’annonce, conflit entre les sources de la vente, annonce probablement en double, risque non qualifié, état dégradé connu des données.",
  "Au tribunal, les ventes comparables passées sont assez fiables pour mesurer les chances de l’emporter (fiabilité au moins moyenne). Sinon, le premier test ne peut pas être évalué et il n’y a pas de repère.",
] as const;

const NOT_MEASURED = [
  "L’état réel du bien, les travaux à prévoir, les désordres que seule une visite révèle. L’enchère plafond estimée suppose par défaut un bien sans travaux.",
  "Les charges de copropriété, les servitudes, l’urbanisme, les diagnostics et les risques juridiques de la procédure, qui se lisent dans le cahier des conditions de vente et les pièces. Immojudis ne lit pas toutes les pièces : ne rien y trouver ne prouve pas l’absence de risque.",
  "L’exactitude de l’annonce, rédigée par un tiers.",
  "La concurrence réelle le jour de la vente : le nombre et les moyens des enchérisseurs.",
  "Votre situation : budget, financement, fiscalité, projet (habiter, louer, revendre). Le repère ne mesure ni un rendement locatif ni une marge de revente.",
] as const;

/**
 * Règle `pepite-v2` (risque d'inondation) : ces textes ne s'affichent que si l'interrupteur serveur
 * `PEPITE_RULE_V2_ENABLED` est ouvert (`pepiteV2EnabledFromEnv`). Fermé, la page décrit `pepite-v1.1`, la règle
 * appliquée. `pepite-v2` = `pepite-v1.1` + ce contrôle. Rédaction validée par `juridique-rgpd` le 26/10/2026, tampon de
 * rue, parcelles et renvoi à l'état des risques mis à jour le 28/10/2026 (n° 28, suite) : à relire à nouveau.
 */
const NOT_LIST_V2 = [
  "Ce n’est ni un état des risques, ni un certificat, et cela ne remplace pas l’état des risques et pollutions, lorsqu’il est exigé, annexé au cahier des conditions de vente (vente au tribunal), au cahier des charges (vente notariale à la bougie) ou à l’avant-contrat (vente notariale interactive).",
  "Ce n’est pas une garantie d’absence de risque d’inondation.",
] as const;

const GUARDRAIL_FLOOD_V2 =
  "Le bien n’est pas situé, à sa position connue, dans la zone de crue fréquente d’un territoire à risque important d’inondation (voir « Le risque d’inondation »).";

const NOT_MEASURED_V2_DILIGENCE =
  "Les charges de copropriété, les servitudes, l’urbanisme, les diagnostics (dont l’état des risques) et les risques juridiques de la procédure, qui se lisent dans le cahier des conditions de vente et les pièces. Seul le risque d’inondation fait l’objet d’un contrôle cartographique limité, décrit plus haut. Immojudis ne lit pas toutes les pièces : ne rien y trouver ne prouve pas l’absence de risque.";

const ABSENCE_V1 = (
  <>
    <strong>
      L’absence de ce repère ne signifie pas que le bien est sans intérêt ni qu’il présente un
      risque.
    </strong>{" "}
    Beaucoup de ventes ne peuvent pas être évaluées : données manquantes, estimation peu fiable,
    type de vente non couvert. Et un bien peut convenir à votre projet sans remplir ces critères.
  </>
);

const ABSENCE_V2 =
  "L’absence de ce repère ne permet de tirer aucune conclusion sur le bien : les données peuvent manquer, ou un critère, dont celui du risque d’inondation, peut ne pas être rempli. Immojudis n’indique pas, vente par vente, la raison. Un bien peut convenir à votre projet sans remplir ces critères.";

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card as="section" aria-labelledby={id}>
      <h2 id={id} className="font-display text-2xl font-semibold">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-ink-soft">{children}</div>
    </Card>
  );
}

export default function Page() {
  return (
    <>
      <BreadcrumbJsonLd trail={[{ name: PAGE_TITLE, path: PEPITE_METHOD_PATH }]} />
      <PageContent />
    </>
  );
}

function PageContent() {
  const contactEmail = publicLegalPublisher().contactEmail;
  // Interrupteur serveur de la règle pepite-v2 : fermé (défaut), la page décrit pepite-v1.1, la règle appliquée.
  const v2 = pepiteV2EnabledFromEnv();
  const version = activePepiteRuleVersion();
  const effectiveClause = pepiteV2EffectiveClause();
  const notList = v2 ? [...NOT_LIST, ...NOT_LIST_V2] : [...NOT_LIST];
  const guardrails = v2 ? [...GUARDRAILS, GUARDRAIL_FLOOD_V2] : [...GUARDRAILS];
  const absenceText = v2 ? <strong>{ABSENCE_V2}</strong> : ABSENCE_V1;
  const notMeasured = v2
    ? [NOT_MEASURED[0], NOT_MEASURED_V2_DILIGENCE, ...NOT_MEASURED.slice(2)]
    : [...NOT_MEASURED];

  return (
    <PageShell
      eyebrow="Transparence"
      title={PAGE_TITLE}
      description="Un repère calculé automatiquement, sur deux critères chiffrés et publics. Il n’est ni un conseil, ni une prévision de prix, ni une garantie."
      width="narrow"
    >
      <div className="grid gap-5">
        <Section id="definition" title="Ce qu’est le repère « Pépite »">
          <p>
            « Pépite » est un <strong>repère calculé automatiquement par Immojudis</strong>, à
            partir de critères publics. Il signale les ventes qui remplissent deux conditions
            chiffrées, calculées sur les données disponibles. Il ne désigne pas une annonce riche en
            informations : il combine deux questions (en vente notariale, seule la seconde est
            posée).
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              <strong>
                Les ventes comparables passées ont-elles été le plus souvent adjugées sous l’enchère
                plafond estimée ?
              </strong>{" "}
              Immojudis regarde si au moins {PEPITE_RULE_PARAMS.chanceMinPct} % l’ont été, sur un
              nombre de ventes suffisant (voir « Les critères et les seuils »).
            </li>
            <li>
              <strong>
                Le coût total estimé au prix de référence, frais compris, représente-t-il au plus{" "}
                {PEPITE_RULE_PARAMS.maxCostShareCourtPct} % de la valeur estimée (
                {PEPITE_RULE_PARAMS.maxCostShareNotaryPct} % en vente notariale) ?
              </strong>
            </li>
          </ol>
          <p>
            Le prix de référence est un repère statistique, décrit plus bas. La valeur estimée est
            celle d’un bien comparable, d’après les ventes passées de la base Demande de valeurs
            foncières (DVF) ; elle ne tient compte ni de l’état du bien ni de son occupation. Pour
            le second critère, la valeur estimée d’un bien vendu loué est toutefois diminuée de la
            décote d’un bien loué, retenue dans les hypothèses par défaut : un bien occupé par un
            locataire se négocie moins cher qu’un bien libre.
          </p>
          <p>
            L’<strong>enchère plafond estimée</strong> est le montant maximal calculé par Immojudis
            avec des hypothèses par défaut : acheter pour habiter, profil équilibré, bien sans
            travaux, frais propres au type de vente, coût de libération du bien s’il est occupé.
            Pour une vente notariale interactive, qui fonctionne par offres, on parle d’
            <strong>offre plafond estimée</strong>. Une enchère ou une offre plafond est une
            hypothèse, pas un résultat.
          </p>
          <p>
            L’attribution est automatique : l’équipe ne choisit pas les ventes une à une. Elle peut
            en revanche retirer le repère quand une erreur est constatée. Lorsqu’une vente remplit
            les critères, sa fiche et sa ligne dans la liste portent un badge « Pépite », avec un
            petit pictogramme de pépite.
          </p>
        </Section>

        <Section id="ce-que-ce-n-est-pas" title="Ce que le repère n’est pas">
          <ul className="list-disc space-y-1 pl-5">
            {notList.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>
            Il ne remplace ni la lecture du cahier des conditions de vente, ni la visite, ni l’avis
            de votre avocat ou du notaire. Immojudis ne porte pas d’enchères et ne garantit aucune
            vente.
          </p>
        </Section>

        <Section id="criteres" title="Les critères et les seuils">
          <p>
            <strong>Version {version}.</strong> Les seuils ci-dessous sont des valeurs de départ,
            contrôlées sur le catalogue. Le repère est affiché depuis le 26 octobre 2026. Une
            modification des critères ou des seuils donnerait lieu à une nouvelle version.
          </p>
          <p>
            <strong>Version 1.1 du 28 octobre 2026 :</strong> les seuils ne changent pas, mais les
            critères sont appliqués plus strictement. Une part de ventes connue seulement comme un
            plancher (« au moins ») doit atteindre le seuil, et la part doit reposer sur assez de
            ventes pour entrer. Une mise à prix inférieure à{" "}
            {PEPITE_RULE_PARAMS.lowStartingPricePct} % de la valeur estimée demande une fiabilité
            forte. La décote d’un bien loué entre dans le second critère. En vente notariale, les
            honoraires de négociation et les frais de publicité doivent avoir été lus. Pendant les{" "}
            {PEPITE_RULE_PARAMS.freezeDaysBeforeSale} derniers jours avant la vente, une estimation
            qui se dégrade fait sortir le repère.
          </p>
          <h3 className="font-semibold text-foreground">Les ventes comparables</h3>
          <p>
            Les chances de l’emporter se mesurent sur les ventes passées des{" "}
            {PEPITE_RULE_PARAMS.historyYears} dernières années, au même tribunal, dans une tranche
            de mise à prix voisine et pour le même type de bien. Il faut au moins{" "}
            {PEPITE_RULE_PARAMS.minNationalSales} ventes comparables en France, tribunaux confondus.
            À partir de {PEPITE_RULE_PARAMS.minCourtSales} ventes comparables au tribunal, la part
            des ventes adjugées sous l’enchère plafond estimée combine celle du tribunal et la part
            nationale, qui compte pour {PEPITE_RULE_PARAMS.smoothingWeightSales} ventes : plus le
            tribunal en compte, moins la part nationale pèse. Sous{" "}
            {PEPITE_RULE_PARAMS.minCourtSales} ventes au tribunal, le premier critère ne peut pas
            être évalué et il n’y a pas de repère. La fourchette du prix de référence repose sur les
            ventes du tribunal seules à partir de {PEPITE_RULE_PARAMS.priceCourtOnlyFromSales}{" "}
            ventes, sur celles de toute la France en dessous.
          </p>
          <h3 className="font-semibold text-foreground">Le premier critère, en détail</h3>
          <p>
            Quand l’enchère plafond estimée dépasse de beaucoup la mise à prix, on ne sait plus
            répartir les prix d’adjudication : la part des ventes adjugées en dessous n’est connue
            que comme un plancher (« au moins »). Ce plancher réussit le critère seulement s’il
            atteint lui-même le seuil, soit {PEPITE_RULE_PARAMS.chanceMinPct} % pour entrer et{" "}
            {PEPITE_RULE_PARAMS.exitChanceBelowPct} % pour rester.
          </p>
          <p>
            Pour entrer, la part doit aussi reposer sur assez de ventes. Une part observée sur peu
            de ventes est incertaine : Immojudis calcule la fourchette (intervalle de confiance de
            Wilson à 95 %) dans laquelle se situe vraisemblablement la vraie part, et la borne basse
            de cette fourchette doit atteindre {PEPITE_RULE_PARAMS.chanceMinWilsonLowPct} %. Sinon,
            la vente n’entre pas. Un repère déjà attribué n’est pas soumis à cette condition : il
            reste, et le critère est indiqué « à confirmer » dans le détail du calcul.
          </p>
          <h3 className="font-semibold text-foreground">Selon le type de vente</h3>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Vente au tribunal :</strong> les deux tests doivent être réussis. Au moins{" "}
              {PEPITE_RULE_PARAMS.chanceMinPct} % des ventes comparables ont été adjugées sous
              l’enchère plafond estimée, et le coût total estimé au prix de référence est d’au plus{" "}
              {PEPITE_RULE_PARAMS.maxCostShareCourtPct} % de la valeur estimée.
            </li>
            <li>
              <strong>Vente notariale à la bougie :</strong> seul le second test s’applique, avec un
              seuil plus strict : au plus {PEPITE_RULE_PARAMS.maxCostShareNotaryPct} %. L’enchère
              plafond estimée doit en outre être au moins égale à la mise à prix. Le coût est
              calculé à partir de la mise à prix, faute d’historique de résultats.
            </li>
            <li>
              <strong>Vente notariale interactive (par offres) :</strong> seul le second test
              s’applique, avec le même seuil de {PEPITE_RULE_PARAMS.maxCostShareNotaryPct} %,
              calculé à partir de la première offre possible. L’offre plafond estimée doit en outre
              être au moins égale à cette première offre, faute de quoi aucune offre ne tient. Le
              prix de réserve du vendeur, qui n’est pas public, reste inconnu : la mention « prix de
              réserve inconnu » accompagne le repère.
            </li>
            <li>
              <strong>Vente domaniale ou de type inconnu :</strong> pas de repère.
            </li>
          </ul>
          <p>
            En vente notariale (à la bougie comme interactive), les honoraires de négociation de
            l’acquéreur et les frais de publicité, quand ils s’appliquent, doivent avoir été lus
            dans l’annonce ou saisis, et non remplacés par des valeurs par défaut : sinon le coût
            serait sous-estimé, et le repère n’est pas attribué.
          </p>
          <p>
            Immojudis prévoit d’archiver les résultats des ventes notariales. Lorsqu’ils seront
            assez nombreux, ces ventes pourraient être soumises aux deux tests, par une nouvelle
            version.
          </p>
        </Section>

        <Section id="garde-fous" title="Les garde-fous">
          <p>
            En plus des deux tests, le repère n’est attribué que si toutes ces conditions sont
            réunies :
          </p>
          <ul className="list-disc space-y-2 pl-5">
            {guardrails.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>
            Le plafond est calculé, par prudence, sur la valeur basse de la fourchette d’estimation
            du bien, et non sur sa valeur centrale.
          </p>
        </Section>

        {v2 ? (
          <Section id="risque-inondation" title="Le risque d’inondation">
            <p>
              Depuis la version pepite-v2{effectiveClause}, le repère n’est pas attribué à un bien
              dont la position connue se trouve dans la zone que la crue fréquente d’un territoire à
              risque important d’inondation (TRI) inonderait. Cette règle reprend tous les critères
              de la version 1.1 et y ajoute ce contrôle. Immojudis consulte pour cela la
              cartographie officielle des TRI diffusée par Géorisques, à partir des coordonnées du
              bien.
            </p>
            <p>
              Ce contrôle suppose une position précise (adresse ou parcelle). Une parcelle multiple
              compte une position par parcelle : chacune est testée (au plus{" "}
              {FLOOD_PARCEL_MAX_PROBES}), et le bien n’est retenu dans la zone de crue fréquente que
              si toutes les parcelles testées s’y trouvent ; si les résultats divergent, ou si
              certaines parcelles n’ont pas pu être testées, le contrôle reste sans résultat. Un
              lieu-dit, ou un numéro que le géocodage n’a retrouvé qu’avec un score de fiabilité
              inférieur à {String(FLOOD_ADDRESS_MIN_SCORE).replace(".", ",")} sur 1, donne une
              position approximative.
            </p>
            <p>
              Quand seule la rue est connue, le point de la rue se situe au milieu de la voie,
              parfois à plusieurs centaines de mètres du numéro réel. Le bien est alors testé avec
              un tampon de {FLOOD_STREET_BUFFER_METERS} mètres autour du point (le point et quatre
              points situés à cette distance) : une position à la rue ne compte que si tout le
              tampon est dans la zone de crue fréquente. Dans tous les autres cas, y compris un
              tampon entièrement en dehors de la zone, le résultat est « inconnu » et le contrôle
              reste sans résultat, car l’absence de zone autour d’un point de rue ne dit rien du
              bien. Quand la position n’est qu’approximative : si la commune compte un TRI, la vente
              ne reçoit pas le repère ; si elle n’en compte pas, le contrôle n’a pas d’objet et le
              repère reste possible, sans vérification du risque d’inondation du bien. Un bien déjà
              repéré dont le contrôle devient impossible (position retirée, source indisponible)
              garde son repère jusqu’à la vente ; la fiche l’indique.
            </p>
            <p>
              Quand le bien se trouve dans le périmètre d’un plan de prévention des risques
              d’inondation (PPRi) d’après le Géoportail de l’urbanisme, le repère peut être
              attribué, mais la fiche le signale : ce périmètre ne dit pas dans quelle zone du plan
              se situe le bien. Son zonage est à vérifier. Cette mention est visible par tous, avec
              le repère. Tant que les périmètres de PPRi n’ont pas pu être consultés pour un bien,
              un nouveau repère n’est pas attribué ; un bien déjà repéré le garde, et la fiche
              indique que ces périmètres ne sont pas contrôlés à ce jour.
            </p>
            <p>
              Ce contrôle n’est ni une expertise, ni un état des risques, ni un certificat. Il ne
              signifie pas l’absence de risque d’inondation : les cartes consultées ne couvrent pas
              tout le territoire ni toutes les causes d’inondation, elles peuvent être incomplètes
              ou anciennes, et leur précision ne permet pas toujours de situer un bien. Il ne
              remplace pas l’état des risques et pollutions (article L. 125-5 du code de
              l’environnement), lorsqu’il est exigé, annexé au cahier des conditions de vente (vente
              au tribunal), au cahier des charges (vente notariale à la bougie) ou à l’avant-contrat
              (vente notariale interactive), ni la lecture du plan de prévention et du règlement
              d’urbanisme, ni la visite, ni l’avis de votre avocat ou du notaire.
            </p>
          </Section>
        ) : null}

        <Section id="stabilite" title="La stabilité du repère">
          <p>
            Pour éviter qu’un repère apparaisse et disparaisse d’un jour à l’autre, on n’y entre pas
            et on n’en sort pas au même seuil.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Une vente reçoit le repère après {PEPITE_RULE_PARAMS.favourableEvaluations}{" "}
              évaluations favorables consécutives.
            </li>
            <li>
              Au tribunal, elle le perd si la part des ventes comparables adjugées sous l’enchère
              plafond estimée passe sous {PEPITE_RULE_PARAMS.exitChanceBelowPct} % ou si le coût
              total estimé au prix de référence dépasse {PEPITE_RULE_PARAMS.exitCostShareAbovePct} %
              de la valeur estimée, ou dès qu’un signal bloquant apparaît. En vente notariale, elle
              le perd si le coût total estimé au prix de référence dépasse{" "}
              {PEPITE_RULE_PARAMS.exitCostShareNotaryAbovePct} % de la valeur estimée, ou dès qu’un
              signal bloquant apparaît.
            </li>
            <li>
              Le repère est figé {PEPITE_RULE_PARAMS.freezeDaysBeforeSale} jours avant la vente,
              sauf signal bloquant ou changement de prix. Pendant ce gel, une estimation de valeur
              qui n’est plus exploitable, plus assez fiable ou qui ne passe plus les contrôles de la
              page « Comment est calculé l’écart avec le marché » fait aussi sortir le repère.
            </li>
          </ul>
        </Section>

        <Section id="prix-probable" title="Le prix de référence et ses limites">
          <p>
            Le <strong>prix de référence</strong> est la mise à prix multipliée par le rapport
            habituel entre le prix d’adjudication et la mise à prix des ventes comparables. On
            retient le rapport médian (la moitié des ventes comparables se sont conclues en
            dessous), sauf quand la mise à prix est inférieure à{" "}
            {PEPITE_RULE_PARAMS.lowStartingPricePct} % de la valeur estimée : les enchérisseurs
            visent alors la valeur du bien, et on retient le rapport en dessous duquel se sont
            conclues trois ventes sur quatre. La fourchette va du rapport en dessous duquel s’est
            conclue une vente sur quatre à celui en dessous duquel s’en sont conclues trois sur
            quatre : elle encadre la moitié centrale des ventes retenues pour la fourchette (voir «
            Les critères et les seuils »).
          </p>
          <p>
            Lorsqu’il est affiché, le prix de référence l’est avec cette réserve : « Repère
            statistique tiré de N ventes comparables passées du tribunal (fiabilité X). La moitié de
            ces ventes s’est conclue dans la fourchette indiquée, l’autre moitié en dehors. Ce n’est
            pas une prévision : le prix final peut être inférieur ou supérieur. » Il n’est montré
            qu’aux comptes qui ont accès à l’enchère plafond (offre Analyse ou déblocage de la
            vente). Pour une vente notariale, Immojudis affiche le prix de départ (la première offre
            possible, pour une vente par offres) et, pour une vente par offres, indique que le prix
            de réserve du vendeur est inconnu ; il ne donne pas de prix de référence, faute
            d’historique des résultats.
          </p>
          <p>
            Les limites sont celles de toute statistique : des ventes comparables ne sont jamais
            identiques à la vôtre, le passé ne dit pas ce qui se produira, et un prix de référence
            n’est pas un prix que vous paierez. Les montants se présentent comme une « enchère
            plafond estimée » ou, pour une vente par offres, une « offre plafond estimée ».
          </p>
        </Section>

        <Section id="ce-que-vous-voyez" title="Ce qui est visible, et par qui">
          <p>
            Lorsqu’il est attribué, le repère « Pépite » est visible par tous. Le montant de
            l’enchère plafond estimée (ou de l’offre plafond estimée) et le détail du calcul sont
            réservés à l’offre Analyse ou à un déblocage de la vente, dans les conditions fixées par
            les{" "}
            <Link href="/conditions-generales" className="font-semibold text-gold-text underline">
              conditions générales
            </Link>
            . Cela n’a aucune influence sur l’attribution du repère, qui obéit aux seuls critères
            publiés sur cette page.
          </p>
        </Section>

        <Section id="non-mesure" title="Ce que le repère ne mesure pas">
          <ul className="list-disc space-y-2 pl-5">
            {notMeasured.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>
            L’estimation de valeur repose sur les ventes passées de la base DVF (demandes de valeurs
            foncières) : elle n’intègre ni l’état du bien ni son occupation. Ses limites sont
            détaillées sur{" "}
            <Link href={MARKET_GAP_METHOD_PATH} className="font-semibold text-gold-text underline">
              la page de méthode de l’écart avec le marché
            </Link>
            .
          </p>
        </Section>

        <Section id="mise-a-jour" title="Mise à jour et retrait">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              Le repère est recalculé régulièrement, au moins une fois par jour. Il n’est affiché
              que si le prix de la vente et l’estimation n’ont pas changé depuis le dernier calcul,
              et si ce calcul date de moins de {PEPITE_RULE_PARAMS.maxEvaluationAgeHours} heures.
            </li>
            <li>
              Il disparaît quand une condition n’est plus remplie, quand la vente n’est plus
              affichée (adjugée, annulée, retirée) ou quand l’équipe constate une erreur.
            </li>
            <li>
              Immojudis peut suspendre le repère pour l’ensemble du site, à tout moment, par exemple
              si ses contrôles montrent qu’il n’est pas assez fiable.
            </li>
          </ul>
        </Section>

        <Section id="independance" title="Indépendance">
          <p>
            <strong>
              Aucune rémunération ne peut obtenir ou améliorer une Pépite : ni les cabinets
              d’avocats qui achètent une mise en avant, ni les organisateurs, vendeurs ou
              professionnels qui publient des annonces.
            </strong>
          </p>
          <p>
            Le calcul n’utilise ni le score d’investissement, ni les données des avocats ou de la
            publicité, ni le profil de la personne qui consulte. Les encarts de cabinets d’avocats,
            signalés comme publicité, sont séparés des annonces et sans lien avec le repère. Le
            repère ne change pas l’ordre par défaut des annonces, décrit sur la page{" "}
            <Link
              href="/classement-des-annonces"
              className="font-semibold text-gold-text underline"
            >
              Comment sont classées les annonces
            </Link>
            .
          </p>
        </Section>

        <Section id="absence" title="Quand il n’y a pas de repère">
          <p>{absenceText}</p>
        </Section>

        {v2 ? (
          <>
            <Section id="historique" title="Historique des versions">
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  pepite-v2{effectiveClause} : ajout du contrôle du risque d’inondation à la version
                  1.1.
                </li>
                <li>
                  pepite-v1.1 (28 octobre 2026) : mêmes seuils, critères appliqués plus strictement
                  (voir « Les critères et les seuils »).
                </li>
                <li>pepite-v1 (depuis le 26 octobre 2026) : version initiale.</li>
              </ul>
            </Section>

            <Section id="sources" title="Sources des données">
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong>Géorisques</strong> (ministère de la Transition écologique, BRGM) :
                  cartographie des territoires à risque important d’inondation (TRI), scénario de
                  crue fréquente, diffusée par l’API publique Géorisques. La date de la carte
                  consultée est enregistrée pour chaque bien. Données publiques réutilisées sous
                  Licence Ouverte 2.0.
                </li>
                <li>
                  <strong>Géoportail de l’urbanisme</strong> (IGN) : servitudes d’utilité publique
                  PM1 (plans de prévention des risques naturels prévisibles), aléa inondation, via
                  l’API Carto de l’IGN. La date de consultation est indiquée sur la fiche. Données
                  publiques réutilisées sous Licence Ouverte 2.0.
                </li>
              </ul>
              <p>
                Seules les coordonnées géographiques du bien sont transmises à ces services, jamais
                l’adresse ni aucune donnée d’un visiteur ou d’un compte. Ces mentions ne signifient
                pas que Géorisques, l’IGN ou leurs partenaires cautionnent ce repère, calculé par
                Immojudis.
              </p>
            </Section>
          </>
        ) : null}

        <Section id="questions-frequentes" title="Questions fréquentes">
          <h3 className="font-semibold text-foreground">Qu’est-ce qu’une pépite ?</h3>
          <p>
            C’est un repère calculé automatiquement par Immojudis, à partir de critères publics. Il
            signale les ventes qui remplissent deux conditions chiffrées : au moins{" "}
            {PEPITE_RULE_PARAMS.chanceMinPct} % des ventes comparables passées ont été adjugées sous
            l’enchère plafond estimée, et le coût total estimé au prix de référence ne dépasse pas{" "}
            {PEPITE_RULE_PARAMS.maxCostShareCourtPct} % de la valeur estimée (
            {PEPITE_RULE_PARAMS.maxCostShareNotaryPct} % en vente notariale, où seule cette seconde
            condition est posée).
          </p>
          <h3 className="font-semibold text-foreground">Est-ce un conseil ?</h3>
          <p>
            Non. Ce n’est pas un conseil en investissement, ni un conseil juridique ou financier, ni
            une recommandation d’acheter ou d’enchérir, ni une garantie de prix, de rendement,
            d’adjudication ou de revente. Il ne remplace ni la lecture du cahier des conditions de
            vente, ni la visite, ni l’avis de votre avocat ou du notaire.
          </p>
          <h3 className="font-semibold text-foreground">
            Pourquoi ce bien n’a-t-il pas de pépite ?
          </h3>
          <p>{absenceText}</p>
          <h3 className="font-semibold text-foreground">Qui peut obtenir une pépite ?</h3>
          <p>
            Toute vente qui remplit les critères, sans que l’équipe choisisse les ventes une à une.
            Aucune rémunération ne peut obtenir ou améliorer une Pépite : ni les cabinets d’avocats
            qui achètent une mise en avant, ni les organisateurs, vendeurs ou professionnels qui
            publient des annonces. Les ventes domaniales et les ventes de type inconnu n’ont pas de
            repère.
          </p>
        </Section>

        <Card as="section" aria-labelledby="signaler-erreur" className="bg-surface-muted">
          <h2 id="signaler-erreur" className="font-display text-2xl font-semibold">
            Signaler une erreur
          </h2>
          <p className="mt-3 text-ink-soft">
            Un repère qui vous semble erroné, une donnée inexacte sur une fiche : écrivez-nous
            depuis la page{" "}
            <Link href="/contact" className="font-semibold text-gold-text underline">
              Contact
            </Link>
            {contactEmail ? (
              <>
                {" "}
                ou à{" "}
                <a
                  href={`mailto:${contactEmail}`}
                  className="font-semibold text-gold-text underline"
                >
                  {contactEmail}
                </a>
              </>
            ) : null}
            . Nous vérifions le signalement et corrigeons ou retirons le repère si nécessaire.
          </p>
        </Card>

        <Card as="section" aria-labelledby="pour-aller-plus-loin" className="bg-surface-muted">
          <h2 id="pour-aller-plus-loin" className="font-display text-2xl font-semibold">
            Pour aller plus loin
          </h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-ink-soft">
            <li>
              <Link
                href="/ressources/prix-plafond-encheres-immobilieres"
                className="font-semibold text-gold-text underline"
              >
                Fixer son enchère plafond
              </Link>
            </li>
            <li>
              <Link
                href={MARKET_GAP_METHOD_PATH}
                className="font-semibold text-gold-text underline"
              >
                Comment est calculé l’écart avec le marché
              </Link>
            </li>
            <li>
              <Link
                href="/classement-des-annonces"
                className="font-semibold text-gold-text underline"
              >
                Comment sont classées les annonces
              </Link>
            </li>
            <li>
              <Link href="/sales" className="font-semibold text-gold-text underline">
                Les ventes à venir
              </Link>
            </li>
          </ul>
        </Card>
      </div>
    </PageShell>
  );
}
