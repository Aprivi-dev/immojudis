"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import { LawyerReferralButton } from "@/components/LawyerReferralButton";
import { fetchFeaturedReferencedLawyer, recordLawyerPlacementEvent } from "@/lib/client-api";
import type { FeaturedReferencedLawyer } from "@/lib/featured-lawyers";
import type { LawyerPlacementEventInput } from "@/lib/lawyer-placement-events";

export function FeaturedLawyerPlacement({
  saleId,
  className = "mt-4",
  placementSlot = "sale_detail_featured_lawyer",
}: {
  saleId: string;
  className?: string;
  placementSlot?: string;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const impressionKeyRef = useRef<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["featured-referenced-lawyer", saleId],
    queryFn: () => fetchFeaturedReferencedLawyer({ saleId }),
    staleTime: 5 * 60_000,
  });

  const lawyer = data?.lawyer ?? null;
  const shellClassName = `rounded-lg border border-gold/25 bg-gold/[0.07] p-4 ${className}`.trim();
  const recordPlacementEvent = useCallback(
    (eventType: LawyerPlacementEventInput["eventType"]) => {
      if (!lawyer) return;
      void recordLawyerPlacementEvent({
        data: {
          saleId,
          lawyerId: lawyer.id,
          eventType,
          placementSlot,
          viewport: placementViewport(),
          pagePath: placementPagePath(),
        },
      }).catch(() => undefined);
    },
    [lawyer, placementSlot, saleId],
  );

  useEffect(() => {
    if (!lawyer || !sectionRef.current) return;

    const impressionKey = `${saleId}:${lawyer.id}:${placementSlot}`;
    if (impressionKeyRef.current === impressionKey) return;

    const recordOnce = () => {
      if (impressionKeyRef.current === impressionKey) return;
      impressionKeyRef.current = impressionKey;
      recordPlacementEvent("impression");
    };

    if (typeof IntersectionObserver === "undefined") {
      recordOnce();
      return;
    }

    const node = sectionRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.25)) {
          recordOnce();
          observer.disconnect();
        }
      },
      { threshold: [0.25] },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [lawyer, placementSlot, recordPlacementEvent, saleId]);

  return (
    <section ref={sectionRef} className={shellClassName}>
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-gold-soft">
        <Scale className="h-3.5 w-3.5" />
        Avocat référencé
      </div>
      <h3 className="mt-2 text-base font-semibold leading-tight text-foreground">
        Besoin d'un accompagnement d'un avocat ?
      </h3>
      {isLoading ? (
        <div className="mt-3 space-y-2">
          <div className="h-3 w-4/5 animate-pulse rounded-full bg-white/70" />
          <div className="h-3 w-2/3 animate-pulse rounded-full bg-white/70" />
        </div>
      ) : lawyer ? (
        <FeaturedLawyerSummary lawyer={lawyer} />
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          ImmoJudis peut rechercher un avocat référencé disponible sur ce secteur.
        </p>
      )}
      <div className="mt-4">
        <LawyerReferralButton saleId={saleId} onIntent={() => recordPlacementEvent("cta_click")} />
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Bloc issu de l'annuaire ImmoJudis. Il est séparé des contacts présents dans les annonces
        sources.
      </p>
    </section>
  );
}

function placementViewport(): LawyerPlacementEventInput["viewport"] {
  if (typeof window === "undefined") return "unknown";
  return window.matchMedia("(min-width: 1024px)").matches ? "desktop" : "mobile";
}

function placementPagePath(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return `${window.location.pathname}${window.location.search}`;
}

function FeaturedLawyerSummary({ lawyer }: { lawyer: FeaturedReferencedLawyer }) {
  return (
    <div className="mt-2 text-sm leading-relaxed text-muted-foreground">
      <p>
        <span className="font-semibold text-foreground">{lawyerDisplayName(lawyer)}</span> est
        sélectionné par ImmoJudis sur ce secteur.
      </p>
      <dl className="mt-3 grid gap-2 rounded-md border border-white/70 bg-white/60 p-3 text-xs">
        {lawyer.firmName ? <PlacementFact label="Cabinet" value={lawyer.firmName} /> : null}
        {lawyer.barAssociation ? (
          <PlacementFact label="Barreau" value={lawyer.barAssociation} />
        ) : null}
        <PlacementFact label="Secteur" value={lawyer.sectorLabel} />
      </dl>
      {lawyer.profileSummary ? (
        <p className="mt-3 line-clamp-3 text-xs">{lawyer.profileSummary}</p>
      ) : null}
    </div>
  );
}

function PlacementFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

function lawyerDisplayName(lawyer: FeaturedReferencedLawyer): string {
  if (/^(me|maitre|maître)\b/i.test(lawyer.displayName.trim())) {
    return lawyer.displayName;
  }
  return `Maître ${lawyer.displayName}`;
}
