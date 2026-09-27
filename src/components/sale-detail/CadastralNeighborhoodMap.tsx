"use client";

import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useId, useRef, useState } from "react";
import type * as MapboxGL from "mapbox-gl";
import { getMapboxAccessToken } from "@/lib/mapbox";
import styles from "./CadastralNeighborhoodMap.module.css";

const IGN_ATTRIBUTION =
  '<a href="https://www.ign.fr/" target="_blank" rel="noopener noreferrer">© IGN</a> / <a href="https://cartes.gouv.fr/" target="_blank" rel="noopener noreferrer">Géoplateforme</a>';
const WMTS_ENDPOINT = "https://data.geopf.fr/wmts?";
const WMS_ENDPOINT = "https://data.geopf.fr/wms-r/wms?";
const WMTS_MATRIX_SET = "PM_0_19";
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
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const addressLabel = address.trim() || "Adresse fournie";
  const pointLabel =
    pointKind === "parcel-centroid"
      ? "Centre de parcelle indicatif"
      : pointKind === "street"
        ? "Repère de rue indicatif"
        : "Point indicatif";

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    let cancelled = false;
    let map: MapboxGL.Map | null = null;
    let marker: MapboxGL.Marker | null = null;
    let fallbackTimer: number | null = null;
    let fallbackActive = false;
    let fallbackRequested = false;
    let mapLoaded = false;

    setFallbackNotice(null);

    if (!hasValidCoordinates) {
      setStatus("error");
      setErrorMessage("Aucun point de carte exploitable n’est disponible.");
      return;
    }

    setStatus("loading");
    setErrorMessage(null);

    const activateWmsFallback = () => {
      if (cancelled || !map || fallbackActive) return;

      fallbackActive = true;
      try {
        map.setLayoutProperty("ign-base-wmts", "visibility", "none");
        map.setLayoutProperty("ign-cadastre-wmts", "visibility", "none");
        map.setLayoutProperty("ign-base-wms", "visibility", "visible");
        map.setLayoutProperty("ign-cadastre-wms", "visibility", "visible");
        setStatus("ready");
        setFallbackNotice(
          "Le flux tuilé IGN est indisponible. Affichage via le flux WMS de secours.",
        );

        fallbackTimer = window.setTimeout(() => {
          if (cancelled || !map || !fallbackActive) return;

          const baseLoaded = map.isSourceLoaded("ign-base-wms");
          const cadastreLoaded = map.isSourceLoaded("ign-cadastre-wms");
          if (!baseLoaded || !cadastreLoaded) {
            setStatus("error");
            setErrorMessage("Les services cartographiques IGN sont momentanément indisponibles.");
          }
        }, 6000);
      } catch {
        setStatus("error");
        setErrorMessage("Le plan cadastral n’a pas pu être chargé pour le moment.");
      }
    };

    void import("mapbox-gl")
      .then((module) => {
        if (cancelled || !container.isConnected) return;

        const mapboxgl = module.default;
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
            if (fallbackRequested) {
              activateWmsFallback();
            } else {
              setStatus("ready");
            }
          });

          mapInstance.on("styledata", () => {
            if (cancelled || !fallbackRequested || fallbackActive) return;
            if (mapInstance.isStyleLoaded()) activateWmsFallback();
          });

          mapInstance.on("error", (event) => {
            if (cancelled) return;

            if (fallbackActive) {
              const message = event.error?.message ?? "";
              if (
                message.includes("/wms-r/wms") ||
                message.includes("ign-base-wms") ||
                message.includes("ign-cadastre-wms")
              ) {
                setStatus("error");
                setErrorMessage(
                  "Les services cartographiques IGN sont momentanément indisponibles.",
                );
              }
              return;
            }
            if (mapLoaded || mapInstance.isStyleLoaded()) {
              activateWmsFallback();
              return;
            }

            fallbackRequested = true;
            setStatus("loading");
            setErrorMessage(null);
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
      if (fallbackTimer != null) window.clearTimeout(fallbackTimer);
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

        {status === "ready" && fallbackNotice && (
          <p className={styles.mapNotice} role="status">
            {fallbackNotice}
          </p>
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
      "ign-base-wmts": {
        type: "raster",
        tiles: [buildIgnWmtsTileUrl("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2")],
        tileSize: 256,
        attribution: IGN_ATTRIBUTION,
      },
      "ign-cadastre-wmts": {
        type: "raster",
        tiles: [buildIgnWmtsTileUrl("CADASTRALPARCELS.PARCELLAIRE_EXPRESS")],
        tileSize: 256,
        attribution: IGN_ATTRIBUTION,
      },
      "ign-base-wms": {
        type: "raster",
        tiles: [buildIgnWmsTileUrl("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2")],
        tileSize: 256,
        attribution: IGN_ATTRIBUTION,
      },
      "ign-cadastre-wms": {
        type: "raster",
        tiles: [buildIgnWmsTileUrl("CADASTRALPARCELS.PARCELLAIRE_EXPRESS")],
        tileSize: 256,
        attribution: IGN_ATTRIBUTION,
      },
    },
    layers: [
      {
        id: "ign-base-wmts",
        type: "raster",
        source: "ign-base-wmts",
        minzoom: 0,
        maxzoom: 19,
      },
      {
        id: "ign-cadastre-wmts",
        type: "raster",
        source: "ign-cadastre-wmts",
        minzoom: 0,
        maxzoom: 19,
        paint: { "raster-opacity": 0.78 },
      },
      {
        id: "ign-base-wms",
        type: "raster",
        source: "ign-base-wms",
        layout: { visibility: "none" },
        minzoom: 0,
        maxzoom: 19,
      },
      {
        id: "ign-cadastre-wms",
        type: "raster",
        source: "ign-cadastre-wms",
        layout: { visibility: "none" },
        minzoom: 0,
        maxzoom: 19,
        paint: { "raster-opacity": 0.78 },
      },
    ],
  };
}

function buildIgnWmtsTileUrl(layer: string) {
  return `${WMTS_ENDPOINT}SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${encodeURIComponent(
    layer,
  )}&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=${WMTS_MATRIX_SET}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
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
