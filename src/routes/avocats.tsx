"use client";

import { useQuery } from "@tanstack/react-query";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Phone from "lucide-react/dist/esm/icons/phone.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { BillingActions } from "@/components/BillingActions";
import { LawyerReferralButton } from "@/components/LawyerReferralButton";
import { fetchLawyerDirectory } from "@/lib/client-api";
import type { LawyerDirectoryProfile } from "@/lib/lawyer-directory";
import { createFileRoute, Link } from "@/lib/router-compat";

type DirectorySearch = {
  saleId?: string;
  city?: string;
  department?: string;
};

export const Route = createFileRoute("/avocats")({
  validateSearch: (search: Record<string, unknown>): DirectorySearch => ({
    saleId: stringValue(search.saleId),
    city: stringValue(search.city),
    department: stringValue(search.department),
  }),
  head: () => ({
    meta: [
      { title: "Annuaire des avocats en ventes judiciaires — Immojudis" },
      {
        name: "description",
        content:
          "Trouvez un avocat référencé par Immojudis pour vérifier votre dossier et porter vos enchères judiciaires.",
      },
    ],
  }),
  component: LawyerDirectoryPage,
});

function LawyerDirectoryPage() {
  const search = Route.useSearch<DirectorySearch>();
  const directoryQuery = useQuery({
    queryKey: ["lawyer-directory", search.saleId, search.city, search.department],
    queryFn: () => fetchLawyerDirectory(search),
    staleTime: 5 * 60_000,
  });
  const errorMessage =
    directoryQuery.error instanceof Error ? directoryQuery.error.message : "Annuaire indisponible";
  const locked = directoryQuery.isError && /réservé|plan Analyse/i.test(errorMessage);

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
                Avocats en ventes judiciaires
              </h1>
              <p className="mt-5 max-w-3xl text-base leading-relaxed text-brand-navy/70 sm:text-lg">
                Identifiez un avocat inscrit au barreau compétent, consultez sa zone d'intervention
                et demandez une mise en relation depuis votre dossier.
              </p>
            </div>
            <form
              action="/avocats"
              method="get"
              className="rounded-lg border border-brand-navy/12 bg-white p-4 shadow-sm"
            >
              {search.saleId ? <input type="hidden" name="saleId" value={search.saleId} /> : null}
              <label htmlFor="lawyer-city" className="text-sm font-semibold text-brand-navy">
                Ville ou barreau
              </label>
              <div className="mt-2 flex gap-2">
                <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-brand-navy/16 px-3">
                  <Search className="h-4 w-4 shrink-0 text-brand-navy/45" aria-hidden />
                  <input
                    id="lawyer-city"
                    name="city"
                    defaultValue={search.city ?? ""}
                    placeholder="Bordeaux, Paris, Lyon…"
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-brand-navy/40"
                  />
                </div>
                <button
                  type="submit"
                  className="min-h-11 rounded-md bg-brand-navy px-4 text-sm font-semibold text-white transition-colors hover:bg-gold-soft"
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
        ) : locked ? (
          <LockedDirectory />
        ) : directoryQuery.isError ? (
          <DirectoryError message={errorMessage} />
        ) : (
          <DirectoryResults
            lawyers={directoryQuery.data?.lawyers ?? []}
            sectorLabel={directoryQuery.data?.sectorLabel ?? search.city ?? null}
            saleId={search.saleId}
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
}: {
  lawyers: LawyerDirectoryProfile[];
  sectorLabel: string | null;
  saleId?: string;
}) {
  if (!lawyers.length) {
    return (
      <div className="rounded-lg border border-brand-navy/12 bg-white p-7 text-center shadow-sm sm:p-10">
        <Scale className="mx-auto h-9 w-9 text-gold-soft" aria-hidden />
        <h2 className="mt-4 font-display text-3xl font-semibold text-brand-navy">
          Aucun avocat référencé sur ce secteur
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-brand-navy/65">
          Élargissez la recherche à un département ou revenez au dossier : Immojudis peut aussi
          effectuer une recherche manuelle lors de votre demande de mise en relation.
        </p>
        {saleId ? <LawyerReferralButton saleId={saleId} className="mx-auto mt-6 min-h-11" /> : null}
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-3xl font-semibold text-brand-navy sm:text-4xl">
          {sectorLabel ? `Avocats disponibles — ${sectorLabel}` : "Avocats disponibles"}
        </h2>
        <p className="text-sm font-medium text-brand-navy/55">
          {lawyers.length} profil{lawyers.length > 1 ? "s" : ""} référencé
          {lawyers.length > 1 ? "s" : ""}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {lawyers.map((lawyer) => (
          <LawyerCard key={lawyer.id} lawyer={lawyer} saleId={saleId} />
        ))}
      </div>
    </>
  );
}

function LawyerCard({ lawyer, saleId }: { lawyer: LawyerDirectoryProfile; saleId?: string }) {
  return (
    <article className="flex flex-col rounded-lg border border-brand-navy/12 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
          <Scale className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-2xl font-semibold leading-tight text-brand-navy">
            {lawyer.displayName}
          </h3>
          <p className="mt-1 text-sm text-brand-navy/62">
            {[lawyer.firmName, lawyer.barAssociation].filter(Boolean).join(" · ") ||
              "Avocat référencé Immojudis"}
          </p>
        </div>
      </div>

      {lawyer.profileSummary ? (
        <p className="mt-5 line-clamp-4 text-sm leading-relaxed text-brand-navy/70">
          {lawyer.profileSummary}
        </p>
      ) : null}

      <dl className="mt-5 grid gap-3 border-y border-brand-navy/10 py-4 text-sm">
        <DirectoryFact icon={<MapPin className="h-4 w-4" />} label="Cabinet">
          {[lawyer.address, lawyer.city].filter(Boolean).join(", ") || "Adresse à confirmer"}
        </DirectoryFact>
        <DirectoryFact icon={<Building2 className="h-4 w-4" />} label="Intervention">
          {lawyer.coverageLabels.slice(0, 3).join(" · ") || lawyer.matchingLabel || "À distance"}
        </DirectoryFact>
        <DirectoryFact icon={<ShieldCheck className="h-4 w-4" />} label="Enchères">
          Accepte les ventes judiciaires
          {lawyer.acceptsRemoteContact ? " et le contact à distance" : ""}
        </DirectoryFact>
      </dl>

      <div className="mt-auto flex flex-wrap gap-2 pt-5">
        {saleId ? (
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
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-brand-navy/16 px-3 text-sm font-semibold text-brand-navy hover:border-gold"
          >
            <Phone className="h-4 w-4" aria-hidden />
            Appeler
          </a>
        ) : null}
        {lawyer.email ? (
          <a
            href={`mailto:${lawyer.email}`}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-brand-navy/16 px-3 text-sm font-semibold text-brand-navy hover:border-gold"
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
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-brand-navy/16 px-3 text-sm font-semibold text-brand-navy hover:border-gold"
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

function LockedDirectory() {
  return (
    <div className="mx-auto max-w-2xl rounded-lg border border-gold/35 bg-white p-7 text-center shadow-sm sm:p-10">
      <Scale className="mx-auto h-10 w-10 text-gold-soft" aria-hidden />
      <h2 className="mt-5 font-display text-3xl font-semibold text-brand-navy sm:text-4xl">
        L'annuaire est inclus dans l'offre Analyse
      </h2>
      <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-brand-navy/67 sm:text-base">
        Débloquez les profils, leurs zones d'intervention et la demande de mise en relation pendant
        30 jours, avec toutes les analyses des annonces.
      </p>
      <BillingActions className="mt-6" />
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
