"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as MapboxGL from "mapbox-gl";
import Pause from "lucide-react/dist/esm/icons/pause.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.js";
import {
  MAPBOX_COPYRIGHT_URL,
  MAPBOX_SATELLITE_ATTRIBUTION,
  MAPBOX_SATELLITE_IMAGERY_DATE_NOTICE,
  disableMapboxTelemetry,
  getMapboxAccessToken,
  mapboxLocaleFr,
  mapboxStaticImageUrl,
} from "@/lib/mapbox";
import { uncertaintyCircle, uncertaintyOverlay } from "@/lib/mapbox-accuracy";
import { addMapboxBuildingVolumes } from "@/lib/mapbox-preview";
import { mapLoadNeedsGesture, type AerialOrbitTarget } from "@/lib/sale-aerial-orbit";
import { cn } from "@/lib/utils";

const ORBIT_STYLE = "mapbox://styles/mapbox/standard-satellite";
// Quelques pâtés de maisons autour du repère : assez près pour reconnaître l'immeuble, assez loin
// pour situer la rue et le voisinage.
const ORBIT_ZOOM = 16.4;
const ORBIT_PITCH = 60;
/** Un tour complet en une minute : assez lent pour lire le voisinage. */
const ORBIT_DEGREES_PER_SECOND = 6;
/** La rotation s'arrête après deux tours ; « Reprendre la rotation » la relance. */
const ORBIT_MAX_DEGREES = 720;
/** Plafond d'images par seconde : la rotation est lente, 30 images/s suffisent à la lisser. */
const ORBIT_MAX_FPS = 30;
/** Au-delà, la carte est abandonnée au profit de l'image d'attente. */
export const ORBIT_LOAD_TIMEOUT_MS = 12_000;
const DEM_SOURCE = "immojudis-orbit-dem";
const ACCURACY_ID = "immojudis-orbit-accuracy";
/** Posé par Radix (react-remove-scroll) sur `<body>` tant qu'une fenêtre modale est ouverte. */
const SCROLL_LOCK_ATTRIBUTE = "data-scroll-locked";

type OrbitStatus = "poster" | "loading" | "ready" | "error";

function reducedMotionQuery() {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
}

/**
 * Visuel principal de la fiche quand la position est sûre : une vue aérienne Mapbox qui tourne
 * lentement autour du repère du bien. L'image satellite fixe s'affiche d'abord (elle sert aussi de
 * repli) ; la carte animée n'est chargée qu'au premier passage du visuel à l'écran sur ordinateur, et
 * seulement au geste (bouton « Lancer la vue 360° ») sur mobile, avec l'économiseur de données, sur un
 * réseau 2G ou 3G, ou si l'utilisateur demande moins d'animations. Une fois chargée, elle reste en place : la
 * rotation s'arrête hors de l'écran, sous une fenêtre modale, après deux tours ou à la demande,
 * mais la carte n'est pas rechargée (chaque chargement compte). En `publicDemo` (page d'exemple),
 * la carte n'est jamais chargée : l'image fixe suffit.
 */
