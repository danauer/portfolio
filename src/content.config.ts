// Mirrors keystatic.config.ts. Keystatic writes the files; Astro validates
// them here (including every cross-reference) and fails the build on errors.
import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const yaml = (dir: string) => glob({ pattern: '*.yaml', base: `./src/content/${dir}` });

// YAML may parse dates as Date objects or strings; normalize both.
const date = () => z.coerce.date().nullish();
const text = () => z.string().nullish();
const tags = z.array(reference('tags')).default([]);
const credits = z
  .array(z.object({ person: reference('people'), role: text() }))
  .default([]);
const status = z.enum(['draft', 'published']).default('draft');

const projects = defineCollection({
  loader: glob({ pattern: '*.mdoc', base: './src/content/projects' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      discipline: z.enum(['ux', 'visual', 'art']),
      status,
      featured: z.boolean().default(false),
      summary: text(),
      cover: image().nullish(),
      coverAlt: text(),
      client: reference('organizations').nullish(),
      position: reference('positions').nullish(),
      role: text(),
      startDate: date(),
      endDate: date(),
      outcomes: z.array(z.string()).default([]),
      medium: text(),
      dimensions: text(),
      gallery: z
        .array(z.object({ image: image(), alt: text(), caption: text() }))
        .default([]),
      credits,
      tags,
    }),
});

const experiments = defineCollection({
  loader: yaml('experiments'),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      status,
      link: z.string().min(1),
      summary: text(),
      cover: image().nullish(),
      coverAlt: text(),
      date: date(),
    }),
});

const organizations = defineCollection({
  loader: yaml('organizations'),
  schema: ({ image }) =>
    z.object({
      name: z.string(),
      kinds: z.array(z.enum(['employer', 'client'])).default([]),
      industry: text(),
      location: text(),
      website: text(),
      logo: image().nullish(),
      description: text(),
      myRole: text(),
      tags,
    }),
});

const positions = defineCollection({
  loader: yaml('positions'),
  schema: z.object({
    title: z.string(),
    organization: reference('organizations'),
    employmentType: z.enum(['full-time', 'part-time', 'contract', 'freelance', 'internship']),
    roleType: z.enum(['management', 'split', 'lead', 'individual', 'contractor', 'personal']).nullish(),
    startDate: z.coerce.date(),
    endDate: date(),
    location: text(),
    summary: text(),
    highlights: z.array(z.string()).default([]),
    tags,
  }),
});

const people = defineCollection({
  loader: yaml('people'),
  schema: z.object({
    name: z.string(),
    title: text(),
    website: text(),
    tags,
  }),
});

const photos = defineCollection({
  loader: yaml('photos'),
  schema: z.object({
    title: z.string(),
    cloudinaryId: z.string().min(1),
    width: z.number().nullish(),
    height: z.number().nullish(),
    alt: text(),
    caption: text(),
    takenAt: date(),
    location: text(),
    camera: text(),
    lens: text(),
    exposure: text(),
    credits,
    tags,
  }),
});

const photoGroups = defineCollection({
  loader: yaml('photo-groups'),
  schema: z.object({
    title: z.string(),
    status,
    date: date(),
    description: text(),
    cover: reference('photos').nullish(),
    photos: z.array(reference('photos')).default([]),
    tags,
  }),
});

const tagsCollection = defineCollection({
  loader: yaml('tags'),
  schema: z.object({
    name: z.string(),
    category: z.enum(['skill', 'tool', 'industry', 'medium', 'theme', 'other']),
    description: text(),
  }),
});

const site = defineCollection({
  loader: yaml('site'),
  schema: ({ image }) =>
    z.object({
      name: text(),
      headline: text(),
      bio: text(),
      portrait: image().nullish(),
      portraitAlt: text(),
      email: text(),
      location: text(),
      links: z.array(z.object({ label: z.string(), url: text() })).default([]),
      experience: z.array(z.object({ name: z.string(), years: text() })).default([]),
      clients: z.array(z.object({ category: z.string(), names: text() })).default([]),
    }),
});

export const collections = {
  projects,
  experiments,
  organizations,
  positions,
  people,
  photos,
  photoGroups,
  tags: tagsCollection,
  site,
};
