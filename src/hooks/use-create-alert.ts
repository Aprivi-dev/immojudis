"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { enableAlertEmailRecap } from "@/components/search/alert-email-consent";
import { useAuth } from "@/hooks/use-auth";
import {
  createWatchedZone as createWatchedZoneRequest,
  fetchAccessPlan,
  fetchNotificationPreferences,
} from "@/lib/client-api";
import { departmentFromSearchQuery } from "@/lib/alerts";
import { ALERT_CREATION_PATH } from "@/lib/discovery-alerts";
import type { GeoPoint } from "@/lib/geo";
import { OFFERS_PATH, loginPathWithRedirect } from "@/lib/navigation";
import { trackProductEvent } from "@/lib/product-events";
import { queryKeys } from "@/lib/query-keys";
import { savePendingAlert } from "@/lib/pending-alert";
import { createAlert } from "@/lib/queries";
import {
  countAlertableSearchFilters,
  hasUnalertableSearchFilters,
} from "@/lib/search/search-filters";
import { isAnalysisOfferOpen } from "@/lib/search/analysis-offer-open";
import type { SalesSearchParams } from "@/lib/search/search-url-state";
import { userMessage } from "@/lib/user-messages";

export type CreateAlertOptions = {
  frequency?: "daily" | "weekly";
  /** Case « email récapitulatif » cochée : le consentement est donné à la création de l'alerte. */
  emailRecap?: boolean;
  /** Nom de l'alerte quand celui construit à partir des critères ne convient pas. */
  name?: string;
  /** Critères dont on tire le nom quand `name` n'est pas donné (par défaut, ceux de l'alerte). */
  nameSearch?: SalesSearchParams;
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
        // ramène la personne sur sa recherche. La demande est gardée pour être créée à la
        // connexion (`PendingAlertRunner`), sauf depuis la page de confirmation d'une alerte
        // (`/alertes/creer`) : la personne y retrouve ses critères et confirme elle-même.
        if (
          countAlertableSearchFilters(search) > 0 &&
          !(returnTo ?? "").startsWith(ALERT_CREATION_PATH)
        ) {
          savePendingAlert(search, options);
        }
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
      // « Sous la fourchette » et « Sans point à vérifier » ne sont pas des critères d'alerte : une
      // recherche qui n'a qu'eux ne donnerait aucun critère, et sinon ils seraient ignorés sans le dire.
      if (countAlertableSearchFilters(search) === 0) {
        toast.error(
          hasUnalertableSearchFilters(search)
            ? "Les filtres « sous la fourchette » et « sans point à vérifier » ne sont pas encore proposés dans les alertes. Ajoutez un autre filtre avant d'enregistrer."
            : "Ajoutez au moins un filtre avant d'enregistrer",
        );
        return { status: "blocked" };
      }

      // Un code de département tapé dans la recherche texte est un filtre département, comme dans
      // le catalogue : il n'est pas gardé comme texte libre (que l'évaluation n'applique pas). Seul
      // le texte restant est un critère avancé : le contrôle de l'offre gratuite porte sur lui.
      const queryDepartment = search.department ? null : departmentFromSearchQuery(search.query);
      const residualQuery = queryDepartment ? null : search.query;
      if (
        !entitlements.plan.hasAnalysisAccess &&
        (residualQuery ||
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
        // Chargé à la demande : ce module (géocodage, filtres du catalogue) est lourd, et les pages
        // qui créent une alerte (accueil du compte, départements) n'ont pas à l'embarquer d'office.
        const { buildAlertName, watchedZoneInputFromSearch } =
          await import("@/components/search/search-page-state");
        const watchedZonesLocked = entitlements.plan.features.watchedZones === "locked";
        const watchedZoneInput = watchedZonesLocked
          ? null
          : await watchedZoneInputFromSearch(search, center);
        const watchedZoneResponse = watchedZoneInput
          ? await createWatchedZoneRequest({ data: watchedZoneInput })
          : null;

        await createAlert(user.id, {
          name: options.name ?? buildAlertName(options.nameSearch ?? search),
          department: search.department || queryDepartment || null,
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
            query: residualQuery ?? null,
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
        if (hasUnalertableSearchFilters(search)) {
          toast.message(
            "Les filtres « sous la fourchette » et « sans point à vérifier » ne sont pas enregistrés dans l'alerte.",
          );
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

  /** Les droits du compte sont lus : une création lancée maintenant ne sera pas refusée « en cours ». */
  const ready = Boolean(user) && !authLoading && !entitlementsLoading && Boolean(entitlements);

  return { createAlertFromSearch, saving, emailRecapEnabled, ready };
}
