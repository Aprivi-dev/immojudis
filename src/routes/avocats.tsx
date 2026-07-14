"use client";

import { useQuery } from "@tanstack/react-query";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Info from "lucide-react/dist/esm/icons/info.js";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Megaphone from "lucide-react/dist/esm/icons/megaphone.js";
import Phone from "lucide-react/dist/esm/icons/phone.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { LawyerReferralButton } from "@/components/LawyerReferralButton";
import { fetchLawyerDirectory } from "@/lib/client-api";
import type { LawyerDirectoryProfile } from "@/lib/lawyer-directory";
import { createFileRoute, Link } from "@/lib/router-compat";

type DirectorySearch = {
  saleId?: string;
  bar?: string;
  city?: string;
  department?: string;
};

export const Route = createFileRoute("/avocats")({
  validateSearch: (search: Record<string, unknown>): DirectorySearch => ({
    saleId: stringValue(search.saleId),
    bar: stringValue(search.bar),
    city: stringValue(search.city),
    department: stringValue(search.department),
  }),
  head: () => ({
    meta: [
      { title: "Annuaire des avocats en droit immobilier — Immojudis" },
      {
        name: "description",
        content:
          "Trouvez un avocat en droit immobilier par barreau et identifiez clairement les profils partenaires sponsorisés.",
      },
    ],
  }),
  component: LawyerDirectoryPage,
});

function LawyerDirectoryPage() {
  const search = Route.useSearch<DirectorySearch>();
  const directoryQuery = useQuery({
    queryKey: ["lawyer-directory", search.saleId, search.bar, search.city, search.department],
    queryFn: () => fetchLawyerDirectory(search),
    staleTime: 5 * 60_000,
  });
  const errorMessage =
    directoryQuery.error instanceof Error ? directoryQuery.error.message : "Annuaire indisponible";

  return (
    <main className="min-h-screen bg-[#eef7ff] text-brand-navy">
      <section className="border-b border-brand-navy/10 bg-white">
        <div className="mx-auto max-w-[1260px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
          <Link
            to={search.saleId ? `/sales/${search.saleId}` : "/sales"}
            className="inline-flex items-center gap-2 text-sm font-semibold text-brand-navy/70 transition-colors hover:text-gold-soft"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {search.saleId ? "Retour à l'annonce" : "Retour aux ventes"}
          </Link>

          <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-end">
            <div>
              <h1 className="max-w-4xl font-display text-5xl font-medium leading-[0.98] text-brand-navy sm:text-6xl">
                Avocats en droit immobilier
              </h1>
              <p className="mt-5 max-w-3xl text-base leading-relaxed text-brand-navy/70 sm:text-lg">
                Consultez les avocats du barreau compétent. Les profils partenaires sont signalés
                séparément et bénéficient d'une visibilité renforcée.
              </p>
            </div>

            <form
              action="/avocats"
              method="get"
              className="rounded-lg border border-brand-navy/12 bg-white p-4 shadow-sm"
            >
              {search.saleId ? <input type="hidden" name="saleId" value={search.saleId} /> : null}
              <label htmlFor="lawyer-bar" className="text-sm font-semibold text-brand-navy">
                Rechercher un barreau
              </label>
              <div className="mt-2 flex gap-2">
                <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-brand-navy/16 px-3 focus-within:border-gold-soft focus-within:ring-2 focus-within:ring-gold/15">
                  <Search className="h-4 w-4 shrink-0 text-brand-navy/45" aria-hidden />
                  <input
                    id="lawyer-bar"
                    name="bar"
                    defaultValue={search.bar ?? search.city ?? ""}
                    placeholder="Bordeaux, Paris, Lyon…"
                    autoComplete="address-level2"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-brand-navy/40"
                  />
                </div>
                <button
                  type="submit"
                  className="min-h-11 rounded-md bg-brand-navy px-4 text-sm font-semibold text-white transition-colors hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
                >
                  Rechercher
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1260px] px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        {directoryQuery.isLoading ? (
          <DirectorySkeleton />
        ) : directoryQuery.isError ? (
          <DirectoryError message={errorMessage} />
        ) : (
          <DirectoryResults
            lawyers={directoryQuery.data?.lawyers ?? []}
            sectorLabel={
              directoryQuery.data?.sectorLabel ??
              search.bar ??
              search.city ??
              search.department ??
              null
            }
            saleId={search.saleId}
            isDemo={directoryQuery.data?.isDemo ?? false}
          />
        )}
      </section>
    </main>
  );
}

