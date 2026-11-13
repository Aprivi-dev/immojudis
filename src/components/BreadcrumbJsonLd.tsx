import { jsonLdString } from "@/lib/json-ld";
import { breadcrumbStructuredData, type BreadcrumbItem } from "@/lib/seo";
import { siteOrigin } from "@/lib/site-url";

/**
 * `BreadcrumbList` structured data of an information page (server component). Renders no visible
 * markup: the trail is Accueil, then `trail`, the page itself last.
 */
export function BreadcrumbJsonLd({ trail }: { trail: readonly BreadcrumbItem[] }) {
  const origin = siteOrigin();
  const data = { "@context": "https://schema.org", ...breadcrumbStructuredData(origin, trail) };
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />
  );
}
