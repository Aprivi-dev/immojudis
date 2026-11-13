"use client";

import { Suspense, useMemo, useState } from "react";
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
import { buttonClasses, Card, Notice, PageTitle } from "@/components/ui/primitives";
import { useAccessPlan } from "@/hooks/use-access-plan";
import { useAuth } from "@/hooks/use-auth";
import { fetchLawyerDirectory, fetchLawyerProsecutedSales } from "@/lib/client-api";
import {
  LAWYER_CONTACT_HREF,
  SPONSORED_LABEL,
  sponsoredPlacementLabel,
} from "@/lib/lawyer-placement-label";
import type {
  LawyerDirectoryOfficialSource,
  LawyerDirectoryPagination,
  LawyerDirectoryProfile,
} from "@/lib/lawyer-directory";
import {
  hasDirectoryCriteria,
  validateDirectorySearch,
  type DirectorySearch,
} from "@/lib/lawyer-directory-search";
import type { LawyerUpcomingSales } from "@/lib/lawyer-prosecuted-sales";
import { lawyerReportPath } from "@/lib/contact-message";
import { isUuid } from "@/lib/uuid";
import { hasStandingAnalysisAccess } from "@/lib/plans";
import { formatDate } from "@/lib/format/dates";
import { formatStartingPrice } from "@/lib/format/numbers";
import { propertyTypeLabel } from "@/lib/format/property-labels";
import { saleDetailPath, searchParamsToRecord } from "@/lib/navigation";
import Link from "next/link";
import { userMessage } from "@/lib/user-messages";
import * as queryKeys from "@/lib/query-keys";

/** At most three areas of practice are shown per lawyer (RIN, art. 10.2). */
const MAX_PRACTICE_TAGS = 3;

const NO_SEARCH: DirectorySearch = {};

/** Dépôt d'une vente par un professionnel (avocat, notaire…), vérifiée avant sa mise en ligne. */
const LAWYER_PUBLISH_HREF = "/publish";

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
  const searching = hasDirectoryCriteria(search);
  const directoryQuery = useQuery({
    queryKey: queryKeys.lawyerDirectory(search.saleId, search.bar, search.city, search.department),
    queryFn: () => fetchLawyerDirectory(search),
    enabled: searching,
    staleTime: 5 * 60_000,
  });
  const more = useNextDirectoryPages(search, directoryQuery.data?.pagination);
  const errorMessage = userMessage(directoryQuery.error, "Annuaire indisponible");
  const data = directoryQuery.data;
  // Le barreau effectivement cherché (pour une annonce : celui du tribunal) remplit le champ.
  const searchedBar =
    (search.saleId ? data?.barAssociation : null) ?? search.bar ?? search.city ?? null;

  return (
    <DirectoryLayout
      search={search}
      barValue={searchedBar ?? data?.barAssociation ?? ""}
      results={
        !searching ? (
          <DirectoryInvitation />
        ) : directoryQuery.isLoading ? (
          <DirectorySkeleton />
        ) : directoryQuery.isError ? (
          <DirectoryError message={errorMessage} />
        ) : (
          <DirectoryResults
            lawyers={[...(data?.lawyers ?? []), ...more.lawyers]}
            total={more.pagination?.total ?? data?.pagination?.total ?? null}
            barAssociation={data?.barAssociation ?? search.bar ?? search.city ?? null}
            sectorLabel={
              data?.sectorLabel ?? search.bar ?? search.city ?? search.department ?? null
            }
            saleId={search.saleId}
            isDemo={data?.isDemo ?? false}
            officialSource={data?.officialSource ?? null}
            more={
              (more.pagination ?? data?.pagination)?.hasMore || more.error ? (
                <LoadMoreLawyers
                  loading={more.loading}
                  error={more.error}
                  onLoad={() => void more.load()}
                />
              ) : null
            }
          />
        )
      }
    />
  );
}

