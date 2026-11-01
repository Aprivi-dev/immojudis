/**
 * Mode sombre de l'aperçu. Le cadre commun (`email-layout.ts`) range ses règles sombres dans
 * `@media (prefers-color-scheme: dark)` : une iframe suit la préférence de l'administrateur, pas le
 * bouton « Sombre ». Le serveur remplace donc la condition par `@media all` dans le HTML d'aperçu.
 * C'est l'effet de nos propres règles, pas l'inversion automatique de Gmail ou d'Apple Mail.
 */
export function forceDarkScheme(html: string): string {
  return html.replaceAll("@media (prefers-color-scheme: dark)", "@media all");
}
