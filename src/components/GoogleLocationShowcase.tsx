import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import Axis3d from "lucide-react/dist/esm/icons/axis-3-d.js";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Maximize2 from "lucide-react/dist/esm/icons/maximize-2.js";
import Pause from "lucide-react/dist/esm/icons/pause.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import Satellite from "lucide-react/dist/esm/icons/satellite.js";
import type { AuctionSale } from "@/lib/types";
import { getNearbySales } from "@/lib/queries";
import { haversineKm } from "@/lib/geo";
import { formatDate, formatPrice, formatSurface, propertyTypeLabel } from "@/lib/format";
import { googleMapsUrl, loadGoogleMaps } from "@/lib/google-maps";
import { cn } from "@/lib/utils";

const DVF_RADIUS_M = 500;
const NEARBY_RADIUS_KM = 0.2;
const STREET_VIEW_RADIUS_M = 90;

type ViewMode = "aerial" | "street" | "market";
type MapLayer = google.maps.Marker | google.maps.Circle;

const MODES: Array<{
  id: ViewMode;
  label: string;
  description: string;
  icon: typeof Axis3d;
}> = [
  {
    id: "aerial",
    label: "Vue 3D",
    description: "Lecture aérienne du bâtiment et de la rue.",
    icon: Axis3d,
  },
  {
    id: "street",
    label: "Façade",
    description: "Immersion Street View si disponible.",
    icon: Camera,
  },
  {
    id: "market",
    label: "Ventes proches",
    description: "Repères Immojudis autour de l'adresse.",
    icon: Satellite,
  },
];

