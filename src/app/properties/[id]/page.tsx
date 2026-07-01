import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PropertyPage } from "@/components/property/PropertyPage";
import { formatCurrency } from "@/lib/format";
import { getPropertyByIdOrSlug, propertySeoDescription } from "@/lib/property-service";

type PageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
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
  const { id } = await params;
  const property = await getPropertyByIdOrSlug(id);
  if (!property) notFound();

  return <PropertyPage property={property} />;
}
