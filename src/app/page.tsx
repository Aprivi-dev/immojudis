import type { Metadata } from "next";
import { organizationStructuredData } from "@/lib/seo";
import { resolveSiteOrigin } from "@/lib/site-url";
import { HomePage } from "@/routes/index";

export const metadata: Metadata = {
  title: { absolute: "Immojudis - Les enchères immobilières en toute clarté" },
  description:
    "Ventes au tribunal, notariales et domaniales référencées : distinguez les procédures, trouvez une annonce et préparez votre achat immobilier.",
  alternates: { canonical: "/" },
};

export default function Page() {
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  const structuredData = organizationStructuredData(origin);
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
      <HomePage />
    </>
  );
}
