import "server-only";
import { createHash } from "node:crypto";
import {
  classifyFloodPosition,
  floodParcelCentroids,
  validFloodCoordinates,
  type FloodPositionInput,
} from "@/lib/flood-risk";

/**
 * Clé de la position : change dès que le point, sa précision, ses drapeaux douteux, le type ou le score du résultat
 * de la BAN (lieu-dit, numéro peu sûr : la position devient approximative), les centroïdes d'une parcelle multiple
 * ou la commune (position approximative) changent. Elle sert à refaire l'observation et à n'utiliser un verdict stocké que pour la
 * position qu'il a observée. Les coordonnées n'y figurent qu'en empreinte (16 caractères d'un SHA-256) : la table
 * ne les copie pas. C'est une pseudonymisation, pas une anonymisation : l'empreinte se recalcule à partir d'une
 * position connue. Module serveur : `node:crypto` n'entre jamais dans le navigateur.
 */
export function floodPositionKey(position: FloodPositionInput): string {
  const kind = classifyFloodPosition(position);
  const coordinates = validFloodCoordinates(position);
  if (kind === "approximate" || !coordinates) {
    return `approx:${position.communeInsee ?? "-"}`;
  }
  const precision = (position.precision ?? "").trim().toLowerCase();
  // Parcelle multiple : les centroïdes testés font partie de la position (ajouter ou retirer une parcelle la change).
  const centroids = floodParcelCentroids(position).map(
    (point) => `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`,
  );
  const fingerprint = createHash("sha256")
    .update([`${coordinates.lat.toFixed(5)},${coordinates.lon.toFixed(5)}`, ...centroids].join("|"))
    .digest("hex")
    .slice(0, 16);
  return `${kind}:${precision}:${fingerprint}`;
}
