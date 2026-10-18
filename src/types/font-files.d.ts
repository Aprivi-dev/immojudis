// Fichiers de police importés comme ressources statiques : l'import donne l'URL publique du fichier
// (`/_next/static/media/<empreinte>.woff2`), la même que celle d'un `url()` de feuille de style.
declare module "*.woff2" {
  const url: string;
  export default url;
}
