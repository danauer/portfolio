#!/usr/bin/env node
// Pulls your Xbox title history (last played, achievements, Game Pass flag) and minutes
// played per game into src/data/xbox/snapshot.json, which the /games pages render at
// build time. The site stays static: the key is only used here, locally.
//
//   npm run xbox:sync                  # library + store picks
//   npm run xbox:sync -- --no-store    # library only (fast, 3 OpenXBL requests)
//   npm run xbox:sync -- --refresh     # ignore the store cache
//   npm run xbox:sync -- --gamertag "Your Gamertag"   # if the account lookup fails
//
// The store step needs no key: it reads Microsoft's public Xbox catalog (genres, user ratings, list
// prices, release dates) and the public Game Pass catalog, then builds picks from the Game Pass games
// you haven't played, matched on genre and ranked with the store's user ratings. Microsoft's old
// best-seller and deal lists are gone, so Game Pass is the only pool of picks. Responses are cached
// in .cache/xbox for a day.
//
// There is no official way to read your own play time from Microsoft without registering
// an Azure app, so this goes through OpenXBL (https://xbl.io), a third-party service:
//   1. Sign in at https://xbl.io with your Xbox account
//   2. Copy the API key into XBL_API_KEY in .env
// The free plan allows 150 requests/hour; a sync uses 3 (plus one per 600 games). NEVER commit the key.
//
// Caveats, so the numbers aren't over-trusted:
//  - Minutes come from Xbox's native MinutesPlayed stat. Microsoft calls it an approximation, and
//    games that don't report it come back with no value. Those are stored as null ("unknown"),
//    never 0, because having no minutes doesn't mean you never played.
//  - Title history includes PC/Win32 titles (Steam and other launchers show up there). They are
//    kept in the snapshot with their devices; src/lib/xbox.ts decides which count.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src/data/xbox/snapshot.json');
const STORE_OUT = path.join(ROOT, 'src/data/xbox/store.json');
const CACHE_DIR = path.join(ROOT, '.cache/xbox');
const BASE = 'https://api.xbl.io';
const BATCH = 600; // titles per stats request on OpenXBL

