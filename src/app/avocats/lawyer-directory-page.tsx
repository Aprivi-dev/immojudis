"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Info from "lucide-react/dist/esm/icons/info.js";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import Languages from "lucide-react/dist/esm/icons/languages.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Megaphone from "lucide-react/dist/esm/icons/megaphone.js";
import Phone from "lucide-react/dist/esm/icons/phone.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { LawyerReferralButton } from "@/components/LawyerReferralButton";
import { useAuth } from "@/hooks/use-auth";
import { fetchLawyerDirectory, fetchLawyerProsecutedSales } from "@/lib/client-api";
import { fetchAccessPlan } from "@/lib/client-billing";
import { sponsoredPlacementLabel } from "@/lib/lawyer-placement-label";
import type { LawyerDirectoryOfficialSource, LawyerDirectoryProfile } from "@/lib/lawyer-directory";
import { validateDirectorySearch, type DirectorySearch } from "@/lib/lawyer-directory-search";
import type { LawyerUpcomingSales } from "@/lib/lawyer-prosecuted-sales";
import { hasStandingAnalysisAccess } from "@/lib/plans";
import { formatStartingPrice } from "@/lib/format/numbers";
import { propertyTypeLabel } from "@/lib/format/property-labels";
import { saleDetailPath, searchParamsToRecord } from "@/lib/navigation";
import Link from "next/link";
import { userMessage } from "@/lib/user-messages";
import { queryKeys } from "@/lib/query-keys";

/** At most three areas of practice are shown per lawyer (RIN, art. 10.2). */
const MAX_PRACTICE_TAGS = 3;

const FRENCH_DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Paris",
});

const NO_SEARCH: DirectorySearch = {};

/**
 * The page is prerendered once for every visitor (static, cached by the CDN): the heading, the
 * explanation of the ranking and the search form are in the HTML itself. The filters of the URL
 * (`?bar=…&saleId=…`) are read in the browser under a Suspense boundary, as on `/sales`; until
 * they are known, the HTML shows the page as it is without any filter, and the directory request
 * only starts once the filters are.
 */
export function LawyerDirectoryPage() {
  return (
    <Suspense fallback={<DirectoryLayout search={NO_SEARCH} results={<DirectorySkeleton />} />}>
      <LawyerDirectoryFromUrl />
    </Suspense>
  );
}

function LawyerDirectoryFromUrl() {
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const search = useMemo(
    () => validateDirectorySearch(searchParamsToRecord(new URLSearchParams(queryString))),
    [queryString],
  );
  return <LawyerDirectoryWithResults search={search} />;
}

function LawyerDirectoryWithResults({ search }: { search: DirectorySearch }) {
  const directoryQuery = useQuery({
    queryKey: queryKeys.lawyerDirectory(search.saleId, search.bar, search.city, search.department),
    queryFn: () => fetchLawyerDirectory(search),
    staleTime: 5 * 60_000,
  });
  const errorMessage = userMessage(directoryQuery.error, "Annuaire indisponible");

  return (
    <DirectoryLayout
      search={search}
      results={
        directoryQuery.isLoading ? (
          <DirectorySkeleton />
        ) : directoryQuery.isError ? (
          <DirectoryError message={errorMessage} />
        ) : (
          <DirectoryResults
            lawyers={directoryQuery.data?.lawyers ?? []}
            barAssociation={
              directoryQuery.data?.barAssociation ?? search.bar ?? search.city ?? null
            }
            sectorLabel={
              directoryQuery.data?.sectorLabel ??
              search.bar ??
              search.city ??
              search.department ??
              null
            }
            saleId={search.saleId}
            isDemo={directoryQuery.data?.isDemo ?? false}
            officialSource={directoryQuery.data?.officialSource ?? null}
          />
        )
      }
    />
  );
}

