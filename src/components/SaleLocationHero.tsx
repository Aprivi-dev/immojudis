import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Pause from "lucide-react/dist/esm/icons/pause.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import type { AuctionSale } from "@/lib/types";
import { getGoogleMapsApiKey, googleMapsUrl, loadGoogleMaps } from "@/lib/google-maps";
import { propertyTypeLabel } from "@/lib/format";

const STREET_VIEW_RADIUS_M = 90;
const ORBIT_DEG_PER_S = 4.5;
const AERIAL_RANGE_M = 350;
const AERIAL_TILT_DEG = 60;
const ORBIT_DURATION_MS = 60000;
const MARKER_ALTITUDE_M = 45;

type StreetState = "idle" | "loading" | "ready" | "missing" | "error";

function saleAddress(sale: AuctionSale): string {
  return [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
}

function useReducedMotion(): boolean {
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

/**
 * Hero localisation : deux tuiles Google Maps en tête de la page détail —
 * vue aérienne 3D (satellite incliné + orbite douce) et Street View. Remplace les
 * visuels extraits, sans aucune dépendance aux photos source : si la clé Maps ou
 * les coordonnées manquent, on affiche un placeholder de marque ; si Street View
 * est absent à l'adresse (fréquent en zone rurale), la tuile droite bascule sur un
 * message dédié. L'orbite respecte prefers-reduced-motion et se met en pause
 * lorsque le bloc sort de l'écran.
 */
export function SaleLocationHero({ sale }: { sale: AuctionSale }) {
  const apiKey = getGoogleMapsApiKey();
  const lat = sale.latitude;
  const lng = sale.longitude;
  const address = saleAddress(sale);
  const title = sale.title ?? propertyTypeLabel(sale.property_type);
  const reducedMotion = useReducedMotion();
  const hasMaps = Boolean(apiKey) && lat != null && lng != null;

  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [streetState, setStreetState] = useState<StreetState>("idle");
  const [isRotating, setIsRotating] = useState(!reducedMotion);
  const [isVisible, setIsVisible] = useState(true);
  const [mode3d, setMode3d] = useState(false);

  const aerialRef = useRef<HTMLDivElement>(null);
  const streetRef = useRef<HTMLDivElement>(null);
  const mapObjRef = useRef<google.maps.Map | null>(null);
  const map3dRef = useRef<google.maps.maps3d.Map3DElement | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const panoRef = useRef<google.maps.StreetViewPanorama | null>(null);
  const altitudeModeRef = useRef<typeof google.maps.maps3d.AltitudeMode | null>(null);

  useEffect(() => {
    if (reducedMotion) setIsRotating(false);
  }, [reducedMotion]);

  // Vue aérienne : Photorealistic 3D (Map3DElement) si disponible, sinon repli
  // sur le satellite incliné. Aucune dépendance aux photos source.
  useEffect(() => {
    if (!hasMaps || lat == null || lng == null || !aerialRef.current) return;
    let cancelled = false;
    const container = aerialRef.current;

    void (async () => {
      try {
        const g = await loadGoogleMaps(apiKey);
        if (cancelled || !container) return;
        const { Map3DElement, Marker3DElement, MapMode, AltitudeMode } =
          await g.maps.importLibrary("maps3d");
        if (cancelled || !container || map3dRef.current || mapObjRef.current) return;

        // L'altitude du centre doit suivre le terrain : avec altitude 0 (niveau de
        // la mer) la caméra vise un point sous le sol et ne montre que le ciel.
        let altitude = 0;
        try {
          const { ElevationService } = await g.maps.importLibrary("elevation");
          const { results } = await new ElevationService().getElevationForLocations({
            locations: [{ lat, lng }],
          });
          if (results?.[0]) altitude = results[0].elevation;
        } catch {
          // élévation indisponible → 0
        }
        if (cancelled || !container || map3dRef.current || mapObjRef.current) return;
        altitudeModeRef.current = AltitudeMode;

        const map3d = new Map3DElement({
          center: { lat, lng, altitude },
          defaultUIHidden: true,
          range: AERIAL_RANGE_M,
          tilt: AERIAL_TILT_DEG,
          heading: 0,
          mode: MapMode.HYBRID,
        });
        map3d.defaultUIHidden = true;
        map3d.setAttribute("default-ui-hidden", "true");
        map3d.style.width = "100%";
        map3d.style.height = "100%";
        container.appendChild(map3d);
        map3dRef.current = map3d;

        // Pin 3D extrudé (poteau jusqu'au sol) pour repérer le bien pendant l'orbite.
        const marker = new Marker3DElement({
          position: { lat, lng, altitude: MARKER_ALTITUDE_M },
          altitudeMode: AltitudeMode.RELATIVE_TO_GROUND,
          extruded: true,
          label: title,
        });
        map3d.append(marker);

        setMode3d(true);
        setMapReady(true);
        setMapError(false);
      } catch {
        // Map Tiles API non activée / 3D indisponible → repli satellite incliné.
        try {
          const g = await loadGoogleMaps(apiKey);
          if (cancelled || !container || mapObjRef.current) return;
          const center = { lat, lng };
          mapObjRef.current = new g.maps.Map(container, {
            backgroundColor: "#09090b",
            center,
            clickableIcons: false,
            disableDefaultUI: true,
            fullscreenControl: false,
            gestureHandling: "greedy",
            heading: 34,
            keyboardShortcuts: false,
            mapTypeId: "satellite",
            tilt: 45,
            zoom: 18,
            zoomControl: false,
          });
          markerRef.current = new g.maps.Marker({
            map: mapObjRef.current,
            position: center,
            title,
          });
          setMode3d(false);
          setMapReady(true);
          setMapError(false);
        } catch {
          if (!cancelled) setMapError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      map3dRef.current?.stopCameraAnimation();
      map3dRef.current?.remove();
      map3dRef.current = null;
      mapObjRef.current = null;
    };
  }, [apiKey, hasMaps, lat, lng, title]);

  // Orbite 3D (flyCameraAround) : boucle douce autour de l'adresse.
  useEffect(() => {
    const map3d = map3dRef.current;
    if (!mode3d || !map3d || lat == null || lng == null) return;
    if (!isRotating || reducedMotion || !isVisible) {
      map3d.stopCameraAnimation();
      return;
    }
    const orbit = () =>
      map3d.flyCameraAround({
        camera: {
          center: { lat, lng, altitude: 0 },
          altitudeMode: altitudeModeRef.current?.RELATIVE_TO_GROUND,
          tilt: AERIAL_TILT_DEG,
          range: AERIAL_RANGE_M,
          heading: 0,
        },
        durationMillis: ORBIT_DURATION_MS,
        repeatCount: 1,
      });
    orbit();
    map3d.addEventListener("gmp-animationend", orbit);
    return () => {
      map3d.removeEventListener("gmp-animationend", orbit);
      map3d.stopCameraAnimation();
    };
  }, [isRotating, isVisible, lat, lng, mode3d, reducedMotion]);

  // Orbite de repli (satellite incliné) : rotation du heading via rAF.
  useEffect(() => {
    if (mode3d || !mapReady || !mapObjRef.current || !isRotating || reducedMotion || !isVisible)
      return;
    let frame = 0;
    let previous = performance.now();
    const animate = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.08);
      previous = now;
      const heading = mapObjRef.current?.getHeading() ?? 0;
      mapObjRef.current?.setHeading((heading + delta * ORBIT_DEG_PER_S) % 360);
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [isRotating, isVisible, mapReady, mode3d, reducedMotion]);

  // Pause de l'orbite quand le hero sort du viewport (coût API + perf).
  useEffect(() => {
    const el = aerialRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), {
      threshold: 0.1,
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMaps]);

  // Street View : recherche du panorama le plus proche, sinon état "missing".
  useEffect(() => {
    if (!hasMaps || lat == null || lng == null || !streetRef.current) return;
    let cancelled = false;
    setStreetState("loading");

    loadGoogleMaps(apiKey)
      .then((g) => {
        if (cancelled || !streetRef.current) return;
        const center = { lat, lng };
        const service = new g.maps.StreetViewService();
        service.getPanorama(
          {
            location: center,
            preference: g.maps.StreetViewPreference.NEAREST,
            radius: STREET_VIEW_RADIUS_M,
            source: g.maps.StreetViewSource.OUTDOOR,
          },
          (data, status) => {
            if (cancelled || !streetRef.current) return;
            if (status !== g.maps.StreetViewStatus.OK || !data?.location?.latLng) {
              setStreetState("missing");
              return;
            }
            const heading = g.maps.geometry.spherical.computeHeading(data.location.latLng, center);
            panoRef.current = new g.maps.StreetViewPanorama(streetRef.current, {
              addressControl: false,
              disableDefaultUI: false,
              fullscreenControl: true,
              motionTracking: false,
              motionTrackingControl: false,
              panControl: false,
              position: data.location.latLng,
              pov: { heading, pitch: 0 },
              scrollwheel: false,
              showRoadLabels: false,
              visible: true,
              zoomControl: true,
            });
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
  }, [apiKey, hasMaps, lat, lng]);

  if (!hasMaps) {
    return (
      <div className="liquid-panel flex min-h-[220px] flex-col items-center justify-center rounded-lg p-8 text-center">
        <MapPin className="h-6 w-6 text-gold" />
        <p className="mt-3 text-sm font-medium text-foreground">Localisation non cartographiée</p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          La vue aérienne et Street View ne sont pas disponibles pour ce bien.
        </p>
      </div>
    );
  }

  const mapsLink = lat != null && lng != null ? googleMapsUrl(lat, lng, address) : undefined;

  return (
    <div className="grid gap-3 lg:grid-cols-[1.7fr_1fr]">
      {/* Tuile 1 — vue aérienne 3D */}
      <div className="liquid-media relative min-h-[300px] overflow-hidden rounded-lg lg:min-h-[440px]">
        <div ref={aerialRef} className="absolute inset-0" />
        <TileBadge>Vue aérienne 3D</TileBadge>
        {!reducedMotion && !mapError && (
          <button
            type="button"
            onClick={() => setIsRotating((v) => !v)}
            aria-label={isRotating ? "Mettre la rotation en pause" : "Reprendre la rotation"}
            className="absolute bottom-3 right-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-background/70 text-gold-soft backdrop-blur transition-colors hover:border-gold/40"
          >
            {isRotating ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
        )}
        {mapError && (
          <FallbackOverlay text="La vue aérienne n'a pas pu être chargée." link={mapsLink} />
        )}
      </div>

      {/* Tuile 2 — Street View */}
      <div className="liquid-media relative min-h-[260px] overflow-hidden rounded-lg lg:min-h-[440px]">
        <div ref={streetRef} className="absolute inset-0" />
        <TileBadge>Street View</TileBadge>
        {(streetState === "missing" || streetState === "error") && (
          <FallbackOverlay
            text={
              streetState === "missing"
                ? "Pas de Street View à cette adresse."
                : "Street View indisponible."
            }
            link={mapsLink}
          />
        )}
      </div>
    </div>
  );
}

function TileBadge({ children }: { children: ReactNode }) {
  return (
    <span className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-background/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-gold-soft backdrop-blur">
      {children}
    </span>
  );
}

function FallbackOverlay({ text, link }: { text: string; link?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/85 px-6 text-center backdrop-blur-sm">
      <MapPin className="h-5 w-5 text-gold" />
      <p className="text-xs text-muted-foreground">{text}</p>
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold-soft hover:text-gold"
        >
          Voir sur Google Maps <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
