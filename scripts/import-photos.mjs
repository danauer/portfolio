#!/usr/bin/env node
// Bulk-imports a folder of photos: uploads each to Cloudinary, reads EXIF, and
// writes a Photo entry (src/content/photos/<slug>.yaml) that Keystatic can edit.
//
//   npm run photos:import -- <folder> [--group <slug>] [--tags tag-a,tag-b] [--dry-run]
//
// --group  appends imported photos to that photo group (created as a draft if missing)
// --tags   tag slugs (must already exist) applied to every imported photo
//
// Re-running is safe: photos that already have an entry are skipped (but still
// added to --group), and Cloudinary uploads never overwrite existing assets.
// GPS coordinates are deliberately not copied into the entries.
import 'dotenv/config';
import { readdir, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { v2 as cloudinary } from 'cloudinary';
import exifr from 'exifr';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'src/content/photos');
const GROUPS_DIR = path.join(ROOT, 'src/content/photo-groups');
const TAGS_DIR = path.join(ROOT, 'src/content/tags');
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.webp']);
const CONCURRENCY = 4;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    group: { type: 'string' },
    tags: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const [folder] = positionals;
if (!folder) {
  console.error('Usage: npm run photos:import -- <folder> [--group <slug>] [--tags a,b] [--dry-run]');
  process.exit(1);
}

const dryRun = opts['dry-run'];
const exists = (p) => access(p).then(() => true, () => false);
const slugify = (s) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleize = (s) => s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

// Config ----------------------------------------------------------------------

const cloudName = process.env.PUBLIC_CLOUDINARY_CLOUD_NAME;
const { CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = process.env;
const cloudFolder = process.env.CLOUDINARY_FOLDER || 'portfolio/photos';

if (!dryRun && (!cloudName || !apiKey || !apiSecret)) {
  console.error('Missing Cloudinary credentials. Set PUBLIC_CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env');
  process.exit(1);
}
cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });

const tags = (opts.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
for (const tag of tags) {
  if (!(await exists(path.join(TAGS_DIR, `${tag}.yaml`)))) {
    console.error(`Unknown tag "${tag}". Create it in Keystatic first (Reference → Tags).`);
    process.exit(1);
  }
}

// Import ----------------------------------------------------------------------

function describeExif(exif = {}) {
  const fmt = (n, digits = 0) => Number(n.toFixed(digits));
  const shutter = (t) => (t >= 1 ? `${fmt(t, 1)}s` : `1/${Math.round(1 / t)}s`);
  const make = exif.Make?.trim();
  const model = exif.Model?.trim();
  const camera = model && make && !model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? `${make} ${model}` : model || make;
  const exposure = [
    exif.FocalLength && `${fmt(exif.FocalLength)}mm`,
    exif.FNumber && `ƒ/${fmt(exif.FNumber, 1)}`,
    exif.ExposureTime && shutter(exif.ExposureTime),
    exif.ISO && `ISO ${exif.ISO}`,
  ].filter(Boolean);
  // EXIF times are camera-local and exifr parses them as local, so use local parts (not UTC).
  const taken = exif.DateTimeOriginal instanceof Date && !isNaN(exif.DateTimeOriginal) ? exif.DateTimeOriginal : null;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    takenAt: taken ? `${taken.getFullYear()}-${pad(taken.getMonth() + 1)}-${pad(taken.getDate())}` : undefined,
    camera: camera || undefined,
    lens: exif.LensModel?.trim() || undefined,
    exposure: exposure.length ? exposure.join(' · ') : undefined,
  };
}

async function importOne(file) {
  const base = path.parse(file).name;
  const slug = slugify(base);
  const entryPath = path.join(PHOTOS_DIR, `${slug}.yaml`);

  if (await exists(entryPath)) return { slug, status: 'skipped (entry exists)' };

  // Pass a buffer, not a path: exifr leaks file handles, which Node 26+ treats as fatal.
  const exif = await exifr
    .parse(await readFile(file), ['DateTimeOriginal', 'Make', 'Model', 'LensModel', 'FNumber', 'ExposureTime', 'ISO', 'FocalLength'])
    .catch(() => undefined);
  const meta = describeExif(exif);
  const publicId = `${cloudFolder}/${slug}`;

  let width, height;
  if (!dryRun) {
    const res = await cloudinary.uploader.upload(file, {
      public_id: publicId,
      asset_folder: cloudFolder,
      overwrite: false,
      unique_filename: false,
      resource_type: 'image',
    });
    ({ width, height } = res);
  }

  const entry = {
    title: titleize(base),
    cloudinaryId: publicId,
    width,
    height,
    alt: '',
    ...meta,
    tags,
  };
  // Drop empty values so the YAML stays tidy (Keystatic fills in defaults).
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];

  if (!dryRun) await writeFile(entryPath, YAML.stringify(entry));
  return { slug, status: dryRun ? 'would import' : 'imported' };
}

async function addToGroup(groupSlug, slugs) {
  const groupPath = path.join(GROUPS_DIR, `${groupSlug}.yaml`);
  const group = (await exists(groupPath))
    ? YAML.parse(await readFile(groupPath, 'utf8'))
    : { title: titleize(groupSlug), status: 'draft', photos: [] };
  group.photos ??= [];
  const added = slugs.filter((s) => !group.photos.includes(s));
  group.photos.push(...added);
  if (!dryRun) await writeFile(groupPath, YAML.stringify(group));
  console.log(`\n${dryRun ? 'Would add' : 'Added'} ${added.length} photo(s) to group "${groupSlug}".`);
}

const files = (await readdir(folder))
  .filter((f) => EXTENSIONS.has(path.extname(f).toLowerCase()))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .map((f) => path.join(folder, f));

if (!files.length) {
  console.error(`No images found in ${folder}`);
  process.exit(1);
}

await mkdir(PHOTOS_DIR, { recursive: true });
await mkdir(GROUPS_DIR, { recursive: true });
console.log(`${dryRun ? '[dry run] ' : ''}Importing ${files.length} image(s) from ${folder} → cloudinary:${cloudFolder}\n`);

const results = new Array(files.length);
let next = 0;
let failed = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < files.length) {
      const i = next++;
      try {
        results[i] = await importOne(files[i]);
        console.log(`  ${results[i].status.padEnd(22)} ${results[i].slug}`);
      } catch (err) {
        failed++;
        console.error(`  FAILED                 ${path.basename(files[i])}: ${err.message ?? err.error?.message ?? err}`);
      }
    }
  }),
);

if (opts.group) await addToGroup(slugify(opts.group), results.filter(Boolean).map((r) => r.slug));
if (failed) {
  console.error(`\n${failed} file(s) failed.`);
  process.exit(1);
}
console.log('\nDone. Open Keystatic to add alt text, captions and tags.');
