// Public property photos from the provider measured as the listing's LCP bottleneck.
// Keep the server allowlist narrow: no signed URLs or arbitrary remote image proxying.
export const listingPhotoRemotePatterns = [
  {
    protocol: "https" as const,
    hostname: "avoventes.fr",
    port: "",
    pathname: "/public/uploads/cabinet/*/images/**",
    search: "",
  },
  {
    protocol: "https" as const,
    hostname: "media.immobilier.notaires.fr",
    port: "",
    pathname: "/inotr/media/**",
    search: "",
  },
  {
    // Vignettes publiques des annonces vench.fr (« /vignettes/v74451.jpg ») : rien d'autre du site.
    protocol: "https" as const,
    hostname: "www.vench.fr",
    port: "",
    pathname: "/vignettes/*.jpg",
    search: "",
  },
];

export function canOptimizeListingPhoto(source: string): boolean {
  try {
    const url = new URL(source);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return false;
    }

    if (url.hostname === "avoventes.fr") {
      return /^\/public\/uploads\/cabinet\/\d+\/images\/[^/]+\.(?:png|jpe?g|webp|avif)$/i.test(
        url.pathname,
      );
    }

    if (url.hostname === "www.vench.fr") {
      return /^\/vignettes\/[^/]+\.jpg$/.test(url.pathname);
    }

    return (
      url.hostname === "media.immobilier.notaires.fr" &&
      /^\/inotr\/media\/.+\.(?:png|jpe?g|webp|avif)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}
