/** Taille de fichier lisible en français (o, Ko, Mo). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} Ko`;
  return `${(kilobytes / 1024).toFixed(1)} Mo`;
}
