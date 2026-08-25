"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchTribunalJudicialActivityDirectory } from "@/lib/tribunal-judicial-activity-directory-client";
import type {
  TribunalJudicialActivityHistoryMonths,
  TribunalJudicialActivityRangeMetric,
  TribunalJudicialActivityResponse,
} from "@/lib/tribunal-judicial-activity";

const WINDOWS: TribunalJudicialActivityHistoryMonths[] = [12, 24, 36];

export function TribunalJudicialActivityExplorer() {
  const [historyMonths, setHistoryMonths] = useState<TribunalJudicialActivityHistoryMonths>(36);
  const [search, setSearch] = useState("");
  const [selectedRegion, setSelectedRegion] = useState("");
  const [selectedCourtCode, setSelectedCourtCode] = useState("");
  const [selectedPropertyType, setSelectedPropertyType] = useState("");
  const query = useQuery({
    queryKey: ["tribunal-judicial-activity-directory", historyMonths],
    queryFn: () => fetchTribunalJudicialActivityDirectory(historyMonths),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const normalizedSearch = normalizeSearch(search);
  const filteredTribunals = useMemo(
    () =>
      (query.data?.tribunals ?? []).filter(
        (tribunal) =>
          (!selectedRegion || tribunal.court.judicialRegion === selectedRegion) &&
          normalizeSearch(
            `${tribunal.court.name} ${tribunal.court.code} ${tribunal.court.judicialRegion ?? ""}`,
          ).includes(normalizedSearch),
      ),
    [normalizedSearch, query.data?.tribunals, selectedRegion],
  );
  const selected =
    filteredTribunals.find((tribunal) => tribunal.court.code === selectedCourtCode) ??
    filteredTribunals[0] ??
    null;
  const selectedType = selected?.activity.propertyTypeBenchmarks.find(
    (benchmark) => benchmark.propertyType === selectedPropertyType,
  );

  return (
    <main className="min-h-screen bg-[#eef7ff] text-brand-navy">
      <header className="border-b border-brand-navy/10 bg-white/80">
        <div className="mx-auto max-w-[1260px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
            <Landmark className="h-4 w-4" aria-hidden />
            Observatoire des ventes judiciaires
          </p>
          <h1 className="mt-3 max-w-5xl font-display text-4xl font-medium leading-tight sm:text-5xl lg:text-6xl">
            La France d’abord, puis chaque tribunal
          </h1>
          <p className="mt-4 max-w-4xl text-sm leading-relaxed text-brand-navy/68 sm:text-base">
            Commencez par les repères nationaux, mesurez la couverture par ressort, puis ouvrez le
            détail d’un tribunal. Les fourchettes représentent les 50 % d’annonces centrales : elles
            ne sont ni une estimation du bien, ni un plafond d’enchère.
          </p>

          {query.data ? (
            <dl className="mt-8 grid max-w-5xl border-y border-brand-navy/12 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryValue label="Tribunaux suivis" value={query.data.totals.trackedCourts} />
              <SummaryValue
                label="Ventes historiques observées"
                value={query.data.totals.observedPastSales}
              />
              <SummaryValue label="Ventes à venir" value={query.data.totals.upcomingSales} />
              <SummaryValue
                label="Dans les 90 jours"
                value={query.data.totals.upcomingSales90Days}
              />
            </dl>
          ) : null}
        </div>
      </header>

      <div className="mx-auto max-w-[1260px] px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        {query.data ? <NationalOverview data={query.data} /> : null}
        {query.data?.regions.length ? (
          <RegionalCoverage
            data={query.data}
            selectedRegion={selectedRegion}
            onRegionChange={(region) => {
              setSelectedRegion(region);
              setSelectedCourtCode("");
              setSelectedPropertyType("");
            }}
          />
        ) : null}

        <section aria-label="Choisir un tribunal" className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <label>
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-navy/60">
              Rechercher un tribunal
            </span>
            <span className="relative mt-2 block">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-navy/45"
                aria-hidden
              />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Marseille, Paris, Lyon…"
                className="h-11 border-brand-navy/15 bg-white pl-10"
              />
            </span>
          </label>
          <fieldset>
            <legend className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-navy/60">
              Historique observé
            </legend>
            <div className="mt-2 inline-flex rounded-md border border-brand-navy/15 bg-white p-1">
              {WINDOWS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={historyMonths === value}
                  onClick={() => setHistoryMonths(value)}
                  className={`min-h-9 rounded px-3 text-sm font-semibold ${
                    historyMonths === value
                      ? "bg-brand-navy text-white"
                      : "text-brand-navy/65 hover:bg-brand-navy/5"
                  }`}
                >
                  {value} mois
                </button>
              ))}
            </div>
          </fieldset>
        </section>

        {query.isLoading ? <ExplorerSkeleton /> : null}
        {query.isError ? <ExplorerError onRetry={() => void query.refetch()} /> : null}
        {!query.isLoading && !query.isError && !filteredTribunals.length ? (
          <p className="mt-8 border-y border-brand-navy/12 bg-white px-4 py-8 text-sm">
            Aucun tribunal suivi ne correspond aux filtres sélectionnés
            {search ? ` pour « ${search} »` : ""}.
          </p>
        ) : null}

        {selected ? (
          <TribunalProfile
            tribunal={selected}
            tribunals={filteredTribunals}
            selectedPropertyType={selectedType?.propertyType ?? ""}
            onCourtChange={(courtCode) => {
              setSelectedCourtCode(courtCode);
              setSelectedPropertyType("");
            }}
            onPropertyTypeChange={setSelectedPropertyType}
          />
        ) : null}
      </div>
    </main>
  );
}

