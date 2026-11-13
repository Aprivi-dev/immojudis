import Link from "next/link";
import { HideForLaunchOfferAccount, LaunchOfferNote } from "@/components/LaunchOfferNote";
import { Badge, Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import type { ShareInterval } from "@/lib/adjudication-barometer";
import { formatDate } from "@/lib/format/dates";
import { formatPrice, formatShareAsPercent } from "@/lib/format/numbers";
import type { PublicAdjudicationPrices } from "@/lib/public-adjudication-prices";
import { PUBLIC_ADJUDICATION_MIN_SAMPLE } from "@/lib/public-adjudication-prices";

const integer = new Intl.NumberFormat("fr-FR");
const ratio = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const multiple = (value: number) => `× ${ratio.format(value)}`;

/** « intervalle à 95 % : de 63 % à 76 % » : l'incertitude de Wilson de la part affichée à côté. */
function intervalText(interval: ShareInterval | null): string | null {
  return interval
    ? `intervalle à 95 % : de ${formatShareAsPercent(interval.low)} à ${formatShareAsPercent(interval.high)}`
    : null;
}

/** Message sobre quand les chiffres ne peuvent pas être servis : aucun chiffre, aucune promesse. */
export function PricesUnavailable() {
  return (
    <PageShell
      eyebrow="Prix réels"
      title="Prix des adjudications immobilières"
      description="Les statistiques de prix ne sont pas disponibles pour le moment. Aucun chiffre n’est affiché tant qu’un calcul revu et suffisamment fourni n’est pas disponible."
      width="narrow"
    >
      <Card as="section" aria-label="Statistiques indisponibles">
        <p className="text-ink-soft">
          Revenez plus tard, ou consultez{" "}
          <Link href="/sales" className="font-semibold underline">
            les ventes à venir
          </Link>
          .
        </p>
      </Card>
    </PageShell>
  );
}

export function PricesView({ data }: { data: PublicAdjudicationPrices }) {
  return (
    <PageShell
      eyebrow="Prix réels"
      title="Prix des adjudications immobilières"
      description={
        <>
          Combien se vendent réellement les biens aux enchères, par rapport à leur mise à prix ? Des
          chiffres nationaux calculés sur les prix adjugés publiés (hors frais, avant surenchère),
          avec leur période, leur effectif et leur méthode.{" "}
          <a href="#methode" className="font-semibold underline">
            Voir la méthode
          </a>
          .
        </>
      }
      width="default"
    >
      <div className="grid gap-5">
        <Card as="section" aria-labelledby="prix-essentiel">
          <h2 id="prix-essentiel" className="font-display text-2xl font-semibold">
            L’essentiel
          </h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-ink-soft">
                Prix adjugé publié (hors frais, avant surenchère), médian, rapporté à la mise à prix
              </dt>
              <dd className="mt-1 font-display text-3xl font-semibold" data-testid="median-ratio">
                {multiple(data.medianRatio)}
              </dd>
              <dd className="mt-1 text-sm text-ink-soft">
                Pour la moitié des biens, le prix adjugé publié est inférieur à ce multiple de la
                mise à prix.
                {data.ratioMiddle50
                  ? ` La moitié centrale des ventes se situe entre ${multiple(data.ratioMiddle50.p25)} et ${multiple(data.ratioMiddle50.p75)}.`
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">Ventes adjugées au-dessus de la mise à prix</dt>
              <dd className="mt-1 font-display text-3xl font-semibold" data-testid="above-rate">
                {formatShareAsPercent(data.aboveStartingRate)}
              </dd>
              <dd className="mt-1 text-sm text-ink-soft">
                Part des prix publiés strictement supérieurs à la mise à prix
                {intervalText(data.aboveStartingInterval)
                  ? ` (${intervalText(data.aboveStartingInterval)})`
                  : ""}
                .
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">Ventes adjugées au moins au double</dt>
              <dd className="mt-1 font-display text-3xl font-semibold">
                {formatShareAsPercent(data.atLeastDoubleRate)}
              </dd>
              <dd className="mt-1 text-sm text-ink-soft">
                Part des prix publiés égaux ou supérieurs à deux fois la mise à prix
                {intervalText(data.atLeastDoubleInterval)
                  ? ` (${intervalText(data.atLeastDoubleInterval)})`
                  : ""}
                .
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-ink-soft">
            Mise à prix médiane : {formatPrice(data.medianStartingPriceEur)} ; prix adjugé publié
            médian : {formatPrice(data.medianHammerPriceEur)}. Ces deux médianes portent sur les
            mêmes ventes mais ne se divisent pas pour retrouver le multiple médian : celui-ci est la
            médiane des rapports calculés vente par vente. Le multiple reflète la mise à prix
            choisie : une mise à prix basse donne mécaniquement un multiple élevé.
          </p>
          <p className="mt-3 text-sm text-ink-soft">
            Périmètre : lots adjugés dont le prix est publié. Les lots non adjugés, retirés ou sans
            prix publié ne sont pas comptés.
          </p>
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
            <Badge tone="neutral">Expérimental</Badge>
            <span>
              Ventes du {formatDate(data.periodStart)} au {formatDate(data.periodEnd)} ·{" "}
              {integer.format(data.sampleSize)} prix adjugés publiés ·{" "}
              {integer.format(data.tribunalCount)} tribunaux ayant au moins{" "}
              {PUBLIC_ADJUDICATION_MIN_SAMPLE} prix · calcul du {formatDate(data.builtAt)}, revu le{" "}
              {formatDate(data.reviewedAt)}
            </span>
          </p>
        </Card>

        {data.propertyTypes.length > 0 ? (
          <Card as="section" aria-labelledby="prix-types">
            <h2 id="prix-types" className="font-display text-2xl font-semibold">
              Par type de bien
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              Seuls les types de biens avec au moins {PUBLIC_ADJUDICATION_MIN_SAMPLE} prix publiés
              sont affichés ; les autres sont masqués.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  Prix adjugé publié rapporté à la mise à prix, par type de bien
                </caption>
                <thead>
                  <tr className="border-b border-line text-ink-soft">
                    <th scope="col" className="py-2 pr-4 font-semibold">
                      Type de bien
                    </th>
                    <th scope="col" className="py-2 pr-4 font-semibold">
                      Prix publiés
                    </th>
                    <th scope="col" className="py-2 pr-4 font-semibold">
                      Multiple médian
                    </th>
                    <th scope="col" className="py-2 pr-4 font-semibold">
                      Moitié centrale des multiples
                    </th>
                    <th scope="col" className="py-2 font-semibold">
                      Au-dessus de la mise (intervalle à 95 %)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.propertyTypes.map((item) => (
                    <tr key={item.propertyType} className="border-b border-line last:border-0">
                      <th scope="row" className="py-2 pr-4 font-medium">
                        {item.label}
                      </th>
                      <td className="py-2 pr-4">{integer.format(item.sampleSize)}</td>
                      <td className="py-2 pr-4">
                        {item.medianRatio === null ? "n. d." : multiple(item.medianRatio)}
                      </td>
                      <td className="py-2 pr-4">
                        {multiple(item.ratioMiddle50.p25)} à {multiple(item.ratioMiddle50.p75)}
                      </td>
                      <td className="py-2">
                        {formatShareAsPercent(item.aboveStartingRate)}
                        {item.aboveStartingInterval ? (
                          <span className="block text-xs text-ink-soft">
                            de {formatShareAsPercent(item.aboveStartingInterval.low)} à{" "}
                            {formatShareAsPercent(item.aboveStartingInterval.high)}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        {data.bands.length > 0 ? (
          <Card as="section" aria-labelledby="prix-tranches">
            <h2 id="prix-tranches" className="font-display text-2xl font-semibold">
              Où se situe le prix adjugé publié
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              Répartition des prix adjugés publiés selon leur rapport à la mise à prix, avec
              l’intervalle de confiance à 95 % de chaque part.
            </p>
            <ul className="mt-4 grid gap-2 text-sm">
              {data.bands.map((band) => (
                <li key={band.label} className="flex items-center justify-between gap-4">
                  <span>{band.label}</span>
                  <span className="text-right">
                    <span className="font-semibold">{formatShareAsPercent(band.share)}</span>
                    {band.interval ? (
                      <span className="block text-xs text-ink-soft">
                        de {formatShareAsPercent(band.interval.low)} à{" "}
                        {formatShareAsPercent(band.interval.high)}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card as="section" aria-labelledby="prix-analyse">
          <h2 id="prix-analyse" className="font-display text-2xl font-semibold">
            Aller plus loin avec l’offre Analyse
          </h2>
          <p className="mt-2 text-ink-soft">
            Le détail tribunal par tribunal et les scénarios de prix d’une vente sont réservés à
            l’offre Analyse.
          </p>
          <LaunchOfferNote className="mt-3" />
          <HideForLaunchOfferAccount>
            <Link
              href="/offres"
              className={buttonClasses({ variant: "primary", className: "mt-4" })}
            >
              Découvrir l’offre Analyse
            </Link>
          </HideForLaunchOfferAccount>
        </Card>

        <Card as="section" id="methode" aria-labelledby="prix-methode">
          <h2 id="prix-methode" className="font-display text-2xl font-semibold">
            Méthode et limites
          </h2>
          <div className="mt-3 space-y-3 text-ink-soft">
            <p>
              {data.sourceLabel}. Périmètre : les lots adjugés dont le prix est publié. Seules les
              ventes judiciaires rattachées à un tribunal, avec une date valide, une mise à prix et
              un prix publié, sont retenues ; les doublons sont écartés. Les lots non adjugés,
              retirés ou sans prix publié ne sont pas comptés. Le prix est le prix adjugé publié,
              hors frais et avant une éventuelle surenchère : il peut ne pas être le prix définitif.
            </p>
            <p>
              Le multiple est le prix adjugé publié divisé par la mise à prix de la même vente ; le
              multiple médian est la médiane de ces rapports, et la moitié centrale est l’intervalle
              entre le premier et le troisième quartile. Le multiple reflète la mise à prix choisie.
              Les parts utilisent l’effectif indiqué comme dénominateur, et leur incertitude est
              donnée par l’intervalle de confiance de Wilson à 95 %.
            </p>
            <p>
              Aucun chiffre n’est publié sous {PUBLIC_ADJUDICATION_MIN_SAMPLE} prix, ni pour un type
              de bien ni pour l’ensemble. Au-delà, un effectif modeste reste descriptif : les
              résultats non publiés par la source peuvent créer un biais, et la couverture varie
              selon les tribunaux.
            </p>
            <p>
              Ces statistiques décrivent des ventes passées et des biens différents. Elles ne
              garantissent ni un prix, ni une adjudication, et ne constituent pas une estimation du
              bien que vous préparez.
            </p>
            <p className="text-sm">{data.warning}</p>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
