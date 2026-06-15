import { formatSurface } from "@/lib/format";

export const STUDIO_ESTIMATED_SURFACE_M2 = 20;

type SurfaceSaleLike = {
  title?: string | null;
  property_type?: string | null;
  app_surface_m2?: number | null;
  habitable_surface_m2?: number | null;
  carrez_surface_m2?: number | null;
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

export function isStudioSale(sale: SurfaceSaleLike): boolean {
  const text = [sale.property_type, sale.title].filter(Boolean).join(" ").toLowerCase();
  return /\b(studio|studette)\b/.test(text);
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

  if (isStudioSale(sale)) {
    return {
      value: STUDIO_ESTIMATED_SURFACE_M2,
      estimated: true,
      label: `${formatSurface(STUDIO_ESTIMATED_SURFACE_M2)} estimés`,
      helperText:
        "Surface provisoire retenue pour un studio sans surface publiée. À confirmer dans les pièces avant d'enchérir.",
    };
  }

  return {
    value: null,
    estimated: false,
    label: "—",
    helperText: null,
  };
}
