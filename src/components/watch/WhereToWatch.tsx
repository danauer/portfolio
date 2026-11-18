// Where to watch: search any movie or show and see where it's streaming, free, or for rent and
// purchase in the US. The page starts as a search box and nothing else. Once there are results,
// the services they're on show up above them as filters. Picked services are saved in this
// browser (localStorage), nowhere else, and are highlighted as yours on every title.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { availability, configured, image, search, type Availability, type TitleSummary } from '../../lib/watch/tmdb';
import { isChannel, nameList, serviceKey, toPicked, type PickedService } from '../../lib/watch/providers';
import { useAsync, useRoute, useStored } from './hooks';
import { Problem, TitleRow, titleKey } from './parts';
import { TitleView } from './TitleView';

const SEARCH_DELAY = 250; // ms after the last keystroke
const MAX_RESULTS = 20; // one page of TMDB results
const CHIPS = 8; // service filters shown before "More"

export default function WhereToWatch() {
  if (!configured) {
    return (
      <div data-wtw-app data-view="home" className="wtw-app">
        <Problem>
          This page needs a TMDB API token. Set <code>PUBLIC_TMDB_READ_TOKEN</code> in <code>.env</code> (and as a GitHub
          repository variable for the deployed site).
        </Problem>
      </div>
    );
  }
  return <App />;
}

