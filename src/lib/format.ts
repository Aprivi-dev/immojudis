export function formatPrice(value: number | null | undefined): string {
  if (value == null) return "Prix non communiqué";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Date à confirmer";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "Date à confirmer";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(d);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatSurface(m2: number | null | undefined): string {
  if (m2 == null) return "—";
  return `${Math.round(m2)} m²`;
}

export function occupancyLabel(status: string | null | undefined): string {
  if (!status) return "Non renseigné";
  const s = status.toLowerCase();
  if (s.includes("libre") || s === "vacant" || s === "free") return "Libre";
  if (s.includes("occup")) return "Occupé";
  if (s.includes("loué") || s.includes("loue") || s.includes("rented")) return "Loué";
  return status;
}

export function propertyTypeLabel(t: string | null | undefined): string {
  if (!t) return "Bien";
  const s = t.toLowerCase();
  if (s.includes("apart") || s.includes("apt")) return "Appartement";
  if (s.includes("house") || s.includes("maison")) return "Maison";
  if (s.includes("land") || s.includes("terrain")) return "Terrain";
  if (s.includes("garage") || s.includes("park")) return "Garage / Parking";
  if (s.includes("commerce") || s.includes("local")) return "Local commercial";
  return t;
}