// A small client for The Movie Database (TMDB) API, used by the Where to watch page.
// It runs in the visitor's browser. The site is static, so there is no server to hide the token
// behind: it's a read-only TMDB token, and the worst someone can do with it is use up its rate limit.
// Where-to-watch data on TMDB comes from JustWatch. Everything here is for the US.

const API = 'https://api.themoviedb.org/3';
const IMAGES = 'https://image.tmdb.org/t/p';
export const REGION = 'US';

// Either kind of TMDB credential works: the v4 "API Read Access Token" (a long JWT, sent as a
// bearer token) or the v3 "API Key" (32 hex characters, sent as a query parameter).
const credential: string = (import.meta.env.PUBLIC_TMDB_READ_TOKEN ?? '').trim();
const isV3Key = /^[0-9a-f]{32}$/i.test(credential);
export const configured = credential.length > 0;

export type MediaType = 'movie' | 'tv';

export interface Provider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
  display_priority: number;
}

export interface Availability {
  /** TMDB's watch page for the title, which has JustWatch's direct link for every option. */
  link: string | null;
  /** Included with a subscription. */
  stream: Provider[];
  /** Free, usually with ads. */
  free: Provider[];
  rent: Provider[];
  buy: Provider[];
}

export interface TitleSummary {
  type: MediaType;
  id: number;
  title: string;
  year: string | null;
  posterPath: string | null;
}

export interface TitleDetail extends TitleSummary {
  backdropPath: string | null;
  overview: string;
  genres: string[];
  /** Minutes, for movies. */
  runtime: number | null;
  /** For TV. */
  seasons: number | null;
  /** For TV: "Returning Series", "Ended" and so on. */
  status: string | null;
  availability: Availability;
}

export class TmdbError extends Error {
  constructor(public status: number) {
    super(`TMDB request failed (${status})`);
  }
}

// One request per URL per visit. Failed requests are dropped from the cache so they can be retried.
const cache = new Map<string, Promise<unknown>>();

function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(API + path);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const key = url.toString();
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;

  const headers: HeadersInit = { accept: 'application/json' };
  if (isV3Key) url.searchParams.set('api_key', credential);
  else headers.authorization = `Bearer ${credential}`;

  const request = fetch(url, { headers }).then((res) => {
    if (!res.ok) throw new TmdbError(res.status);
    return res.json() as Promise<T>;
  });
  cache.set(key, request);
  request.catch(() => cache.delete(key));
  return request;
}

export function image(path: string | null, size: 'w92' | 'w154' | 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original') {
  return path ? `${IMAGES}/${size}${path}` : null;
}

// Raw shapes, only the fields this page reads.
interface RawTitle {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
}
interface RawRegion {
  link?: string;
  flatrate?: Provider[];
  free?: Provider[];
  ads?: Provider[];
  rent?: Provider[];
  buy?: Provider[];
}
interface RawProviders {
  results?: Record<string, RawRegion>;
}
interface Page<T> {
  results: T[];
  total_results: number;
}

const summarize = (raw: RawTitle, type: MediaType): TitleSummary => {
  const date = type === 'movie' ? raw.release_date : raw.first_air_date;
  return {
    type,
    id: raw.id,
    title: (type === 'movie' ? raw.title : raw.name) ?? 'Untitled',
    year: date ? date.slice(0, 4) : null,
    posterPath: raw.poster_path ?? null,
  };
};

const byPriority = (a: Provider, b: Provider) => a.display_priority - b.display_priority;
// For one title: the service itself before add-ons sold through Amazon, Apple or Roku, then TMDB's order.
const channel = (p: Provider) => Number(/\b(?:amazon|apple tv|roku premium)\s+channel$/i.test(p.provider_name.trim()));
const forTitle = (a: Provider, b: Provider) => channel(a) - channel(b) || byPriority(a, b);

function toAvailability(raw: RawProviders | undefined): Availability {
  const us = raw?.results?.[REGION] ?? {};
  return {
    link: us.link ?? null,
    stream: [...(us.flatrate ?? [])].sort(forTitle),
    free: [...(us.free ?? []), ...(us.ads ?? [])].sort(forTitle),
    rent: [...(us.rent ?? [])].sort(forTitle),
    buy: [...(us.buy ?? [])].sort(forTitle),
  };
}

/** Movies and TV shows matching the query, in TMDB's relevance order. People are left out. */
export async function search(query: string): Promise<TitleSummary[]> {
  const page = await get<Page<RawTitle>>('/search/multi', { query, include_adult: 'false', page: 1 });
  return page.results
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map((r) => summarize(r, r.media_type as MediaType));
}

export async function availability(type: MediaType, id: number): Promise<Availability> {
  return toAvailability(await get<RawProviders>(`/${type}/${id}/watch/providers`));
}

export async function details(type: MediaType, id: number): Promise<TitleDetail> {
  const raw = await get<
    RawTitle & {
      overview?: string;
      genres?: { name: string }[];
      runtime?: number | null;
      number_of_seasons?: number | null;
      status?: string;
      'watch/providers'?: RawProviders;
    }
  >(`/${type}/${id}`, { append_to_response: 'watch/providers' });
  return {
    ...summarize(raw, type),
    backdropPath: raw.backdrop_path ?? null,
    overview: raw.overview ?? '',
    genres: (raw.genres ?? []).map((g) => g.name),
    runtime: type === 'movie' ? raw.runtime || null : null,
    seasons: type === 'tv' ? raw.number_of_seasons ?? null : null,
    status: type === 'tv' ? raw.status ?? null : null,
    availability: toAvailability(raw['watch/providers']),
  };
}
