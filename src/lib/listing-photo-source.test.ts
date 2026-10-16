import { matchRemotePattern } from "next/dist/shared/lib/match-remote-pattern";
import { expect, it } from "vitest";
import { canOptimizeListingPhoto, listingPhotoRemotePatterns } from "./listing-photo-source";

// Même règle que le serveur d'images de Next : ce que canOptimizeListingPhoto accepte doit être
// autorisé par next.config.ts, et rien d'autre.
const allowedByServer = (source: string) =>
  listingPhotoRemotePatterns.some((pattern) => matchRemotePattern(pattern, new URL(source)));

it("allows the measured provider's public property photos", () => {
  expect(
    canOptimizeListingPhoto("https://avoventes.fr/public/uploads/cabinet/286/images/property.png"),
  ).toBe(true);
  expect(
    canOptimizeListingPhoto(
      "https://media.immobilier.notaires.fr/inotr/media/1/33015/2074289/af06ff9c_XGA.jpg",
    ),
  ).toBe(true);
});
it("allows the public vignettes of vench.fr, and only those", () => {
  const vignette = "https://www.vench.fr/vignettes/v74451.jpg";
  expect(canOptimizeListingPhoto(vignette)).toBe(true);
  expect(allowedByServer(vignette)).toBe(true);
});
it.each([
  "https://vench.fr/vignettes/v74451.jpg",
  "https://www.vench.fr.evil.example/vignettes/v74451.jpg",
  "http://www.vench.fr/vignettes/v74451.jpg",
  "https://www.vench.fr/vignettes/v74451.jpg?token=private",
  "https://www.vench.fr/vignettes/v74451.png",
  "https://www.vench.fr/vignettes/sub/v74451.jpg",
  "https://www.vench.fr/upload/photo/maison.jpg",
  "https://www.vench.fr/images/ventes/165184/card.jpg",
])("keeps vench.fr narrow: %s", (source) => {
  expect(canOptimizeListingPhoto(source)).toBe(false);
  expect(allowedByServer(source)).toBe(false);
});
it("refuses vench.fr vignettes carrying credentials", () => {
  expect(canOptimizeListingPhoto("https://user:password@www.vench.fr/vignettes/v74451.jpg")).toBe(
    false,
  );
});
it.each([
  "https://other.example/public/uploads/cabinet/286/images/property.png",
  "https://avoventes.fr.evil.example/public/uploads/cabinet/286/images/property.png",
  "https://user:password@avoventes.fr/public/uploads/cabinet/286/images/property.png",
  "https://avoventes.fr/public/uploads/cabinet/286/images/property.png?token=private",
  "https://avoventes.fr/public/uploads/cabinet/286/documents/diagnostic.pdf",
  "https://media.immobilier.notaires.fr.evil.example/inotr/media/1/property.jpg",
  "https://media.immobilier.notaires.fr/inotr/private/property.jpg?token=private",
  "https://media.immobilier.notaires.fr/inotr/media/private/document.pdf",
  "https://media.immobilier.notaires.fr/inotr/media/property.jpg?token=private",
  "https://user:password@media.immobilier.notaires.fr/inotr/media/property.jpg",
  "http://127.0.0.1/image.png",
  "data:image/png;base64,AAA",
])("does not proxy unapproved or signed sources: %s", (source) => {
  expect(canOptimizeListingPhoto(source)).toBe(false);
});
