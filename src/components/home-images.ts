/**
 * `dossier-apartment.webp` illustrates two blocks of the home page (the example file of the
 * hero and the offers section). Both ask for the same `sizes` and `quality`, so the optimizer
 * serves them from the same URL and the browser downloads the photo once. Keep them identical:
 * the larger layout (half the viewport on desktop) wins for both.
 */
export const DOSSIER_APARTMENT_SIZES = "(max-width: 760px) 100vw, 50vw";
export const DOSSIER_APARTMENT_QUALITY = 85;
