import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/BreadcrumbJsonLd";
import { Card, PageShell } from "@/components/ui/primitives";
import {
  MARKET_GAP_MAX_DISCOUNT_PCT,
  MARKET_GAP_METHOD_PATH,
  MARKET_GAP_MIN_DISCOUNT_PCT,
  MARKET_GAP_NOT_SIGNIFICANT_LABEL,
} from "@/lib/market-gap";
import {
  MARKET_GAP_BAND_LABELS,
  MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT,
} from "@/lib/market-gap-band";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: MARKET_GAP_METHOD_PATH,
  title: "Comment est calculé l’écart avec le marché",
  description:
    "La méthode derrière l’écart entre la mise à prix et la valeur de marché : source DVF, ventes comparables, périmètre, période, repli et limites de l’estimation.",
});

/**
 * Cette page décrit le code, pas une intention : `buildValuePreview` (src/lib/value-preview.ts),
 * `analyzeMarketCandidates` (market-estimation-engine.ts), `buildEstimate` (market.server.ts),
 * `getDvfMarketStatisticsFallback` (dvf-market-statistics.ts), `estimateMarketDiscountPct`
 * (alert-matches.ts) et le garde-fou de `src/lib/market-gap.ts`.
 *
 * Les chiffres ne viennent pas tous d'une constante importée. Seuls ceux qui existent sous forme
 * de constante exportée ou de fonction exportée du moteur sont lus ou vérifiés par
 * `page.test.tsx` : les seuils du garde-fou (importés ici), le seuil urbain de 10 000 habitants
 * (`URBAN_POPULATION_THRESHOLD`) et les seuils de 5 et 12 ventes du repli
 * (`selectStatisticScope`). Le seuil de 30 ventes du département n'est pas observable : à défaut,
 * l'échelle la mieux fournie est retenue.
 * Les autres (4 ventes, 60 mois, rayons, tolérances de surface, plage 300 à 50 000 €/m², 24 mois,
 * 12 % par an…) sont recopiés à la main depuis des constantes privées du moteur : quand l'une
 * change, cette page doit changer avec elle.
 */
const FORMULA = "écart = (valeur estimée − mise à prix) ÷ valeur estimée × 100";

const COMPARABLE_STEPS = [
  "On retient les ventes du même type de bien que le vôtre (appartement, maison, immeuble, local commercial ou terrain), dans un rayon autour de l’adresse : de 150 m pour un appartement en ville à 10 km pour un terrain à la campagne. Une commune de 10 000 habitants ou plus est considérée comme urbaine.",
  "Seules comptent les ventes des 60 derniers mois. Pour chaque parcelle, on garde la vente la plus récente, afin qu’un immeuble très actif ne pèse pas plus que les autres.",
  "On garde les ventes de surface voisine (à plus ou moins 35 % pour un appartement, 40 % pour une maison, 50 % pour un immeuble ou un local, 60 % pour un terrain). Il en faut au moins 4 ; sinon l’estimation reste « indicative ».",
  "On écarte les prix au m² invraisemblables (hors de 300 à 50 000 € le m² pour le bâti), puis, à partir de 7 ventes, les valeurs extrêmes.",
  "Chaque vente reçoit un poids qui dépend de sa distance au bien, de son ancienneté (ce critère est divisé par deux tous les 24 mois), de sa surface et de sa proximité dans le quartier. Le prix au m² est ajusté de l’évolution locale des prix quand elle est mesurable (au moins 6 ventes sur 12 mois ou plus, plafonnée à 12 % par an).",
  "La valeur estimée est la médiane pondérée de ces prix au m², multipliée par la surface du bien. La fourchette affichée (arrondie au millier d’euros) va du 10e au 90e centile.",
] as const;

const RELIABLE_CRITERIA = [
  "au moins 4 ventes comparables, dont l’échantillon effectif atteint 3 ;",
  "des ventes de surface voisine (pas d’élargissement à tout le type de bien) ;",
  "des prix pas trop dispersés : l’écart entre le 25e et le 75e centile ne dépasse pas 75 % de la médiane ;",
  "toutes les années de données ont pu être lues ;",
  "la surface du bien n’est pas une estimation, et sa position n’est pas approximative.",
] as const;