const { values: opts } = parseArgs({
  options: {
    gamertag: { type: 'string' },
    'no-store': { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
  },
});

const apiKey = process.env.XBL_API_KEY?.trim();
if (!apiKey) {
  console.error('Set XBL_API_KEY in .env. See the header of scripts/sync-xbox.mjs for how to get it.');
  process.exit(1);
}

async function call(route, body) {
  const res = await fetch(BASE + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      'X-Authorization': apiKey,
      Accept: 'application/json',
      'Accept-Language': 'en-US',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 429) fail('OpenXBL rate limit hit (150 requests/hour on the free plan). Try again later.');
  if (res.status === 401 || res.status === 403) fail(`OpenXBL rejected the key (${res.status}). Check XBL_API_KEY.`);
  if (!res.ok) fail(`${route} returned ${res.status}: ${text.slice(0, 200)}`);
  try {
    const json = JSON.parse(text);
    return json?.content ?? json; // responses are sometimes wrapped as { content, code }
  } catch {
    return fail(`${route} did not return JSON: ${text.slice(0, 200)}`);
  }
}
function fail(msg) {
  console.error(`${msg}\nNothing was written; the existing snapshot is untouched.`);
  process.exit(1);
}

// Account ---------------------------------------------------------------------------------
console.log('Looking up the account…');
const profileOf = (c) => {
  const user = c?.profileUsers?.[0];
  if (!user) return null;
  const s = Object.fromEntries((user.settings ?? []).map((x) => [x.id, x.value]));
  return { xuid: user.id, gamertag: s.Gamertag ?? s.ModernGamertag ?? null, gamerscore: Number(s.Gamerscore) || 0, avatar: s.GameDisplayPicRaw ?? null };
};
const me = profileOf(await call(opts.gamertag ? `/v2/friends/search?gt=${encodeURIComponent(opts.gamertag)}` : '/v2/account'));
if (!me?.xuid) fail('Could not read the account. Try --gamertag "Your Gamertag".');

// Title history ---------------------------------------------------------------------------
console.log('Fetching title history…');
const history = (await call(`/v2/titles/${me.xuid}`))?.titles;
if (!Array.isArray(history)) fail('Title history came back in an unexpected shape.');
const titles = history.filter((t) => !t.type || t.type === 'Game');

// Minutes played ---------------------------------------------------------------------------
console.log(`Fetching minutes played for ${titles.length} titles…`);
const minutes = new Map();
for (let i = 0; i < titles.length; i += BATCH) {
  const stats = await call('/v2/player/stats', {
    xuids: [me.xuid],
    groups: [],
    stats: titles.slice(i, i + BATCH).map((t) => ({ name: 'MinutesPlayed', titleId: String(t.titleId) })),
  });
  const lists = stats?.statlistscollection;
  if (!Array.isArray(lists)) fail('Play time came back in an unexpected shape.');
  for (const s of lists.flatMap((l) => l.stats ?? [])) {
    if (s.value != null) minutes.set(String(s.titleid ?? s.titleId), Number(s.value) || 0);
  }
}

const https = (u) => (u ? u.replace(/^http:\/\//, 'https://') : null);
const games = titles
  .map((t) => ({
    titleId: String(t.titleId),
    name: t.name,
    devices: t.devices ?? [],
    image: https(t.displayImage),
    // null = Xbox reported nothing, which is not the same as zero.
    minutes: minutes.get(String(t.titleId)) ?? null,
    lastPlayed: t.titleHistory?.lastTimePlayed ?? null,
    achievements: t.achievement?.currentAchievements ?? 0,
    gamerscore: t.achievement?.currentGamerscore ?? 0,
    totalGamerscore: t.achievement?.totalGamerscore ?? 0,
    gamePass: !!t.gamePass?.isGamePass,
  }))
  .sort((a, b) => (b.minutes ?? -1) - (a.minutes ?? -1) || (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? ''));

const snapshot = {
  generatedAt: new Date().toISOString(),
  profile: { gamertag: me.gamertag, gamerscore: me.gamerscore, avatar: https(me.avatar) },
  games,
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(snapshot, null, 1) + '\n');

const tracked = games.filter((g) => g.minutes != null && g.minutes > 0);
console.log(`\nWrote ${path.relative(process.cwd(), OUT)}`);
console.log(`  ${games.length} titles, ${tracked.length} with play time (${Math.round(tracked.reduce((n, g) => n + g.minutes, 0) / 60)}h), ${games.length - tracked.length} without`);
console.log(`  ${me.gamertag}, gamerscore ${me.gamerscore}`);
console.log('  top by play time:');
for (const g of tracked.slice(0, 5)) console.log(`    ${(g.minutes / 60).toFixed(1).padStart(7)}h  ${g.name}`);

// Store recommendations -----------------------------------------------------------------------

if (opts['no-store']) {
  console.log('\nSkipping the store (--no-store).');
  process.exit(0);
}

try {
  await buildStore();
} catch (err) {
  // The catalog endpoints are unofficial; if they change, keep the library snapshot and the last good picks.
  console.warn(`\nStore step failed: ${err.message}\nThe library snapshot was written; store.json was left as it was.`);
}

async function buildStore() {
  console.log('\nReading the Xbox catalog…');
  await mkdir(CACHE_DIR, { recursive: true });

  const CATALOG = 'https://displaycatalog.mp.microsoft.com/v7.0';
  const GAME_PASS_CONSOLE = 'f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e'; // "All Console Games"
  const TTL = 24 * 60 * 60 * 1000;
  const BULK = 100; // product ids per catalog request
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function cached(key, fetcher) {
    const file = path.join(CACHE_DIR, `${key.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
    if (!opts.refresh) {
      try {
        const { at, data } = JSON.parse(await readFile(file, 'utf8'));
        if (Date.now() - at < TTL) return data;
      } catch {}
    }
    let data;
    for (let attempt = 0; ; attempt++) {
      try { data = await fetcher(); break; } catch (err) {
        if (attempt >= 2) throw err;
        await sleep(2000 * (attempt + 1));
      }
    }
    await writeFile(file, JSON.stringify({ at: Date.now(), data }));
    return data;
  }
  async function getJson(url) {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36' } });
    if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
    return res.json();
  }

  // One catalog product -> the few fields we keep.
  const cents = (n) => (typeof n === 'number' ? Math.round(n * 100) : null);
  const slim = (p) => {
    const lp = p.LocalizedProperties?.[0] ?? {};
    const mp = p.MarketProperties?.[0] ?? {};
    const rating = (mp.UsageData ?? []).find((u) => u.AggregateTimeSpan === 'AllTime');
    const price = p.DisplaySkuAvailabilities?.flatMap((d) => d.Availabilities ?? []).map((a) => a.OrderManagementData?.Price).find(Boolean);
    const art = (purposes) => purposes.map((x) => lp.Images?.find((i) => i.ImagePurpose === x)).find(Boolean);
    const img = art(['SuperHeroArt', 'TitledHeroArt', 'BrandedKeyArt', 'BoxArt']);
    return {
      id: p.ProductId,
      name: lp.ProductTitle,
      genres: (p.Properties?.Categories ?? [p.Properties?.Category]).filter((g) => g && g !== 'Other'),
      rating: rating?.RatingCount ? { avg: rating.AverageRating, count: rating.RatingCount } : null,
      release: mp.OriginalReleaseDate ?? null,
      msrpCents: cents(price?.MSRP),
      // The catalog serves art at any width; cards never need more than this.
      image: img ? `https:${img.Uri}?w=460&q=80` : null,
    };
  };

  // Games Pass ids, then details in bulk.
  const passIds = await cached('gamepass-ids', async () => {
    const list = await getJson(`https://catalog.gamepass.com/sigls/v2?id=${GAME_PASS_CONSOLE}&language=en-US&market=US`);
    return list.filter((x) => x.id).map((x) => x.id);
  });
  console.log(`  Game Pass: ${passIds.length} console games`);

  const catalog = new Map(); // product id -> slim
  for (let i = 0; i < passIds.length; i += BULK) {
    const ids = passIds.slice(i, i + BULK);
    const products = await cached(`details-${ids[0]}-${ids.length}`, async () => {
      const json = await getJson(`${CATALOG}/products?bigIds=${ids.join(',')}&market=US&languages=en-US&fieldsTemplate=Details`);
      return json.Products.filter((p) => p.ProductType === 'Game').map(slim);
    });
    for (const p of products) if (p.name && p.genres.length) catalog.set(p.id, p);
    await sleep(150);
  }
  console.log(`  catalog: ${catalog.size} games with genre data`);

  // Your own games: the same catalog data, looked up by package family name (Xbox 360 titles have none).
  const pfnById = new Map(titles.filter((t) => t.pfn).map((t) => [String(t.titleId), t.pfn]));
  const ownedInfo = new Map(); // titleId -> slim
  let looked = 0;
  for (const g of games) {
    const pfn = pfnById.get(g.titleId);
    if (!pfn) continue;
    const info = await cached(`pfn-${pfn}`, async () => {
      const json = await getJson(`${CATALOG}/products/lookup?market=US&languages=en-US&alternateId=PackageFamilyName&value=${encodeURIComponent(pfn)}&fieldsTemplate=Details`);
      const p = json.Products?.find((x) => x.ProductType === 'Game') ?? json.Products?.[0];
      return p ? slim(p) : null;
    });
    if (info) ownedInfo.set(g.titleId, info);
    if (++looked % 20 === 0) await sleep(150);
  }
  console.log(`  genres for ${ownedInfo.size} of your ${games.length} Xbox titles`);

  // Dynamic products (previews, app-like collections) carry a placeholder release date in the year 9998.
  const isPlaceholder = (p) => p.release && new Date(p.release).getUTCFullYear() > 3000;

  // Names ----------------------------------------------------------------------------------
  const baseName = (name = '') =>
    name
      .toLowerCase()
      .replace(/[™®©]/g, '')
      .replace(/\(.*?\)/g, '')
      .replace(/\b(edition|remastered|definitive|deluxe|ultimate|standard|game of the year|goty|xbox|series x|console|windows|digital|the)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const franchise = (name = '') => baseName(name.split(/[:\-–—]\s/)[0]).replace(/\s+(\d+|[ivx]+)$/, '').trim();

  // Taste profile: genres weighted by sqrt(hours), discounted for genres everything shares ---------
  // Same rule as src/lib/xbox.ts: PC-only titles and betas/launchers don't count.
  const PC = new Set(['PC', 'Win32']);
  const counts = (g) => !(g.devices.length > 0 && g.devices.every((d) => PC.has(d))) && !/\b(beta|launcher)\b/i.test(g.name);
  const df = new Map();
  for (const p of catalog.values()) p.genres.forEach((x) => df.set(x, (df.get(x) ?? 0) + 1));
  const idf = new Map([...df].map(([x, n]) => [x, Math.log((catalog.size + 1) / (n + 1)) + 1]));
  const vec = (genres) => new Map(genres.map((x) => [x, 1]));
  const cosine = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    for (const [t] of a) { const w = idf.get(t) ?? 1; na += w * w; if (b.has(t)) dot += w * w; }
    for (const [t] of b) nb += (idf.get(t) ?? 1) ** 2;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };

  const byGame = new Map(); // one entry per game (a game can have several title ids)
  for (const g of games.filter(counts)) {
    const info = ownedInfo.get(g.titleId);
    const k = baseName(g.name);
    const e = byGame.get(k) ?? { name: g.name, minutes: 0, genres: new Set() };
    e.minutes += g.minutes ?? 0;
    info?.genres.forEach((x) => e.genres.add(x));
    byGame.set(k, e);
  }
  const profile = new Map();
  const playedVecs = [];
  for (const e of byGame.values()) {
    if (e.minutes < 60 || !e.genres.size) continue;
    const w = Math.sqrt(e.minutes / 60);
    for (const x of e.genres) profile.set(x, (profile.get(x) ?? 0) + w);
    playedVecs.push({ name: e.name.replace(/[™®©]/g, '').trim(), vec: vec([...e.genres]), w });
  }
  console.log(`  taste profile built from ${playedVecs.length} games you've played for an hour or more`);
  if (!playedVecs.length) throw new Error('no played games with genre data, so there is nothing to match on');
  const profileRanked = [...profile].map(([x, w]) => [x, w * (idf.get(x) ?? 1)]).sort((a, b) => b[1] - a[1]);

  // Candidates: Game Pass games that aren't in your history ----------------------------------
  const ownedNames = new Set(games.map((g) => baseName(g.name)));
  const seen = new Set();
  const pool = [];
  for (const p of catalog.values()) {
    const k = baseName(p.name);
    if (ownedNames.has(k) || seen.has(k) || isPlaceholder(p)) continue;
    seen.add(k);
    pool.push(p);
  }

  // Ratings: shrink toward the catalog mean so a 5.0 from 12 people doesn't beat a 4.4 from 50,000.
  const PRIOR_AVG = 4.0, PRIOR_WEIGHT = 50;
  const quality = (p) => (p.rating ? (p.rating.avg * p.rating.count + PRIOR_AVG * PRIOR_WEIGHT) / (p.rating.count + PRIOR_WEIGHT) : PRIOR_AVG);
  // Below this (on the shrunk 5-star scale) a game is poorly rated, however well it fits the genres.
  const MIN_QUALITY = 3.7;
  const minMax = (values) => {
    const lo = Math.min(...values), hi = Math.max(...values);
    return (v) => (hi > lo ? (v - lo) / (hi - lo) : 0);
  };
  const scored = pool.filter((p) => quality(p) >= MIN_QUALITY).map((p) => {
    const v = vec(p.genres);
    const because = playedVecs
      .map((pv) => ({ name: pv.name, s: cosine(pv.vec, v) * Math.log1p(pv.w) }))
      .filter((x) => x.s > 0.35)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .map((x) => x.name);
    const sharedGenres = p.genres.filter((x) => profile.has(x)).sort((a, b) => profile.get(b) * (idf.get(b) ?? 1) - profile.get(a) * (idf.get(a) ?? 1)).slice(0, 3);
    return { ...p, affinity: cosine(profile, v), quality: quality(p), popularity: Math.log10((p.rating?.count ?? 0) + 1), because, sharedGenres };
  });
  const nA = minMax(scored.map((c) => c.affinity));
  const nQ = minMax(scored.map((c) => c.quality));
  const nP = minMax(scored.map((c) => c.popularity));
  for (const c of scored) {
    c.match = Math.round(100 * nA(c.affinity));
    c.score = 0.55 * nA(c.affinity) + 0.3 * nQ(c.quality) + 0.15 * nP(c.popularity);
  }

  const used = new Set();
  const take = (candidates, filter, n) => {
    const out = [];
    for (const c of candidates) {
      if (out.length === n) break;
      const f = franchise(c.name);
      if (!filter(c) || used.has(f)) continue;
      out.push(c);
      used.add(f);
    }
    return out;
  };
  const byScore = [...scored].sort((a, b) => b.score - a.score);
  const byRating = [...scored].sort((a, b) => b.quality - a.quality || b.popularity - a.popularity);
  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const clean = (c) => ({
    id: c.id,
    // "Enlisted Xbox One", "Cities: Skylines - Xbox One Edition": the console is noise on a Xbox page.
    name: c.name.replace(/[™®©]/g, '').replace(/\s*[-–:]?\s*Xbox (One|Series X\|S|360)( Edition)?$/i, '').trim(),
    image: c.image,
    msrpCents: c.msrpCents,
    rating: c.rating,
    release: c.release,
    genres: c.genres.slice(0, 4),
    sharedGenres: c.sharedGenres,
    because: c.because,
    match: c.match,
  });
  const groups = [
    { id: 'best', title: 'Best matches', blurb: 'The closest fit to the genres you actually spend time on, nudged toward games players rate highly.', items: take(byScore, (c) => c.match >= 40, 12) },
    { id: 'rated', title: 'Highest rated', blurb: 'The best-reviewed games in the Game Pass catalog that fit your taste, from the Xbox store’s user ratings.', items: take(byRating, (c) => c.match >= 50 && (c.rating?.count ?? 0) >= 1000, 8) },
    { id: 'new', title: 'New to Game Pass', blurb: 'Released in the last year, ranked by fit.', items: take(byScore, (c) => c.match >= 40 && c.release && new Date(c.release).getTime() > yearAgo, 8) },
  ]
    .map((g) => ({ ...g, items: g.items.map(clean) }))
    .filter((g) => g.items.length);

  // Genres, rating and artwork for everything in your history, keyed by title id.
  const owned = {};
  for (const [titleId, info] of ownedInfo) owned[titleId] = { genres: info.genres, rating: info.rating, release: info.release, image: info.image, productId: info.id };

  const store = {
    generatedAt: new Date().toISOString(),
    catalog: catalog.size,
    profile: profileRanked.slice(0, 10).map(([genre, w]) => ({ genre, weight: Math.round(w * 10) / 10 })),
    candidates: scored.length,
    groups,
    owned,
  };
  await writeFile(STORE_OUT, JSON.stringify(store, null, 1) + '\n');
  console.log(`  wrote ${path.relative(process.cwd(), STORE_OUT)}: ${groups.reduce((n, g) => n + g.items.length, 0)} picks from ${scored.length} candidates`);
  for (const g of groups) console.log(`    ${g.title}: ${g.items.slice(0, 4).map((i) => `${i.name} (${i.match}%)`).join(', ')}`);
}
