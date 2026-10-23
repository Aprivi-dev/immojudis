import Link from "next/link";
import { Suspense } from "react";
import { Terme } from "@/components/ceiling/Terme";
import { FEES_SIMULATOR_DEPARTMENTS } from "@/components/fees-simulator/departments";
import { Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import { SALE_CALENDAR_DISCLAIMER } from "@/lib/sale-calendar";
import { seoLongDate } from "@/lib/seo";
import {
  HEARINGS_WEEK_DAYS,
  HEARINGS_WINDOW_DAYS,
  hearingDepartments,
  type HearingWindows,
} from "@/lib/upcoming-hearings";
import {
  HearingsFilteredListing,
  HearingsListing,
  type HearingDepartmentOption,
} from "./hearings-list";

/** Les départements ayant une audience, avec leur nom (« Gironde (33) ») et leur nombre d'audiences. */
function departmentOptions(windows: HearingWindows): HearingDepartmentOption[] {
  return hearingDepartments(windows).map(({ code, count }) => {
    const name = FEES_SIMULATOR_DEPARTMENTS.find((department) => department.code === code)?.name;
    return { code, count, label: name ? `${name} (${code})` : code };
  });
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
  const departments = departmentOptions(windows);
  const paths = Object.fromEntries(tribunalPaths);

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

        {total > 0 ? (
          // Le choix du département est dans l'adresse, lu dans le navigateur : la page reste produite
          // à l'avance. En attendant (et pour les robots) la frontière montre la liste complète.
          <Suspense
            fallback={
              <HearingsListing
                windows={windows}
                tribunalPaths={paths}
                departments={departments}
                department={null}
              />
            }
          >
            <HearingsFilteredListing
              windows={windows}
              tribunalPaths={paths}
              departments={departments}
            />
          </Suspense>
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
