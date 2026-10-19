"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { enableAlertEmailRecap } from "@/components/search/alert-email-consent";
import { buildAlertName, watchedZoneInputFromSearch } from "@/components/search/search-page-state";
import { useAuth } from "@/hooks/use-auth";
import {
  createWatchedZone as createWatchedZoneRequest,
  fetchAccessPlan,
  fetchNotificationPreferences,
} from "@/lib/client-api";
import type { GeoPoint } from "@/lib/geo";
import { OFFERS_PATH, loginPathWithRedirect } from "@/lib/navigation";
import { trackProductEvent } from "@/lib/product-events";
import { queryKeys } from "@/lib/query-keys";
import { createAlert } from "@/lib/queries";
import { isAnalysisOfferOpen } from "@/lib/search/analysis-offer-open";
import { countActiveSearchFilters } from "@/lib/search/search-filters";
import type { SalesSearchParams } from "@/lib/search/search-url-state";
import { userMessage } from "@/lib/user-messages";

export type CreateAlertOptions = {
  frequency?: "daily" | "weekly";
  /** Case « email récapitulatif » cochée : le consentement est donné à la création de l'alerte. */
  emailRecap?: boolean;
  /** Nom de l'alerte quand celui construit à partir des critères ne convient pas. */
  name?: string;
};

/**
 * Issue d'une demande d'alerte :
 * - `created` : l'alerte existe (`emailConsent` dit si l'email récapitulatif est actif) ;
 * - `login` : la personne n'est pas connectée, elle part vers la connexion (motif « alerte ») ;
 * - `blocked` : refusée avant tout envoi (compte en vérification, offre, critères) ;
 * - `failed` : la création a échoué, le message est déjà affiché.
 */
export type CreateAlertResult =
  | { status: "created"; emailConsent: boolean }
  | { status: "login" }
  | { status: "blocked" }
  | { status: "failed" };

/**
 * Création d'une alerte à partir d'une recherche : partagée par le catalogue, l'étape finale de
 * l'accueil du compte, les pages département, `/tribunaux` et les résultats vides. Les règles
 * sont celles de l'offre (alerte gratuite : critères publics seulement) ; la base les applique
 * aussi. L'email récapitulatif n'est activé que sur demande explicite (`emailRecap`), jamais par
 * défaut.
 *
 * @param returnTo adresse où ramener la personne après la connexion (son choix y est retrouvé).
 * @param center centre déjà connu d'une recherche « autour de » (évite de le géocoder).
 */
