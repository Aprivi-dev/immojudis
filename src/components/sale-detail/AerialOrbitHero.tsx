"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useRef, useState } from "react";
import type * as MapboxGL from "mapbox-gl";
import Pause from "lucide-react/dist/esm/icons/pause.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.js";
import {
  disableMapboxTelemetry,
  getMapboxAccessToken,
  mapboxSatelliteImageUrl,
} from "@/lib/mapbox";
import { addMapboxBuildingVolumes } from "@/lib/mapbox-preview";
import type { AerialOrbitTarget } from "@/lib/sale-aerial-orbit";
import { cn } from "@/lib/utils";

const ORBIT_STYLE = "mapbox://styles/mapbox/standard-satellite";
// Quelques pâtés de maisons autour du repère : assez près pour reconnaître l'immeuble, assez loin
// pour situer la rue et le voisinage.
const ORBIT_ZOOM = 16.4;
const ORBIT_PITCH = 60;
/** Un tour complet en une minute : assez lent pour lire le voisinage. */
const ORBIT_DEGREES_PER_SECOND = 6;
const DEM_SOURCE = "immojudis-orbit-dem";

type OrbitStatus = "poster" | "loading" | "ready" | "error";

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Visuel principal de la fiche quand la position est sûre : une vue aérienne Mapbox qui tourne
 * lentement autour du repère du bien. L'image satellite fixe s'affiche d'abord (elle sert aussi de
 * repli) ; la carte animée n'est chargée qu'au premier passage du visuel à l'écran, et seulement au
 * clic si l'utilisateur demande moins d'animations. Une fois chargée, elle reste en place : la
 * rotation s'arrête hors de l'écran mais la carte n'est pas rechargée (chaque chargement compte).
 */
export function AerialOrbitHero({
  target,
  title,
  className,
}: {
  target: AerialOrbitTarget;
  title: string;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<OrbitStatus>("poster");
  const [requested, setRequested] = useState(false);
  const [playing, setPlaying] = useState(true);
  // Lus à chaque image de l'animation, sans relancer l'effet qui crée la carte.
  const playingRef = useRef(true);
  const visibleRef = useRef(false);
  const token = getMapboxAccessToken();
  const { lat, lng, address } = target;

  const poster = mapboxSatelliteImageUrl({ lat, lng, zoom: 16.5, width: 1280, height: 720 });

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = Boolean(entry?.isIntersecting);
        if (visibleRef.current && !prefersReducedMotion()) setRequested(true);
      },
      { threshold: 0.2 },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const shouldLoad = Boolean(token) && requested;

  useEffect(() => {
    const container = containerRef.current;
    if (!shouldLoad || !container) return;

    let cancelled = false;
    let frameId = 0;
    let previous = 0;
    let mapLoaded = false;
    let map: MapboxGL.Map | null = null;
    let marker: MapboxGL.Marker | null = null;
    setStatus("loading");

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
          pitch: ORBIT_PITCH,
          style: ORBIT_STYLE,
          zoom: ORBIT_ZOOM,
        });
        map = instance;

        marker = new mapboxgl.Marker({ element: orbitPin(), anchor: "bottom" })
          .setLngLat([lng, lat])
          .addTo(instance);

        const step = (now: number) => {
          const delta = previous ? Math.min((now - previous) / 1000, 0.1) : 0;
          previous = now;
          if (playingRef.current && visibleRef.current && !document.hidden) {
            instance.rotateTo((instance.getBearing() + delta * ORBIT_DEGREES_PER_SECOND) % 360, {
              duration: 0,
            });
          }
          frameId = window.requestAnimationFrame(step);
        };

        instance.on("load", () => {
          if (cancelled) return;
          mapLoaded = true;
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
          setStatus("ready");
          frameId = window.requestAnimationFrame(step);
        });
        instance.on("error", () => {
          // Une tuile manquante n'empêche pas la vue ; seule une carte jamais chargée fait repli.
          if (!cancelled && !mapLoaded) setStatus("error");
        });
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      if (frameId) window.cancelAnimationFrame(frameId);
      marker?.remove();
      map?.remove();
    };
  }, [shouldLoad, lat, lng, token]);

  const mapShown = status === "ready";
  const started = status !== "poster";
  const togglePlaying = () => {
    const next = started ? !playing : true;
    playingRef.current = next;
    setPlaying(next);
    setRequested(true);
  };

  return (
    <div ref={rootRef} className={cn("relative w-full overflow-hidden bg-night", className)}>
      <div
        role="img"
        aria-label={`Vue aérienne autour de l’adresse ${address}, avec le repère indicatif de « ${title} »`}
        className="absolute inset-0"
      >
        {poster ? (
          <img
            src={poster}
            alt=""
            fetchPriority="high"
            decoding="async"
            className={cn(
              "absolute inset-0 h-full w-full object-cover transition-opacity duration-700",
              mapShown ? "opacity-0" : "opacity-100",
            )}
          />
        ) : null}
        {/* La feuille de style de Mapbox impose `position: relative` au conteneur de la carte : il
            prend donc la taille de ce cadre (h-full) au lieu d'être positionné lui-même. */}
        <div
          className={cn(
            "absolute inset-0 transition-opacity duration-700",
            mapShown ? "opacity-100" : "opacity-0",
          )}
        >
          <div ref={containerRef} data-testid="aerial-orbit-map" className="h-full w-full" />
        </div>
      </div>

      <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1 md:left-4 md:top-4">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-white/20 bg-night/75 px-2.5 py-1 text-[11px] font-semibold text-white shadow-lg backdrop-blur">
          <RotateCw className="h-3 w-3" aria-hidden />
          Vue aérienne 360°
        </span>
        <span className="w-fit rounded-full bg-night/60 px-2.5 py-0.5 text-[11px] text-white/80 backdrop-blur">
          Repère indicatif d’après l’adresse
        </span>
      </div>

      {token && status !== "error" ? (
        <button
          type="button"
          onClick={togglePlaying}
          className="absolute right-3 top-3 z-10 inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft md:right-4 md:top-4"
        >
          {started && playing ? (
            <>
              <Pause className="h-4 w-4" aria-hidden />
              Mettre en pause
            </>
          ) : (
            <>
              <Play className="h-4 w-4" aria-hidden />
              {started ? "Reprendre la rotation" : "Lancer la vue 360°"}
            </>
          )}
        </button>
      ) : null}

      {status === "loading" ? (
        <span className="sr-only" role="status">
          Chargement de la vue aérienne…
        </span>
      ) : null}
    </div>
  );
}

/** Repère en goutte, bien visible sur l'imagerie satellite (contour blanc, ombre portée). */
function orbitPin() {
  const pin = document.createElement("span");
  pin.className = "pointer-events-none block drop-shadow-lg";
  pin.setAttribute("aria-hidden", "true");
  pin.innerHTML =
    '<svg width="38" height="50" viewBox="0 0 38 50" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M19 48C19 48 3 30.6 3 18.5C3 9.4 10.2 2 19 2s16 7.4 16 16.5C35 30.6 19 48 19 48Z" style="fill:var(--brand-navy);stroke:#fff;stroke-width:3"/>' +
    '<circle cx="19" cy="18.5" r="6" style="fill:var(--gold-soft)"/></svg>';
  return pin;
}
