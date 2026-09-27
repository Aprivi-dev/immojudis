"use client";

import { useEffect, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import {
  geocodeCadastralNeighborhood,
  type CadastralNeighborhoodPoint,
} from "@/lib/cadastre-neighborhood";
import { CadastralNeighborhoodMap } from "./CadastralNeighborhoodMap";
import styles from "./CadastralPlanDisclosure.module.css";

type Props = {
  point: CadastralNeighborhoodPoint | null;
  streetAddress: string | null;
  displayAddress: string | null;
  postalCode: string | null;
  city: string | null;
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
}: Props) {
  const [open, setOpen] = useState(false);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const lookupKey = [streetAddress, postalCode, city].join("|");
  const lookupDone = lookup?.key === lookupKey;
  const mapPoint = point ?? (lookupDone ? lookup.point : null);

  useEffect(() => {
    if (!open || point || !streetAddress || lookupDone) return;

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
  }, [open, point, streetAddress, postalCode, city, lookupDone, lookupKey]);

  return (
    <details className={styles.disclosure} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles.summary}>
        <span className={styles.icon} aria-hidden="true">
          <Map size={19} />
        </span>
        <span className={styles.summaryText}>
          <strong>Plan cadastral du quartier</strong>
          <small>Parcelles voisines autour de l’adresse · source IGN</small>
        </span>
        <ChevronDown className={styles.chevron} size={19} aria-hidden="true" />
      </summary>
      {open ? (
        <div className={styles.content}>
          {mapPoint ? (
            <>
              <CadastralNeighborhoodMap
                lat={mapPoint.lat}
                lng={mapPoint.lng}
                pointKind={mapPoint.kind}
                address={displayAddress ?? "Adresse de l’annonce"}
              />
              <p className={styles.location}>
                <MapPin size={15} aria-hidden="true" />
                {mapPoint.kind === "parcel-centroid"
                  ? "Centre de parcelle indicatif"
                  : "Point indicatif"}{" "}
                · {mapPoint.source}
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
          <p className={styles.caveat}>
            Le point situe le quartier. Il ne confirme ni la parcelle du bien ni ses limites
            juridiques.
          </p>
          <a
            className={styles.source}
            href="https://cartes.gouv.fr/explorer-les-cartes/"
            target="_blank"
            rel="noreferrer"
          >
            Consulter la carte officielle <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
      ) : null}
    </details>
  );
}