export function useCreateAlert({
  returnTo,
  center = null,
}: {
  returnTo: string | null | undefined;
  center?: GeoPoint | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, loading: authLoading } = useAuth();
  const [saving, setSaving] = useState(false);
  const { data: entitlements, isLoading: entitlementsLoading } = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(user?.id ?? "anonymous"),
    queryFn: fetchAccessPlan,
    enabled: Boolean(user) && !authLoading,
    staleTime: 5 * 60_000,
  });
  const { data: notificationPreferences } = useQuery({
    queryKey: queryKeys.notificationPreferences(user?.id ?? "anonymous"),
    queryFn: fetchNotificationPreferences,
    enabled: Boolean(user) && !authLoading,
    staleTime: 60_000,
    retry: false,
  });
  const emailRecapEnabled = notificationPreferences?.preferences.alertEmailEnabled === true;

  /** Une fonction réservée à Analyse : vers l'offre si elle est ouvrable, sinon on l'explique. */
  const explainReservedFeature = useCallback(
    async (reservedMessage: string) => {
      if (await isAnalysisOfferOpen()) {
        toast.message(reservedMessage);
        router.push(OFFERS_PATH);
        return;
      }
      toast.message(`${reservedMessage} L'abonnement Analyse n'est pas encore ouvert.`);
    },
    [router],
  );

  const createAlertFromSearch = useCallback(
    async (
      search: SalesSearchParams,
      options: CreateAlertOptions = {},
    ): Promise<CreateAlertResult> => {
      if (authLoading) {
        toast.message("Vérification de votre compte en cours. Réessayez dans un instant.");
        return { status: "blocked" };
      }
      if (!user) {
        // La première alerte est gratuite : on invite à créer un compte puis on
        // ramène la personne sur sa recherche.
        router.push(loginPathWithRedirect(returnTo, { reason: "alerte" }));
        return { status: "login" };
      }
      if (entitlementsLoading || !entitlements) {
        toast.message("Vérification de votre compte en cours. Réessayez dans un instant.");
        return { status: "blocked" };
      }
      const alertsLocked = entitlements.plan.features.smartAlerts === "locked";
      if (alertsLocked) {
        await explainReservedFeature(
          "Les alertes de cette recherche sont réservées à l'offre Analyse.",
        );
        return { status: "blocked" };
      }
      const name = options.name ?? buildAlertName(search);
      if (countActiveSearchFilters(search) === 0) {
        toast.error("Ajoutez au moins un filtre avant d'enregistrer");
        return { status: "blocked" };
      }

      if (
        !entitlements.plan.hasAnalysisAccess &&
        (search.query ||
          search.occupancy ||
          search.minScore != null ||
          search.minYield != null ||
          search.minMarketDiscount != null ||
          search.dpeClasses?.length ||
          search.houseWithLand)
      ) {
        toast.error(
          "L'alerte gratuite accepte les critères publics : zone, type de vente, type de bien, budget et surface.",
        );
        return { status: "blocked" };
      }
      setSaving(true);
      try {
        const watchedZonesLocked = entitlements.plan.features.watchedZones === "locked";
        const watchedZoneInput = watchedZonesLocked
          ? null
          : await watchedZoneInputFromSearch(search, center);
        const watchedZoneResponse = watchedZoneInput
          ? await createWatchedZoneRequest({ data: watchedZoneInput })
          : null;

        await createAlert(user.id, {
          name,
          department: search.department || null,
          city: search.city || null,
          property_type: search.homeTypes?.length === 1 ? search.homeTypes[0] : null,
          max_price_eur: search.maxPrice ?? null,
          min_surface_m2: search.minSqft ?? null,
          occupancy_status: search.occupancy || null,
          min_investment_score: search.minScore ?? null,
          max_price_per_m2: search.maxPricePerM2 ?? null,
          min_yield_pct: search.minYield ?? null,
          min_market_discount_pct: search.minMarketDiscount ?? null,
          dpe_classes: search.dpeClasses ?? [],
          require_house_with_land: Boolean(search.houseWithLand),
          alert_frequency:
            options.frequency ?? (entitlements.plan.hasAnalysisAccess ? "daily" : "weekly"),
          watched_zone_id: watchedZoneResponse?.zone.id ?? null,
          advanced_criteria: {
            source: "sales_search",
            min_sale_date: search.minSaleDate ?? null,
            max_sale_date: search.maxSaleDate ?? null,
            sale_type: search.saleType ?? null,
            query: search.query ?? null,
            around_address: search.aroundAddress ?? null,
            around_radius_km: search.aroundRadius ?? null,
            watched_zone_id: watchedZoneResponse?.zone.id ?? null,
          },
        });
        const saved = watchedZoneResponse
          ? "Zone surveillée et alerte créées"
          : "Recherche enregistrée";
        let emailConsent = emailRecapEnabled;
        if (options.emailRecap && !emailRecapEnabled) {
          // Le consentement est explicite (case non pré-cochée) et horodaté côté serveur.
          if (await enableAlertEmailRecap(queryClient, user.id)) {
            emailConsent = true;
            toast.success(`${saved}. Email récapitulatif activé.`);
          } else {
            toast.error(
              `${saved}, mais l'email récapitulatif n'a pas pu être activé. Réessayez depuis la cloche des notifications.`,
            );
          }
        } else {
          toast.success(saved);
        }
        trackProductEvent("alert_created", { email_consent: emailConsent });
        return { status: "created", emailConsent };
      } catch (saveError) {
        toast.error(userMessage(saveError));
        return { status: "failed" };
      } finally {
        setSaving(false);
      }
    },
    [
      authLoading,
      center,
      emailRecapEnabled,
      entitlements,
      entitlementsLoading,
      explainReservedFeature,
      queryClient,
      returnTo,
      router,
      user,
    ],
  );

  return { createAlertFromSearch, saving, emailRecapEnabled };
}
