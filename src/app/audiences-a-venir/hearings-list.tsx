"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId } from "react";
import { SaleDetailLink } from "@/components/SaleDetailLink";
import { SectorAlertCta } from "@/components/SectorAlertCta";
import { Card } from "@/components/ui/primitives";
import { formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import {
  HEARINGS_DEPARTMENT_PARAM,
  HEARINGS_WEEK_DAYS,
  HEARINGS_WINDOW_DAYS,
  filterWindowsByDepartment,
  validHearingDepartment,
  type HearingDay,
  type HearingWindows,
} from "@/lib/upcoming-hearings";
import { RelativeDay } from "./relative-day";

const count = new Intl.NumberFormat("fr-FR");

/** Les jours de la première fenêtre ouverts d'emblée sans filtre : les autres se déplient d'un clic. */
const OPEN_DAYS_WITHOUT_FILTER = 2;

export type HearingDepartmentOption = { code: string; label: string; count: number };

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
  openAll,
  openFirst,
}: {
  days: readonly HearingDay[];
  tribunalPaths: Readonly<Record<string, string>>;
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
                <RelativeDay dayKey={day.dayKey} label={dayLabel(day.dayKey)} />{" "}
                <span className="text-base font-normal text-ink-soft">
                  · {count.format(day.count)} {hearingWord(day.count)}
                </span>
              </h3>
              <span className="ml-2 text-sm text-gold-text underline group-open:hidden">
                Afficher
              </span>
            </summary>
            <div className="mt-3 grid gap-3">
              {day.tribunals.map((group) => {
                const tribunalPath = group.tribunalCode ? tribunalPaths[group.tribunalCode] : null;
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
  windows,
  tribunalPaths,
  departments,
  department,
  onDepartmentChange,
}: {
  windows: HearingWindows;
  tribunalPaths: Readonly<Record<string, string>>;
  departments: readonly HearingDepartmentOption[];
  department: string | null;
  /** Absent avant l'hydratation : le filtre est alors grisé. */
  onDepartmentChange?: (code: string | null) => void;
}) {
  const shown = filterWindowsByDepartment(windows, department);
  const total = shown.weekCount + shown.laterCount;
  const option = departments.find((candidate) => candidate.code === department);
  return (
    <>
      {departments.length > 0 ? (
        <Card as="section" aria-label="Filtrer par département">
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
        </Card>
      ) : null}

      {shown.weekCount > 0 ? (
        <Card as="section" aria-labelledby="sept-jours">
          <h2 id="sept-jours" className="font-display text-2xl font-semibold">
            Dans les {HEARINGS_WEEK_DAYS} prochains jours
            <span className="text-lg font-normal text-ink-soft">
              {" "}
              · {count.format(shown.weekCount)} {hearingWord(shown.weekCount)}
            </span>
          </h2>
          <Days
            days={shown.week}
            tribunalPaths={tribunalPaths}
            openAll={department !== null}
            openFirst={OPEN_DAYS_WITHOUT_FILTER}
          />
        </Card>
      ) : null}

      {shown.laterCount > 0 ? (
        <Card as="section" aria-labelledby="trente-jours">
          <h2 id="trente-jours" className="font-display text-2xl font-semibold">
            Du {HEARINGS_WEEK_DAYS + 1}e au {HEARINGS_WINDOW_DAYS}e jour
            <span className="text-lg font-normal text-ink-soft">
              {" "}
              · {count.format(shown.laterCount)} {hearingWord(shown.laterCount)}
            </span>
          </h2>
          <Days
            days={shown.later}
            tribunalPaths={tribunalPaths}
            openAll={department !== null}
            openFirst={0}
          />
        </Card>
      ) : null}

      {department && total === 0 ? (
        <Card as="section" aria-labelledby="aucune-departement">
          <h2 id="aucune-departement" className="font-display text-2xl font-semibold">
            Aucune audience dans ce département
          </h2>
          <p className="mt-3 text-ink-soft">
            Aucune vente au tribunal n’y a, pour le moment, une date d’audience annoncée dans les{" "}
            {HEARINGS_WINDOW_DAYS} prochains jours.
          </p>
        </Card>
      ) : null}

      {department ? (
        <SectorAlertCta
          criteria={{ department }}
          intro={`Recevez les nouvelles ventes du département ${option?.label ?? department}, dont les prochaines audiences.`}
        />
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
  windows,
  tribunalPaths,
  departments,
}: {
  windows: HearingWindows;
  tribunalPaths: Readonly<Record<string, string>>;
  departments: readonly HearingDepartmentOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
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
      windows={windows}
      tribunalPaths={tribunalPaths}
      departments={departments}
      department={department}
      onDepartmentChange={change}
    />
  );
}
