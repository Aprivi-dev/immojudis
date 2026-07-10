import type { User } from "@supabase/supabase-js";

export type AccountType = "b2c" | "b2b";
export type AccountTier = "free" | "premium";
export type UserRole = "user" | "admin";
export type ProfessionalRole = "lawyer" | "notary" | "bailiff" | "court" | "other";
export type ProfessionalStatus = "not_applicable" | "pending" | "approved" | "rejected";

export type AccountProfile = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  account_type: AccountType;
  account_tier: AccountTier;
  user_role: UserRole;
  professional_role: ProfessionalRole | null;
  organization_name: string | null;
  professional_status: ProfessionalStatus;
  created_at?: string;
  updated_at?: string;
};

export const ACCOUNT_TYPE_OPTIONS: Array<{
  value: AccountType;
  label: string;
  description: string;
}> = [
  {
    value: "b2c",
    label: "Investisseur particulier",
    description: "Consulter les fiches, favoris et alertes avant d'enchérir.",
  },
  {
    value: "b2b",
    label: "Professionnel",
    description: "Référencer une vente, déposer les pièces et préparer sa visibilité.",
  },
];

export const PROFESSIONAL_ROLE_OPTIONS: Array<{
  value: ProfessionalRole;
  label: string;
}> = [
  { value: "lawyer", label: "Avocat" },
  { value: "notary", label: "Notaire" },
  { value: "bailiff", label: "Huissier / commissaire de justice" },
  { value: "court", label: "Tribunal / greffe" },
  { value: "other", label: "Autre professionnel" },
];

export function isAccountType(value: unknown): value is AccountType {
  return value === "b2c" || value === "b2b";
}

export function isAccountTier(value: unknown): value is AccountTier {
  return value === "free" || value === "premium";
}

export function isUserRole(value: unknown): value is UserRole {
  return value === "user" || value === "admin";
}

export function isProfessionalRole(value: unknown): value is ProfessionalRole {
  return (
    value === "lawyer" ||
    value === "notary" ||
    value === "bailiff" ||
    value === "court" ||
    value === "other"
  );
}

export function isProfessionalStatus(value: unknown): value is ProfessionalStatus {
  return (
    value === "not_applicable" ||
    value === "pending" ||
    value === "approved" ||
    value === "rejected"
  );
}

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function hasAdminRole(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const metadata = value as { app_metadata?: { role?: unknown }; user_role?: unknown };
  return metadata.app_metadata?.role === "admin" || metadata.user_role === "admin";
}

export function isAdminAccount(
  user: User | null | undefined,
  profile?: AccountProfile | null,
): boolean {
  if (profile) return profile.user_role === "admin";
  return hasAdminRole(user);
}

export function profileFromUserMetadata(user: User | null | undefined): AccountProfile | null {
  if (!user) return null;
  const accountType = isAccountType(user.user_metadata?.account_type)
    ? user.user_metadata.account_type
    : "b2c";
  const professionalRole = isProfessionalRole(user.user_metadata?.professional_role)
    ? user.user_metadata.professional_role
    : null;
  const status = accountType === "b2b" ? "pending" : "not_applicable";
  const admin = hasAdminRole(user);

  return {
    user_id: user.id,
    email: user.email ?? null,
    full_name:
      typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : null,
    account_type: accountType,
    account_tier: admin ? "premium" : "free",
    user_role: admin ? "admin" : "user",
    professional_role: accountType === "b2b" ? professionalRole : null,
    organization_name:
      typeof user.user_metadata?.organization_name === "string"
        ? user.user_metadata.organization_name
        : null,
    professional_status: status,
  };
}

export function getAccountType(
  user: User | null | undefined,
  profile?: AccountProfile | null,
): AccountType {
  if (profile?.account_type) return profile.account_type;
  const value = user?.user_metadata?.account_type;
  return value === "b2b" ? "b2b" : "b2c";
}

export function isProfessionalAccount(
  user: User | null | undefined,
  profile?: AccountProfile | null,
) {
  return (
    isAdminAccount(user, profile) ||
    (getAccountType(user, profile) === "b2b" && getProfessionalStatus(profile) === "approved")
  );
}

export function getProfessionalRole(
  user: User | null | undefined,
  profile?: AccountProfile | null,
): ProfessionalRole | null {
  if (profile?.professional_role) return profile.professional_role;
  const value = user?.user_metadata?.professional_role;
  if (isProfessionalRole(value)) {
    return value;
  }
  return null;
}

export function getProfessionalStatus(profile: AccountProfile | null | undefined) {
  return isProfessionalStatus(profile?.professional_status) ? profile.professional_status : null;
}
