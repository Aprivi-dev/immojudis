/**
 * Journal d'une erreur serveur des routes publiques de l'agent d'information, sans donnée
 * personnelle : le message d'une erreur de base ou de fournisseur peut citer une adresse email, un
 * nom ou un chemin de fichier. Seuls le type, le code et le statut sont conservés.
 */
export function logInformationAgentRouteError(
  scope: string,
  error: unknown,
  extra: Record<string, string | number | boolean | null> = {},
): void {
  const detail = error as { name?: unknown; code?: unknown; status?: unknown } | null;
  const text = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value).slice(0, 60) : null;
  console.error(
    JSON.stringify({
      scope,
      level: "error",
      errorName: text(detail?.name) ?? typeof error,
      errorCode: text(detail?.code),
      errorStatus: text(detail?.status),
      ...extra,
    }),
  );
}
