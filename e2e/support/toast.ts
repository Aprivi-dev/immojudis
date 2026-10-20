import type { Locator, Page } from "@playwright/test";

/**
 * Notifications et régions d'état, côté tests.
 *
 * `LazyToaster` monte en permanence une région vivante invisible (`role="status"`,
 * `data-testid="toast-announcer"`) qui relaie aux lecteurs d'écran le texte des notifications
 * émises avant que sonner soit chargé. Selon la course, ce texte s'y trouve aussi : un
 * `page.getByText("Recherche enregistrée")` ou un `page.getByRole("status")` peut alors désigner
 * deux éléments (violation du mode strict). L'annonce doit rester ; les tests ciblent donc la
 * notification visible, ou la région d'état propre à la page.
 */

/** Conteneur des notifications sonner (la section « Notifications alt+T »). */
export function toastRegion(page: Page): Locator {
  return page.getByRole("region", { name: /Notifications/ });
}

/** Notification visible portant ce texte (jamais la région vivante invisible qui la relaie). */
export function toastMessage(
  page: Page,
  text: string | RegExp,
  options?: { exact?: boolean },
): Locator {
  return toastRegion(page).getByText(text, options);
}

/** Régions `role="status"` de la page, sans l'annonceur des notifications. */
export function pageStatus(page: Page): Locator {
  return page.locator('[role="status"]:not([data-testid="toast-announcer"])');
}
