import type { User } from "@supabase/supabase-js";

export type AccountType = "b2c" | "b2b";
export type ProfessionalRole = "lawyer" | "notary" | "bailiff" | "other";

export const ADMIN_EMAILS = ["a.privileggio@gmail.com"] as const;

export const ACCOUNT_TYPE_OPTIONS: Array<{
  value: AccountType;
  label: string;
  description: string;
}> = [
  {
    value: "b2c",
    label: "Investisseur particulier",
    description: "Accès aux annonces, scores, carte, favoris et alertes.",
  },
  {
    value: "b2b",
    label: "Professionnel",
    description: "Avocat, notaire ou huissier souhaitant préparer une annonce.",
  },
];

export const PROFESSIONAL_ROLE_OPTIONS: Array<{
  value: ProfessionalRole;
  label: string;
}> = [
  { value: "lawyer", label: "Avocat" },
  { value: "notary", label: "Notaire" },
  { value: "bailiff", label: "Huissier / commissaire de justice" },
  { value: "other", label: "Autre professionnel" },
];

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function isAdminEmail(email: string | null | undefined): boolean {
  return ADMIN_EMAILS.includes(normalizeEmail(email) as (typeof ADMIN_EMAILS)[number]);
}

export function isAdminAccount(user: User | null | undefined): boolean {
  return isAdminEmail(user?.email);
}

export function getAccountType(user: User | null | undefined): AccountType {
  const value = user?.user_metadata?.account_type;
  return value === "b2b" ? "b2b" : "b2c";
}

export function isProfessionalAccount(user: User | null | undefined) {
  return isAdminAccount(user) || getAccountType(user) === "b2b";
}

export function getProfessionalRole(user: User | null | undefined): ProfessionalRole | null {
  const value = user?.user_metadata?.professional_role;
  if (value === "lawyer" || value === "notary" || value === "bailiff" || value === "other") {
    return value;
  }
  return null;
}
