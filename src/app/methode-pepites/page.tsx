import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { Card, PageShell } from "@/components/ui/primitives";
import { publicLegalPublisher } from "@/lib/legal-documents";
import { MARKET_GAP_METHOD_PATH } from "@/lib/market-gap";
import { pageMetadata } from "@/lib/page-metadata";
import { PEPITE_METHOD_PATH, PEPITE_RULE_VERSION, PEPITE_V1 } from "./method";

const PAGE_TITLE = "Comment repérons-nous les pépites ?";

export const metadata: Metadata = pageMetadata({
  path: PEPITE_METHOD_PATH,
  title: PAGE_TITLE,
  description:
    "Ce que signifie le repère « Pépite » : critères et seuils publics, prix probable et ses limites, ce qu’il ne mesure pas, indépendance vis-à-vis de la publicité.",
});

/**
 * Cette page décrit la règle `pepite-v1` (seuils dans `./method.ts`, recopiés à la main). Elle est
 * écrite pour rester vraie quel que soit l'état du repère (observation seule ou affichage) : elle
 * ne dit jamais que des pépites sont déjà affichées, ni combien il y en a.
 */
const NOT_LIST = [
  "Ce n’est pas un conseil en investissement, ni un conseil juridique ou financier.",
  "Ce n’est pas une recommandation d’acheter, ni d’enchérir.",
  "Ce n’est pas une garantie de prix, de rendement, d’adjudication ni de revente.",
  "Ce n’est ni une expertise du bien, ni une estimation officielle de sa valeur.",
] as const;

