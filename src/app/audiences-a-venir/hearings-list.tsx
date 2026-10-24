"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, lazy, useId, type ReactNode } from "react";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import { HEARINGS_DEPARTMENT_PARAM, validHearingDepartment } from "@/lib/hearings-department";
import { RelativeDay } from "./relative-day";

// L'invitation à créer une alerte n'apparaît qu'une fois un département choisi : son code (session,
// formulaire) n'entre pas dans le JavaScript initial de la page.
const SectorAlertCta = lazy(() =>
  import("@/components/SectorAlertCta").then((module) => ({ default: module.SectorAlertCta })),
);

const count = new Intl.NumberFormat("fr-FR");

/** Les jours de la première fenêtre ouverts d'emblée sans filtre : les autres se déplient d'un clic. */
const OPEN_DAYS_WITHOUT_FILTER = 2;

/**
 * Les classes de `<Card as="section">` : `Card` passe par `cn` (tailwind-merge), qui alourdirait le
 * JavaScript initial de la page. Un test vérifie que les deux restent identiques.
 */
export const CARD_CLASS = "rounded-lg border border-line bg-white text-foreground p-4 sm:p-5";

export type HearingDepartmentOption = { code: string; label: string; count: number };

/**
 * Les audiences telles que le serveur les a mises en page (voir `hearings-rows.tsx`) : chaque ligne
 * est un élément déjà rendu, le navigateur ne fait que choisir lesquelles montrer.
 */
export type ListedHearing = { id: string; department: string | null; row: ReactNode };
export type ListedGroup = { key: string; heading: ReactNode; hearings: ListedHearing[] };
export type ListedDay = { dayKey: string; label: string; groups: ListedGroup[] };
export type ListedWindows = {
  weekDays: number;
  windowDays: number;
  week: ListedDay[];
  later: ListedDay[];
};

type FilteredDay = ListedDay & { count: number };

function hearingWord(total: number): string {
  return total > 1 ? "audiences" : "audience";
}

/** Les jours réduits aux audiences d'un département (aucun filtre : tous), jours et tribunaux vides retirés. */
function filterDays(days: readonly ListedDay[], department: string | null): FilteredDay[] {
  const result: FilteredDay[] = [];
  for (const day of days) {
    const groups = day.groups
      .map((group) => ({
        ...group,
        hearings: department
          ? group.hearings.filter((hearing) => hearing.department === department)
          : group.hearings,
      }))
      .filter((group) => group.hearings.length > 0);
    const total = groups.reduce((sum, group) => sum + group.hearings.length, 0);
    if (total > 0) result.push({ ...day, groups, count: total });
  }
  return result;
}

function totalOf(days: readonly FilteredDay[]): number {
  return days.reduce((sum, day) => sum + day.count, 0);
}

