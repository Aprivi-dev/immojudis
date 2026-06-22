export function isNew(createdAt: string | null | undefined, days = 7): boolean {
  if (!createdAt) return false;
  const date = new Date(createdAt);
  if (isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() < days * 24 * 60 * 60 * 1000;
}
