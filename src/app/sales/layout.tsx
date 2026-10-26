import { FeeRegimesProvider } from "@/components/FeeRegimesProvider";
import { MapboxPreconnect } from "@/components/MapboxPreconnect";
import { PhotoMirrorPreconnect } from "@/components/PhotoMirrorPreconnect";
import { feeRegimesSettingsFromEnv } from "@/lib/fee-regime.server";

/**
 * Le catalogue (`/sales`) et la fiche (`/sales/[id]`) affichent les copies hébergées des photos et
 * des vignettes Mapbox : les connexions à ces deux origines sont préparées dès le premier octet. Ce
 * layout ne fait que cela ; il enveloppe les `loading.tsx` de /sales et de la fiche. Les autres
 * pages n'affichent aucune copie ni vignette Mapbox au premier écran et n'ouvrent donc aucune
 * connexion de plus. Il passe aussi aux cartes de résultats l'interrupteur par régime lu côté
 * serveur (`CEILING_FEE_REGIMES_OPEN`).
 */
export default function SalesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PhotoMirrorPreconnect />
      <MapboxPreconnect />
      <FeeRegimesProvider value={feeRegimesSettingsFromEnv()}>{children}</FeeRegimesProvider>
    </>
  );
}