/**
 * Pages suivantes de l'annuaire (50 profils par appel), ajoutées sous la première au clic sur
 * « Voir les avocats suivants ». Elles sont oubliées dès que les filtres de l'adresse changent.
 */
function useNextDirectoryPages(
  search: DirectorySearch,
  firstPage: LawyerDirectoryPagination | undefined,
) {
  const searchKey = JSON.stringify(search);
  const [state, setState] = useState<{
    key: string;
    lawyers: LawyerDirectoryProfile[];
    pagination?: LawyerDirectoryPagination;
    loading: boolean;
    error: string | null;
  }>({ key: searchKey, lawyers: [], loading: false, error: null });
  const current =
    state.key === searchKey
      ? state
      : { key: searchKey, lawyers: [], pagination: undefined, loading: false, error: null };

  async function load() {
    const pagination = current.pagination ?? firstPage;
    if (!pagination?.hasMore || current.loading) return;
    setState({ ...current, loading: true, error: null });
    try {
      const next = await fetchLawyerDirectory({ ...search, page: pagination.page + 1 });
      setState({
        key: searchKey,
        lawyers: [...current.lawyers, ...next.lawyers],
        pagination: next.pagination,
        loading: false,
        error: null,
      });
    } catch (error) {
      setState({
        ...current,
        loading: false,
        error: userMessage(error, "Impossible de charger les avocats suivants."),
      });
    }
  }

  return { ...current, load };
}

function LoadMoreLawyers({
  loading,
  error,
  onLoad,
}: {
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}) {
  return (
    <div className="mt-6 flex flex-col items-center gap-3">
      {error ? (
        <Notice tone="danger" role="alert" className="w-full max-w-xl text-center">
          {error}
        </Notice>
      ) : null}
      <button
        type="button"
        onClick={onLoad}
        disabled={loading}
        className={buttonClasses({ variant: "secondary", className: "w-full sm:w-auto" })}
      >
        {loading ? "Chargement…" : "Voir les avocats suivants"}
      </button>
    </div>
  );
}

