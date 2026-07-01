import { MOCK_PROPERTIES } from "@/lib/mock-property";
import type { Property, PropertyCard } from "@/lib/property-types";

export type PropertyRepository = {
  findByIdOrSlug: (identifier: string) => Promise<Property | null>;
  findSimilar: (property: Property) => Promise<PropertyCard[]>;
};

const mockRepository: PropertyRepository = {
  async findByIdOrSlug(identifier) {
    const normalized = normalizeIdentifier(identifier);
    return (
      MOCK_PROPERTIES.find(
        (property) =>
          normalizeIdentifier(property.id) === normalized ||
          normalizeIdentifier(property.slug) === normalized,
      ) ?? null
    );
  },

  async findSimilar(property) {
    if (property.similarListings?.length) return property.similarListings;
    return MOCK_PROPERTIES.filter((candidate) => candidate.id !== property.id)
      .slice(0, 3)
      .map(propertyToCard);
  },
};

export async function getPropertyByIdOrSlug(
  identifier: string,
  repository: PropertyRepository = mockRepository,
): Promise<Property | null> {
  const property = await repository.findByIdOrSlug(identifier);
  if (!property) return null;

  const similarListings = await repository.findSimilar(property);
  return {
    ...property,
    similarListings,
  };
}

export function propertyToCard(property: Property): PropertyCard {
  return {
    id: property.id,
    slug: property.slug,
    price: property.price,
    currency: property.currency,
    address: property.address,
    city: property.city,
    beds: property.beds,
    baths: property.baths,
    sqft: property.sqft,
    photoUrl: property.photos[0]?.url ?? "/brand/immojudis-mark-transparent.png",
  };
}

export function buildPropertyStructuredData(property: Property) {
  const image = property.photos[0]?.url;
  return {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    name: property.title,
    description: property.description,
    url: `/properties/${property.slug}`,
    image,
    address: {
      "@type": "PostalAddress",
      streetAddress: property.address,
      addressLocality: property.city,
      addressRegion: property.region,
      postalCode: property.postalCode,
      addressCountry: property.country,
    },
    offers: {
      "@type": "Offer",
      price: property.price,
      priceCurrency: property.currency,
      availability: "https://schema.org/InStock",
    },
  };
}

export function propertySeoDescription(property: Property): string {
  const parts = [
    property.city,
    property.propertyType,
    property.beds ? `${property.beds} chambre${property.beds > 1 ? "s" : ""}` : null,
    property.sqft ? `${property.sqft} ft2` : null,
  ].filter(Boolean);
  return `${property.title}. ${parts.join(" · ")}. Fiche immobiliere premium Immojudis avec photos, carte, historique et contact.`;
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}