function Days({
  days,
  openAll,
  openFirst,
}: {
  days: readonly FilteredDay[];
  /** Tous les jours ouverts (liste filtrée, donc courte). */
  openAll: boolean;
  /** Nombre de premiers jours ouverts quand `openAll` est faux. */
  openFirst: number;
}) {
  return (
    <div className="mt-4 grid gap-3">
      {days.map((day, index) => (
        // Un jour par bloc repliable : 800 lignes d'un coup faisaient une page de 79 000 px. Le contenu
        // reste dans le HTML (lisible par les robots) ; « ouvert » ne dépend que de l'écran.
        <section key={`${day.dayKey}-${openAll}`} aria-labelledby={`jour-${day.dayKey}`}>
          <details
            open={openAll || index < openFirst}
            className="group rounded-lg border border-line px-4 py-3"
          >
            <summary className="cursor-pointer list-none">
              <h3 id={`jour-${day.dayKey}`} className="inline font-display text-xl font-semibold">
                <RelativeDay dayKey={day.dayKey} label={day.label} />{" "}
                <span className="text-base font-normal text-ink-soft">
                  · {count.format(day.count)} {hearingWord(day.count)}
                </span>
              </h3>
              <span className="ml-2 text-sm text-gold-text underline group-open:hidden">
                Afficher
              </span>
            </summary>
            <div className="mt-3 grid gap-3">
              {day.groups.map((group) => (
                <div key={group.key}>
                  {group.heading}
                  <ul className="mt-1 divide-y divide-line">
                    {group.hearings.map((hearing) => (
                      <li key={hearing.id} className="py-2">
                        {hearing.row}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        </section>
      ))}
    </div>
  );
}

/** Liste déroulante des départements ; sans script (avant l'hydratation) elle reste visible et grisée. */
function DepartmentFilter({
  departments,
  value,
  onChange,
  disabled,
}: {
  departments: readonly HearingDepartmentOption[];
  value: string | null;
  onChange?: (code: string | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5 sm:max-w-sm">
      <label htmlFor={id} className="text-sm font-semibold text-brand-navy">
        Département
      </label>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value || null)}
        className="form-input h-11 cursor-pointer"
      >
        <option value="">Tous les départements</option>
        {departments.map((department) => (
          <option key={department.code} value={department.code}>
            {department.label} · {count.format(department.count)} {hearingWord(department.count)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Les deux fenêtres d'audiences pour un département donné (ou tous). Sans script (rendu du serveur,
 * ou avant l'hydratation) c'est la liste complète : le HTML garde toutes les audiences pour les
 * moteurs de recherche, la page n'est qu'un peu plus lourde.
 */
export function HearingsListing({
  listing,
  departments,
  department,
  onDepartmentChange,
}: {
  listing: ListedWindows;
  departments: readonly HearingDepartmentOption[];
  department: string | null;
  /** Absent avant l'hydratation : le filtre est alors grisé. */
  onDepartmentChange?: (code: string | null) => void;
}) {
  const week = filterDays(listing.week, department);
  const later = filterDays(listing.later, department);
  const weekCount = totalOf(week);
  const laterCount = totalOf(later);
  const total = weekCount + laterCount;
  const option = departments.find((candidate) => candidate.code === department);
  return (
    <>
      {departments.length > 0 ? (
        <section className={CARD_CLASS} aria-label="Filtrer par département">
          <DepartmentFilter
            departments={departments}
            value={department}
            onChange={onDepartmentChange}
            disabled={!onDepartmentChange}
          />
          {department && option ? (
            <p className="mt-3 text-sm text-ink-soft" role="status">
              {count.format(total)} {hearingWord(total)} dans le département {option.label}.{" "}
              <button
                type="button"
                onClick={() => onDepartmentChange?.(null)}
                className="font-semibold text-gold-text underline"
              >
                Voir tous les départements
              </button>
            </p>
          ) : (
            <p className="mt-3 text-sm text-ink-soft">
              Choisissez un département pour ne voir que ses audiences et être prévenu de ses
              nouvelles ventes.
            </p>
          )}
        </section>
      ) : null}

      {weekCount > 0 ? (
        <section className={CARD_CLASS} aria-labelledby="sept-jours">
          <h2 id="sept-jours" className="font-display text-2xl font-semibold">
            Dans les {listing.weekDays} prochains jours
            <span className="text-lg font-normal text-ink-soft">
              {" "}
              · {count.format(weekCount)} {hearingWord(weekCount)}
            </span>
          </h2>
          <Days days={week} openAll={department !== null} openFirst={OPEN_DAYS_WITHOUT_FILTER} />
        </section>
      ) : null}

      {laterCount > 0 ? (
        <section className={CARD_CLASS} aria-labelledby="trente-jours">
          <h2 id="trente-jours" className="font-display text-2xl font-semibold">
            Du {listing.weekDays + 1}e au {listing.windowDays}e jour
            <span className="text-lg font-normal text-ink-soft">
              {" "}
              · {count.format(laterCount)} {hearingWord(laterCount)}
            </span>
          </h2>
          <Days days={later} openAll={department !== null} openFirst={0} />
        </section>
      ) : null}

      {department && total === 0 ? (
        <section className={CARD_CLASS} aria-labelledby="aucune-departement">
          <h2 id="aucune-departement" className="font-display text-2xl font-semibold">
            Aucune audience dans ce département
          </h2>
          <p className="mt-3 text-ink-soft">
            Aucune vente au tribunal n’y a, pour le moment, une date d’audience annoncée dans les{" "}
            {listing.windowDays} prochains jours.
          </p>
        </section>
      ) : null}

      {department ? (
        <Suspense fallback={null}>
          <SectorAlertCta
            criteria={{ department }}
            intro={`Recevez les nouvelles ventes du département ${option?.label ?? department}, dont les prochaines audiences.`}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * La liste filtrée par `?departement=` : le choix est dans l'adresse (partageable, bouton retour). Lue
 * dans le navigateur pour que la page reste produite à l'avance et mise en cache ; la frontière
 * Suspense de la page garde, en attendant, la liste complète.
 */
export function HearingsFilteredListing({
  listing,
  departments,
}: {
  listing: ListedWindows;
  departments: readonly HearingDepartmentOption[];
}) {
  const router = useRouter();
  const pathname = usePublicPathname();
  const searchParams = useSearchParams();
  const department = validHearingDepartment(
    searchParams.get(HEARINGS_DEPARTMENT_PARAM),
    departments,
  );

  function change(code: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (code) next.set(HEARINGS_DEPARTMENT_PARAM, code);
    else next.delete(HEARINGS_DEPARTMENT_PARAM);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <HearingsListing
      listing={listing}
      departments={departments}
      department={department}
      onDepartmentChange={change}
    />
  );
}
