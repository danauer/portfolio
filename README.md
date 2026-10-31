# Portfolio

A static portfolio site built with [Astro](https://astro.build), with content managed by
[Keystatic](https://keystatic.com), a CMS that runs only on your machine. Photography is
hosted on [Cloudinary](https://cloudinary.com). The site deploys to GitHub Pages.

## Setup

```sh
nvm use               # Node version is pinned in .nvmrc
npm install
cp .env.example .env  # then fill in your Cloudinary details
npm run dev
```

- Site: http://127.0.0.1:4321
- CMS: http://127.0.0.1:4321/keystatic

## How content works

Keystatic edits files in `src/content/` and images in `src/assets/images/`. There's no
database: the repo *is* the content. To publish, commit and push to `main`. GitHub Actions
builds the site and deploys it.

The repo is public, so anything you commit (including drafts) is readable on GitHub. The
`status: draft` flag only keeps content off the *built site*. Keep confidential work out of
the repo entirely.

### Data model

| Collection | What it is | Links to |
|---|---|---|
| Projects | UX, visual design and art work. `discipline` picks the section. | Organization (client), Position, People (credits), Tags |
| Organizations | Employers and clients (one record can be both) | Tags |
| Positions | A job title held at an organization, with dates | Organization, Tags |
| People | Collaborators credited on projects and photos | Tags |
| Photos | A single Cloudinary-hosted photo with EXIF details | People (credits), Tags |
| Photo groups | An ordered set of photos (album / series) | Photos, Tags |
| Tags | Shared across everything, grouped by category | — |
| Site settings | Name, headline, bio, contact links | — |

Links are only stored on one side (e.g. a project points to its position). Reverse lookups,
like the projects listed under each job on `/timeline`, are computed at build time. A broken
link (e.g. a deleted tag still referenced somewhere) fails the build, so mistakes can't ship.

The schema is defined twice and the two must stay in sync:
`keystatic.config.ts` defines the CMS forms, and `src/content.config.ts` validates the files
for Astro.

### Pages

`/` featured work · `/ux`, `/visual`, `/art` + a page per project · `/photography` + a page per
group · `/photos/<slug>` · `/timeline` · `/about` · `/tags` + a page per tag

## Photos and Cloudinary

Project images (screenshots etc.) live in the repo and are optimized by Astro at build time.
Photography lives in Cloudinary to keep the repo small; the site only stores each photo's
Cloudinary ID and metadata.

To import a folder of photos:

```sh
npm run photos:import -- ~/Pictures/export/new-york --group new-york --tags street,film
```

This uploads each image to Cloudinary (`portfolio/photos/<slug>`), reads date, camera, lens
and exposure from EXIF (GPS is deliberately not copied), writes a Photo entry, and appends
the photos to the group (creating the group as a draft if it doesn't exist). It's safe to
re-run. Add `--dry-run` to preview. Then open Keystatic to add alt text and captions.

Export web-sized JPEGs (e.g. 3000px on the long edge) rather than full-resolution originals.
They look identical on the site and use far less of Cloudinary's free-tier storage.

You can also upload in Cloudinary's own UI and create the Photo entry in Keystatic by pasting
the public ID.

## Deploying to GitHub Pages (one-time setup)

1. Push this repo to GitHub.
2. **Settings → Pages → Source:** GitHub Actions.
3. **Settings → Secrets and variables → Actions → Variables:** add `CLOUDINARY_CLOUD_NAME`.
   This is a variable, not a secret; it's public anyway. Your API key and secret are only
   used locally and must never be committed.
4. Push to `main`. The workflow in `.github/workflows/deploy.yml` builds and deploys. It sets
   the base path automatically, so this works for both `user.github.io` and
   `user.github.io/repo-name` URLs.

## Commands

| Command | |
|---|---|
| `npm run dev` | Site + Keystatic at 127.0.0.1:4321 (drafts visible) |
| `npm run build` | Static build to `dist/` (drafts excluded) |
| `npm run preview` | Serve the built site |
| `npm run check` | Type-check |
| `npm run photos:import -- <folder>` | Bulk import photos to Cloudinary |