function DirectoryResults({
  lawyers,
  sectorLabel,
  saleId,
  isDemo,
}: {
  lawyers: LawyerDirectoryProfile[];
  sectorLabel: string | null;
  saleId?: string;
  isDemo: boolean;
}) {
  if (!lawyers.length) {
    return (
      <div className="rounded-lg border border-brand-navy/12 bg-white p-7 text-center shadow-sm sm:p-10">
        <Scale className="mx-auto h-9 w-9 text-gold-soft" aria-hidden />
        <h2 className="mt-4 font-display text-3xl font-semibold text-brand-navy">
          Aucun avocat trouvé pour ce barreau
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-brand-navy/65">
          Vérifiez le nom du barreau ou revenez au dossier. Si une annonce est sélectionnée,
          Immojudis peut aussi rechercher manuellement un avocat disponible sur ce secteur.
        </p>
        {saleId ? <LawyerReferralButton saleId={saleId} className="mx-auto mt-6 min-h-11" /> : null}
      </div>
    );
  }

  const sponsoredLawyers = lawyers.filter((lawyer) => lawyer.isSponsored);
  const directoryLawyers = lawyers.filter((lawyer) => !lawyer.isSponsored);

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
        <p className="text-sm font-medium text-brand-navy/55">
          {lawyers.length} profil{lawyers.length > 1 ? "s" : ""}
        </p>
      </div>

      {sponsoredLawyers.length ? (
        <section aria-labelledby="partner-lawyers-title">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.15em] text-gold-soft">
                <Megaphone className="h-4 w-4" aria-hidden />
                Profils sponsorisés
              </div>
              <h3
                id="partner-lawyers-title"
                className="mt-2 font-display text-3xl font-semibold text-brand-navy"
              >
                Avocats partenaires
              </h3>
            </div>
            <p className="max-w-xl text-sm leading-relaxed text-brand-navy/60 sm:text-right">
              Ces avocats rémunèrent Immojudis pour une visibilité renforcée sur ce barreau.
            </p>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            {sponsoredLawyers.map((lawyer) => (
              <LawyerCard key={lawyer.id} lawyer={lawyer} saleId={saleId} sponsored />
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
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-brand-navy/50">
              Résultats naturels
            </p>
            <h3
              id="directory-lawyers-title"
              className="mt-2 font-display text-3xl font-semibold text-brand-navy"
            >
              Annuaire du barreau
            </h3>
          </div>
          <p className="text-sm text-brand-navy/55">
            {directoryLawyers.length} fiche{directoryLawyers.length > 1 ? "s" : ""} standard
          </p>
        </div>

        {directoryLawyers.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {directoryLawyers.map((lawyer) => (
              <LawyerCard key={lawyer.id} lawyer={lawyer} saleId={saleId} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-brand-navy/20 bg-white/60 p-6 text-sm leading-relaxed text-brand-navy/65">
            Aucune fiche standard n'est encore publiée pour ce barreau. Les profils partenaires
            affichés ci-dessus restent identifiés comme sponsorisés.
          </div>
        )}
      </section>

      <div className="mt-10 flex gap-3 rounded-lg border border-brand-navy/12 bg-white p-5 text-sm leading-relaxed text-brand-navy/65">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-gold-soft" aria-hidden />
        <p>
          La mise en avant payante ne constitue ni une notation, ni une recommandation juridique, ni
          une garantie de résultat. Vérifiez directement auprès de l'avocat son inscription, sa
          disponibilité et les conditions de son intervention.
        </p>
      </div>
    </>
  );
}

function LawyerCard({
  lawyer,
  saleId,
  sponsored = false,
}: {
  lawyer: LawyerDirectoryProfile;
  saleId?: string;
  sponsored?: boolean;
}) {
  return (
    <article
      className={`relative flex flex-col overflow-hidden rounded-lg bg-white ${
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
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-gold-soft">
              Profil sponsorisé
            </p>
          ) : null}
          <h3 className="font-display text-2xl font-semibold leading-tight text-brand-navy">
            {lawyer.displayName}
          </h3>
          <p className="mt-1 text-sm text-brand-navy/62">
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

      {sponsored && lawyer.practiceTags.length ? (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Domaines d'intervention">
          {lawyer.practiceTags.slice(0, 4).map((tag) => (
            <li
              key={tag}
              className="rounded-full border border-gold/25 bg-gold/[0.07] px-2.5 py-1 text-[11px] font-semibold text-brand-navy/70"
            >
              {practiceTagLabel(tag)}
            </li>
          ))}
        </ul>
      ) : null}

      <dl
        className={`${sponsored ? "mt-5" : "mt-4"} grid gap-3 border-y border-brand-navy/10 py-4 text-sm`}
      >
        <DirectoryFact icon={<MapPin className="h-4 w-4" />} label="Cabinet">
          {[lawyer.address, lawyer.city].filter(Boolean).join(", ") || "Adresse à confirmer"}
        </DirectoryFact>
        <DirectoryFact icon={<Building2 className="h-4 w-4" />} label="Intervention">
          {lawyer.coverageLabels.slice(0, 3).join(" · ") || lawyer.matchingLabel || "À distance"}
        </DirectoryFact>
        {sponsored ? (
          <DirectoryFact icon={<ShieldCheck className="h-4 w-4" />} label="Enchères">
            Accepte les ventes judiciaires
            {lawyer.acceptsRemoteContact ? " et le contact à distance" : ""}
          </DirectoryFact>
        ) : null}
      </dl>

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
      </div>
    </article>
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
      <span className="text-gold-soft" aria-hidden>
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
    <div className="grid gap-4 lg:grid-cols-2" aria-label="Chargement de l'annuaire">
      {[0, 1].map((item) => (
        <div
          key={item}
          className="h-80 animate-pulse rounded-lg border border-brand-navy/10 bg-white/70"
        />
      ))}
    </div>
  );
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