function NationalOverview({ data }: { data: TribunalJudicialActivityDirectoryData }) {
  const national = data.national;
  return (
    <section aria-labelledby="national-overview-title" className="mb-10">
      <div className="flex flex-col gap-3 border-b border-brand-navy/14 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-soft">
            Niveau 1 · France entière
          </p>
          <h2
            id="national-overview-title"
            className="mt-2 font-display text-3xl font-semibold sm:text-4xl"
          >
            Repères nationaux
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-brand-navy/62">
            Toutes les annonces retenues sont judiciaires, vérifiées ou recoupées et rattachées à un
            tribunal actif du référentiel Justice.
          </p>
        </div>
        <p className="text-xs font-semibold text-brand-navy/58">
          Historique de {data.period.historyMonths} mois
        </p>
      </div>

      <div className="mt-6 grid overflow-hidden rounded-lg border border-brand-navy/12 bg-white md:grid-cols-2 xl:grid-cols-4">
        <ProfileMetric
          icon={BarChart3}
          label="Mise à prix médiane · France"
          value={formatCurrencyMedian(national.startingPriceRangeEur)}
          detail={formatCurrencyRange(national.startingPriceRangeEur)}
        />
        <ProfileMetric
          icon={Clock3}
          label="Anticipation médiane · France"
          value={formatDaysMedian(national.discoveryLeadRangeDays)}
          detail={formatDaysRange(national.discoveryLeadRangeDays)}
        />
        <ProfileMetric
          icon={CalendarDays}
          label="Ventes observées dans l’historique"
          value={formatNumber(national.observedPastSales)}
          detail={`${formatNumber(national.upcomingSales)} ventes à venir suivies`}
        />
        <ProfileMetric
          icon={ShieldCheck}
          label="Couverture des profils tribunal"
          value={formatPercent(national.coverage.rate)}
          detail={`${national.coverage.publishableCourtProfiles} sur ${national.coverage.trackedCourts} avec prix et délai publiables`}
        />
      </div>

      <p className="mt-4 text-xs leading-relaxed text-brand-navy/55">
        Ces agrégats décrivent le catalogue suivi par Immojudis. Les prix d’adjudication et taux
        d’issue relèvent d’un corpus de preuve séparé et restent masqués tant que ses seuils ne sont
        pas atteints.
      </p>
    </section>
  );
}

type TribunalJudicialActivityDirectoryData = Awaited<
  ReturnType<typeof fetchTribunalJudicialActivityDirectory>
>;