const LIMITS = [
  "La DVF recense des prix de vente déclarés. Elle ignore l’état du bien, ses travaux, son occupation, la qualité de l’étage ou de l’exposition : l’estimation ne les corrige pas.",
  "La DVF est publiée avec un décalage (la base est renouvelée deux fois par an) : les ventes les plus récentes n’y figurent pas encore, et un quartier peu actif a peu de ventes à comparer.",
  "La DVF ne couvre pas l’Alsace, la Moselle ni Mayotte : les biens de ces territoires n’ont en principe pas d’écart avec le marché.",
  "La mise à prix n’est pas le prix d’adjudication : le prix final peut être très différent, et des frais s’y ajoutent. Un écart important ne dit pas ce que vous paierez.",
  "Une surface mal renseignée (un terrain pris pour la surface habitable, par exemple) fausse la valeur estimée et donc l’écart.",
  "L’estimation donne un ordre de grandeur, pas une expertise, et ne constitue ni un conseil juridique ni un conseil financier.",
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
      <BreadcrumbJsonLd
        trail={[
          { name: "Comment est calculé l’écart avec le marché", path: MARKET_GAP_METHOD_PATH },
        ]}
      />
      <PageContent />
    </>
  );
}

function PageContent() {
  return (
    <PageShell
      eyebrow="Transparence"
      title="Comment est calculé l’écart avec le marché ?"
      description="Sur une fiche de vente, Immojudis compare la mise à prix à la valeur de marché estimée du bien. Voici d’où vient cette valeur, comment l’écart se calcule, quand il n’est pas affiché et ce qu’il ne dit pas."
      width="narrow"
    >
      <div className="grid gap-5">
        <Section id="formule" title="L’écart, en une formule">
          <p>
            L’écart compare la mise à prix de la vente à la valeur de marché estimée du bien. Il
            s’exprime en pourcentage de cette valeur, arrondi à l’unité :
          </p>
          <p className="rounded-lg bg-surface-muted p-3 font-semibold text-foreground">{FORMULA}</p>
          <p>
            Un écart positif signifie que la mise à prix est <strong>sous</strong> la valeur estimée
            ; un écart négatif, qu’elle est <strong>au-dessus</strong>. Il compare une mise à prix,
            c’est-à-dire un prix de départ, à une valeur de marché : ce n’est pas une promesse
            d’économie.
          </p>
        </Section>

        <Section id="source" title="D’où vient la valeur de marché">
          <p>
            La valeur vient de la base <strong>DVF</strong> (« demandes de valeurs foncières »), qui
            recense les ventes immobilières réalisées en France, publiée en données ouvertes par
            l’administration fiscale. Immojudis la lit à partir de copies normalisées de ces
            fichiers ou, à défaut, des fichiers publics de data.gouv.fr et de l’API ouverte du
            Cerema.
          </p>
          <p>
            L’aperçu de la fiche lit une estimation calculée à l’avance et mémorisée : l’afficher ne
            déclenche pas de nouveau calcul.
          </p>
        </Section>

        <Section id="comparables" title="Les ventes comparables : périmètre et période">
          <ol className="list-decimal space-y-2 pl-5">
            {COMPARABLE_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p>
            Quand un modèle statistique entraîné sur des ventes passées est actif pour ce type de
            bien, il est combiné à cette médiane, avec un poids qui dépend de la qualité des
            comparables.
          </p>
        </Section>

        <Section id="fiabilite" title="Quand l’estimation est jugée fiable">
          <p>
            L’écart n’est affiché que pour une estimation jugée fiable. Elle l’est lorsque toutes
            ces conditions sont réunies :
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {RELIABLE_CRITERIA.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
          <p>
            Le rayon est élargi pas à pas (jusqu’à cinq rayons selon le type de bien) tant que
            l’estimation n’est pas fiable. Quand il a été élargi, l’estimation l’indique.
          </p>
        </Section>

        <Section id="repli" title="Quand il y a trop peu de ventes">
          <p>
            Si, même avec le rayon le plus large, il n’y a pas assez de ventes comparables,
            Immojudis se replie sur des statistiques DVF agrégées : celles de la commune si elles
            reposent sur au moins 5 ventes, sinon celles de l’intercommunalité (au moins 12 ventes),
            sinon celles du département (au moins 30 ventes). À défaut, l’échelle la mieux fournie
            est retenue, dès une vente. Ces statistiques doivent avoir été mises à jour il y a 24
            mois au plus. Il n’y a pas de repli pour un terrain.
          </p>
          <p>
            Cette valeur de repli est présentée comme <strong>indicative et fragile</strong>, avec
            une fourchette volontairement large. Elle n’est pas jugée fiable :{" "}
            <strong>aucun écart en pourcentage n’en est tiré</strong>, ni dans l’aperçu d’un compte
            gratuit ni dans les alertes sur la décote.
          </p>
        </Section>

        <Section id="garde-fou" title="Quand l’écart n’est pas affiché">
          <p>
            Un écart très éloigné de zéro vient plus souvent d’une estimation fausse (surface
            erronée, vente d’une part seulement, type de bien mal qualifié) que d’une affaire
            exceptionnelle. Par prudence, Immojudis n’affiche alors{" "}
            <strong>aucun pourcentage</strong> : seulement le prix au m² de la mise à prix, avec la
            mention « {MARKET_GAP_NOT_SIGNIFICANT_LABEL} ». Les seuils sont les suivants, par
            rapport à la valeur estimée :
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              mise à prix inférieure de plus de {MARKET_GAP_MAX_DISCOUNT_PCT} % à la valeur estimée
              (moins de {100 - MARKET_GAP_MAX_DISCOUNT_PCT} % de cette valeur) ;
            </li>
            <li>
              mise à prix supérieure de plus de {-MARKET_GAP_MIN_DISCOUNT_PCT} % à la valeur estimée
              (plus de {100 - MARKET_GAP_MIN_DISCOUNT_PCT} % de cette valeur).
            </li>
          </ul>
          <p>
            La fourchette de valeur reste affichée. Le prix au m² n’est donné que si la surface de
            référence de l’estimation est connue.
          </p>
          <p>
            La même plage s’applique dans les <strong>alertes</strong> : une vente dont l’écart la
            dépasse ne remplit jamais un critère de décote minimale et son résumé n’affiche aucun
            pourcentage. Elle s’applique aussi au facteur « Décote de départ » de la prévision de
            résultat de la fiche, qui indique alors seulement « {MARKET_GAP_NOT_SIGNIFICANT_LABEL}{" "}
            ».
          </p>
        </Section>

        <Section id="bandes" title="Le repère en trois bandes de la fiche publique">
          <p>
            Sans compte, la fiche d’une vente au tribunal ou chez le notaire peut afficher un repère
            en trois bandes, <strong>sans aucun chiffre</strong>. Il situe la mise à prix par
            rapport à la fourchette de la valeur estimée (du 10e au 90e centile), et non par rapport
            à la seule valeur centrale :
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              « nettement sous la valeur estimée » : la mise à prix est sous le bas de la fourchette
              ;
            </li>
            <li>« proche de la valeur estimée » : elle est dans la fourchette ;</li>
            <li>
              « au-dessus de la valeur estimée » : elle est au-dessus du haut de la fourchette.
            </li>
          </ul>
          <p>
            Le repère n’apparaît que si l’estimation est jugée fiable (critères ci-dessus), si la
            fourchette n’est pas plus large que {MARKET_GAP_BAND_MAX_INTERVAL_WIDTH_PCT} % de la
            valeur estimée et, lorsque l’estimation est combinée à un modèle statistique, si ce
            modèle est toujours actif. Les seuils de la section précédente s’appliquent aussi :
            au-delà, aucun repère n’est donné. Quand l’estimation n’est pas assez fiable, la fiche
            l’indique (« {MARKET_GAP_BAND_LABELS.insufficient} ») ; tant qu’elle n’est pas calculée,
            elle ne dit rien. Une cession de l’État, dont le prix est un prix publié, n’a pas de
            repère.
          </p>
          <p>
            Le pourcentage, la valeur estimée et la fourchette restent réservés aux comptes. Ce
            repère est indicatif : la mise à prix est un prix de départ, et il ne remplace ni une
            visite ni l’avis d’un professionnel.
          </p>
        </Section>

        <Section id="limites" title="Les limites à garder en tête">
          <ul className="list-disc space-y-2 pl-5">
            {LIMITS.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </Section>

        <Card as="section" aria-labelledby="pour-aller-plus-loin" className="bg-surface-muted">
          <h2 id="pour-aller-plus-loin" className="font-display text-2xl font-semibold">
            Pour aller plus loin
          </h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-ink-soft">
            <li>
              <Link
                href="/classement-des-annonces"
                className="font-semibold text-gold-text underline"
              >
                Comment sont classées les annonces
              </Link>
            </li>
            <li>
              <Link
                href="/simulateur-frais-encheres"
                className="font-semibold text-gold-text underline"
              >
                Le simulateur de frais d’enchères
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
