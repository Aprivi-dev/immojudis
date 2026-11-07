/** `decodeURIComponent` qui rend la valeur telle quelle si elle est mal encodée. */
export function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