const GUARDRAILS = [
  `L’estimation de valeur du bien est jugée exploitable et fiable (fiabilité forte ou correcte), s’appuie sur au moins ${PEPITE_V1.minValueComparables} ventes comparables, repose sur une surface connue et ne présente pas d’écart aberrant avec la mise à prix. Elle suit la méthode décrite sur la page « Comment est calculé l’écart avec le marché ». Un terrain seul et un bien mixte n’ont pas de repère.`,
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

  return (
    <PageShell
      eyebrow="Transparence"
      title={PAGE_TITLE}
      description="Le repère « Pépite » est calculé automatiquement par Immojudis à partir de critères publics. Voici ce qu’il est, ses critères et ses seuils, ses limites et son indépendance."
      width="narrow"
    >
      <div className="grid gap-5">
        <Section id="definition" title="Ce qu’est le repère « Pépite »">
          <p>
            « Pépite » est un <strong>repère calculé automatiquement par Immojudis</strong>, à
            partir de critères publics, pour signaler un potentiel d’investissement mesuré par deux
            conditions chiffrées, calculées sur les données disponibles. Il ne désigne pas une
            annonce riche en informations : il combine deux questions.
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              <strong>
                Les ventes comparables passées ont-elles été le plus souvent adjugées sous l’enchère
                plafond estimée ?
              </strong>{" "}
              Immojudis regarde si au moins {PEPITE_V1.chanceMinPct} % l’ont été.
            </li>
            <li>
              <strong>
                Le coût total estimé au prix de référence, frais compris, représente-t-il au plus{" "}
                {PEPITE_V1.maxCostShareCourtPct} % de la valeur estimée (
                {PEPITE_V1.maxCostShareNotaryPct} % en vente notariale) ?
              </strong>
            </li>
          </ol>
          <p>
            Le prix de référence est le prix probable décrit plus bas. La valeur estimée est celle
            d’un bien comparable, d’après les ventes DVF passées ; elle ne tient compte ni de l’état
            du bien ni de son occupation.
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
            les critères, sa fiche et sa ligne dans la liste peuvent porter un badge « Pépite »,
            avec un petit pictogramme de pépite.
          </p>
        </Section>

        <Section id="ce-que-ce-n-est-pas" title="Ce que le repère n’est pas">
          <ul className="list-disc space-y-1 pl-5">
            {NOT_LIST.map((item) => (
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
            <strong>Version {PEPITE_RULE_VERSION}.</strong> Les seuils ci-dessous sont des valeurs
            de départ, contrôlées sur le catalogue. Une modification des critères ou des seuils
            donnerait lieu à une nouvelle version.
          </p>
          <h3 className="font-semibold text-foreground">Les ventes comparables</h3>
          <p>
            Les chances de l’emporter se mesurent sur les ventes passées des{" "}
            {PEPITE_V1.historyYears} dernières années, au même tribunal, dans une tranche de mise à
            prix voisine et pour le même type de bien. Quand le tribunal compte moins de{" "}
            {PEPITE_V1.courtCompleteBelowSales} ventes comparables, l’observation est complétée par
            celle de toute la France ; sous {PEPITE_V1.courtReplaceBelowSales} ventes, elle est
            remplacée par elle.
          </p>
          <h3 className="font-semibold text-foreground">Selon le type de vente</h3>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Vente au tribunal :</strong> les deux tests doivent être réussis. Au moins{" "}
              {PEPITE_V1.chanceMinPct} % des ventes comparables ont été adjugées sous l’enchère
              plafond estimée, et le coût total estimé au prix de référence est d’au plus{" "}
              {PEPITE_V1.maxCostShareCourtPct} % de la valeur estimée.
            </li>
            <li>
              <strong>Vente notariale à la bougie :</strong> seul le second test s’applique, avec un
              seuil plus strict : au plus {PEPITE_V1.maxCostShareNotaryPct} %. L’enchère plafond
              estimée doit en outre être au moins égale à la mise à prix. Le coût est calculé à
              partir de la mise à prix, faute d’historique de résultats.
            </li>
            <li>
              <strong>Vente notariale interactive (par offres) :</strong> seul le second test
              s’applique, avec le même seuil de {PEPITE_V1.maxCostShareNotaryPct} %, calculé à
              partir de la première offre possible. Le prix de réserve du vendeur, qui n’est pas
              public, reste inconnu : la mention « prix de réserve inconnu » accompagne le repère.
            </li>
            <li>
              <strong>Vente domaniale ou de type inconnu :</strong> pas de repère.
            </li>
          </ul>
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
            {GUARDRAILS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>
            Le plafond est calculé, par prudence, sur la valeur basse de la fourchette d’estimation
            du bien, et non sur sa valeur centrale.
          </p>
        </Section>

        <Section id="stabilite" title="La stabilité du repère">
          <p>
            Pour éviter qu’un repère apparaisse et disparaisse d’un jour à l’autre, on n’y entre pas
            et on n’en sort pas au même seuil.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Une vente reçoit le repère après {PEPITE_V1.favourableEvaluations} évaluations
              favorables consécutives.
            </li>
            <li>
              Au tribunal, elle le perd si la part des ventes comparables adjugées sous l’enchère
              plafond estimée passe sous {PEPITE_V1.exitChanceBelowPct} % ou si le coût total
              probable dépasse {PEPITE_V1.exitCostShareAbovePct} % de la valeur estimée, ou dès
              qu’un signal bloquant apparaît.
            </li>
            <li>
              Le repère est figé {PEPITE_V1.freezeDaysBeforeSale} jours avant la vente, sauf signal
              bloquant ou changement de prix.
            </li>
          </ul>
        </Section>

        <Section id="prix-probable" title="Le prix probable et ses limites">
          <p>
            Le <strong>prix probable</strong> est la mise à prix multipliée par le rapport habituel
            entre le prix d’adjudication et la mise à prix des ventes comparables. On retient le
            rapport médian (la moitié des ventes comparables se sont conclues en dessous), sauf
            quand la mise à prix est inférieure à {PEPITE_V1.lowStartingPricePct} % de la valeur
            estimée : les enchérisseurs visent alors la valeur du bien, et on retient le rapport en
            dessous duquel se sont conclues trois ventes sur quatre. La fourchette va du rapport en
            dessous duquel s’est conclue une vente sur quatre à celui en dessous duquel s’en sont
            conclues trois sur quatre : elle encadre la moitié centrale des ventes comparables.
          </p>
          <p>
            Lorsqu’il est affiché, le prix probable l’est avec cette réserve : « Repère statistique
            tiré de N ventes comparables passées du tribunal (fiabilité X). La moitié de ces ventes
            s’est conclue dans la fourchette indiquée, l’autre moitié en dehors. Ce n’est pas une
            prévision : le prix final peut être inférieur ou supérieur. » Il ne serait montré qu’aux
            comptes qui ont accès à l’enchère plafond (offre Analyse ou déblocage de la vente). Pour
            une vente notariale, Immojudis afficherait le prix de départ et indiquerait que le prix
            de réserve du vendeur est inconnu ; il ne donnerait pas de prix probable tant qu’il
            n’existe pas d’historique des résultats.
          </p>
          <p>
            Les limites sont celles de toute statistique : des ventes comparables ne sont jamais
            identiques à la vôtre, le passé ne dit pas ce qui se produira, et un prix probable n’est
            pas un prix que vous paierez. Les montants se présentent comme une « enchère plafond
            estimée » ou, pour une vente par offres, une « offre plafond estimée ».
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
            {NOT_MEASURED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>
            L’estimation de valeur repose sur les ventes passées de la base DVF : elle n’intègre ni
            l’état du bien ni son occupation. Ses limites sont détaillées sur{" "}
            <Link href={MARKET_GAP_METHOD_PATH} className="font-semibold text-gold-text underline">
              la page de méthode de l’écart avec le marché
            </Link>
            .
          </p>
        </Section>

        <Section id="mise-a-jour" title="Mise à jour et retrait">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              Le repère serait recalculé régulièrement. Il ne serait affiché que si le prix de la
              vente et l’estimation n’ont pas changé depuis le dernier calcul, et si ce calcul date
              de moins de {PEPITE_V1.maxEvaluationAgeHours} heures.
            </li>
            <li>
              Il disparaîtrait quand une condition n’est plus remplie, quand la vente n’est plus
              affichée (adjugée, annulée, retirée) ou quand l’équipe constate une erreur.
            </li>
            <li>
              Immojudis pourrait suspendre le repère pour l’ensemble du site, à tout moment, par
              exemple si ses contrôles montrent qu’il n’est pas assez fiable.
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
          <p>
            <strong>
              L’absence de ce repère ne signifie pas que le bien est sans intérêt ni qu’il présente
              un risque.
            </strong>{" "}
            Beaucoup de ventes ne peuvent pas être évaluées : données manquantes, estimation peu
            fiable, type de vente non couvert. Et un bien peut convenir à votre projet sans remplir
            ces critères.
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
