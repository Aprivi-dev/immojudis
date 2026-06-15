const GOOGLE_MAPS_CALLBACK = "__immojudisGoogleMapsInit";
const GOOGLE_MAPS_SCRIPT_ID = "immojudis-google-maps-js";

let googleMapsPromise: Promise<typeof google> | null = null;

export function getGoogleMapsApiKey() {
  return (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() ?? "";
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
    )}&v=weekly&libraries=geometry&loading=async&callback=${GOOGLE_MAPS_CALLBACK}`;
    script.onerror = () => reject(new Error("Le script Google Maps n'a pas pu être chargé."));
    document.head.appendChild(script);
  });

  return googleMapsPromise;
}

export function googleMapsUrl(lat: number, lng: number, query?: string | null) {
  const encodedQuery = encodeURIComponent(query?.trim() || `${lat},${lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${encodedQuery}`;
}

export function googleStaticMapUrl({
  lat,
  lng,
  zoom = 16,
  width = 640,
  height = 360,
  maptype = "hybrid",
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
