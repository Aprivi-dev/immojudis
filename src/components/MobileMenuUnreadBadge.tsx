import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { fetchAlertNotifications } from "@/lib/client-api";
import * as queryKeys from "@/lib/query-keys";
import { MOBILE_MENU_UNREAD_ID } from "@/components/mobile-menu-unread";

/**
 * Pastille de notifications non lues sur le bouton du menu mobile : la cloche n'y est visible
 * qu'une fois le menu ouvert, une vente nouvelle passerait sinon inaperçue. Elle partage la
 * requête de la cloche (même clé) : aucun appel supplémentaire.
 */
export function MobileMenuUnreadBadge() {
  const { user, loading } = useAuth();
  if (loading || !user) return null;
  return <UnreadBadge key={user.id} userId={user.id} />;
}

function UnreadBadge({ userId }: { userId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.alertNotifications(userId),
    queryFn: () => fetchAlertNotifications({ limit: 12 }),
    refetchInterval: 120_000,
  });
  const unreadCount = (data?.notifications ?? []).filter(
    (notification) => !notification.readAt,
  ).length;
  if (unreadCount === 0) return null;
  return (
    <>
      <span
        aria-hidden
        data-testid="mobile-menu-unread"
        className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-gold px-1 text-[10px] font-bold text-brand-navy"
      >
        {unreadCount > 9 ? "9+" : unreadCount}
      </span>
      <span id={MOBILE_MENU_UNREAD_ID} className="sr-only">
        {unreadCount > 1
          ? `${unreadCount} notifications d'alertes non lues`
          : "1 notification d'alerte non lue"}
      </span>
    </>
  );
}