function DirectoryLayout({
  search,
  barValue = search.bar ?? search.city ?? "",
  results,
}: {
  search: DirectorySearch;
  /** Valeur du champ « Rechercher un barreau » : le barreau cherché, une fois connu. */
  barValue?: string;
  results: React.ReactNode;
}) {
  return (
    <main id="contenu" className="min-h-screen bg-background text-brand-navy">
      <section className="border-b border-line bg-white">
        <div className="mx-auto max-w-[1260px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <Link
            href={search.saleId ? `/sales/${search.saleId}` : "/sales"}
            className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-ink-soft transition-colors hover:text-gold-text"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {search.saleId ? "Retour à l'annonce" : "Retour aux ventes"}
          </Link>

          {/* Titre et formulaire alignés en haut (plus de vide au-dessus du titre) ; sur mobile, le
              formulaire précède directement les résultats. */}
          <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-start lg:gap-10">
            <div className="min-w-0">
              <PageTitle className="max-w-4xl text-brand-navy">
                Avocats inscrits au barreau
              </PageTitle>
              <p className="mt-4 max-w-3xl text-base leading-relaxed text-ink-soft sm:text-lg">
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
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">
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

            <Card as="form" action="/avocats" method="get" className="min-w-0">
              {search.saleId ? <input type="hidden" name="saleId" value={search.saleId} /> : null}
              <label htmlFor="lawyer-bar" className="text-sm font-semibold text-brand-navy">
                Rechercher un barreau
              </label>
              <div className="mt-2 flex gap-2">
                <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-brand-navy/55 px-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-gold-soft">
                  <Search className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
                  <input
                    // Remonté quand le barreau cherché est connu : la valeur par défaut le reprend.
                    key={barValue}
                    id="lawyer-bar"
                    name="bar"
                    defaultValue={barValue}
                    placeholder="Bordeaux, Paris, Lyon…"
                    autoComplete="address-level2"
                    className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-ink-soft sm:text-sm"
                  />
                </div>
                <button type="submit" className={buttonClasses({ variant: "primary" })}>
                  Rechercher
                </button>
              </div>
            </Card>
          </div>
        </div>
      </section>

      <section
        aria-label="Résultats de l'annuaire"
        className="mx-auto max-w-[1260px] px-4 py-8 sm:px-6 lg:px-8 lg:py-12"
      >
        {results}
      </section>

      <div className="mx-auto grid max-w-[1260px] grid-cols-1 gap-4 px-4 pb-12 sm:px-6 lg:grid-cols-2 lg:px-8">
        <Card
          as="aside"
          aria-labelledby="lawyer-entry-title"
          className="min-w-0 border-gold/45 bg-surface"
        >
          <h2 id="lawyer-entry-title" className="text-base font-semibold text-brand-navy">
            Vous êtes avocat ?
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            Présentez votre cabinet aux acquéreurs de votre barreau. Les mises en avant sont
            signalées « {SPONSORED_LABEL} ». Vous pouvez aussi déposer une vente à publier : elle
            est vérifiée par l'équipe Immojudis avant sa mise en ligne.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Link
              href={LAWYER_CONTACT_HREF}
              className={buttonClasses({ variant: "secondary", className: "w-full sm:w-auto" })}
            >
              Présenter mon cabinet
            </Link>
            <Link
              href={LAWYER_PUBLISH_HREF}
              className={buttonClasses({ variant: "secondary", className: "w-full sm:w-auto" })}
            >
              Publier une vente
            </Link>
          </div>
        </Card>
        <Card as="aside" aria-labelledby="lawyer-prosecuting-title" className="min-w-0">
          <h2 id="lawyer-prosecuting-title" className="text-base font-semibold text-brand-navy">
            Vous poursuivez une vente ?
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            {isUuid(search.saleId)
              ? "Pour nous signaler une erreur sur la fiche de cette vente, si vous la poursuivez, écrivez-nous"
              : "Pour nous signaler une erreur sur la fiche d’une vente que vous poursuivez, écrivez-nous"}{" "}
            depuis le formulaire de contact, avec le sujet « Je suis l’avocat poursuivant d’une
            vente ». Précisez ce qui est inexact ou manquant. Nous examinons chaque signalement ; la
            qualité indiquée n’est pas vérifiée automatiquement. Immojudis n’est pas partie à la
            procédure et ne donne pas de conseil juridique.
          </p>
          <Link
            href={lawyerReportPath(search.saleId)}
            className={buttonClasses({ variant: "secondary", className: "mt-3 w-full sm:w-auto" })}
          >
            Signaler une erreur sur une fiche
          </Link>
        </Card>
      </div>
    </main>
  );
}

/** Sans filtre dans l'adresse : une invitation à choisir un barreau, pas tout l'annuaire. */
function DirectoryInvitation() {
  return (
    <Card className="p-6 text-center sm:p-10">
      <Scale className="mx-auto h-9 w-9 text-gold-text" aria-hidden />
      <h2 className="mt-4 font-display text-2xl font-semibold text-brand-navy sm:text-3xl">
        Choisissez un barreau
      </h2>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
        Saisissez un barreau ou la ville d'un tribunal judiciaire (Bordeaux, Paris, Lyon…) pour
        afficher les avocats qui y sont inscrits. Depuis la fiche d'une vente, l'annuaire s'ouvre
        directement sur le barreau du tribunal qui juge la vente.
      </p>
      <div className="mt-6 flex justify-center">
        <CnbDirectoryLink barAssociation={null} />
      </div>
    </Card>
  );
}

