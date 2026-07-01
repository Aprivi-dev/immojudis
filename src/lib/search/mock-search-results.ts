import type { ViewportBounds } from "./search-url-state";

export type PropertyType = "house" | "condo" | "townhouse" | "multi_family" | "land" | "apartment";

export type ListingStatus = "active" | "pending" | "sold" | "off_market";

export type SearchResult = {
  id: string;
  slug: string;
  price: number;
  currency: string;
  address: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  lotSize?: string;
  propertyType: PropertyType;
  status: ListingStatus;
  isNew?: boolean;
  hasOpenHouse?: boolean;
  latitude?: number;
  longitude?: number;
  photoUrl?: string;
  photosCount?: number;
  listedAt?: string;
  brokerage?: string;
};

export type SearchResponse = {
  results: SearchResult[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  bounds?: ViewportBounds;
};

export const mockSearchResults: SearchResult[] = [
  {
    id: "mock-bordeaux-1",
    slug: "hotel-particulier-bordeaux-centre",
    price: 432000,
    currency: "EUR",
    address: "18 rue Sainte-Catherine",
    city: "Bordeaux",
    region: "Gironde",
    postalCode: "33000",
    country: "France",
    beds: 4,
    baths: 2,
    sqft: 168,
    propertyType: "house",
    status: "active",
    isNew: true,
    hasOpenHouse: true,
    latitude: 44.8378,
    longitude: -0.5792,
    photoUrl: "/media/landing/auction-bordeaux.jpg",
    photosCount: 8,
    listedAt: "2026-06-20",
    brokerage: "Immojudis",
  },
  {
    id: "mock-nantes-1",
    slug: "appartement-nantes-tribunal",
    price: 215000,
    currency: "EUR",
    address: "6 quai de la Fosse",
    city: "Nantes",
    region: "Loire-Atlantique",
    postalCode: "44000",
    country: "France",
    beds: 2,
    baths: 1,
    sqft: 72,
    propertyType: "apartment",
    status: "pending",
    latitude: 47.213,
    longitude: -1.56,
    photoUrl: "/media/landing/auction-nantes.jpg",
    photosCount: 5,
    listedAt: "2026-06-14",
    brokerage: "Immojudis",
  },
  {
    id: "mock-toulouse-1",
    slug: "terrain-toulouse-metropole",
    price: 148000,
    currency: "EUR",
    address: "Route de Seysses",
    city: "Toulouse",
    region: "Haute-Garonne",
    postalCode: "31100",
    country: "France",
    sqft: 940,
    lotSize: "940 m2",
    propertyType: "land",
    status: "active",
    latitude: 43.6047,
    longitude: 1.4442,
    photoUrl: "/media/landing/auction-toulouse.jpg",
    photosCount: 3,
    listedAt: "2026-06-06",
    brokerage: "Immojudis",
  },
];
