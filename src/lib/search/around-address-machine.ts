import type { GeoPoint } from "@/lib/geo";
import { defineMachine } from "@/lib/state-machine";

/**
 * Localisation de l'adresse d'une recherche « autour de » (`/sales`).
 *
 * Le point trouvé appartient à une adresse : il est rangé avec elle. Avant, un `center` et un
 * booléen `geocoding` vivaient séparément, ce qui laissait deux états faux :
 * - l'adresse effacée pendant la recherche laissait « localisation en cours » affiché sans fin ;
 * - en passant d'une adresse A à une adresse B, le point de A restait le centre le temps que B
 *   réponde : le tri par distance et la zone d'une alerte créée à ce moment portaient sur A.
 *
 * - `idle` : pas d'adresse ;
 * - `locating` : adresse en cours de localisation, aucun centre ;
 * - `located` : centre connu pour cette adresse ;
 * - `unlocated` : adresse introuvable ou service indisponible, aucun centre.
 */
export type AroundAddressState =
  | { status: "idle" }
  | { status: "locating"; address: string }
  | { status: "located"; address: string; point: GeoPoint }
  | { status: "unlocated"; address: string };

export type AroundAddressEvent =
  /** L'adresse de la recherche a changé (`null` : plus d'adresse). */
  | { type: "ADDRESS_CHANGED"; address: string | null }
  /** Réponse du géocodeur pour `address` (`null` : introuvable ou en échec). */
  | { type: "RESOLVED"; address: string; point: GeoPoint | null };

/** Depuis n'importe quel état : plus d'adresse, ou une adresse à localiser. */
const ADDRESS_CHANGED = (
  _state: AroundAddressState,
  event: Extract<AroundAddressEvent, { type: "ADDRESS_CHANGED" }>,
): AroundAddressState => (event.address ? { status: "locating", address: event.address } : IDLE);

const IDLE: AroundAddressState = { status: "idle" };
const settled = { ADDRESS_CHANGED };

export const aroundAddressMachine = defineMachine<AroundAddressState, AroundAddressEvent>(IDLE, {
  idle: settled,
  locating: {
    ADDRESS_CHANGED,
    // La réponse d'une adresse qui n'est plus celle de la recherche est ignorée.
    RESOLVED: (state, event) =>
      event.address !== state.address
        ? state
        : event.point
          ? { status: "located", address: state.address, point: event.point }
          : { status: "unlocated", address: state.address },
  },
  located: settled,
  unlocated: settled,
});

/** Centre de la recherche : seulement quand il est celui de l'adresse en cours. */
export function aroundAddressCenter(state: AroundAddressState): GeoPoint | null {
  return state.status === "located" ? state.point : null;
}

export function isLocatingAroundAddress(state: AroundAddressState): boolean {
  return state.status === "locating";
}