function DirectoryResults({
  lawyers,
  total,
  barAssociation,
  sectorLabel,
  saleId,
  isDemo,
  officialSource,
  more,
}: {
  lawyers: LawyerDirectoryProfile[];
  /** Nombre total de profils de la recherche (toutes pages), quand l'API le donne. */
  total: number | null;
  barAssociation: string | null;
  sectorLabel: string | null;
  saleId?: string;
  isDemo: boolean;
  officialSource: LawyerDirectoryOfficialSource | null;
  /** Bouton « Voir les avocats suivants », quand d'autres pages existent. */
  more?: React.ReactNode;
}) {
  const prosecutedSales = useProsecutedSalesForPaidAccount(lawyers);

  if (!lawyers.length) {
    return (
      <Card className="p-6 text-center sm:p-10">
        <Scale className="mx-auto h-9 w-9 text-gold-text" aria-hidden />
        <h2 className="mt-4 font-display text-2xl font-semibold text-brand-navy sm:text-3xl">
          {barAssociation
            ? `Aucun avocat trouvé pour le barreau de ${barAssociation}`
            : "Aucun avocat trouvé pour ce barreau"}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          Vérifiez le nom du barreau dans le champ de recherche ou revenez au dossier. Si une
          annonce est sélectionnée, Immojudis peut aussi rechercher manuellement un avocat
          disponible sur ce secteur.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {saleId ? <LawyerReferralButton saleId={saleId} className="min-h-11" /> : null}
          <CnbDirectoryLink barAssociation={barAssociation} />
        </div>
      </Card>
    );
  }

  const profileCount = total ?? lawyers.length;
  const sponsoredLawyers = lawyers.filter((lawyer) => lawyer.isSponsored);
  const directoryLawyers = lawyers.filter((lawyer) => !lawyer.isSponsored);
  // One term everywhere: a placement still in its free trial is named as such, never as paid.
  const hasTrialPlacement = sponsoredLawyers.some((lawyer) => lawyer.placement === "trial");

  return (
    <>
      {isDemo ? (
        <Notice tone="info" className="mb-6 flex gap-3">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden />
          <p>
            Aperçu de développement : ces fiches sont fictives et servent uniquement à tester la
            présentation de l'annuaire.
          </p>
        </Notice>
      ) : null}
      <div className="mb-7 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-3xl font-semibold text-brand-navy sm:text-4xl">
          {sectorLabel ? `Avocats — ${sectorLabel}` : "Annuaire des avocats"}
        </h2>
        <p role="status" className="text-sm font-medium text-ink-soft">
          {profileCount} profil{profileCount > 1 ? "s" : ""}
          {lawyers.length < profileCount ? ` · ${lawyers.length} affichés` : ""}
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
          <div className="mb-5 flex flex-col gap-2 rounded-lg border border-info/25 bg-info-tint p-4 text-xs leading-relaxed text-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>
              Source :{" "}
              <a
                href={officialSource.datasetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-info underline decoration-info/40 underline-offset-2"
              >
                {officialSource.label}
              </a>
              {" · "}
              <a
                href={officialSource.licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-info underline decoration-info/40 underline-offset-2"
              >
                {officialSource.licenseLabel}
              </a>
            </p>
            <p className="shrink-0 font-medium">
              Mise à jour le {formatDate(officialSource.updatedAt, officialSource.updatedAt)}
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
          <div className="rounded-lg border border-dashed border-line bg-white p-6 text-sm leading-relaxed text-ink-soft">
            Aucune fiche standard n'est encore publiée pour ce barreau. Les profils mis en avant
            affichés ci-dessus restent identifiés comme tels.
          </div>
        )}
        {more}
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
  const plan = useAccessPlan(loading ? null : user?.id);
  const paidAccount = Boolean(user) && hasStandingAnalysisAccess(plan);
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
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-info">
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
              className={`rounded-full px-2.5 py-1 text-xs font-semibold text-ink-soft ${
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
            {formatDate(lawyer.oathDate, lawyer.oathDate)}
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
            sale.saleDate ? formatDate(sale.saleDate, sale.saleDate) : null,
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
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">
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
    <Notice tone="danger" role="alert" className="p-6">
      <strong>Impossible de charger l'annuaire.</strong>
      <p className="mt-2">{message}</p>
    </Notice>
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
