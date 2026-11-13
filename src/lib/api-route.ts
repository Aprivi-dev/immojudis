import "server-only";
import { NextResponse } from "next/server";
import {
  type ApiRequestContext,
  apiError,
  createApiRequestContext,
  withApiHeaders,
} from "@/lib/api-observability";

/** En-têtes d'une réponse propre au compte qui l'a demandée : jamais gardée par un cache partagé. */
const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
  vary: "authorization",
} as const;

export type ApiRouteOptions = {
  /** Nom de la route dans les journaux (`api.favorites`, `v1.sales.land-report`…). */
  scope: string;
  /** Message rendu pour une erreur qui n'en a pas de public. */
  fallbackMessage: string;
  /** Statut d'une erreur inconnue (500 par défaut ; 503 pour un service de lecture indisponible). */
  fallbackStatus?: number;
  /**
   * Forme de succès vide fusionnée dans le corps d'erreur, pour les clients qui lisent un champ
   * (`{ favorites: [] }`). Jamais de détail d'erreur ici.
   */
  emptyBody?: Record<string, unknown>;
  /**
   * API publique versionnée (`/api/v1`) : les messages métier levés comme simples `Error` ne sont
   * pas rendus (contrat historique, message générique). Les erreurs typées le sont toujours.
   */
  versionedApi?: boolean;
  /** En-têtes posés sur toutes les réponses de la route, erreurs comprises (`x-robots-tag`…). */
  headers?: Record<string, string>;
};

export type ApiRouteContext<Params> = {
  /** Contexte de corrélation : `requestId`, durée, quota (`enforceUserRateLimit(…, { context })`). */
  api: ApiRequestContext;
  params: Params;
};

type NextRouteContext<Params> = { params: Promise<Params> };

/**
 * Enveloppe commune des routes `/api` : le contexte de requête est créé à l'entrée, le succès et
 * l'erreur sont journalisés une fois avec la durée réelle et portent `x-request-id`, et une réponse
 * sans `cache-control` posé par la route est privée (`private, no-store`, `vary: authorization`).
 *
 * Le handler rend une `Response` (en-têtes propres, fichier, redirection) ou un corps JSON.
 */
export function apiRoute<Params = Record<string, never>>(
  options: ApiRouteOptions,
  handler: (request: Request, route: ApiRouteContext<Params>) => Promise<Response | object>,
): (request: Request, routeContext?: NextRouteContext<Params>) => Promise<Response> {
  return async (request, routeContext) => {
    const api = createApiRequestContext(request, options.scope);
    try {
      const params = ((await routeContext?.params) ?? {}) as Params;
      const result = await handler(request, { api, params });
      const response = result instanceof Response ? result : NextResponse.json(result);
      if (!response.headers.has("cache-control")) {
        for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
          response.headers.set(name, value);
        }
      }
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        response.headers.set(name, value);
      }
      // Une réponse gardée par un cache partagé ne répète pas l'identifiant de la première requête.
      const shared = /\bpublic\b|s-maxage/.test(response.headers.get("cache-control") ?? "");
      return withApiHeaders(response, api, { echoRequestId: !shared });
    } catch (error) {
      const response = apiError(error, api, {
        fallbackMessage: options.fallbackMessage,
        fallbackStatus: options.fallbackStatus,
        extra: options.emptyBody,
        exposeBusinessMessages: !options.versionedApi,
      });
      for (const [name, value] of Object.entries({
        ...PRIVATE_NO_STORE_HEADERS,
        ...options.headers,
      })) {
        response.headers.set(name, value);
      }
      return response;
    }
  };
}
