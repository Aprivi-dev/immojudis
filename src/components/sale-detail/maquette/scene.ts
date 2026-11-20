import {
  BackSide,
  Box3,
  BoxGeometry,
  BufferAttribute,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import type { MaquetteKind } from "@/lib/sale-maquette";
import { maquetteLight } from "./light";
import { box, createMaquetteMaterials, maquetteModel, trees } from "./models";

/** Colonne de prix : sa hauteur est la part du montant dans le plus élevé des montants affichés. */
export type MaquetteColumn =
  | { kind: "amount"; color: string; share: number }
  /** Montant réservé : un voile qui s'efface vers le haut, sans hauteur à comparer. */
  | { kind: "locked" };

export type MaquetteScene = {
  /** Pose les colonnes de prix (aucune à la création), sans toucher au point de vue. */
  setColumns(columns: readonly MaquetteColumn[]): void;
  setHour(hour: number): void;
  /** Tourne autour de la maquette, en radians (positif : vers la droite). */
  rotate(angle: number): void;
  /** Rapproche (facteur < 1) ou éloigne (facteur > 1) le point de vue. */
  zoom(factor: number): void;
  dispose(): void;
};

const FIELD_OF_VIEW = 32;
/** Demi-largeur à garder visible à hauteur de la cible : le socle et un peu d'air. */
const VISIBLE_HALF_WIDTH = 17.5;
const DISTANCE = 50;
/** Angle de la caméra avec la verticale : assez bas pour voir l'horizon et le ciel. */
const POLAR = 1.36;
const ZOOM = { min: 0.6, max: 1.35 };
const SKY_RADIUS = 320;
const COLUMN_MAX_HEIGHT = 9;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Générateur pseudo-aléatoire à graine : le décor est le même à chaque affichage. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function priceColumns(columns: readonly MaquetteColumn[]): Group {
  const group = new Group();
  const [size, gap] = [1.5, 2.1];
  columns.forEach((column, index) => {
    const x = index * gap;
    if (column.kind === "amount") {
      const material = new MeshStandardMaterial({ color: column.color, roughness: 0.5 });
      group.add(
        box([size, Math.max(column.share * COLUMN_MAX_HEIGHT, 0.3), size], [x, 0.1, 0], material),
      );
      return;
    }
    // Plus haut que toute colonne et transparent au sommet : aucune hauteur ne se lit, donc aucun
    // montant ne se devine par comparaison.
    const height = COLUMN_MAX_HEIGHT * 1.15;
    const geometry = new BoxGeometry(size, height, size);
    const positions = geometry.attributes.position;
    const fade = new BufferAttribute(new Float32Array(positions.count * 4), 4);
    for (let vertex = 0; vertex < positions.count; vertex += 1) {
      fade.setXYZW(vertex, 1, 1, 1, positions.getY(vertex) < 0 ? 0.5 : 0);
    }
    geometry.setAttribute("color", fade);
    const veil = new Mesh(
      geometry,
      new MeshStandardMaterial({
        color: 0x9aa6b8,
        roughness: 0.9,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    veil.position.set(x, 0.1 + height / 2, 0);
    group.add(veil);
  });
  if (columns.length) {
    const width = (columns.length - 1) * gap + size + 0.9;
    const plate = new MeshStandardMaterial({ color: 0xcfc6b8, roughness: 0.9 });
    group.add(box([width, 0.1, size + 0.9], [((columns.length - 1) * gap) / 2, 0, 0], plate));
  }
  return group;
}

/** Libère les ressources graphiques de `root` et de ses descendants. */
function release(root: Object3D) {
  const used = new Set<{ dispose(): void }>();
  root.traverse((object) => {
    const { geometry, material } = object as Partial<Mesh>;
    if (geometry) used.add(geometry);
    for (const item of ([] as Material[]).concat(material ?? [])) used.add(item);
    // Un maillage répété garde en plus le tampon des positions de ses exemplaires.
    if (object instanceof InstancedMesh) used.add(object);
  });
  used.forEach((resource) => resource.dispose());
}

/**
 * Scène de la maquette : un volume schématique du type de bien sur un socle, des colonnes de prix à
 * sa droite, un ciel et un soleil qui suivent l'heure. Rendu à la demande : une image n'est calculée
 * que lorsqu'un geste, un bouton, l'heure ou la taille du cadre change quelque chose.
 *
 * Lève une erreur si le navigateur ne fournit pas de contexte WebGL. `dispose` rend ce contexte au
 * navigateur (qui n'en garde qu'une poignée par page) : le canevas ne sert qu'à une scène.
 */
export function createMaquetteScene({
  canvas,
  kind,
  accent,
  hour,
  animated,
  onContextLost,
}: {
  canvas: HTMLCanvasElement;
  kind: MaquetteKind;
  /** Couleur de ce qui est vendu (lot, immeuble, parcelle), en notation CSS. */
  accent: string;
  hour: number;
  /** `false` : aucun mouvement de caméra animé (mouvement réduit demandé). */
  animated: boolean;
  onContextLost: () => void;
}): MaquetteScene {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  // Rien ne bouge dans la scène : les ombres ne sont recalculées qu'au changement d'heure.
  renderer.shadowMap.autoUpdate = false;

  const scene = new Scene();
  const fog = new Fog(0xffffff, 70, 250);
  scene.fog = fog;
  const camera = new PerspectiveCamera(FIELD_OF_VIEW, 1, 1, SKY_RADIUS * 2.2);

  const ambient = new HemisphereLight(0xffffff, 0x9a917f, 1);
  const sun = new DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;
  Object.assign(sun.shadow.camera, {
    left: -24,
    right: 24,
    top: 24,
    bottom: -24,
    near: 1,
    far: 140,
  });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(ambient, sun, sun.target);

  // Ciel : une voûte dégradée de l'horizon au zénith, dont l'horizon a la couleur du brouillard.
  const skyGeometry = new SphereGeometry(SKY_RADIUS, 32, 16);
  const skyColors = new BufferAttribute(
    new Float32Array(skyGeometry.attributes.position.count * 3),
    3,
  );
  skyGeometry.setAttribute("color", skyColors);
  const sky = new Mesh(
    skyGeometry,
    new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false }),
  );

  const materials = createMaquetteMaterials(accent);
  const ground = new Mesh(
    new CircleGeometry(SKY_RADIUS, 48).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ color: 0xe2e6d4, roughness: 1 }),
  );
  ground.position.y = -0.6;
  ground.receiveShadow = true;
  const plinth = new Mesh(
    new CylinderGeometry(15.5, 15.9, 0.6, 72),
    new MeshStandardMaterial({ color: 0xfaf7f1, roughness: 0.9 }),
  );
  plinth.position.y = -0.3;
  plinth.castShadow = true;
  plinth.receiveShadow = true;

  const model = maquetteModel(kind, materials);
  model.position.x = -3.5;
  // La caméra vise plus bas pour une maison ou un terrain que pour un immeuble.
  const modelHeight = new Box3().setFromObject(model).max.y;
  const target = new Vector3(0.5, clamp(modelHeight * 0.38, 2.4, 5.2), 0);
  let prices = new Group();

  // Décor : des arbres de maquette semés autour du socle, toujours aux mêmes places.
  const random = seeded(20261120);
  const grove = trees(
    Array.from({ length: 48 }, () => {
      const angle = random() * Math.PI * 2;
      const radius = 26 + random() ** 1.6 * 60;
      return [Math.cos(angle) * radius, -0.6, Math.sin(angle) * radius, 0.75 + random() * 0.55];
    }),
    materials,
  );
  scene.add(sky, ground, plinth, model, prices, grove);

  // Point de vue : la valeur affichée rejoint la valeur visée, sans à-coup.
  const goal = { azimuth: 0.62, zoom: 1 };
  const view = { ...goal, azimuth: animated ? goal.azimuth - 0.9 : goal.azimuth };
  let fitDistance = DISTANCE;
  let frame = 0;
  let lastFrame = 0;
  let disposed = false;

  const draw = (now: number) => {
    frame = 0;
    const elapsed = lastFrame ? (now - lastFrame) / 1000 : 0;
    const ease = animated ? 1 - Math.exp(-elapsed * 6) : 1;
    lastFrame = now;
    let moving = false;
    for (const key of ["azimuth", "zoom"] as const) {
      const gap = goal[key] - view[key];
      if (Math.abs(gap) < 0.0005) view[key] = goal[key];
      else {
        view[key] += gap * ease;
        moving = true;
      }
    }
    const distance = fitDistance * view.zoom;
    const flat = distance * Math.sin(POLAR);
    camera.position.set(
      target.x + flat * Math.sin(view.azimuth),
      target.y + distance * Math.cos(POLAR),
      target.z + flat * Math.cos(view.azimuth),
    );
    camera.lookAt(target);
    renderer.render(scene, camera);
    if (moving) invalidate();
    else lastFrame = 0;
  };
  const invalidate = () => {
    if (!frame && !disposed) frame = window.requestAnimationFrame(draw);
  };

  const zenith = new Color();
  const horizon = new Color();
  const shade = new Color();
  const setHour = (value: number) => {
    const light = maquetteLight(value);
    zenith.setHex(light.zenith);
    horizon.setHex(light.horizon);
    const positions = skyGeometry.attributes.position;
    for (let index = 0; index < positions.count; index += 1) {
      const height = Math.max(positions.getY(index) / SKY_RADIUS, 0);
      shade.copy(horizon).lerp(zenith, height ** 0.4);
      skyColors.setXYZ(index, shade.r, shade.g, shade.b);
    }
    skyColors.needsUpdate = true;
    fog.color.copy(horizon);
    // Lumière du ciel : le zénith adouci, pour ne pas bleuir les façades.
    ambient.color.copy(zenith).lerp(shade.setHex(0xffffff), 0.45);
    ambient.intensity = light.ambientIntensity;
    sun.color.setHex(light.sunColor);
    sun.intensity = light.sunIntensity;
    sun.position.set(...light.sunDirection).multiplyScalar(70);
    materials.glass.emissiveIntensity = light.windowGlow * 1.4;
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  };

  const setColumns = (columns: readonly MaquetteColumn[]) => {
    scene.remove(prices);
    release(prices);
    prices = priceColumns(columns);
    prices.position.set(7.6, 0, 2.4);
    scene.add(prices);
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  };

  const resize = () => {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width || !height) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const halfWidth = Math.tan((FIELD_OF_VIEW * Math.PI) / 360) * camera.aspect;
    fitDistance = Math.max(DISTANCE, VISIBLE_HALF_WIDTH / halfWidth);
    // Tout de suite : changer la taille efface le canevas, une image d'attente clignoterait.
    window.cancelAnimationFrame(frame);
    draw(performance.now());
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  // Geste : glisser à l'horizontale fait tourner (le défilement vertical de la page reste libre au
  // doigt) ; deux doigts qui s'écartent rapprochent. Les boutons du composant font la même chose.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const onPointerDown = (event: PointerEvent) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinch = 0;
  };
  const onPointerMove = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);
    if (pointers.size === 1) {
      goal.azimuth = view.azimuth -= (next.x - previous.x) * 0.008;
    } else if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      const spread = Math.hypot(first.x - second.x, first.y - second.y);
      if (pinch && spread) {
        goal.zoom = view.zoom = clamp((view.zoom * pinch) / spread, ZOOM.min, ZOOM.max);
      }
      pinch = spread;
    }
    invalidate();
  };
  const onPointerEnd = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pinch = 0;
  };
  const onLost = (event: Event) => {
    event.preventDefault();
    onContextLost();
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerEnd);
  canvas.addEventListener("pointercancel", onPointerEnd);
  canvas.addEventListener("webglcontextlost", onLost);

  setHour(hour);
  resize();

  return {
    setColumns,
    setHour,
    rotate(angle) {
      goal.azimuth += angle;
      invalidate();
    },
    zoom(factor) {
      goal.zoom = clamp(goal.zoom * factor, ZOOM.min, ZOOM.max);
      invalidate();
    },
    dispose() {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerEnd);
      canvas.removeEventListener("pointercancel", onPointerEnd);
      canvas.removeEventListener("webglcontextlost", onLost);
      release(scene);
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