function RegionalCoverage({
  data,
  selectedRegion,
  onRegionChange,
}: {
  data: TribunalJudicialActivityDirectoryData;
  selectedRegion: string;
  onRegionChange: (region: string) => void;
}) {
  return (
    <section
      aria-labelledby="regional-coverage-title"
      className="mb-10 border-y border-brand-navy/14 py-7"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-soft">
            Niveau 2 · Ressorts judiciaires
          </p>
          <h2
            id="regional-coverage-title"
            className="mt-2 font-display text-2xl font-semibold sm:text-3xl"
          >
            Où les données sont-elles assez denses ?
          </h2>
        </div>
        {selectedRegion ? (
          <button
            type="button"
            onClick={() => onRegionChange("")}
            className="text-left text-sm font-semibold underline underline-offset-4"
          >
            Revenir à toute la France
          </button>
        ) : null}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="list">
        {data.regions.map((region) => (
          <div key={region.name} role="listitem">
            <button
              type="button"
              aria-pressed={selectedRegion === region.name}
              onClick={() => onRegionChange(selectedRegion === region.name ? "" : region.name)}
              className={`h-full w-full rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                selectedRegion === region.name
                  ? "border-brand-navy bg-brand-navy text-white"
                  : "border-brand-navy/12 bg-white hover:border-gold/50"
              }`}
            >
              <span className="font-display text-xl font-semibold">{region.name}</span>
              <span
                className={`mt-2 block text-xs ${
                  selectedRegion === region.name ? "text-white/70" : "text-brand-navy/58"
                }`}
              >
                {region.coverage.publishableCourtProfiles}/{region.coverage.trackedCourts} profils
                publiables · {region.upcomingSales} ventes à venir
              </span>
              <span
                className={`mt-3 block text-sm font-semibold ${
                  selectedRegion === region.name ? "text-white" : "text-gold-soft"
                }`}
              >
                Mise médiane {formatCurrencyMedian(region.startingPriceRangeEur)}
              </span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function TribunalProfile({
  tribunal,
  tribunals,
  selectedPropertyType,
  onCourtChange,
  onPropertyTypeChange,
}: {
  tribunal: TribunalJudicialActivityResponse;
  tribunals: TribunalJudicialActivityResponse[];
  selectedPropertyType: string;
  onCourtChange: (courtCode: string) => void;
  onPropertyTypeChange: (propertyType: string) => void;
}) {
  const selectedType = tribunal.activity.propertyTypeBenchmarks.find(
    (benchmark) => benchmark.propertyType === selectedPropertyType,
  );
  const priceRange = selectedType?.startingPriceRangeEur ?? tribunal.activity.startingPriceRangeEur;
  const leadRange =
    selectedType?.discoveryLeadRangeDays ?? tribunal.activity.discoveryLeadRangeDays;
  const scopeLabel = selectedType
    ? propertyTypeLabel(selectedType.propertyType)
    : "Tous types de biens";

  return (
    <article className="mt-8 border-t border-brand-navy/14 pt-7" aria-labelledby="court-title">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-soft">
            Profil statistique du tribunal
          </p>
          <h2 id="court-title" className="mt-2 font-display text-3xl font-semibold sm:text-5xl">
            {tribunal.court.name}
          </h2>
          <p className="mt-2 text-sm text-brand-navy/60">
            {tribunal.court.judicialRegion ?? "Ressort judiciaire non publié"}
          </p>
        </div>
        <label>
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-navy/60">
            Tribunal affiché
          </span>
          <select
            value={tribunal.court.code}
            onChange={(event) => onCourtChange(event.target.value)}
            className="mt-2 h-11 w-full rounded-md border border-brand-navy/15 bg-white px-3 text-sm font-semibold"
          >
            {tribunals.map((item) => (
              <option key={item.court.code} value={item.court.code}>
                {item.court.name} · {item.activity.upcomingSales} à venir
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-7 flex flex-col gap-4 rounded-lg border border-brand-navy/12 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Affiner les repères de mise et de délai</p>
          <p className="mt-1 text-xs text-brand-navy/55">
            Les petits groupes restent masqués sous cinq annonces.
          </p>
        </div>
        <label className="sm:w-72">
          <span className="sr-only">Type de bien</span>
          <select
            value={selectedPropertyType}
            onChange={(event) => onPropertyTypeChange(event.target.value)}
            className="h-11 w-full rounded-md border border-brand-navy/15 bg-[#f8fbfe] px-3 text-sm font-semibold"
          >
            <option value="">Tous types de biens</option>
            {tribunal.activity.propertyTypeBenchmarks.map((benchmark) => (
              <option key={benchmark.propertyType} value={benchmark.propertyType}>
                {propertyTypeLabel(benchmark.propertyType)} · {benchmark.observedSales}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-6 grid overflow-hidden rounded-lg border border-brand-navy/12 bg-white md:grid-cols-2 xl:grid-cols-4">
        <ProfileMetric
          icon={BarChart3}
          label={`Mise à prix médiane · ${scopeLabel}`}
          value={formatCurrencyMedian(priceRange)}
          detail={formatCurrencyRange(priceRange)}
        />
        <ProfileMetric
          icon={Clock3}
          label={`Anticipation médiane · ${scopeLabel}`}
          value={formatDaysMedian(leadRange)}
          detail={formatDaysRange(leadRange)}
        />
        <ProfileMetric
          icon={CalendarDays}
          label="Audience suivante suivie"
          value={formatDate(tribunal.activity.nextSaleAt)}
          detail={`${tribunal.activity.upcomingHearingDays} jours d’audience · ${tribunal.activity.upcomingSales} ventes`}
        />
        <ProfileMetric
          icon={Landmark}
          label="Rythme des audiences suivies"
          value={formatCadence(tribunal.activity.medianDaysBetweenHearingDays)}
          detail={`${formatMetricNumber(tribunal.activity.medianLotsPerHearingDay)} lots médians par jour`}
        />
      </div>

      <div className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
        <section className="border-y border-brand-navy/12 py-6" aria-labelledby="interpret-title">
          <h3 id="interpret-title" className="font-display text-2xl font-semibold">
            Comment lire ces chiffres ?
          </h3>
          <p className="mt-3 text-sm leading-relaxed text-brand-navy/66">
            La fourchette publiée va du 25e au 75e percentile : la moitié des annonces retenues se
            situe à l’intérieur. Une mise à prix basse ne signifie pas que le bien sera adjugé à ce
            montant. Les frais, l’état du bien et la concurrence restent déterminants.
          </p>
          <p className="mt-3 text-xs leading-relaxed text-brand-navy/54">
            Échantillons : {priceRange.sampleSize} mises à prix et {leadRange.sampleSize} délais ·
            annonces judiciaires vérifiées ou recoupées uniquement.
          </p>
        </section>

        <section
          className="border border-amber-200 bg-amber-50 p-5"
          aria-labelledby="outcome-title"
        >
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-amber-900">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Résultats d’adjudication
          </p>
          <h3
            id="outcome-title"
            className="mt-2 font-display text-2xl font-semibold text-amber-950"
          >
            Écart prix final / mise à prix non publié
          </h3>
          <p className="mt-3 text-sm leading-relaxed text-amber-950/75">
            Immojudis rapproche Judilibre, DVF et les résultats de vente, puis impose une revue
            humaine. Le tribunal n’affichera cette statistique qu’avec au moins dix résultats
            définitifs suffisamment documentés.
          </p>
        </section>
      </div>

      <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-brand-navy/55">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" aria-hidden />
        Indicateurs de couverture Immojudis, non exhaustifs du greffe et non prédictifs d’une vente
        individuelle. Données en attente, conflictuelles ou sans rattachement exact exclues.
      </p>
    </article>
  );
}

function ProfileMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Landmark;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border-b border-brand-navy/10 p-5 last:border-b-0 md:[&:nth-last-child(-n+2)]:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0">
      <Icon className="h-5 w-5 text-gold-soft" aria-hidden />
      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.1em] text-brand-navy/55">
        {label}
      </p>
      <p className="mt-2 font-display text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-2 text-xs leading-relaxed text-brand-navy/55">{detail}</p>
    </div>
  );
}

function SummaryValue({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-b border-brand-navy/10 py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:px-5 sm:first:pl-0 sm:last:border-r-0">
      <dt className="text-xs text-brand-navy/55">{label}</dt>
      <dd className="mt-1 font-display text-3xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function ExplorerSkeleton() {
  return (
    <div className="mt-8 space-y-5" aria-label="Chargement des statistiques par tribunal">
      <Skeleton className="h-14 w-full bg-brand-navy/8" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-40 bg-brand-navy/8" />
        ))}
      </div>
    </div>
  );
}

function ExplorerError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="mt-8 border border-red-200 bg-red-50 p-5 text-red-950">
      <p className="font-semibold">Statistiques temporairement indisponibles</p>
      <p className="mt-2 text-sm">Aucune valeur de remplacement n’est générée.</p>
      <button type="button" onClick={onRetry} className="mt-4 text-sm font-semibold underline">
        Réessayer
      </button>
    </div>
  );
}

function formatCurrencyMedian(metric: TribunalJudicialActivityRangeMetric): string {
  return metric.status === "published" ? formatCurrency(metric.p50) : "Non publié";
}

function formatCurrencyRange(metric: TribunalJudicialActivityRangeMetric): string {
  return metric.status === "published"
    ? `Fourchette centrale ${formatCurrency(metric.p25)} – ${formatCurrency(metric.p75)}`
    : `${metric.sampleSize} annonces · minimum requis : 5`;
}

function formatDaysMedian(metric: TribunalJudicialActivityRangeMetric): string {
  return metric.status === "published" ? `${formatNumber(metric.p50)} jours` : "Non publié";
}

function formatDaysRange(metric: TribunalJudicialActivityRangeMetric): string {
  return metric.status === "published"
    ? `Fourchette centrale ${formatNumber(metric.p25)} – ${formatNumber(metric.p75)} jours`
    : `${metric.sampleSize} délais · minimum requis : 5`;
}

function formatCadence(
  metric: TribunalJudicialActivityResponse["activity"]["medianDaysBetweenHearingDays"],
): string {
  return metric.status === "published"
    ? `Tous les ${formatNumber(metric.value)} jours`
    : "Non publié";
}

function formatMetricNumber(
  metric: TribunalJudicialActivityResponse["activity"]["medianLotsPerHearingDay"],
): string {
  return metric.status === "published" ? formatNumber(metric.value) : "Non publié";
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "Aucune date";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  }).format(new Date(value));
}

function propertyTypeLabel(value: string): string {
  return (
    {
      apartment: "Appartement",
      house: "Maison",
      commercial: "Local commercial",
      building: "Immeuble",
      land: "Terrain",
      parking: "Stationnement",
      mixed: "Bien mixte",
      other: "Autre",
    }[value] ?? value
  );
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("fr-FR");
}
