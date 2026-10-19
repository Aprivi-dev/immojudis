import Link from "next/link";
import { HideForLaunchOfferAccount, LaunchOfferNote } from "@/components/LaunchOfferNote";
import { Badge, Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import type { PublicAdjudicationPrices } from "@/lib/public-adjudication-prices";
import { PUBLIC_ADJUDICATION_MIN_SAMPLE } from "@/lib/public-adjudication-prices";

const integer = new Intl.NumberFormat("fr-FR");
const euro = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const percent = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 });
const ratio = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dayFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const parisDayFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Paris",
});

/** Les dates de période sont des jours civils (`AAAA-MM-JJ`) : lues en UTC pour ne pas bouger. */
function day(value: string): string {
  return dayFormat.format(new Date(`${value}T00:00:00Z`));
}

function instant(value: string): string {
  return parisDayFormat.format(new Date(value));
}

const multiple = (value: number) => `× ${ratio.format(value)}`;

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
          chiffres nationaux calculés sur les prix d’adjudication publiés, avec leur période, leur
          effectif et leur méthode.{" "}
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
                Prix final médian, rapporté à la mise à prix
              </dt>
              <dd className="mt-1 font-display text-3xl font-semibold" data-testid="median-ratio">
                {multiple(data.medianRatio)}
              </dd>
              <dd className="mt-1 text-sm text-ink-soft">
                Pour la moitié des biens, le prix final est inférieur à ce multiple de la mise à
                prix.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">Ventes adjugées au-dessus de la mise à prix</dt>
              <dd className="mt-1 font-display text-3xl font-semibold" data-testid="above-rate">
                {percent.format(data.aboveStartingRate)}
              </dd>
              <dd className="mt-1 text-sm text-ink-soft">
                Part des prix publiés strictement supérieurs à la mise à prix.
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">Ventes adjugées au moins au double</dt>
              <dd className="mt-1 font-display text-3xl font-semibold">
                {percent.format(data.atLeastDoubleRate)}
              </dd>
              <dd className="mt-1 text-sm text-ink-soft">
                Part des prix publiés égaux ou supérieurs à deux fois la mise à prix.
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-ink-soft">
            Mise à prix médiane : {euro.format(data.medianStartingPriceEur)} ; prix final médian :{" "}
            {euro.format(data.medianHammerPriceEur)}. Ces deux médianes portent sur les mêmes ventes
            mais ne se divisent pas pour retrouver le multiple médian : celui-ci est la médiane des
            rapports calculés vente par vente.
          </p>
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
            <Badge tone="neutral">Expérimental</Badge>
            <span>
              Ventes du {day(data.periodStart)} au {day(data.periodEnd)} ·{" "}
              {integer.format(data.sampleSize)} prix publiés · {integer.format(data.tribunalCount)}{" "}
              tribunaux ayant au moins {PUBLIC_ADJUDICATION_MIN_SAMPLE} prix · calcul du{" "}
              {instant(data.builtAt)}, revu le {instant(data.reviewedAt)}
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
                  Prix final rapporté à la mise à prix, par type de bien
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
                    <th scope="col" className="py-2 font-semibold">
                      Au-dessus de la mise
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
                      <td className="py-2">{percent.format(item.aboveStartingRate)}</td>
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
              Où se situe le prix final
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              Répartition des prix publiés selon leur rapport à la mise à prix.
            </p>
            <ul className="mt-4 grid gap-2 text-sm">
              {data.bands.map((band) => (
                <li key={band.label} className="flex items-center justify-between gap-4">
                  <span>{band.label}</span>
                  <span className="font-semibold">{percent.format(band.share)}</span>
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
              {data.sourceLabel}. Seules les ventes judiciaires rattachées à un tribunal, avec une
              date valide, une mise à prix et un prix publié, sont retenues ; les doublons sont
              écartés. Les prix s’entendent hors frais.
            </p>
            <p>
              Le multiple est le prix final divisé par la mise à prix de la même vente ; le multiple
              médian est la médiane de ces rapports. Les parts utilisent l’effectif indiqué comme
              dénominateur.
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
