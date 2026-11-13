/**
 * Abonnement à un choix gardé dans `localStorage` (pour `useSyncExternalStore`) : prévenu quand
 * cet onglet annonce un changement (`changeEvent`) ou quand un autre onglet modifie la clé.
 */
export function subscribeStoredChoice(
  storageKey: string,
  changeEvent: string,
  onChange: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === storageKey) onChange();
  };
  window.addEventListener(changeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEvent, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
