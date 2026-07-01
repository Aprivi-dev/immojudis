export type PropertyPhoto = {
  id: string;
  url: string;
  alt: string;
  width?: number;
  height?: number;
};

export type PropertyCard = {
  id: string;
  slug: string;
  price: number;
  currency: string;
  address: string;
  city: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  photoUrl: string;
};

export type Property = {
  id: string;
  slug: string;
  title: string;
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
  yearBuilt?: number;
  propertyType?: string;
  pricePerSqft?: number;
  description: string;
  photos: PropertyPhoto[];
  location?: {
    lat: number;
    lng: number;
  };
  agent?: {
    name: string;
    phone?: string;
    email?: string;
    brokerage?: string;
    avatarUrl?: string;
  };
  facts: {
    label: string;
    value: string;
  }[];
  details: {
    category: string;
    items: {
      label: string;
      value: string;
    }[];
  }[];
  priceHistory?: {
    date: string;
    event: string;
    price?: number;
    source?: string;
  }[];
  similarListings?: PropertyCard[];
};
