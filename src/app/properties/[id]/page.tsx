import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PropertyPage } from "@/components/property/PropertyPage";
import { formatCurrency } from "@/lib/format";
import { getPropertyByIdOrSlug, propertySeoDescription } from "@/lib/property-service";

const PROPERTY_DEMO_ENABLED = process.env.ENABLE_PROPERTY_DEMO === "true";

type PageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  if (!PROPERTY_DEMO_ENABLED) {
    return {
      title: "Annonce exemple",
      description: "Exemple de fiche immobiliere Immojudis.",
      alternates: {
        canonical: "/annonce-exemple",
      },
      robots: { index: false, follow: false },
    };
  }

  const { id } = await params;
  const property = await getPropertyByIdOrSlug(id);

  if (!property) {
    return {
      title: "Bien introuvable",
      description: "Cette fiche immobiliere est introuvable.",
      robots: { index: false },
    };
  }

  const title = `${property.title} - ${formatCurrency(property.price, property.currency)}`;
  const description = propertySeoDescription(property);
  const image = property.photos[0]?.url;

  return {
    title,
    description,
    alternates: {
      canonical: `/properties/${property.slug}`,
    },
    openGraph: {
      title,
      description,
      type: "article",
      images: image ? [{ url: image }] : undefined,
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
    },
  };
}

export default async function Page({ params }: PageProps) {
  if (!PROPERTY_DEMO_ENABLED) {
    redirect("/annonce-exemple");
  }

  const { id } = await params;
  const property = await getPropertyByIdOrSlug(id);
  if (!property) notFound();

  return <PropertyPage property={property} />;
}
