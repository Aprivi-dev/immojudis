"use client";

import { useId } from "react";
import type { LandGeometry, LandParcel, LandZone } from "@/lib/land-report-types";

const COLORS = ["#b8d7c0", "#d4c4a2", "#c1d1e7", "#dcc5d8"];

export function LandParcelDiagram({
  parcels,
  zones,
}: {
  parcels: LandParcel[];
  zones: LandZone[];
}) {
  const clipId = useId().replace(/:/g, "");
  const points = parcels.flatMap((parcel) => polygons(parcel.geometry).flat(2));
  if (!points.length || points.some((point) => !point.every(Number.isFinite))) return null;
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minY = Math.min(...points.map((point) => point[1]));
  const maxY = Math.max(...points.map((point) => point[1]));
  const xCorrection = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  const dx = (maxX - minX) * xCorrection;
  const dy = maxY - minY;
  if (dx <= 0 || dy <= 0) return null;
  const scale = Math.min(550 / dx, 240 / dy);
  const xOffset = (600 - dx * scale) / 2;
  const yOffset = (290 - dy * scale) / 2;
  const transform = ([x, y]: number[]) => [
    xOffset + (x - minX) * xCorrection * scale,
    yOffset + (maxY - y) * scale,
  ];
  const path = (geometry: LandGeometry) =>
    polygons(geometry)
      .flatMap((polygon) =>
        polygon.map(
          (ring) =>
            ring
              .map(
                (point, index) =>
                  `${index ? "L" : "M"}${transform(point)
                    .map((value) => value.toFixed(2))
                    .join(",")}`,
              )
              .join(" ") + "Z",
        ),
      )
      .join(" ");
  return (
    <figure
      style={{
        margin: "14px 0",
        border: "1px solid #d8e2db",
        borderRadius: 10,
        overflow: "hidden",
        background: "white",
      }}
    >
      <svg
        role="img"
        aria-label="Contours cadastraux des parcelles et zonages intersectés"
        viewBox="0 0 600 290"
        style={{ width: "100%", maxHeight: 290, display: "block" }}
      >
        <defs>
          <clipPath id={clipId}>
            <rect width="600" height="290" />
          </clipPath>
        </defs>
        <rect width="600" height="290" fill="#f0f4ef" />
        <g clipPath={`url(#${clipId})`}>
          {zones
            .filter((zone) => zone.geometry)
            .map((zone, index) => (
              <path
                key={zone.id}
                d={path(zone.geometry!)}
                fill={COLORS[index % COLORS.length]}
                fillRule="evenodd"
                stroke="white"
                strokeWidth={1}
              />
            ))}
          {parcels.map((parcel) => (
            <path
              key={parcel.id}
              d={path(parcel.geometry)}
              fill={zones.length ? "#ffffff20" : "#b8d7c0"}
              fillRule="evenodd"
              stroke="#215c3c"
              strokeWidth={2.5}
            >
              <title>{`${parcel.section} ${parcel.number}`}</title>
            </path>
          ))}
        </g>
        <text x="580" y="25" textAnchor="end" fill="#536556" fontSize="11">
          N ↑
        </text>
      </svg>
      <figcaption
        style={{ padding: "10px 12px", fontSize: ".72rem", lineHeight: 1.6, color: "#536556" }}
      >
        Contours et zonage · IGN / Géoportail de l’urbanisme.{" "}
        {zones.map((zone) => zone.label).join(" · ")}
        <br />
        Le cadastre ne constitue pas un bornage et ne confirme pas le périmètre de la vente.
      </figcaption>
    </figure>
  );
}

function polygons(geometry: LandGeometry): number[][][][] {
  return geometry.type === "Polygon"
    ? [geometry.coordinates as number[][][]]
    : (geometry.coordinates as number[][][][]);
}