function App() {
  const [route, go, canGoBack] = useRoute();
  const [picks, setPicks] = useStored<PickedService[]>('wtw:picks', []);
  const mine = useMemo(() => new Set(picks.map((p) => p.key)), [picks]);
  const togglePick = (service: PickedService) =>
    setPicks((prev) => (prev.some((p) => p.key === service.key) ? prev.filter((p) => p.key !== service.key) : [...prev, service]));

  // The search box shows what you type right away; the route (and the URL) follows after a pause.
  const [query, setQuery] = useState(route.view === 'search' ? route.q : '');
  const routeQuery = route.view === 'search' ? route.q : '';
  useEffect(() => {
    // Leave the box alone when it already says the same thing (a trailing space mid-typing, say).
    if (route.view === 'search') setQuery((prev) => (prev.trim() === route.q ? prev : route.q));
    if (route.view === 'home') setQuery((prev) => (prev.trim() ? '' : prev));
    // Only when the route changes from outside the box (Back, Forward, a link).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);
  useEffect(() => {
    const q = query.trim();
    if (q === routeQuery || route.view === 'title') return;
    // Starting a search adds a history entry, so Back returns to the empty box; refining it just updates that entry.
    const timer = setTimeout(() => go(q ? { view: 'search', q } : { view: 'home' }, { replace: route.view === 'search' }), SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [query, routeQuery, route.view, go]);

  const onType = (value: string) => {
    setQuery(value);
    // Typing on a title page starts a new search, as a new history entry so Back returns to the title.
    if (route.view === 'title' && value.trim()) go({ view: 'search', q: value.trim() });
  };

  const open = useCallback((t: TitleSummary) => go({ view: 'title', type: t.type, id: t.id }), [go]);

  // The document title follows the view.
  const baseTitle = useRef(document.title);
  const [viewTitle, setViewTitle] = useState<string | null>(null);
  useEffect(() => {
    const prefix = route.view === 'title' ? viewTitle : route.view === 'search' ? `“${route.q}”` : null;
    document.title = prefix ? `${prefix} · ${baseTitle.current}` : baseTitle.current;
  }, [route, viewTitle]);
  useEffect(() => () => void (document.title = baseTitle.current), []);

  // On a computer, the box is ready to type into. (On phones that would throw up the keyboard.)
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (route.view === 'home' && matchMedia('(pointer: fine)').matches) input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const back = () => (canGoBack ? history.back() : go({ view: 'home' }));

  // On the empty page the title and box sit in the middle of the screen; with a search they move to
  // the top. CSS does the layout; this animates the move (measure before and after, then slide).
  const form = useRef<HTMLFormElement>(null);
  const lastRects = useRef<{ form: DOMRect; title: DOMRect | null } | null>(null);
  const lastView = useRef(route.view);
  useLayoutEffect(() => {
    const box = form.current;
    if (!box) return;
    const title = box.closest('.wtw')?.querySelector<HTMLElement>(':scope > h1') ?? null;
    const was = lastView.current;
    const moved = (was === 'home') !== (route.view === 'home') && was !== 'title' && route.view !== 'title';
    const before = lastRects.current;
    if (moved && before && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const timing = { duration: 380, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' };
      const after = box.getBoundingClientRect();
      box.animate(
        [
          { transform: `translate(${before.form.left - after.left}px, ${before.form.top - after.top}px)`, width: `${before.form.width}px` },
          { transform: 'none', width: `${after.width}px` },
        ],
        timing,
      );
      if (title && before.title) {
        const t = title.getBoundingClientRect();
        title.animate([{ transform: `translate(${before.title.left - t.left}px, ${before.title.top - t.top}px)` }, { transform: 'none' }], timing);
      }
    }
    lastView.current = route.view;
    lastRects.current = { form: box.getBoundingClientRect(), title: title?.getBoundingClientRect() ?? null };
  }, [route.view]);

  return (
    <div data-wtw-app data-view={route.view} className="wtw-app">
      <form ref={form} className="search" role="search" onSubmit={(e) => e.preventDefault()}>
        <label>
          <span className="sr-only">Search movies and TV shows</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.75" />
            <path d="m13 13 4.5 4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
          <input
            ref={input}
            type="search"
            placeholder="Search movies and TV shows"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => onType(e.target.value)}
          />
        </label>
      </form>

      {route.view === 'title' && (
        <TitleView
          key={`${route.type}-${route.id}`}
          type={route.type}
          id={route.id}
          mine={mine}
          onBack={back}
          backLabel={canGoBack ? 'Back' : 'Search'}
          onTitle={setViewTitle}
        />
      )}
      {route.view === 'search' && (
        <Results q={route.q} picks={picks} mine={mine} onTogglePick={togglePick} onClearPicks={() => setPicks([])} onOpen={open} />
      )}
    </div>
  );
}

interface Hit {
  title: TitleSummary;
  /** Null when TMDB couldn't say. */
  where: Availability | null;
}

/** What a title is included with or free on: the things the service filters match. */
const includedOn = (where: Availability | null) => (where ? [...where.stream, ...where.free] : []);

function Results({ q, picks, mine, onTogglePick, onClearPicks, onOpen }: {
  q: string;
  picks: PickedService[];
  mine: ReadonlySet<string>;
  onTogglePick: (s: PickedService) => void;
  onClearPicks: () => void;
  onOpen: (t: TitleSummary) => void;
}) {
  // Results and where each one is arrive together, so the filters and the list never disagree.
  const results = useAsync(async () => {
    const titles = (await search(q)).slice(0, MAX_RESULTS);
    const where = await Promise.all(titles.map((t) => availability(t.type, t.id).catch(() => null)));
    return titles.map((title, i): Hit => ({ title, where: where[i] }));
  }, [q]);

  // While the next search loads, keep showing the last one (faded) instead of flashing a skeleton.
  const last = useRef<Hit[] | null>(null);
  if (results.status === 'done') last.current = results.data;
  const hits = results.status === 'done' ? results.data : results.status === 'loading' ? last.current : null;
  const stale = results.status === 'loading' && hits !== null;

  const [showMore, setShowMore] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  useEffect(() => setShowOthers(false), [q]);

  // One chip per service the results are included with: picked ones first, then by how many results are on each.
  const chips = useMemo(() => {
    const found = new Map<string, { service: PickedService; count: number; rank: number }>();
    for (const hit of hits ?? []) {
      const seen = new Set<string>();
      for (const p of includedOn(hit.where)) {
        if (isChannel(p.provider_name)) continue;
        const service = toPicked(p);
        if (seen.has(service.key)) continue;
        seen.add(service.key);
        const entry = found.get(service.key) ?? { service, count: 0, rank: p.display_priority };
        entry.count++;
        entry.rank = Math.min(entry.rank, p.display_priority);
        found.set(service.key, entry);
      }
    }
    const picked = picks.map((p) => ({ service: found.get(p.key)?.service ?? p, count: found.get(p.key)?.count ?? 0, picked: true }));
    const rest = [...found.values()]
      .filter((e) => !mine.has(e.service.key))
      .sort((a, b) => b.count - a.count || a.rank - b.rank)
      .map((e) => ({ ...e, picked: false }));
    return [...picked, ...rest];
  }, [hits, picks, mine]);
  const visibleChips = showMore ? chips : chips.filter((c, i) => c.picked || i < Math.max(CHIPS, picks.length));
  const hiddenChips = chips.length - visibleChips.length;

  const filtering = mine.size > 0;
  const matches = (hit: Hit) => includedOn(hit.where).some((p) => mine.has(serviceKey(p.provider_name)));
  const matched = hits ? (filtering ? hits.filter(matches) : hits) : [];
  const others = hits && filtering ? hits.filter((h) => !matches(h)) : [];
  const picked = nameList(picks.map((p) => p.name), 3);

  return (
    <>
      {hits && chips.length > 0 && (
        <section className="filters" aria-labelledby="filters-title">
          <div className="filters-head">
            <h2 className="kicker" id="filters-title">
              Filter by service
            </h2>
            {filtering ? (
              <button type="button" className="link-button small" onClick={onClearPicks}>
                Clear
              </button>
            ) : (
              <span className="muted small">Pick the ones you have. They’re remembered and highlighted everywhere.</span>
            )}
          </div>
          <ul className="service-chips">
            {visibleChips.map(({ service, count, picked }) => (
              <li key={service.key}>
                <button type="button" className="service-chip" aria-pressed={picked} onClick={() => onTogglePick(service)}>
                  {service.logoPath ? (
                    <img className="logo" src={image(service.logoPath, 'w92')!} alt="" loading="lazy" />
                  ) : (
                    <span className="logo logo-empty" aria-hidden="true">
                      {service.name[0]}
                    </span>
                  )}
                  <span className="chip-name">{service.name}</span>
                  <span className="chip-count" aria-label={`${count} result${count === 1 ? '' : 's'}`}>
                    {count}
                  </span>
                </button>
              </li>
            ))}
            {hiddenChips > 0 && (
              <li>
                <button type="button" className="service-chip more" onClick={() => setShowMore(true)}>
                  {hiddenChips} more
                </button>
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="results" aria-labelledby="results-title" aria-busy={stale}>
        <h2 className="kicker" id="results-title">
          {!hits
            ? `Searching for “${q}”`
            : filtering
              ? `${matched.length} of ${hits.length} on ${picked}`
              : `${hits.length} result${hits.length === 1 ? '' : 's'} for “${q}”`}
        </h2>
        {results.status === 'loading' && !hits && <div className="rows-skeleton" aria-hidden="true" />}
        {results.status === 'error' && <Problem onRetry={results.retry}>Couldn’t search TMDB.</Problem>}
        {hits && hits.length === 0 && <p className="muted">No movies or shows match “{q}”.</p>}
        {hits && filtering && matched.length === 0 && hits.length > 0 && <p className="muted">None of these are on {picked}.</p>}
        {matched.length > 0 && (
          <ul className="rows" data-stale={stale || undefined}>
            {matched.map((h) => (
              <TitleRow key={titleKey(h.title)} title={h.title} where={h.where} mine={mine} onOpen={onOpen} />
            ))}
          </ul>
        )}
        {others.length > 0 && (
          <div className="others">
            {matched.length > 0 && (
              <button type="button" className="link-button" aria-expanded={showOthers} onClick={() => setShowOthers(!showOthers)}>
                {showOthers ? 'Hide' : 'Show'} {others.length} more that {others.length === 1 ? 'isn’t' : 'aren’t'} on {picked}
              </button>
            )}
            {(showOthers || matched.length === 0) && (
              <ul className="rows" data-stale={stale || undefined}>
                {others.map((h) => (
                  <TitleRow key={titleKey(h.title)} title={h.title} where={h.where} mine={mine} onOpen={onOpen} />
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </>
  );
}
