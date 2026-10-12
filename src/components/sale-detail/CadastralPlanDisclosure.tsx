"use client";

import { useEffect, useState } from "react";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import {
  geocodeCadastralNeighborhood,
  type CadastralNeighborhoodPoint,
} from "@/lib/cadastre-neighborhood";
import type { ParcelOutlines } from "@/lib/land-parcel-outline";
import { CadastralNeighborhoodMap } from "./CadastralNeighborhoodMap";
import styles from "./CadastralPlanDisclosure.module.css";

type Props = {
  point: CadastralNeighborhoodPoint | null;
  streetAddress: string | null;
  displayAddress: string | null;
  postalCode: string | null;
  city: string | null;
  /** Parcels found by the official land report, outlined on the plan. */
  parcels?: ParcelOutlines | null;
};

type Lookup = {
  key: string;
  point: CadastralNeighborhoodPoint | null;
};

export function CadastralPlanDisclosure({
  point,
  streetAddress,
  displayAddress,
  postalCode,
  city,
  parcels = null,
}: Props) {
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const lookupKey = [streetAddress, postalCode, city].join("|");
  const lookupDone = lookup?.key === lookupKey;
  const addressPoint = point ?? (lookupDone ? lookup.point : null);
  // A parcel cited by the listing locates the property better than any address point
  // (a commune-only address is geocoded to the village centre).
  const mapPoint: CadastralNeighborhoodPoint | null = parcels?.confirmed
    ? { ...parcels.center, kind: "parcel-centroid", source: "Parcelle citée dans l’annonce" }
    : (addressPoint ??
      (parcels
        ? { ...parcels.center, kind: "parcel-centroid", source: "Parcelle probable" }
        : null));

  useEffect(() => {
    if (point || parcels?.confirmed || !streetAddress || lookupDone) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    let active = true;
    void geocodeCadastralNeighborhood(
      { address: streetAddress, postalCode, city },
      controller.signal,
    ).then((resolvedPoint) => {
      if (active) setLookup({ key: lookupKey, point: resolvedPoint });
    });

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [point, parcels?.confirmed, streetAddress, postalCode, city, lookupDone, lookupKey]);

  return (
    <section className={styles.root} aria-label="Plan cadastral du quartier">
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Map size={19} />
        </span>
        <span className={styles.summaryText}>
          <strong>Plan cadastral du quartier</strong>
          <small>Parcelles voisines autour de l’adresse · source IGN</small>
        </span>
      </header>
      <div className={styles.content}>
        {mapPoint ? (
          <>
            <CadastralNeighborhoodMap
              lat={mapPoint.lat}
              lng={mapPoint.lng}
              pointKind={mapPoint.kind}
              address={displayAddress ?? "Adresse de l’annonce"}
              outlines={parcels}
            />
            <p className={styles.location}>
              <MapPin size={15} aria-hidden="true" />
              {parcels?.confirmed
                ? "Contour plein : parcelle citée dans l’annonce, retrouvée au cadastre"
                : parcels
                  ? "Contour pointillé : parcelle probable d’après l’adresse, à confirmer"
                  : `${mapPoint.kind === "parcel-centroid" ? "Centre de parcelle indicatif" : "Point d’adresse indicatif"} · ${mapPoint.source}`}
            </p>
          </>
        ) : streetAddress && !lookupDone ? (
          <div className={styles.placeholder} role="status">
            Localisation de l’adresse en cours…
          </div>
        ) : (
          <div className={styles.placeholder} role="status">
            Le plan ne peut pas être centré avec précision sur cette adresse.
            {streetAddress ? (
              <button type="button" onClick={() => setLookup(null)}>
                Réessayer
              </button>
            ) : null}
          </div>
        )}
        {parcels?.confirmed ? null : (
          <p className={styles.caveat}>
            Le point situe le quartier. Il ne délimite pas la parcelle du bien.
          </p>
        )}
        <a
          className={styles.source}
          href="https://cartes.gouv.fr/explorer-les-cartes/"
          target="_blank"
          rel="noreferrer"
        >
          Consulter la carte officielle <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
