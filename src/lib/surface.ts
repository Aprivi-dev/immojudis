import { formatSurface } from "@/lib/format";

// Surface provisoire retenue pour les très petits logements sans surface publiée :
// les studios et les appartements 1 pièce (T1). À confirmer avant d'enchérir.
export const STUDIO_ESTIMATED_SURFACE_M2 = 20;

type SurfaceSaleLike = {
  title?: string | null;
  property_type?: string | null;
  app_surface_m2?: number | null;
  habitable_surface_m2?: number | null;
  carrez_surface_m2?: number | null;
  rooms_count?: number | null;
};

export type SaleSurface = {
  value: number | null;
  estimated: boolean;
  label: string;
  helperText: string | null;
};

function positiveSurface(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function typeText(sale: SurfaceSaleLike): string {
  return [sale.property_type, sale.title].filter(Boolean).join(" ").toLowerCase();
}

export function isStudioSale(sale: SurfaceSaleLike): boolean {
  return /\b(studio|studette)\b/.test(typeText(sale));
}

// property_type est normalisé en "apartment" ; on tolère aussi les variantes FR/abrégées.
export function isApartmentSale(sale: SurfaceSaleLike): boolean {
  return /\bapartment\b|\bappart|\bapt\b/.test(typeText(sale));
}

// Appartement 1 pièce (T1) : même estimation qu'un studio, mais uniquement si le
// nombre de pièces est renseigné et ne dépasse pas 1.
function isSingleRoomApartment(sale: SurfaceSaleLike): boolean {
  const rooms = sale.rooms_count;
  const hasAtMostOneRoom = rooms != null && Number.isFinite(rooms) && rooms >= 0 && rooms <= 1;
  return hasAtMostOneRoom && isApartmentSale(sale);
}

export function getRecordedSurface(sale: SurfaceSaleLike): number | null {
  return (
    positiveSurface(sale.app_surface_m2) ??
    positiveSurface(sale.habitable_surface_m2) ??
    positiveSurface(sale.carrez_surface_m2)
  );
}

export function getSaleSurface(sale: SurfaceSaleLike): SaleSurface {
  const recorded = getRecordedSurface(sale);
  if (recorded != null) {
    return {
      value: recorded,
      estimated: false,
      label: formatSurface(recorded),
      helperText: null,
    };
  }

  const estimate = (kind: string): SaleSurface => ({
    value: STUDIO_ESTIMATED_SURFACE_M2,
    estimated: true,
    label: `${formatSurface(STUDIO_ESTIMATED_SURFACE_M2)} estimés`,
    helperText: `Surface provisoire retenue pour ${kind} sans surface publiée. À confirmer dans les pièces avant d'enchérir.`,
  });

  if (isStudioSale(sale)) return estimate("un studio");
  if (isSingleRoomApartment(sale)) return estimate("un appartement 1 pièce");

  return {
    value: null,
    estimated: false,
    label: "—",
    helperText: null,
  };
}
