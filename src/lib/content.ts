import { getCollection, getEntry, type CollectionEntry } from 'astro:content';

export type Discipline = CollectionEntry<'projects'>['data']['discipline'];

export const disciplines: Record<Discipline, { label: string; path: string }> = {
  ux: { label: 'UX Design', path: 'ux' },
  visual: { label: 'Visual Design', path: 'visual' },
  art: { label: 'Art', path: 'art' },
};

/** Drafts show up in `npm run dev` (marked as drafts) but never in a production build. */
export const isVisible = (status: 'draft' | 'published') => !import.meta.env.PROD || status === 'published';

const byRecency = (a: CollectionEntry<'projects'>, b: CollectionEntry<'projects'>) =>
  (b.data.endDate ?? b.data.startDate ?? new Date(0)).getTime() -
  (a.data.endDate ?? a.data.startDate ?? new Date(0)).getTime();

export async function getProjects(discipline?: Discipline) {
  const projects = await getCollection(
    'projects',
    (p) => isVisible(p.data.status) && (!discipline || p.data.discipline === discipline),
  );
  return projects.sort(byRecency);
}

export async function getPhotoGroups() {
  const groups = await getCollection('photoGroups', (g) => isVisible(g.data.status));
  return groups.sort((a, b) => (b.data.date?.getTime() ?? 0) - (a.data.date?.getTime() ?? 0));
}

export async function getSettings() {
  return (await getEntry('site', 'settings'))?.data;
}

/** Prefixes a site-relative path with the configured base (needed for GitHub project pages). */
export function url(path: string) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}/${path.replace(/^\//, '')}`;
}

export const projectUrl = (p: CollectionEntry<'projects'>) => url(`${disciplines[p.data.discipline].path}/${p.id}`);

const monthYear = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function formatRange(start?: Date | null, end?: Date | null, { ongoing = 'Present' } = {}) {
  if (!start) return end ? monthYear.format(end) : '';
  return `${monthYear.format(start)} – ${end ? monthYear.format(end) : ongoing}`;
}

export function formatDuration(start: Date, end?: Date | null) {
  const e = end ?? new Date();
  const months = (e.getUTCFullYear() - start.getUTCFullYear()) * 12 + (e.getUTCMonth() - start.getUTCMonth()) + 1;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y && `${y} yr${y > 1 ? 's' : ''}`, m && `${m} mo${m > 1 ? 's' : ''}`].filter(Boolean).join(' ');
}
