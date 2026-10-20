import Link from "next/link";
import { Terme } from "@/components/ceiling/Terme";
import { SaleDetailLink } from "@/components/SaleDetailLink";
import { Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import { formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import { SALE_CALENDAR_DISCLAIMER } from "@/lib/sale-calendar";
import { seoLongDate } from "@/lib/seo";
import {
  HEARINGS_WEEK_DAYS,
  HEARINGS_WINDOW_DAYS,
  type HearingDay,
  type HearingWindows,
} from "@/lib/upcoming-hearings";
import { RelativeDay } from "./relative-day";

const count = new Intl.NumberFormat("fr-FR");

function hearingWord(total: number): string {
  return total > 1 ? "audiences" : "audience";
}

/** Le jour en toutes lettres ; « (aujourd’hui) » et « (demain) » s'ajoutent dans le navigateur (`RelativeDay`). */
function dayLabel(dayKey: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dayKey}T12:00:00Z`));
}

function Days({
  days,
  tribunalPaths,
}: {
  days: readonly HearingDay[];
  tribunalPaths: ReadonlyMap<string, string>;
}) {
  return (
    <div className="mt-4 grid gap-6">
      {days.map((day) => (
        <section key={day.dayKey} aria-labelledby={`jour-${day.dayKey}`}>
          <h3 id={`jour-${day.dayKey}`} className="font-display text-xl font-semibold">
            <RelativeDay dayKey={day.dayKey} label={dayLabel(day.dayKey)} />{" "}
            <span className="text-base font-normal text-ink-soft">
              · {count.format(day.count)} {hearingWord(day.count)}
            </span>
          </h3>
          <div className="mt-2 grid gap-3">
            {day.tribunals.map((group) => {
              const tribunalPath = group.tribunalCode
                ? tribunalPaths.get(group.tribunalCode)
                : null;
              return (
                <div key={group.key}>
                  <h4 className="font-semibold">
                    {tribunalPath ? (
                      <Link href={tribunalPath} className="text-gold-text underline">
                        {group.label}
                      </Link>
                    ) : (
                      group.label
                    )}
                  </h4>
                  <ul className="mt-1 divide-y divide-line">
                    {group.hearings.map((hearing) => (
                      <li key={hearing.id} className="py-2">
                        <SaleDetailLink
                          saleId={hearing.id.toLowerCase()}
                          returnTo="/audiences-a-venir"
                          className="grid gap-1 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-4"
                        >
                          <span className="min-w-0">
                            <span className="font-semibold underline-offset-4 hover:underline">
                              {hearing.city || "Commune à confirmer"}
                              {hearing.department ? ` (${hearing.department})` : ""}
                            </span>
                            <span className="block text-sm text-ink-soft">
                              {propertyTypeLabel(hearing.propertyType)} ·{" "}
                              {hearing.time ? `à ${hearing.time}` : "heure à confirmer"}
                            </span>
                          </span>
                          <span className="text-sm tabular-nums">
                            <span className="text-ink-soft">Mise à prix </span>
                            <span className="font-semibold">
                              {formatStartingPrice(hearing.startingPriceEur)}
                            </span>
                          </span>
                        </SaleDetailLink>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Contenu de la page « Audiences à venir » : pas d'adresse exacte (commune, type de bien, tribunal,
 * date, mise à prix, comme les cartes publiques), un lien vers la fiche de chaque vente.
 */
export function HearingsView({
  windows,
  tribunalPaths,
  truncated,
  unavailable = false,
  generatedAt,
}: {
  windows: HearingWindows;
  /** Adresse de la page de chaque tribunal, par code (vide si l'activité des tribunaux est indisponible). */
  tribunalPaths: ReadonlyMap<string, string>;
  /** Vrai quand la base a plus d'audiences que la limite de lecture : la liste est incomplète. */
  truncated: boolean;
  /** Vrai quand la lecture a échoué (au build, sans base) : la page le dit au lieu d'annoncer « aucune audience ». */
  unavailable?: boolean;
  generatedAt: Date;
}) {
  const total = windows.weekCount + windows.laterCount;
  const updated = seoLongDate(generatedAt.toISOString());

  return (
    <PageShell
      eyebrow="Ventes judiciaires"
      title="Audiences de ventes judiciaires à venir"
      description={
        <>
          <p>
            Les <Terme terme="adjudication">audiences d’adjudication</Terme> des{" "}
            {HEARINGS_WEEK_DAYS} puis des {HEARINGS_WINDOW_DAYS} prochains jours, avec la{" "}
            <Terme terme="mise-a-prix">mise à prix</Terme> de chaque bien, jour par jour et tribunal
            par tribunal.
          </p>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-semibold text-brand-navy underline underline-offset-2">
              À savoir avant de lire la liste
            </summary>
            <div className="mt-2 grid gap-2">
              <p>
                Seules figurent les ventes au tribunal dont la date est annoncée et n’est contredite
                par aucune source. Les ventes dont le report est connu n’y figurent pas ; une date
                peut encore changer.
              </p>
              <p>
                {SALE_CALENDAR_DISCLAIMER} Liste établie sur le catalogue public
                {updated ? ` au ${updated}` : ""} ; elle ne constitue pas un conseil juridique.
              </p>
            </div>
          </details>
        </>
      }
    >
      <nav aria-label="Fil d’Ariane" className="mb-6 text-sm text-ink-soft">
        <ol className="flex flex-wrap items-center gap-x-2">
          <li>
            <Link href="/" className="hover:underline">
              Accueil
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href="/tribunaux" className="hover:underline">
              Tribunaux
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page">Audiences à venir</li>
        </ol>
      </nav>

      <div className="grid gap-5">
        {total === 0 && unavailable ? (
          <Card as="section" aria-labelledby="indisponible">
            <h2 id="indisponible" className="font-display text-2xl font-semibold">
              Audiences momentanément indisponibles
            </h2>
            <p className="mt-3 text-ink-soft">
              La liste des audiences n’a pas pu être lue. Réessayez dans quelques instants ou
              consultez les ventes à venir tribunal par tribunal.
            </p>
          </Card>
        ) : null}

        {total === 0 && !unavailable ? (
          <Card as="section" aria-labelledby="aucune">
            <h2 id="aucune" className="font-display text-2xl font-semibold">
              Aucune audience à date annoncée
            </h2>
            <p className="mt-3 text-ink-soft">
              Aucune vente au tribunal n’a, pour le moment, une date d’audience annoncée dans les{" "}
              {HEARINGS_WINDOW_DAYS} prochains jours. Le catalogue est mis à jour régulièrement.
            </p>
          </Card>
        ) : null}

        {windows.weekCount > 0 ? (
          <Card as="section" aria-labelledby="sept-jours">
            <h2 id="sept-jours" className="font-display text-2xl font-semibold">
              Dans les {HEARINGS_WEEK_DAYS} prochains jours
              <span className="text-lg font-normal text-ink-soft">
                {" "}
                · {count.format(windows.weekCount)} {hearingWord(windows.weekCount)}
              </span>
            </h2>
            <Days days={windows.week} tribunalPaths={tribunalPaths} />
          </Card>
        ) : null}

        {windows.laterCount > 0 ? (
          <Card as="section" aria-labelledby="trente-jours">
            <h2 id="trente-jours" className="font-display text-2xl font-semibold">
              Du {HEARINGS_WEEK_DAYS + 1}e au {HEARINGS_WINDOW_DAYS}e jour
              <span className="text-lg font-normal text-ink-soft">
                {" "}
                · {count.format(windows.laterCount)} {hearingWord(windows.laterCount)}
              </span>
            </h2>
            <Days days={windows.later} tribunalPaths={tribunalPaths} />
          </Card>
        ) : null}

        {truncated ? (
          <p className="text-sm text-ink-soft" role="note">
            La liste est limitée aux premières audiences ; les suivantes sont dans la recherche.
          </p>
        ) : null}

        <Card as="section" aria-labelledby="suites">
          <h2 id="suites" className="font-display text-2xl font-semibold">
            Pour aller plus loin
          </h2>
          <p className="mt-3 text-ink-soft">
            Chaque fiche détaille la vente et permet d’ajouter l’audience à votre agenda. Pour voir
            toutes les ventes à venir, y compris celles dont la date n’est pas encore annoncée :
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/sales" className={buttonClasses({ variant: "primary", size: "md" })}>
              Rechercher les ventes à venir
            </Link>
            <Link href="/tribunaux" className={buttonClasses({ variant: "secondary", size: "md" })}>
              Ventes par tribunal
            </Link>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
