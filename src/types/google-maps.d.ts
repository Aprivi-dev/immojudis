export {};

declare global {
  interface Window {
    google?: typeof google;
    __immojudisGoogleMapsInit?: () => void;
  }

  namespace google {
    namespace maps {
      type LatLngLike = LatLng | LatLngLiteral;

      interface LatLngLiteral {
        lat: number;
        lng: number;
      }

      class LatLng {
        lat(): number;
        lng(): number;
      }

      interface LatLngAltitudeLiteral {
        lat: number;
        lng: number;
        altitude?: number;
      }

      interface MapOptions {
        backgroundColor?: string;
        center?: LatLngLiteral;
        clickableIcons?: boolean;
        disableDefaultUI?: boolean;
        fullscreenControl?: boolean;
        gestureHandling?: string;
        heading?: number;
        keyboardShortcuts?: boolean;
        mapTypeControl?: boolean;
        mapTypeId?: string;
        minZoom?: number;
        restriction?: {
          latLngBounds: {
            north: number;
            south: number;
            east: number;
            west: number;
          };
          strictBounds?: boolean;
        };
        rotateControl?: boolean;
        scaleControl?: boolean;
        streetViewControl?: boolean;
        styles?: Array<Record<string, unknown>>;
        tilt?: number;
        zoom?: number;
        zoomControl?: boolean;
      }

      class Map {
        constructor(mapDiv: HTMLElement, opts?: MapOptions);
        getHeading(): number | undefined;
        setCenter(latLng: LatLngLiteral): void;
        setHeading(heading: number): void;
        setTilt(tilt: number): void;
        setZoom(zoom: number): void;
      }

      interface Icon {
        anchor?: Point;
        labelOrigin?: Point;
        scaledSize?: Size;
        url: string;
      }

      interface MarkerLabel {
        color?: string;
        fontSize?: string;
        fontWeight?: string;
        text: string;
      }

      interface MarkerOptions {
        icon?: Icon | string;
        label?: MarkerLabel | string;
        map?: Map | null;
        optimized?: boolean;
        position?: LatLngLiteral;
        title?: string;
        zIndex?: number;
      }

      class Marker {
        constructor(opts?: MarkerOptions);
        setMap(map: Map | null): void;
      }

      interface CircleOptions {
        center?: LatLngLiteral;
        clickable?: boolean;
        fillColor?: string;
        fillOpacity?: number;
        map?: Map | null;
        radius?: number;
        strokeColor?: string;
        strokeOpacity?: number;
        strokeWeight?: number;
      }

      class Circle {
        constructor(opts?: CircleOptions);
        setMap(map: Map | null): void;
      }

      class Point {
        constructor(x: number, y: number);
      }

      class Size {
        constructor(width: number, height: number);
      }

      interface StreetViewLocationRequest {
        location: LatLngLiteral;
        preference?: StreetViewPreference;
        radius?: number;
        source?: StreetViewSource;
      }

      interface StreetViewPanoramaData {
        location?: {
          description?: string;
          latLng?: LatLng;
        };
      }

      interface StreetViewPov {
        heading: number;
        pitch: number;
      }

      interface StreetViewPanoramaOptions {
        addressControl?: boolean;
        clickToGo?: boolean;
        disableDefaultUI?: boolean;
        fullscreenControl?: boolean;
        imageDateControl?: boolean;
        linksControl?: boolean;
        motionTracking?: boolean;
        motionTrackingControl?: boolean;
        panControl?: boolean;
        position?: LatLngLike;
        pov?: StreetViewPov;
        scrollwheel?: boolean;
        showRoadLabels?: boolean;
        visible?: boolean;
        zoomControl?: boolean;
      }

      class StreetViewPanorama {
        constructor(container: HTMLElement, opts?: StreetViewPanoramaOptions);
        setPov(pov: StreetViewPov): void;
        setVisible(visible: boolean): void;
      }

      class StreetViewService {
        getPanorama(
          request: StreetViewLocationRequest,
          callback: (data: StreetViewPanoramaData | null, status: StreetViewStatus) => void,
        ): void;
      }

      enum StreetViewPreference {
        BEST = "best",
        NEAREST = "nearest",
      }

      enum StreetViewSource {
        DEFAULT = "default",
        OUTDOOR = "outdoor",
      }

      enum StreetViewStatus {
        OK = "OK",
        UNKNOWN_ERROR = "UNKNOWN_ERROR",
        ZERO_RESULTS = "ZERO_RESULTS",
      }

      interface LocationElevationRequest {
        locations: LatLngLiteral[];
      }

      interface ElevationResult {
        elevation: number;
      }

      interface LocationElevationResponse {
        results: ElevationResult[];
      }

      class ElevationService {
        getElevationForLocations(
          request: LocationElevationRequest,
        ): Promise<LocationElevationResponse>;
      }

      namespace geometry {
        namespace spherical {
          function computeHeading(from: LatLngLike, to: LatLngLike): number;
        }
      }

      function importLibrary(libraryName: "maps3d"): Promise<typeof maps3d>;
      function importLibrary(
        libraryName: "elevation",
      ): Promise<{ ElevationService: typeof ElevationService }>;

      namespace maps3d {
        enum MapMode {
          HYBRID = "HYBRID",
          SATELLITE = "SATELLITE",
        }

        interface Camera {
          center?: LatLngAltitudeLiteral;
          heading?: number;
          range?: number;
          roll?: number;
          tilt?: number;
        }

        interface Map3DElementOptions {
          center?: LatLngAltitudeLiteral;
          heading?: number;
          mode?: MapMode;
          range?: number;
          roll?: number;
          tilt?: number;
        }

        interface FlyAroundAnimationOptions {
          camera: Camera;
          durationMillis?: number;
          repeatCount?: number;
          rounds?: number;
        }

        class Map3DElement extends HTMLElement {
          constructor(options?: Map3DElementOptions);
          center: LatLngAltitudeLiteral | null;
          heading: number | null;
          mode: MapMode | null;
          range: number | null;
          tilt: number | null;
          flyCameraAround(options: FlyAroundAnimationOptions): void;
          stopCameraAnimation(): void;
        }

        enum AltitudeMode {
          ABSOLUTE = "ABSOLUTE",
          CLAMP_TO_GROUND = "CLAMP_TO_GROUND",
          RELATIVE_TO_GROUND = "RELATIVE_TO_GROUND",
          RELATIVE_TO_MESH = "RELATIVE_TO_MESH",
        }

        interface Marker3DElementOptions {
          altitudeMode?: AltitudeMode;
          extruded?: boolean;
          label?: string;
          position?: LatLngAltitudeLiteral | LatLngLiteral;
          sizePreserved?: boolean;
          zIndex?: number;
        }

        class Marker3DElement extends HTMLElement {
          constructor(options?: Marker3DElementOptions);
        }
      }
    }
  }
}
