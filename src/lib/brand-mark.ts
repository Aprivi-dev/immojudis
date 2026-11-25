/**
 * Géométrie du pictogramme de la marque, dans une boîte de 64 × 64 : la tuile, le corps du temple
 * (architrave, trois colonnes, socle) et son fronton. Le fronton se dessine en points, comme les
 * objets tramés des peintures ; le favicon garde le fronton plein (`public/brand/
 * immojudis-justice-temple.svg`, mêmes tracés de tuile et de corps), les points ne se lisant plus
 * sous 24 px.
 */
export const BRAND_TILE_PATH =
  "M14 0h36a14 14 0 0 1 14 14v36a14 14 0 0 1-14 14H14A14 14 0 0 1 0 50V14A14 14 0 0 1 14 0Z";

export const BRAND_BODY_PATH =
  "M14.75 29.84h34.5v2.16h-34.5ZM17.62 34.16h5.75v10.78h-5.75ZM29.12 34.16h5.75v10.78h-5.75ZM40.62 34.16h5.75v10.78h-5.75ZM12.59 47.09h38.81v3.59h-38.81Z";

/** Rayon d'un point du fronton. */
export const BRAND_ROOF_DOT_RADIUS = 1.3;

const ROOF_ROWS = 5;
const ROOF_STEP_X = 4.53;
const ROOF_STEP_Y = 3.17;
const ROOF_TOP = 13.7;

/** Centres des points du fronton : cinq rangées de 1, 3, 5, 7 et 9 points, de la largeur du temple. */
export const BRAND_ROOF_DOTS: ReadonlyArray<readonly [x: number, y: number]> = Array.from(
  { length: ROOF_ROWS },
  (_, row) =>
    Array.from(
      { length: 2 * row + 1 },
      (_, index) =>
        [
          Number((32 + (index - row) * ROOF_STEP_X).toFixed(2)),
          Number((ROOF_TOP + row * ROOF_STEP_Y).toFixed(2)),
        ] as const,
    ),
).flat();
