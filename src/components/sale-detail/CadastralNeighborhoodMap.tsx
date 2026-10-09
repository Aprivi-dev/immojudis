"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useId, useRef, useState } from "react";
import type * as MapboxGL from "mapbox-gl";
import { disableMapboxTelemetry, getMapboxAccessToken } from "@/lib/mapbox";
import styles from "./CadastralNeighborhoodMap.module.css";

const IGN_ATTRIBUTION =
  '<a href="https://www.ign.fr/" target="_blank" rel="noopener noreferrer">© IGN</a> / <a href="https://cartes.gouv.fr/" target="_blank" rel="noopener noreferrer">Géoplateforme</a>';
const WMS_ENDPOINT = "https://data.geopf.fr/wms-r/wms?";
const DEFAULT_ZOOM = 17;

type MapStatus = "loading" | "ready" | "error";

export type CadastralNeighborhoodMapProps = {
  lat: number;
  lng: number;
  address: string;
  pointKind: "listing" | "address" | "street" | "parcel-centroid";
};

export function CadastralNeighborhoodMap({
  lat,
  lng,
  address,
  pointKind,
}: CadastralNeighborhoodMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const hasValidCoordinates = isValidCoordinates(lat, lng);
  const [status, setStatus] = useState<MapStatus>(hasValidCoordinates ? "loading" : "error");
  const [errorMessage, setErrorMessage] = useState<string | null>(
    hasValidCoordinates ? null : "Aucun point de carte exploitable n’est disponible.",
  );
  const addressLabel = address.trim() || "Adresse fournie";
  const pointLabel =
    pointKind === "parcel-centroid"
      ? "Centre de parcelle indicatif"
      : pointKind === "street"
        ? "Repère de rue indicatif"
        : "Point d’adresse indicatif";

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    let cancelled = false;
    let map: MapboxGL.Map | null = null;
    let marker: MapboxGL.Marker | null = null;
    let checkTimer: number | null = null;
    let mapLoaded = false;

    if (!hasValidCoordinates) {
      setStatus("error");
      setErrorMessage("Aucun point de carte exploitable n’est disponible.");
      return;
    }

    setStatus("loading");
    setErrorMessage(null);

    void import("mapbox-gl")
      .then((module) => {
        if (cancelled || !container.isConnected) return;

        const mapboxgl = module.default;
        disableMapboxTelemetry(mapboxgl);
        const accessToken = getMapboxAccessToken();
        if (accessToken) mapboxgl.accessToken = accessToken;

        try {
          const mapOptions: MapboxGL.MapboxOptions = {
            attributionControl: true,
            center: [lng, lat],
            container,
            dragRotate: false,
            maxZoom: 19,
            minZoom: 13,
            renderWorldCopies: false,
            style: buildIgnStyle(),
            zoom: DEFAULT_ZOOM,
          };

          if (accessToken) mapOptions.accessToken = accessToken;

          const mapInstance = new mapboxgl.Map(mapOptions);
          map = mapInstance;
          mapInstance.addControl(
            new mapboxgl.NavigationControl({ visualizePitch: false }),
            "top-right",
          );
          mapInstance.addControl(
            new mapboxgl.ScaleControl({ maxWidth: 120, unit: "metric" }),
            "bottom-left",
          );

          const markerElement = document.createElement("button");
          markerElement.type = "button";
          markerElement.className = styles.marker;
          markerElement.setAttribute("aria-label", pointLabel);
          markerElement.title = pointLabel;

          const markerPulse = document.createElement("span");
          markerPulse.className = styles.markerPulse;
          markerPulse.setAttribute("aria-hidden", "true");

          const markerDot = document.createElement("span");
          markerDot.className = styles.markerDot;
          markerDot.setAttribute("aria-hidden", "true");
          markerElement.append(markerPulse, markerDot);

          marker = new mapboxgl.Marker({ element: markerElement, anchor: "center" })
            .setLngLat([lng, lat])
            .setPopup(
              new mapboxgl.Popup({ closeButton: true, offset: 18 }).setText(
                `${pointLabel} · ${addressLabel}`,
              ),
            )
            .addTo(mapInstance);

          mapInstance.on("load", () => {
            if (cancelled) return;
            mapLoaded = true;
            setStatus("ready");
            // Les tuiles viennent du flux WMS de l'IGN, qui répond toujours (tuile vide hors
            // couverture) : on ne signale une panne que si les deux couches restent muettes.
            checkTimer = window.setTimeout(() => {
              if (cancelled) return;
              if (
                !mapInstance.isSourceLoaded("ign-base") ||
                !mapInstance.isSourceLoaded("ign-cadastre")
              ) {
                setStatus("error");
                setErrorMessage(
                  "Les services cartographiques IGN sont momentanément indisponibles.",
                );
              }
            }, 6000);
          });

          mapInstance.on("error", (event) => {
            if (cancelled || mapLoaded) return;
            const message = event.error?.message ?? "";
            if (message.includes("/wms-r/wms") || message.includes("ign-")) {
              setStatus("error");
              setErrorMessage("Les services cartographiques IGN sont momentanément indisponibles.");
            }
          });
        } catch {
          setStatus("error");
          setErrorMessage("Le plan cadastral n’a pas pu être chargé pour le moment.");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage("Le plan cadastral n’a pas pu être chargé pour le moment.");
      });

    return () => {
      cancelled = true;
      if (checkTimer != null) window.clearTimeout(checkTimer);
      marker?.remove();
      map?.remove();
    };
  }, [addressLabel, hasValidCoordinates, lat, lng, pointLabel]);

  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Plan du quartier</p>
          <h3 id={headingId} className={styles.title}>
            Parcelles cadastrales autour de l’adresse
          </h3>
          <p className={styles.address}>{addressLabel}</p>
        </div>
        <span className={styles.sourcePill}>IGN · PCI</span>
      </div>

      <div className={styles.mapFrame}>
        <div
          ref={mapContainerRef}
          className={styles.mapCanvas}
          aria-label={`Plan cadastral autour de ${addressLabel}`}
        />

        {status !== "ready" && (
          <div
            className={styles.status}
            role={status === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {status === "loading" && <span className={styles.spinner} aria-hidden="true" />}
            <p>
              {status === "loading"
                ? "Chargement du plan cadastral du quartier…"
                : (errorMessage ?? "Le plan cadastral n’est pas disponible pour le moment.")}
            </p>
            {status === "error" && (
              <a
                className={styles.fallbackLink}
                href="https://www.cadastre.gouv.fr/scpc/accueil.do"
                target="_blank"
                rel="noreferrer"
              >
                Ouvrir le cadastre officiel
              </a>
            )}
          </div>
        )}
      </div>

      <div className={styles.legend} aria-label="Légende du plan">
        <span>
          <i className={styles.legendPoint} aria-hidden="true" /> {pointLabel}
        </span>
        <span>
          <i className={styles.legendParcel} aria-hidden="true" /> Limites cadastrales
        </span>
      </div>
    </section>
  );
}

function buildIgnStyle(): MapboxGL.StyleSpecification {
  return {
    version: 8,
    sources: {
      "ign-base": {
        type: "raster",
        tiles: [buildIgnWmsTileUrl("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2")],
        tileSize: 256,
        attribution: IGN_ATTRIBUTION,
      },
      "ign-cadastre": {
        type: "raster",
        tiles: [buildIgnWmsTileUrl("CADASTRALPARCELS.PARCELLAIRE_EXPRESS")],
        tileSize: 256,
        attribution: IGN_ATTRIBUTION,
      },
    },
    layers: [
      { id: "ign-base", type: "raster", source: "ign-base", minzoom: 0, maxzoom: 19 },
      {
        id: "ign-cadastre",
        type: "raster",
        source: "ign-cadastre",
        minzoom: 0,
        maxzoom: 19,
        paint: { "raster-opacity": 0.78 },
      },
    ],
  };
}

function buildIgnWmsTileUrl(layer: string) {
  return `${WMS_ENDPOINT}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${encodeURIComponent(
    layer,
  )}&STYLES=normal&FORMAT=image/png&TRANSPARENT=true&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256`;
}

function isValidCoordinates(lat: number, lng: number) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}
