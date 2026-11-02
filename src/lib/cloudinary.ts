// Builds Cloudinary delivery URLs. Only the (public) cloud name is needed —
// API credentials are used by scripts/import-photos.mjs and never by the site.
const cloudName = import.meta.env.PUBLIC_CLOUDINARY_CLOUD_NAME;

if (!cloudName) {
  throw new Error('PUBLIC_CLOUDINARY_CLOUD_NAME is not set. Copy .env.example to .env and fill it in.');
}

type Options = {
  width?: number;
  height?: number;
  crop?: 'fill' | 'limit' | 'fit';
};

export function cldUrl(publicId: string, { width, height, crop = 'limit' }: Options = {}) {
  // f_auto/q_auto pick the best format and compression per browser; delivered
  // derivatives have metadata (including GPS) stripped.
  const t = ['f_auto', 'q_auto', `c_${crop}`];
  if (width) t.push(`w_${width}`);
  if (height) t.push(`h_${height}`);
  if (crop === 'fill') t.push('g_auto');
  return `https://res.cloudinary.com/${cloudName}/image/upload/${t.join(',')}/${publicId}`;
}

const widths = [400, 800, 1200, 1600, 2400];

export function cldSrcset(publicId: string, options: Omit<Options, 'width'> & { aspect?: number } = {}) {
  const { aspect, ...rest } = options;
  return widths
    .map((w) => {
      const height = aspect ? Math.round(w / aspect) : undefined;
      return `${cldUrl(publicId, { ...rest, width: w, height })} ${w}w`;
    })
    .join(', ');
}
