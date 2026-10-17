import { PhotoMirrorPreconnect } from "@/components/PhotoMirrorPreconnect";

/**
 * Le catalogue (`/sales`) et la fiche (`/sales/[id]`) affichent les copies hébergées des photos :
 * la connexion à leur stockage est préparée dès le premier octet. Ce layout ne fait que cela ; il
 * enveloppe les `loading.tsx` de /sales et de la fiche. Les autres pages n'affichent aucune copie
 * et n'ouvrent donc aucune connexion de plus.
 */
export default function SalesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PhotoMirrorPreconnect />
      {children}
    </>
  );
}
