const GOOGLE_MAPS_CALLBACK = "__immojudisGoogleMapsInit";
const GOOGLE_MAPS_SCRIPT_ID = "immojudis-google-maps-js";

let googleMapsPromise: Promise<typeof google> | null = null;

// Jeton navigateur public Google Maps, restreint par référent HTTP au domaine
// immojudis. Il est déjà servi en clair dans chaque bundle client, donc le
// committer comme repli de build est sans risque (un tiers ne peut pas l'utiliser
// hors domaine grâce à la restriction de référent). La variable d'env Vercel
// reste prioritaire ; en cas de rotation, mettre à jour l'env ET cette constante.
const FALLBACK_GOOGLE_MAPS_API_KEY = "AIzaSyAgTPSC3WC_Buscats-mlTUieaXE1d1jW0";

export function getGoogleMapsApiKey() {
  const fromEnv = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim();
  if (fromEnv) return fromEnv;
  // En production, garantir la clé même si le build n'a pas reçu la variable d'env
  // (déploiements prébuildés / CLI qui « perdent » les env vars). En dev local,
  // on garde le repli Leaflet/OSM (pas de clé → pas de Google).
  return import.meta.env.PROD ? FALLBACK_GOOGLE_MAPS_API_KEY : "";
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