function saleAddress(sale: AuctionSale) {
  return [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
}

function scoreColor(score: number | null | undefined): string {
  if (score == null) return "#f2c487";
  if (score >= 80) return "#16c784";
  if (score >= 60) return "#63b3ff";
  if (score >= 40) return "#f2c487";
  return "#f97373";
}

function markerIcon(googleApi: typeof google, color: string, size: number): google.maps.Icon {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">
      <defs>
        <filter id="shadow" x="-45%" y="-30%" width="190%" height="190%">
          <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#000" flood-opacity=".36"/>
        </filter>
      </defs>
      <path filter="url(#shadow)" d="M24 4c-8.28 0-15 6.52-15 14.56 0 10.92 15 25.44 15 25.44s15-14.52 15-25.44C39 10.52 32.28 4 24 4Z" fill="${color}"/>
      <circle cx="24" cy="18.5" r="6.5" fill="#09090b" opacity=".82"/>
      <circle cx="24" cy="18.5" r="3.5" fill="#f8efe1"/>
    </svg>`;

  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new googleApi.maps.Size(size, size),
    anchor: new googleApi.maps.Point(size / 2, size - 3),
  };
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}

export function GoogleLocationShowcase({ sale, apiKey }: { sale: AuctionSale; apiKey: string }) {
  const lat = sale.latitude;
  const lng = sale.longitude;
  const address = saleAddress(sale);
  const title = sale.title ?? propertyTypeLabel(sale.property_type);
  const reducedMotion = useReducedMotion();
  const [mode, setMode] = useState<ViewMode>("aerial");
  const [isRotating, setIsRotating] = useState(!reducedMotion);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [streetState, setStreetState] = useState<
    "idle" | "loading" | "ready" | "missing" | "error"
  >("idle");
  const [streetDescription, setStreetDescription] = useState<string | null>(null);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const streetContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const streetRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const mapLayersRef = useRef<MapLayer[]>([]);

  const { data: nearby = [] } = useQuery({
    queryKey: ["nearby-sales-google", sale.id, lat, lng],
    queryFn: () =>
      lat != null && lng != null
        ? getNearbySales(lat, lng, NEARBY_RADIUS_KM, sale.id, 30)
        : Promise.resolve([]),
    enabled: lat != null && lng != null,
    staleTime: 5 * 60_000,
  });

  const filteredNearby = useMemo(() => {
    if (lat == null || lng == null) return [];
    return nearby.filter((s) => {
      if (s.latitude == null || s.longitude == null) return false;
      return haversineKm({ lat, lng }, { lat: s.latitude, lng: s.longitude }) <= NEARBY_RADIUS_KM;
    });
  }, [lat, lng, nearby]);

  useEffect(() => {
    if (reducedMotion) setIsRotating(false);
  }, [reducedMotion]);

  useEffect(() => {
    if (lat == null || lng == null || mode !== "aerial" || !mapContainerRef.current) return;

    let cancelled = false;

    loadGoogleMaps(apiKey)
      .then((googleApi) => {
        if (cancelled || !mapContainerRef.current) return;

        const center = { lat, lng };

        if (!mapRef.current) {
          mapRef.current = new googleApi.maps.Map(mapContainerRef.current, {
            backgroundColor: "#09090b",
            center,
            clickableIcons: false,
            disableDefaultUI: true,
            fullscreenControl: true,
            gestureHandling: "greedy",
            heading: 34,
            keyboardShortcuts: false,
            mapTypeControl: false,
            mapTypeId: "satellite",
            rotateControl: false,
            scaleControl: false,
            streetViewControl: false,
            tilt: 45,
            zoom: 18,
            zoomControl: true,
          });
        } else {
          mapRef.current.setCenter(center);
          mapRef.current.setZoom(18);
          mapRef.current.setTilt(45);
        }

        mapLayersRef.current.forEach((layer) => layer.setMap(null));
        mapLayersRef.current = [];

        mapLayersRef.current.push(
          new googleApi.maps.Circle({
            center,
            clickable: false,
            fillColor: "#f2c487",
            fillOpacity: 0.08,
            map: mapRef.current,
            radius: DVF_RADIUS_M,
            strokeColor: "#f2c487",
            strokeOpacity: 0.65,
            strokeWeight: 1,
          }),
        );

        mapLayersRef.current.push(
          new googleApi.maps.Marker({
            icon: markerIcon(googleApi, scoreColor(sale.investment_score), 48),
            map: mapRef.current,
            optimized: true,
            position: center,
            title,
            zIndex: 100,
          }),
        );

        for (const nearbySale of filteredNearby.slice(0, 12)) {
          if (nearbySale.latitude == null || nearbySale.longitude == null) continue;
          mapLayersRef.current.push(
            new googleApi.maps.Marker({
              icon: markerIcon(googleApi, scoreColor(nearbySale.investment_score), 30),
              map: mapRef.current,
              optimized: true,
              position: { lat: nearbySale.latitude, lng: nearbySale.longitude },
              title: nearbySale.title ?? propertyTypeLabel(nearbySale.property_type),
              zIndex: 40,
            }),
          );
        }

        setMapReady(true);
        setMapError(null);
      })
      .catch((error) => {
        if (!cancelled) {
          setMapError(error instanceof Error ? error.message : "Google Maps est indisponible.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, filteredNearby, lat, lng, mode, sale.investment_score, title]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || mode !== "aerial" || !isRotating || reducedMotion) return;

    let frame = 0;
    let previous = performance.now();
    const animate = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.08);
      previous = now;
      const currentHeading = mapRef.current?.getHeading() ?? 0;
      mapRef.current?.setHeading((currentHeading + delta * 4.5) % 360);
      frame = window.requestAnimationFrame(animate);
    };

    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [isRotating, mapReady, mode, reducedMotion]);

  useEffect(() => {
    if (lat == null || lng == null || mode !== "street" || !streetContainerRef.current) return;
    if (streetRef.current) {
      streetRef.current.setVisible(true);
      return;
    }

    let cancelled = false;
    setStreetState("loading");

    loadGoogleMaps(apiKey)
      .then((googleApi) => {
        if (cancelled || !streetContainerRef.current) return;

        const service = new googleApi.maps.StreetViewService();
        const center = { lat, lng };
        service.getPanorama(
          {
            location: center,
            preference: googleApi.maps.StreetViewPreference.NEAREST,
            radius: STREET_VIEW_RADIUS_M,
            source: googleApi.maps.StreetViewSource.OUTDOOR,
          },
          (data, status) => {
            if (cancelled || !streetContainerRef.current) return;
            if (status !== googleApi.maps.StreetViewStatus.OK || !data?.location?.latLng) {
              setStreetState("missing");
              return;
            }

            const heading = googleApi.maps.geometry.spherical.computeHeading(
              data.location.latLng,
              center,
            );

            streetRef.current = new googleApi.maps.StreetViewPanorama(streetContainerRef.current, {
              addressControl: false,
              clickToGo: true,
              disableDefaultUI: false,
              fullscreenControl: true,
              imageDateControl: true,
              linksControl: true,
              motionTracking: false,
              motionTrackingControl: false,
              panControl: false,
              position: data.location.latLng,
              pov: { heading, pitch: 0 },
              scrollwheel: false,
              showRoadLabels: true,
              visible: true,
              zoomControl: true,
            });
            setStreetDescription(data.location.description ?? null);
            setStreetState("ready");
          },
        );
      })
      .catch(() => {
        if (!cancelled) setStreetState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, lat, lng, mode]);

  if (lat == null || lng == null) {
    return (
      <section className="liquid-panel rounded-lg p-5">
        <h2 className="text-lg font-semibold">Adresse & environnement</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Coordonnées GPS indisponibles pour ce bien.
        </p>
      </section>
    );
  }

  return (
    <section className="liquid-panel overflow-hidden rounded-lg">
      <div className="border-b border-white/10 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
              Adresse & environnement
            </p>
            <h2 className="mt-2 font-display text-2xl leading-tight text-foreground">
              Comprendre l'adresse en 30 secondes
            </h2>
            <p className="mt-2 flex max-w-2xl items-start gap-2 text-sm text-muted-foreground">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
              <span>{address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`}</span>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link
              to="/map"
              search={{
                around_address: address,
                around_radius: 5,
              }}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 text-xs font-semibold text-muted-foreground transition-colors hover:border-gold/40 hover:text-gold-soft"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Carte complète
            </Link>
            <a
              href={googleMapsUrl(lat, lng, address)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 text-xs font-semibold text-gold-soft transition-colors hover:bg-gold/16"
            >
              Google Maps
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="relative min-h-[430px] border-b border-white/10 bg-black/30 lg:border-b-0 lg:border-r">
          <div className="absolute left-4 right-4 top-4 z-10 flex flex-wrap gap-2">
            {MODES.map((item) => {
              const Icon = item.icon;
              const selected = mode === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setMode(item.id)}
                  className={cn(
                    "inline-flex h-10 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors backdrop-blur-xl",
                    selected
                      ? "border-gold/50 bg-gold text-background shadow-lg shadow-gold/10"
                      : "border-white/10 bg-background/65 text-muted-foreground hover:border-gold/35 hover:text-gold-soft",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>

          <div
            ref={mapContainerRef}
            className={cn(
              "absolute inset-0 transition-opacity duration-300",
              mode === "aerial" ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />

          <div
            ref={streetContainerRef}
            className={cn(
              "absolute inset-0 transition-opacity duration-300",
              mode === "street" ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />

          {mode === "market" && (
            <div className="absolute inset-0 overflow-y-auto bg-[radial-gradient(circle_at_72%_12%,rgba(242,196,135,.14),transparent_34%),linear-gradient(135deg,rgba(20,17,15,.96),rgba(9,9,11,.98))] p-4 pt-20 sm:p-6 sm:pt-24">
              <div className="max-w-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-gold">
                  Rayon 200 m
                </p>
                <h3 className="mt-2 font-display text-2xl text-foreground">
                  Les ventes judiciaires très proches
                </h3>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Ces repères ne remplacent pas les comparables DVF, mais ils aident à situer le
                  dossier dans son environnement immédiat.
                </p>
                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  {filteredNearby.slice(0, 6).map((nearbySale) => {
                    const surface =
                      nearbySale.app_surface_m2 ??
                      nearbySale.habitable_surface_m2 ??
                      nearbySale.carrez_surface_m2;
                    return (
                      <Link
                        key={nearbySale.id}
                        to="/sales/$id"
                        params={{ id: nearbySale.id }}
                        className="liquid-panel-soft group rounded-lg p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="line-clamp-2 text-sm font-semibold text-foreground">
                              {nearbySale.title ?? propertyTypeLabel(nearbySale.property_type)}
                            </p>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {formatDate(nearbySale.sale_date)}
                            </p>
                          </div>
                          <span
                            className="rounded-full px-2 py-1 text-xs font-semibold text-background"
                            style={{ background: scoreColor(nearbySale.investment_score) }}
                          >
                            {nearbySale.investment_score != null
                              ? Math.round(nearbySale.investment_score)
                              : "?"}
                          </span>
                        </div>
                        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{formatPrice(nearbySale.starting_price_eur)}</span>
                          <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                          <span>{formatSurface(surface)}</span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
                {filteredNearby.length === 0 && (
                  <div className="mt-6 rounded-lg border border-gold/25 bg-gold/10 p-4 text-sm text-gold-soft">
                    Aucune autre vente judiciaire n'est détectée dans les 200 m. Le prix plafond
                    doit donc s'appuyer en priorité sur le marché local DVF et l'état du dossier.
                  </div>
                )}
              </div>
            </div>
          )}

          {mode === "aerial" && mapError && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/88 p-6 text-center backdrop-blur">
              <div className="max-w-sm">
                <p className="text-sm font-semibold text-foreground">Vue Google indisponible</p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{mapError}</p>
              </div>
            </div>
          )}

          {mode === "street" && streetState !== "ready" && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/88 p-6 text-center backdrop-blur">
              <div className="max-w-sm">
                <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-gold/30 bg-gold/10 text-gold">
                  <Camera className="h-5 w-5" />
                </span>
                <p className="mt-4 text-sm font-semibold text-foreground">
                  {streetState === "loading"
                    ? "Recherche de la façade..."
                    : streetState === "missing"
                      ? "Street View indisponible à cette adresse"
                      : streetState === "error"
                        ? "Street View n'a pas pu être chargé"
                        : "Sélectionnez la vue façade"}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Lorsque Google ne dispose pas d'un panorama proche, la vue aérienne reste la
                  référence visuelle principale.
                </p>
              </div>
            </div>
          )}

          {mode === "aerial" && !mapError && (
            <div className="absolute bottom-4 left-4 right-4 z-10 flex flex-wrap items-center justify-between gap-3">
              <span className="rounded-full border border-white/10 bg-background/70 px-3 py-2 text-xs text-muted-foreground backdrop-blur-xl">
                Cercle doré : rayon DVF 500 m
              </span>
              <button
                type="button"
                onClick={() => setIsRotating((current) => !current)}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-white/10 bg-background/70 px-3 text-xs font-semibold text-gold-soft backdrop-blur-xl transition-colors hover:border-gold/35"
              >
                {isRotating ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {isRotating ? "Pause" : "Rotation"}
              </button>
            </div>
          )}
        </div>

        <aside className="space-y-4 p-5 sm:p-6">
          <div className="rounded-lg border border-gold/20 bg-gold/10 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gold">
              Lecture rapide
            </p>
            <p className="mt-2 text-sm leading-6 text-gold-soft">
              On vérifie le bâtiment, l'accès rue et les repères proches avant de fixer une mise
              plafond.
            </p>
          </div>

          <div className="grid gap-3">
            {MODES.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setMode(item.id)}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    mode === item.id
                      ? "border-gold/40 bg-gold/10"
                      : "border-white/10 bg-white/[0.03] hover:border-gold/25",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Icon className="h-4 w-4 text-gold" />
                    {item.label}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {item.description}
                  </span>
                </button>
              );
            })}
          </div>

          <dl className="grid gap-3 border-t border-white/10 pt-4 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Coordonnées</dt>
              <dd className="text-right font-medium text-foreground">
                {lat.toFixed(5)}, {lng.toFixed(5)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Ventes proches</dt>
              <dd className="font-medium text-foreground">{filteredNearby.length}</dd>
            </div>
            {streetState === "ready" && streetDescription && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Street View</dt>
                <dd className="text-right font-medium text-foreground">{streetDescription}</dd>
              </div>
            )}
          </dl>
        </aside>
      </div>
    </section>
  );
}
