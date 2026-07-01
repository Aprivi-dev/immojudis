"use client";

import { useEffect, useMemo, useState } from "react";
import type { Property } from "@/lib/property-types";
import { buildPropertyStructuredData } from "@/lib/property-service";
import { Footer } from "./Footer";
import { MapSection } from "./MapSection";
import { MortgageCalculator } from "./MortgageCalculator";
import { NeighborhoodSection } from "./NeighborhoodSection";
import { OverviewSection } from "./OverviewSection";
import { PriceHistorySection } from "./PriceHistorySection";
import { PropertyDetailsTable } from "./PropertyDetailsTable";
import { PropertyHeader } from "./PropertyHeader";
import { PropertyHero } from "./PropertyHero";
import { SectionNav, type PropertySectionItem } from "./SectionNav";
import { SimilarListings } from "./SimilarListings";
import { StickyContactCard } from "./StickyContactCard";

const PROPERTY_SECTIONS: PropertySectionItem[] = [
  { id: "overview", label: "Apercu" },
  { id: "details", label: "Details" },
  { id: "map", label: "Carte" },
  { id: "price-history", label: "Historique" },
  { id: "neighborhood", label: "Quartier" },
  { id: "similar", label: "Similaires" },
  { id: "mortgage", label: "Financement" },
];

export function PropertyPage({ property }: { property: Property }) {
  const [activeSection, setActiveSection] = useState(PROPERTY_SECTIONS[0].id);
  const structuredData = useMemo(() => buildPropertyStructuredData(property), [property]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActiveSection(visible.target.id);
      },
      {
        rootMargin: "-30% 0px -58% 0px",
        threshold: [0.1, 0.25, 0.5],
      },
    );

    PROPERTY_SECTIONS.forEach((section) => {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    });

    return () => observer.disconnect();
  }, []);

  return (
    <main className="min-h-screen bg-[#f7f5f1] text-foreground">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <PropertyHeader property={property} />
      <PropertyHero property={property} />
      <SectionNav sections={PROPERTY_SECTIONS} activeSection={activeSection} />

      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:px-8">
        <div className="min-w-0 space-y-10">
          <OverviewSection property={property} />
          <PropertyDetailsTable property={property} />
          <MapSection property={property} />
          <PriceHistorySection property={property} />
          <NeighborhoodSection property={property} />
          <SimilarListings property={property} />
          <MortgageCalculator property={property} />
        </div>
        <StickyContactCard property={property} />
      </div>
      <Footer />
    </main>
  );
}