function DirectoryLayout({
  search,
  results,
}: {
  search: DirectorySearch;
  results: React.ReactNode;
}) {
  return (
    <main id="contenu" className="min-h-screen bg-background text-brand-navy">
      <section className="border-b border-brand-navy/10 bg-white">
        <div className="mx-auto max-w-[1260px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
          <Link
            href={search.saleId ? `/sales/${search.saleId}` : "/sales"}
            className="inline-flex items-center gap-2 text-sm font-semibold text-brand-navy/70 transition-colors hover:text-gold-text"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {search.saleId ? "Retour à l'annonce" : "Retour aux ventes"}
          </Link>

          <div className="mt-7 grid grid-cols-1 gap-7 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-end">
            <div className="min-w-0">
              <h1 className="max-w-4xl font-display text-5xl font-medium leading-[0.98] text-brand-navy sm:text-6xl">
                Avocats inscrits au barreau
              </h1>
              <p className="mt-5 max-w-3xl text-base leading-relaxed text-brand-navy/70 sm:text-lg">
                Consultez les avocats du barreau compétent. Les profils bénéficiant d'une mise en
                avant payante (ou en période d'essai de cette offre) sont signalés séparément.
              </p>
              <section aria-labelledby="lawyer-ranking-title" className="mt-5 max-w-3xl">
                <h2
                  id="lawyer-ranking-title"
                  className="text-sm font-semibold text-brand-navy sm:text-base"
                >
                  Comment sont classés les avocats ?
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-brand-navy/70">
                  La liste est d'abord limitée au barreau recherché (pour une annonce : celui du
                  tribunal qui juge la vente, hors avocat poursuivant). Les avocats bénéficiant
                  d'une mise en avant sont affichés en premier, dans une section à part, selon un
                  niveau de priorité attribué par Immojudis puis par ordre alphabétique. Les autres
                  suivent par ordre alphabétique : d'abord les avocats référencés par Immojudis,
                  puis ceux de l'annuaire officiel du CNB. Aucune note, aucun avis ni critère de
                  qualité n'entre dans ce classement.
                </p>
              </section>
            </div>

            <form
              action="/avocats"
              method="get"
              className="min-w-0 rounded-lg border border-brand-navy/12 bg-white p-4 shadow-sm"
            >
              {search.saleId ? <input type="hidden" name="saleId" value={search.saleId} /> : null}
              <label htmlFor="lawyer-bar" className="text-sm font-semibold text-brand-navy">
                Rechercher un barreau
              </label>
              <div className="mt-2 flex gap-2">
                <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-brand-navy/16 px-3 focus-within:border-gold-soft focus-within:outline-2 focus-within:outline-gold-soft">
                  <Search className="h-4 w-4 shrink-0 text-brand-navy/65" aria-hidden />
                  <input
                    id="lawyer-bar"
                    name="bar"
                    defaultValue={search.bar ?? search.city ?? ""}
                    placeholder="Bordeaux, Paris, Lyon…"
                    autoComplete="address-level2"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-brand-navy/65"
                  />
                </div>
                <button
                  type="submit"
                  className="min-h-11 rounded-md bg-brand-navy px-4 text-sm font-semibold text-white transition-colors hover:bg-gold-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
                >
                  Rechercher
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1260px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        {results}
      </section>
    </main>
  );
}

