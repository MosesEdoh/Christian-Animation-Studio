/** Decimal units match the saved file's byte count, not an estimated render size. */
export function movieSizeLabel(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isSafeInteger(bytes) || bytes < 0) return 'Size unknown';
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log10(bytes) / 3) - 1, units.length - 1);
  return `${(bytes / 1000 ** (index + 1)).toLocaleString('en-US', { maximumFractionDigits: 1 })} ${units[index]}`;
}
