import type { Metadata } from "next";
import { HomeRouteClient } from "./_route-clients/HomeRouteClient";

export const metadata: Metadata = {
  title: "Immojudis - L'immobilier judiciaire en toute clarté",
  description:
    "L'immobilier judiciaire en toute clarté : rapports d'opportunité, comparables DVF, alertes avancées et mise maximale avant audience.",
  alternates: { canonical: "/" },
};

export default function Page() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "ImmoJudis",
    url: "/",
    potentialAction: {
      "@type": "SearchAction",
      target: "/sales?q={search_term_string}",
      "query-input": "required name=search_term_string",
    },
  };
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
      <HomeRouteClient />
    </>
  );
}
