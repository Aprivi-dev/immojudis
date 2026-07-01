import { createFileRoute } from "@/lib/router-compat";
import { PropertyPage } from "@/components/property/PropertyPage";
import { PropertyNotFound } from "@/components/property/PropertyNotFound";
import { PropertyPageSkeleton } from "@/components/property/PropertyPageSkeleton";
import { getPropertyByIdOrSlug, propertySeoDescription } from "@/lib/property-service";
import { formatCurrency } from "@/lib/format";

export const Route = createFileRoute("/properties/$id")({
  loader: ({ params }) => getPropertyByIdOrSlug(params.id),
  head: ({ loaderData }) => {
    const property = loaderData;
    if (!property) {
      return {
        meta: [
          { title: "Bien introuvable — Immojudis" },
          { name: "description", content: "Cette fiche immobiliere est introuvable." },
          { name: "robots", content: "noindex" },
        ],
      };
    }

    const title = `${property.title} — ${formatCurrency(property.price, property.currency)} — Immojudis`;
    const description = propertySeoDescription(property);
    const ogImage = property.photos[0]?.url;

    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:type", content: "article" },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        ...(ogImage ? [{ property: "og:image", content: ogImage }] : []),
        { name: "twitter:card", content: ogImage ? "summary_large_image" : "summary" },
      ],
      links: [{ rel: "canonical", href: `/properties/${property.slug}` }],
    };
  },
  pendingComponent: PropertyPageSkeleton,
  notFoundComponent: PropertyNotFound,
  component: PropertyRoute,
});

function PropertyRoute() {
  const property = Route.useLoaderData();
  if (!property) return <PropertyNotFound />;
  return <PropertyPage property={property} />;
}
