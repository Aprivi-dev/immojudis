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
        mapId?: string;
        mapTypeControl?: boolean;
        mapTypeId?: string;
        rotateControl?: boolean;
        streetViewControl?: boolean;
        tilt?: number;
        zoom?: number;
        zoomControl?: boolean;
      }

      class Map {
        constructor(mapDiv: HTMLElement, opts?: MapOptions);
        getHeading(): number | undefined;
        setHeading(heading: number): void;
      }

      interface MarkerOptions {
        map?: Map | null;
        position?: LatLngLiteral;
        title?: string;
      }

      class Marker {
        constructor(opts?: MarkerOptions);
        setMap(map: Map | null): void;
      }

      interface StreetViewLocationRequest {
        location: LatLngLiteral;
        preference?: StreetViewPreference;
        radius?: number;
        source?: StreetViewSource;
      }

      interface StreetViewPanoramaData {
        location?: {
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

      function importLibrary(libraryName: "maps3d"): Promise<typeof maps3d>;
      function importLibrary(
        libraryName: "elevation",
      ): Promise<{ ElevationService: typeof ElevationService }>;

      namespace maps3d {
        enum MapMode {
          HYBRID = "HYBRID",
          SATELLITE = "SATELLITE",
        }

        enum AltitudeMode {
          ABSOLUTE = "ABSOLUTE",
          CLAMP_TO_GROUND = "CLAMP_TO_GROUND",
          RELATIVE_TO_GROUND = "RELATIVE_TO_GROUND",
          RELATIVE_TO_MESH = "RELATIVE_TO_MESH",
        }

        interface Camera {
          altitudeMode?: AltitudeMode;
          center?: LatLngAltitudeLiteral;
          heading?: number;
          range?: number;
          roll?: number;
          tilt?: number;
        }

        interface Map3DElementOptions {
          center?: LatLngAltitudeLiteral;
          defaultUIHidden?: boolean;
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
          defaultUIHidden: boolean | null;
          flyCameraAround(options: FlyAroundAnimationOptions): void;
          stopCameraAnimation(): void;
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