function DirectoryResults({
  lawyers,
  barAssociation,
  sectorLabel,
  saleId,
  isDemo,
  officialSource,
}: {
  lawyers: LawyerDirectoryProfile[];
  barAssociation: string | null;
  sectorLabel: string | null;
  saleId?: string;
  isDemo: boolean;
  officialSource: LawyerDirectoryOfficialSource | null;
}) {
  const prosecutedSales = useProsecutedSalesForPaidAccount(lawyers);

  if (!lawyers.length) {
    return (
      <div className="rounded-lg border border-brand-navy/12 bg-white p-7 text-center shadow-sm sm:p-10">
        <Scale className="mx-auto h-9 w-9 text-gold-text" aria-hidden />
        <h2 className="mt-4 font-display text-3xl font-semibold text-brand-navy">
          Aucun avocat trouvé pour ce barreau
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-brand-navy/65">
          Vérifiez le nom du barreau ou revenez au dossier. Si une annonce est sélectionnée,
          Immojudis peut aussi rechercher manuellement un avocat disponible sur ce secteur.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {saleId ? <LawyerReferralButton saleId={saleId} className="min-h-11" /> : null}
          <CnbDirectoryLink barAssociation={barAssociation} />
        </div>
      </div>
    );
  }

  const sponsoredLawyers = lawyers.filter((lawyer) => lawyer.isSponsored);
  const directoryLawyers = lawyers.filter((lawyer) => !lawyer.isSponsored);
  // One term everywhere: a placement still in its free trial is named as such, never as paid.
  const hasTrialPlacement = sponsoredLawyers.some((lawyer) => lawyer.placement === "trial");

  return (
    <>
      {isDemo ? (
        <div className="mb-6 flex gap-3 rounded-lg border border-blue-300 bg-blue-50 p-4 text-sm leading-relaxed text-blue-950">
          <Info className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <p>
            Aperçu de développement : ces fiches sont fictives et servent uniquement à tester la
            présentation de l'annuaire.
          </p>
        </div>
      ) : null}
      <div className="mb-7 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-3xl font-semibold text-brand-navy sm:text-4xl">
          {sectorLabel ? `Avocats — ${sectorLabel}` : "Annuaire des avocats"}
        </h2>
        <p className="text-sm font-medium text-brand-navy/65">
          {lawyers.length} profil{lawyers.length > 1 ? "s" : ""}
        </p>
      </div>

      {sponsoredLawyers.length ? (
        <section aria-labelledby="partner-lawyers-title">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.15em] text-gold-text">
                <Megaphone className="h-4 w-4" aria-hidden />
                {hasTrialPlacement ? "Mise en avant (essai ou payante)" : "Mise en avant payante"}
              </div>
              <h3
                id="partner-lawyers-title"
                className="mt-2 font-display text-3xl font-semibold text-brand-navy"
              >
                Avocats mis en avant
              </h3>
            </div>
            <p className="max-w-xl text-sm leading-relaxed text-brand-navy/65 sm:text-right">
              {hasTrialPlacement
                ? "Ces avocats bénéficient d'une visibilité renforcée sur ce barreau : mise en avant payante ou période d'essai de cette offre."
                : "Ces avocats rémunèrent Immojudis pour une visibilité renforcée sur ce barreau."}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {sponsoredLawyers.map((lawyer) => (
              <LawyerCard
                key={lawyer.id}
                lawyer={lawyer}
                saleId={saleId}
                upcomingSales={prosecutedSales[lawyer.id]}
                sponsored
              />
            ))}
          </div>
        </section>
      ) : null}

      <section
        aria-labelledby="directory-lawyers-title"
        className={sponsoredLawyers.length ? "mt-12" : undefined}
      >
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-brand-navy/12 pb-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-brand-navy/65">
              Résultats naturels
            </p>
            <h3
              id="directory-lawyers-title"
              className="mt-2 font-display text-3xl font-semibold text-brand-navy"
            >
              Avocats de l'annuaire
            </h3>
          </div>
          <p className="text-sm text-brand-navy/65">
            {directoryLawyers.length} fiche{directoryLawyers.length > 1 ? "s" : ""} standard
          </p>
        </div>

        {officialSource ? (
          <div className="mb-5 flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50/80 p-4 text-xs leading-relaxed text-blue-950 sm:flex-row sm:items-center sm:justify-between">
            <p>
              Source :{" "}
              <a
                href={officialSource.datasetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold underline decoration-blue-950/30 underline-offset-2"
              >
                {officialSource.label}
              </a>
              {" · "}
              <a
                href={officialSource.licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold underline decoration-blue-950/30 underline-offset-2"
              >
                {officialSource.licenseLabel}
              </a>
            </p>
            <p className="shrink-0 font-medium">
              Mise à jour le {formatFrenchDate(officialSource.updatedAt)}
            </p>
          </div>
        ) : null}

        {directoryLawyers.length ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {directoryLawyers.map((lawyer) => (
              <LawyerCard
                key={lawyer.id}
                lawyer={lawyer}
                saleId={saleId}
                upcomingSales={prosecutedSales[lawyer.id]}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-brand-navy/20 bg-white/60 p-6 text-sm leading-relaxed text-brand-navy/65">
            Aucune fiche standard n'est encore publiée pour ce barreau. Les profils mis en avant
            affichés ci-dessus restent identifiés comme tels.
          </div>
        )}
      </section>

      <div className="mt-10 flex flex-col gap-4 rounded-lg border border-brand-navy/12 bg-white p-5 text-sm leading-relaxed text-brand-navy/65 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-gold-text" aria-hidden />
          <p>
            Une mise en avant, payante ou en période d'essai, ne constitue ni une notation, ni une
            recommandation juridique, ni une garantie de résultat. Vérifiez directement auprès de
            l'avocat sa disponibilité et les conditions de son intervention.
          </p>
        </div>
        <CnbDirectoryLink barAssociation={barAssociation} />
      </div>
    </>
  );
}

/**
 * Ventes à venir des avocats de la page, chargées pour un compte PAYANT seulement (abonnement
 * Analyse, premium, administrateur : jamais l'offre de lancement). Pour un visiteur ou un compte
 * gratuit, aucune requête n'est envoyée et rien n'est affiché, pas même un teaser : le lien avocat
 * poursuivant ↔ vente ne leur est pas montré. Une erreur laisse les cartes sans cette liste.
 */
function useProsecutedSalesForPaidAccount(
  lawyers: LawyerDirectoryProfile[],
): Record<string, LawyerUpcomingSales> {
  const { user, loading } = useAuth();
  const userKey = user?.id ?? "anonymous";
  const planQuery = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(userKey),
    queryFn: fetchAccessPlan,
    enabled: Boolean(user) && !loading,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const paidAccount = Boolean(user) && hasStandingAnalysisAccess(planQuery.data?.plan);
  const lawyerIds = lawyers.filter((lawyer) => lawyer.source === "immojudis").map(({ id }) => id);
  const salesQuery = useQuery({
    queryKey: queryKeys.lawyerProsecutedSales(userKey, lawyerIds),
    queryFn: () => fetchLawyerProsecutedSales(lawyerIds),
    enabled: paidAccount && lawyerIds.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return paidAccount ? (salesQuery.data?.lawyers ?? {}) : {};
}

function LawyerCard({
  lawyer,
  saleId,
  upcomingSales,
  sponsored = false,
}: {
  lawyer: LawyerDirectoryProfile;
  saleId?: string;
  /** Réservé aux comptes payants : absent pour les autres. */
  upcomingSales?: LawyerUpcomingSales;
  sponsored?: boolean;
}) {
  return (
    <article
      className={`relative flex flex-col overflow-hidden rounded-lg bg-white [contain-intrinsic-size:auto_22rem] [content-visibility:auto] ${
        sponsored
          ? "border border-gold/45 p-5 shadow-[0_18px_45px_rgba(19,44,72,0.10)] sm:p-6"
          : "border border-brand-navy/12 p-5 shadow-sm"
      }`}
    >
      {sponsored ? <div className="absolute inset-x-0 top-0 h-1 bg-gold-soft" /> : null}
      <div className="flex items-start gap-4">
        <span
          className={`grid shrink-0 place-items-center rounded-md font-display font-semibold ${
            sponsored
              ? "h-14 w-14 bg-brand-navy text-lg text-white"
              : "h-11 w-11 bg-brand-navy/[0.07] text-sm text-brand-navy"
          }`}
          aria-hidden
        >
          {lawyerInitials(lawyer.displayName)}
        </span>
        <div className="min-w-0">
          {sponsored ? (
            <p className="mb-1 text-xs font-bold uppercase tracking-[0.1em] text-gold-text">
              {sponsoredPlacementLabel(lawyer.placement)}
            </p>
          ) : lawyer.source === "cnb" ? (
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-blue-700">
              Annuaire officiel CNB
            </p>
          ) : null}
          <h3 className="font-display text-2xl font-semibold leading-tight text-brand-navy">
            {lawyer.displayName}
          </h3>
          <p className="mt-1 text-sm text-brand-navy/65">
            {[lawyer.firmName, lawyer.barAssociation].filter(Boolean).join(" · ") ||
              "Avocat inscrit à l'annuaire"}
          </p>
        </div>
      </div>

      {sponsored && lawyer.profileSummary ? (
        <p className="mt-5 line-clamp-4 text-sm leading-relaxed text-brand-navy/70">
          {lawyer.profileSummary}
        </p>
      ) : null}

      {lawyer.practiceTags.length ? (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Domaines d'intervention">
          {lawyer.practiceTags.slice(0, MAX_PRACTICE_TAGS).map((tag) => (
            <li
              key={tag}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold text-brand-navy/70 ${
                sponsored
                  ? "border border-gold/25 bg-gold/[0.07]"
                  : "border border-brand-navy/10 bg-brand-navy/[0.04]"
              }`}
            >
              {practiceTagLabel(tag)}
            </li>
          ))}
        </ul>
      ) : null}

      <dl
        className={`${sponsored ? "mt-5" : "mt-4"} grid grid-cols-1 gap-3 border-y border-brand-navy/10 py-4 text-sm`}
      >
        <DirectoryFact icon={<MapPin className="h-4 w-4" />} label="Cabinet">
          {[lawyer.address, lawyer.city].filter(Boolean).join(", ") || "Adresse à confirmer"}
        </DirectoryFact>
        <DirectoryFact icon={<Building2 className="h-4 w-4" />} label="Intervention">
          {lawyer.coverageLabels.slice(0, 3).join(" · ") || lawyer.matchingLabel || "À distance"}
        </DirectoryFact>
        {lawyer.oathDate ? (
          <DirectoryFact icon={<CalendarDays className="h-4 w-4" />} label="Serment">
            {formatFrenchDate(lawyer.oathDate)}
          </DirectoryFact>
        ) : null}
        {lawyer.languages.length ? (
          <DirectoryFact icon={<Languages className="h-4 w-4" />} label="Langues">
            {lawyer.languages.slice(0, 4).join(" · ")}
          </DirectoryFact>
        ) : null}
        {sponsored ? (
          <DirectoryFact icon={<ShieldCheck className="h-4 w-4" />} label="Enchères">
            Accepte les ventes judiciaires
            {lawyer.acceptsRemoteContact ? " et le contact à distance" : ""}
          </DirectoryFact>
        ) : null}
      </dl>

      {upcomingSales?.sales.length ? (
        <ProsecutedSales lawyerId={lawyer.id} upcoming={upcomingSales} />
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2 pt-5">
        {sponsored && saleId ? (
          <LawyerReferralButton
            saleId={saleId}
            requestedLawyerId={lawyer.id}
            label="Demander une mise en relation"
            className="min-h-11"
          />
        ) : null}
        {lawyer.phone ? (
          <a
            href={`tel:${lawyer.phone}`}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-brand-navy/16 px-3 text-sm font-semibold text-brand-navy transition-colors hover:border-gold"
          >
            <Phone className="h-4 w-4" aria-hidden />
            Appeler
          </a>
        ) : null}
        {lawyer.email ? (
          <a
            href={`mailto:${lawyer.email}`}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-brand-navy/16 px-3 text-sm font-semibold text-brand-navy transition-colors hover:border-gold"
          >
            <Mail className="h-4 w-4" aria-hidden />
            Écrire
          </a>
        ) : null}
        {lawyer.websiteUrl ? (
          <a
            href={lawyer.websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-brand-navy/16 px-3 text-sm font-semibold text-brand-navy transition-colors hover:border-gold"
          >
            Site
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        ) : null}
        {lawyer.source === "cnb" ? (
          <a
            href={cnbDirectoryHref(lawyer.barAssociation)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-brand-navy/16 px-3 text-sm font-semibold text-brand-navy transition-colors hover:border-gold"
          >
            Vérifier sur le CNB
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Ventes à venir où le nom de l'avocat figure comme avocat poursuivant, pour un compte payant
 * seulement. Uniquement des faits déjà publics de la vente (type, ville, date, tribunal, mise à prix) et un lien vers sa fiche. Le
 * rapprochement est automatique (nom et barreau) : la mention le dit, sans jamais en faire une
 * recommandation.
 */
function ProsecutedSales({
  lawyerId,
  upcoming,
}: {
  lawyerId: string;
  upcoming: LawyerUpcomingSales;
}) {
  const headingId = `prosecuted-sales-${lawyerId}`;
  const hidden = upcoming.total - upcoming.sales.length;

  return (
    <section aria-labelledby={headingId} className="mt-4">
      <h4
        id={headingId}
        className="text-xs font-bold uppercase tracking-[0.12em] text-brand-navy/70"
      >
        Ventes à venir en tant qu'avocat poursuivant
      </h4>
      <ul className="mt-2 grid gap-2">
        {upcoming.sales.map((sale) => {
          const details = [
            sale.saleDate ? formatFrenchDate(sale.saleDate) : null,
            sale.tribunalName,
            sale.startingPriceEur && sale.startingPriceEur > 0
              ? `Mise à prix ${formatStartingPrice(sale.startingPriceEur)}`
              : null,
          ].filter(Boolean);
          return (
            <li key={sale.id}>
              <Link
                href={saleDetailPath(sale.id)}
                className="block min-h-11 rounded-md border border-brand-navy/12 px-3 py-2 text-sm transition-colors hover:border-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
              >
                <span className="block font-semibold text-brand-navy">
                  {propertyTypeLabel(sale.propertyType)}
                  {sale.city ? ` à ${sale.city}` : ""}
                </span>
                {details.length ? (
                  <span className="block break-words text-xs text-brand-navy/65">
                    {details.join(" · ")}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <p className="mt-2 text-xs text-brand-navy/65">
          {hidden} autre{hidden > 1 ? "s" : ""} vente{hidden > 1 ? "s" : ""} à venir non affichée
          {hidden > 1 ? "s" : ""}.
        </p>
      ) : null}
      <p className="mt-2 text-xs leading-relaxed text-brand-navy/60">
        Rapprochement automatique d'après le nom indiqué dans les annonces et le barreau du tribunal
        : vérifiez-le sur l'annonce. Cette liste n'est pas une recommandation.
      </p>
    </section>
  );
}

function CnbDirectoryLink({ barAssociation }: { barAssociation: string | null }) {
  const href = cnbDirectoryHref(barAssociation);

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md border border-brand-navy/16 px-4 text-sm font-semibold text-brand-navy transition-colors hover:border-gold hover:text-gold-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
    >
      Résultats officiels du CNB
      <ExternalLink className="h-4 w-4" aria-hidden />
    </a>
  );
}

function DirectoryFact({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1.25rem_5.5rem_minmax(0,1fr)] gap-2">
      <span className="text-gold-text" aria-hidden>
        {icon}
      </span>
      <dt className="font-semibold text-brand-navy">{label}</dt>
      <dd className="text-brand-navy/65">{children}</dd>
    </div>
  );
}

function DirectoryError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-white p-6 text-sm text-red-800 shadow-sm">
      <strong>Impossible de charger l'annuaire.</strong>
      <p className="mt-2">{message}</p>
    </div>
  );
}

function DirectorySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Chargement de l'annuaire">
      {[0, 1].map((item) => (
        <div
          key={item}
          className="h-80 animate-pulse rounded-lg border border-brand-navy/10 bg-white/70"
        />
      ))}
    </div>
  );
}

function lawyerInitials(displayName: string) {
  const parts = displayName
    .replace(/^(?:me|ma[iî]tre)\s+/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("fr") ?? "")
    .join("");
}

function practiceTagLabel(tag: string) {
  return tag.replace(/[-_]+/g, " ").replace(/^./, (character) => character.toLocaleUpperCase("fr"));
}

function cnbDirectoryHref(barAssociation: string | null) {
  return barAssociation
    ? `/api/lawyers/cnb-redirect?${new URLSearchParams({ bar: barAssociation }).toString()}`
    : "https://cnb.avocat.fr/annuaire-des-avocats-de-france";
}

function formatFrenchDate(value: string) {
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(date.getTime())) return value;
  return FRENCH_DATE_FORMATTER.format(date);
}
