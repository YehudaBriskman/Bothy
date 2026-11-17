/** Locale-aware formatting. Every date, size and count on the site goes through here. */

export function formatDate(iso: string, tag: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone: 'UTC' }).format(
    Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1),
  );
}

export function formatSize(bytes: number, tag: string): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1)
    return new Intl.NumberFormat(tag, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(mb);
  return new Intl.NumberFormat(tag, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 }).format(bytes / 1024);
}
