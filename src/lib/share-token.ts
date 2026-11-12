import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Jetons des liens de partage (rapports de vente, comparaisons) : 24 octets aléatoires en base64url. Seule
 * leur empreinte est enregistrée ; le jeton brut n'est montré qu'une fois, à la création du lien.
 */
export function createShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Le jeton nettoyé, ou `null` s'il ne peut pas être un jeton de partage (rien n'est alors lu en base). */
export function normalizeShareToken(value: string): string | null {
  const token = value.trim();
  return /^[A-Za-z0-9_-]{24,120}$/.test(token) ? token : null;
}