export function AerialOrbitHero({
  target,
  title,
  className,
  publicDemo = false,
  startImmediately = false,
}: {
  target: AerialOrbitTarget;
  title: string;
  className?: string;
  publicDemo?: boolean;
  /** Le visiteur vient de choisir « Vue 360° » : ce geste vaut demande de chargement. */
  startImmediately?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxGL.Map | null>(null);
  const rotatedRef = useRef(0);
  const [status, setStatus] = useState<OrbitStatus>("poster");
  const [requested, setRequested] = useState(startImmediately);
  // Intention de l'utilisateur (pause / reprise), distincte des conditions du moment.
  const [playing, setPlaying] = useState(true);
  const [finished, setFinished] = useState(false);
  const [inView, setInView] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  // Un clic sur « Lancer / Reprendre » vaut accord pour l'animation malgré le mouvement réduit.
  const [motionConsent, setMotionConsent] = useState(startImmediately);
  // Image à noms de rues ; si Mapbox la refuse, l'imagerie seule la remplace.
  const [plainPoster, setPlainPoster] = useState(false);
  const token = getMapboxAccessToken();
  const { lat, lng, address, accuracyMeters } = target;

  const poster = mapboxStaticImageUrl({
    lat,
    lng,
    zoom: 16.5,
    width: 1280,
    height: 720,
    // L'image d'attente est l'élément le plus grand de la page : @1x et WebP, soit 150 à 250 Ko
    // au lieu de 900 Ko en JPEG @2x pour un cadre de 400 à 600 px.
    pixelRatio: 1,
    format: "webp",
    style: plainPoster ? "mapbox/satellite-v9" : "mapbox/satellite-streets-v12",
    overlay: uncertaintyOverlay(lat, lng, accuracyMeters),
  });
  const posterAlt = `Vue aérienne autour de l’adresse ${address}, avec la position approximative de « ${title} »`;

  // Préférence de mouvement réduit, suivie en direct.
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches);
      // Le nouveau réglage prime sur un accord donné avant.
      if (event.matches) setMotionConsent(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Onglet masqué et fenêtre modale ouverte : la rotation attend.
  useEffect(() => {
    const onVisibility = () => setTabHidden(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    const readLock = () => setModalOpen(document.body.hasAttribute(SCROLL_LOCK_ATTRIBUTE));
    readLock();
    const observer =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(readLock);
    observer?.observe(document.body, {
      attributes: true,
      attributeFilter: [SCROLL_LOCK_ATTRIBUTE],
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, []);

  const loadAutomatically = !publicDemo && !reducedMotion;
  useEffect(() => {
    const root = rootRef.current;
    if (publicDemo || !root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = Boolean(entry?.isIntersecting);
        setInView(visible);
        if (visible && loadAutomatically && !mapLoadNeedsGesture()) setRequested(true);
      },
      { threshold: 0.2 },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [publicDemo, loadAutomatically]);

  const shouldLoad = !publicDemo && Boolean(token) && requested;

  useEffect(() => {
    const container = containerRef.current;
    if (!shouldLoad || !container) return;

    let cancelled = false;
    let mapLoaded = false;
    let disposed = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let map: MapboxGL.Map | null = null;
    let marker: MapboxGL.Marker | null = null;
    let resizeObserver: ResizeObserver | null = null;
    setStatus("loading");

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (timeoutId) clearTimeout(timeoutId);
      resizeObserver?.disconnect();
      marker?.remove();
      map?.remove();
      mapRef.current = null;
    };
    // Retour à l'image d'attente : la carte est démontée pour libérer son contexte WebGL.
    const fallBackToPoster = () => {
      if (cancelled) return;
      setStatus("error");
      dispose();
    };

    void import("mapbox-gl")
      .then((module) => {
        if (cancelled || !container.isConnected) return;
        const mapboxgl = module.default;
        disableMapboxTelemetry(mapboxgl);
        mapboxgl.accessToken = token;

        const instance = new mapboxgl.Map({
          accessToken: token,
          antialias: true,
          attributionControl: true,
          bearing: 0,
          center: [lng, lat],
          config: {
            basemap: { showPointOfInterestLabels: false, showTransitLabels: false },
          },
          container,
          // Visuel d'en-tête : il ne capte ni le défilement ni le balayage sur mobile. La
          // navigation libre reste dans la vue « Quartier 3D ».
          interactive: false,
          locale: mapboxLocaleFr(`Vue aérienne autour de ${address}`),
          pitch: ORBIT_PITCH,
          style: ORBIT_STYLE,
          zoom: ORBIT_ZOOM,
        });
        map = instance;
        mapRef.current = instance;
        const canvas = instance.getCanvas();
        // Le canevas ne se lit pas : l'image d'attente porte la description de la vue.
        canvas.setAttribute("aria-hidden", "true");
        canvas.addEventListener("webglcontextlost", fallBackToPoster);
        // La carte mesure son conteneur à sa création ; le visuel peut encore prendre sa hauteur
        // finale ensuite (feuilles de style chargées après coup). Sans ce suivi, elle restait à
        // 300 px de haut dans un cadre de près de 600.
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => instance.resize());
          resizeObserver.observe(container);
        }

        marker = new mapboxgl.Marker({ element: orbitPin(), anchor: "bottom" })
          .setLngLat([lng, lat])
          .addTo(instance);

        timeoutId = setTimeout(() => {
          if (!mapLoaded) fallBackToPoster();
        }, ORBIT_LOAD_TIMEOUT_MS);

        instance.on("load", () => {
          if (cancelled || disposed) return;
          mapLoaded = true;
          if (timeoutId) clearTimeout(timeoutId);
          if (!instance.getSource(DEM_SOURCE)) {
            instance.addSource(DEM_SOURCE, {
              type: "raster-dem",
              url: "mapbox://mapbox.mapbox-terrain-dem-v1",
              tileSize: 512,
              maxzoom: 14,
            });
            instance.setTerrain({ source: DEM_SOURCE, exaggeration: 1.1 });
          }
          addMapboxBuildingVolumes(instance);
          instance.addSource(ACCURACY_ID, {
            type: "geojson",
            data: {
              type: "Feature",
              properties: {},
              geometry: uncertaintyCircle(lat, lng, accuracyMeters),
            },
          });
          instance.addLayer({
            id: ACCURACY_ID,
            type: "fill",
            source: ACCURACY_ID,
            paint: {
              "fill-color": "#ffffff",
              "fill-opacity": 0.2,
              "fill-outline-color": "#ffffff",
            },
          });
          setStatus("ready");
        });
        instance.on("error", () => {
          // Une tuile manquante n'empêche pas la vue ; seule une carte jamais chargée fait repli.
          if (!mapLoaded) fallBackToPoster();
        });
      })
      .catch(() => {
        fallBackToPoster();
      });

    return () => {
      cancelled = true;
      dispose();
    };
  }, [shouldLoad, lat, lng, token, address, accuracyMeters]);

  // Rotation : la boucle n'existe que tant que toutes les conditions sont réunies, et se défait
  // d'elle-même dès que l'une tombe (hors écran, pause, modale, onglet masqué, mouvement réduit).
  const motionAllowed = !reducedMotion || motionConsent;
  const rotating =
    status === "ready" &&
    playing &&
    !finished &&
    inView &&
    !tabHidden &&
    !modalOpen &&
    motionAllowed;
  useEffect(() => {
    if (!rotating) return;
    let frameId = 0;
    let last = 0;
    const step = (now: number) => {
      const map = mapRef.current;
      if (!map) return;
      frameId = window.requestAnimationFrame(step);
      if (last && now - last < 1000 / ORBIT_MAX_FPS - 1) return;
      const delta = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      const degrees = delta * ORBIT_DEGREES_PER_SECOND;
      rotatedRef.current += degrees;
      map.rotateTo((map.getBearing() + degrees) % 360, { duration: 0 });
      if (rotatedRef.current >= ORBIT_MAX_DEGREES) {
        window.cancelAnimationFrame(frameId);
        setFinished(true);
      }
    };
    frameId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frameId);
  }, [rotating]);

  const mapShown = status === "ready";
  const togglePlaying = useCallback(() => {
    if (status === "loading") return;
    if (status === "poster") {
      setRequested(true);
      setPlaying(true);
      setMotionConsent(true);
      return;
    }
    if (playing && !finished && motionAllowed) {
      setPlaying(false);
      return;
    }
    rotatedRef.current = 0;
    setFinished(false);
    setPlaying(true);
    setMotionConsent(true);
  }, [finished, motionAllowed, playing, status]);

  const pausable = status === "ready" && playing && !finished && motionAllowed;
  const loading = status === "loading";

  return (
    <div
      ref={rootRef}
      data-orbit-status={status}
      className={cn("relative w-full overflow-hidden bg-night", className)}
    >
      {/* Le bouton précède la carte dans le DOM (ses liens de crédits viennent après lui) ; sa
          place à l'écran ne change pas. Pas de bouton en démonstration publique, ni sans la carte. */}
      {token && !publicDemo && status !== "error" ? (
        <button
          type="button"
          onClick={togglePlaying}
          disabled={loading}
          className="absolute right-3 top-3 z-10 inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-night focus-visible:ring-2 focus-visible:ring-white disabled:cursor-wait disabled:opacity-80 md:right-4 md:top-4"
        >
          {pausable ? (
            <>
              <Pause className="h-4 w-4" aria-hidden />
              Mettre en pause
            </>
          ) : loading ? (
            <>
              <RotateCw className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Chargement de la vue…
            </>
          ) : (
            <>
              <Play className="h-4 w-4" aria-hidden />
              {status === "ready" ? "Reprendre la rotation" : "Lancer la vue 360°"}
            </>
          )}
        </button>
      ) : null}

      <div className="absolute inset-0">
        {poster ? (
          <img
            src={poster}
            alt={posterAlt}
            fetchPriority="high"
            decoding="async"
            onError={() => setPlainPoster(true)}
            className={cn(
              "absolute inset-0 h-full w-full object-cover transition-opacity duration-700",
              mapShown ? "opacity-0" : "opacity-100",
            )}
          />
        ) : null}
        {/* La feuille de style de Mapbox impose `position: relative` au conteneur de la carte : il
            prend donc la taille de ce cadre (h-full) au lieu d'être positionné lui-même. `inert`
            tant que la carte n'est pas prête : rien n'y est focalisable ni lu avant. */}
        <div
          inert={!mapShown}
          className={cn(
            "absolute inset-0 transition-opacity duration-700",
            mapShown ? "opacity-100" : "opacity-0",
          )}
        >
          <div ref={containerRef} data-testid="aerial-orbit-map" className="h-full w-full" />
        </div>
      </div>

      {poster && !mapShown ? (
        // Les crédits de l'image fixe, hors de l'image : `object-cover` rogne ceux qu'elle porte.
        <a
          href={MAPBOX_COPYRIGHT_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="aerial-orbit-attribution"
          className="absolute bottom-1 right-1 z-10 max-w-[calc(100%-0.5rem)] rounded bg-night/85 px-1.5 py-0.5 text-xs font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {MAPBOX_SATELLITE_ATTRIBUTION} · {MAPBOX_SATELLITE_IMAGERY_DATE_NOTICE}
        </a>
      ) : null}

      <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1 md:left-4 md:top-4">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-white/20 bg-night/85 px-2.5 py-1 text-xs font-semibold text-white shadow-lg backdrop-blur">
          <RotateCw className="h-3 w-3" aria-hidden />
          Vue aérienne 360°
        </span>
        <span className="w-fit rounded-full bg-night/85 px-2.5 py-0.5 text-xs text-white backdrop-blur">
          Position approximative
        </span>
        {mapShown ? (
          <span className="w-fit rounded-full bg-night/85 px-2.5 py-0.5 text-xs text-white backdrop-blur">
            3D schématique : hauteurs des bâtiments estimées
          </span>
        ) : null}
      </div>

      {loading ? (
        <span className="sr-only" role="status">
          Chargement de la vue aérienne…
        </span>
      ) : null}
    </div>
  );
}

/** Petit repère en goutte (contour blanc, ombre portée) : le cercle d'incertitude dit la précision. */
function orbitPin() {
  const pin = document.createElement("span");
  pin.className = "pointer-events-none block drop-shadow-lg";
  pin.setAttribute("aria-hidden", "true");
  pin.innerHTML =
    '<svg width="24" height="32" viewBox="0 0 38 50" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M19 48C19 48 3 30.6 3 18.5C3 9.4 10.2 2 19 2s16 7.4 16 16.5C35 30.6 19 48 19 48Z" style="fill:var(--brand-navy);stroke:#fff;stroke-width:3"/>' +
    '<circle cx="19" cy="18.5" r="6" style="fill:var(--gold-soft)"/></svg>';
  return pin;
}
