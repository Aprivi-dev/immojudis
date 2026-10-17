import { MapboxPreconnect } from "@/components/MapboxPreconnect";
import { PhotoMirrorPreconnect } from "@/components/PhotoMirrorPreconnect";

/**
 * Le catalogue (`/sales`) et la fiche (`/sales/[id]`) affichent les copies hébergées des photos et
 * des vignettes Mapbox : les connexions à ces deux origines sont préparées dès le premier octet. Ce
 * layout ne fait que cela ; il enveloppe les `loading.tsx` de /sales et de la fiche. Les autres
 * pages n'affichent aucune copie ni vignette Mapbox au premier écran et n'ouvrent donc aucune
 * connexion de plus.
 */
export default function SalesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PhotoMirrorPreconnect />
      <MapboxPreconnect />
      {children}
    </>
  );
}
