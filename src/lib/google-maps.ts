const GOOGLE_MAPS_CALLBACK = "__immojudisGoogleMapsInit";
const GOOGLE_MAPS_SCRIPT_ID = "immojudis-google-maps-js";

let googleMapsPromise: Promise<typeof google> | null = null;

export function getGoogleMapsApiKey() {
  const fromEnv = (
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? process.env.VITE_GOOGLE_MAPS_API_KEY
  )?.trim();
  return fromEnv || "";
}

export function getGoogleMapsMapId() {
  const fromEnv = (
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? process.env.VITE_GOOGLE_MAPS_MAP_ID
  )?.trim();
  return fromEnv || "";
}

export function loadGoogleMaps(apiKey: string): Promise<typeof google> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Google Maps ne peut être chargé que dans le navigateur."));
  }

  if (window.google?.maps?.Map) return Promise.resolve(window.google);
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = new Promise((resolve, reject) => {
    const existingScript = document.getElementById(
      GOOGLE_MAPS_SCRIPT_ID,
    ) as HTMLScriptElement | null;

    const resolveIfReady = () => {
      if (window.google?.maps?.Map) {
        resolve(window.google);
        return true;
      }
      return false;
    };

    if (resolveIfReady()) return;

    window[GOOGLE_MAPS_CALLBACK] = () => {
      if (window.google?.maps?.Map) {
        resolve(window.google);
      } else {
        reject(new Error("Google Maps a répondu sans exposer l'API JavaScript."));
      }
    };

    if (existingScript) {
      existingScript.addEventListener("load", resolveIfReady, { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("Le script Google Maps n'a pas pu être chargé.")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.id = GOOGLE_MAPS_SCRIPT_ID;
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey,
    )}&v=weekly&libraries=geometry,marker&loading=async&callback=${GOOGLE_MAPS_CALLBACK}`;
    script.onerror = () => reject(new Error("Le script Google Maps n'a pas pu être chargé."));
    document.head.appendChild(script);
  });

  return googleMapsPromise;
}

export function googleMapsUrl(lat: number, lng: number, query?: string | null) {
  const encodedQuery = encodeURIComponent(query?.trim() || `${lat},${lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`;
}

export function googleMapsQueryUrl(query: string) {
  const encodedQuery = encodeURIComponent(query.trim());
  return `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`;
}

export function googleMapsAerial3dUrl(lat: number, lng: number) {
  return `https://www.google.com/maps/@${lat},${lng},120a,35y,0h,60t/data=!3m1!1e3`;
}

export function googleMapsStreetViewUrl(lat: number, lng: number) {
  const params = new URLSearchParams({
    api: "1",
    map_action: "pano",
    viewpoint: `${lat},${lng}`,
  });
  return `https://www.google.com/maps/@?${params.toString()}`;
}

// NB: `roadmap` (et non `satellite`/`hybrid`) par défaut. L'API Static Maps de
// Google refuse l'imagerie satellite/hybride pour les comptes de l'EEE (réponse
// HTTP 403 "satellite and hybrid map types are not available for your account
// and region"), ce qui faisait échouer le chargement des vignettes → repli OSM.
// Le type `roadmap` est servi normalement (200) ; ne pas revenir à `hybrid` ici.
export function googleStaticMapUrl({
  lat,
  lng,
  zoom = 16,
  width = 640,
  height = 360,
  maptype = "roadmap",
}: {
  lat: number;
  lng: number;
  zoom?: number;
  width?: number;
  height?: number;
  maptype?: "roadmap" | "satellite" | "terrain" | "hybrid";
}) {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) return "";

  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    key: apiKey,
    maptype,
    scale: "2",
    size: `${Math.round(width)}x${Math.round(height)}`,
    zoom: String(zoom),
  });

  params.append("markers", `color:0xf2c487|${lat},${lng}`);
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}
