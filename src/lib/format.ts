// Number, duration and date formatting shared by the /games, /steam and /psn pages.
const nf = new Intl.NumberFormat('en-US');
export const num = (n: number) => nf.format(Math.round(n));
export const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const hours = (minutes: number) => {
  const h = minutes / 60;
  if (h === 0) return '0 h';
  if (h < 1) return `${Math.round(minutes)} min`;
  return `${h < 10 ? h.toFixed(1) : num(h)} h`;
};
export const money = (cents: number, digits = 0) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(cents / 100);
export const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;
/** Unix seconds -> "Nov 13, 2026". */
export const date = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
