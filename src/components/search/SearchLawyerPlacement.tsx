"use client";

import { useQuery } from "@tanstack/react-query";
import Megaphone from "lucide-react/dist/esm/icons/megaphone.js";
import { fetchLawyerDirectory } from "@/lib/client-api";
import type { LawyerDirectoryProfile } from "@/lib/lawyer-directory";
import { resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";

export type SearchLawyerPlacementProps = {
  geographicLabel?: string;
  department?: string;
  city?: string;
  className?: string;
};

/**
 * Reserves the fourth-card slot for a geographically scoped lawyer campaign.
 *
 * The directory endpoint is public, but the component only renders a lawyer
 * when the endpoint explicitly returns a real, active Immojudis placement.
 * Demo rows and ordinary directory profiles intentionally fall back to the
 * transparent contact card below.
 */
export function SearchLawyerPlacement({
  geographicLabel,
  department,
  city,
  className = "",
}: SearchLawyerPlacementProps) {
  const cityValue = cleanScopeValue(city);
  const departmentValue = cleanScopeValue(department) ?? singleDepartmentFromLabel(geographicLabel);
  const hasScope = Boolean(cityValue || departmentValue);
  const areaLabel =
    cleanScopeValue(geographicLabel) ||
    [cityValue, departmentValue].filter(Boolean).join(" · ") ||
    "votre secteur";

  const directoryQuery = useQuery({
    queryKey: ["search-lawyer-placement", cityValue, departmentValue],
    queryFn: () =>
      fetchLawyerDirectory({
        city: cityValue ?? undefined,
        department: departmentValue ?? undefined,
      }),
    enabled: hasScope,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const sponsoredLawyer = selectRealSponsoredLawyer(directoryQuery.data?.lawyers, {
    isDemo: directoryQuery.data?.isDemo ?? false,
  });

  if (sponsoredLawyer) {
    return (
      <SponsoredLawyerCard lawyer={sponsoredLawyer} areaLabel={areaLabel} className={className} />
    );
  }

  return (
    <OpenLawyerPlacement loading={hasScope && directoryQuery.isLoading} className={className} />
  );
}

function SponsoredLawyerCard({
  lawyer,
  areaLabel,
  className,
}: {
  lawyer: LawyerDirectoryProfile;
  areaLabel: string;
  className: string;
}) {
  const title = lawyer.firmName || lawyer.displayName;
  const matchingArea = lawyer.matchingLabel || areaLabel;

  return (
    <section
      aria-labelledby="search-lawyer-placement-title"
      className={`flex min-h-[320px] flex-col rounded-lg border border-[#d9b477] bg-[#fffaf2] p-4 shadow-sm ${className}`.trim()}
    >
      <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.14em] text-gold-text">
        <Megaphone className="h-3.5 w-3.5" aria-hidden />
        Sponsorisé
      </div>
      <h2
        id="search-lawyer-placement-title"
        className="mt-2 font-display text-lg font-semibold leading-tight text-[#132238]"
      >
        {title}
      </h2>
      <p className="mt-1 text-sm font-medium text-[#526170]">{lawyer.displayName}</p>
      <p className="mt-3 text-sm leading-relaxed text-[#526170]">
        Ce cabinet présente son activité pour les ventes immobilières judiciaires sur {matchingArea}
        .
      </p>
      {lawyer.barAssociation || lawyer.city || lawyer.department ? (
        <p className="mt-3 text-xs text-[#5b6878]">
          {[lawyer.barAssociation, lawyer.city, lawyer.department].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      <a
        href={directoryHref(lawyer)}
        className="mt-auto inline-flex min-h-10 items-center justify-center rounded-md border border-[#c98d45]/45 bg-white px-3 py-2 text-xs font-bold text-gold-text transition-colors hover:border-[#c98d45] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c98d45] focus-visible:ring-offset-2"
      >
        Voir l’annuaire du secteur
      </a>
      <p className="mt-3 text-[11px] leading-relaxed text-[#5b6878]">
        Cette mise en avant est signalée comme sponsorisée et ne constitue ni une recommandation, ni
        une garantie de résultat.
      </p>
    </section>
  );
}

function OpenLawyerPlacement({ loading, className }: { loading: boolean; className: string }) {
  return (
    <section
      aria-labelledby="search-lawyer-placement-title"
      aria-busy={loading}
      className={`flex min-h-[320px] flex-col rounded-lg border border-[#d9b477] bg-[#fffaf2] p-4 shadow-sm ${className}`.trim()}
    >
      <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#5b6878]">
        <Megaphone className="h-3.5 w-3.5" aria-hidden />
        Espace partenaire
      </div>
      <h2
        id="search-lawyer-placement-title"
        className="mt-2 font-display text-lg font-semibold leading-tight text-[#132238]"
      >
        Présentez votre cabinet
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-[#526170]">
        Présentez votre cabinet aux acquéreurs qui recherchent un bien dans ce secteur.
      </p>
      <a
        href="/contact"
        className="mt-auto inline-flex min-h-10 items-center justify-center rounded-md bg-[#132238] px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-[#29405d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c98d45] focus-visible:ring-offset-2"
      >
        Présenter mon cabinet
      </a>
    </section>
  );
}

function selectRealSponsoredLawyer(
  lawyers: LawyerDirectoryProfile[] | undefined,
  { isDemo }: { isDemo: boolean },
): LawyerDirectoryProfile | null {
  if (isDemo) return null;
  return lawyers?.find((lawyer) => lawyer.source === "immojudis" && lawyer.isSponsored) ?? null;
}

function cleanScopeValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function singleDepartmentFromLabel(value: string | undefined): string | null {
  const resolution = resolveFrenchGeoSearch(value);
  return resolution.kind === "department" && resolution.departments.length === 1
    ? (resolution.departments[0] ?? null)
    : null;
}

function directoryHref(lawyer: LawyerDirectoryProfile): string {
  const params = new URLSearchParams();
  if (lawyer.city) params.set("city", lawyer.city);
  if (lawyer.department) params.set("department", lawyer.department);
  const query = params.toString();
  return query ? `/avocats?${query}` : "/avocats";
}
