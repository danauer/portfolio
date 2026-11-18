import { useEffect, useRef } from 'react';
import { details, image, type MediaType, type Provider, type TitleDetail } from '../../lib/watch/tmdb';
import { providerLink, serviceKey, serviceName, uniqueServices } from '../../lib/watch/providers';
import { useAsync } from './hooks';
import { Poster, Problem, typeLabel } from './parts';

interface Props {
  type: MediaType;
  id: number;
  mine: ReadonlySet<string>;
  onBack: () => void;
  backLabel: string;
  onTitle: (title: string | null) => void;
}

const groups = [
  { key: 'stream', label: 'Stream', note: 'Included with a subscription' },
  { key: 'rent', label: 'Rent', note: null },
  { key: 'buy', label: 'Buy', note: null },
  { key: 'free', label: 'Free', note: 'With ads, no subscription' },
] as const;

function runtime(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

function facts(t: TitleDetail) {
  const out = [typeLabel(t), t.year];
  if (t.runtime) out.push(runtime(t.runtime));
  if (t.seasons) out.push(`${t.seasons} season${t.seasons === 1 ? '' : 's'}`);
  if (t.status === 'Ended' || t.status === 'Canceled') out.push(t.status);
  return out.filter(Boolean).join(' · ');
}

function ProviderTile({ p, title, mine }: { p: Provider; title: TitleDetail; mine: boolean }) {
  const link = providerLink(p, title.title, title.type, title.availability.link);
  const logo = image(p.logo_path, 'w92');
  const body = (
    <>
      {logo ? <img className="logo" src={logo} alt="" loading="lazy" /> : <span className="logo logo-empty" aria-hidden="true" />}
      <span className="tile-name">{serviceName(p.provider_name)}</span>
      {mine && <span className="tile-tag">Yours</span>}
    </>
  );
  return (
    <li className="tile" data-mine={mine || undefined}>
      {link ? (
        <a href={link.href} target="_blank" rel="noopener noreferrer" aria-label={`${link.label}${mine ? ' (one of your services)' : ''}, opens in a new tab`}>
          {body}
        </a>
      ) : (
        <span>{body}</span>
      )}
    </li>
  );
}

export function TitleView({ type, id, mine, onBack, backLabel, onTitle }: Props) {
  const title = useAsync(() => details(type, id), [type, id]);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    onTitle(title.status === 'done' ? title.data.title : null);
  }, [title.status, title.data, onTitle]);

  // Move focus to the title once it's loaded, so screen readers start from the new view.
  useEffect(() => {
    if (title.status === 'done') heading.current?.focus({ preventScroll: true });
  }, [title.status, title.data]);

  return (
    <article className="title-view">
      <button type="button" className="back" onClick={onBack}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {backLabel}
      </button>

      {title.status === 'loading' && <div className="title-skeleton" aria-label="Loading" />}
      {title.status === 'error' && <Problem onRetry={title.retry}>Couldn’t load this title from TMDB.</Problem>}
      {title.status === 'done' && <Detail t={title.data} mine={mine} headingRef={heading} />}
    </article>
  );
}

function Detail({ t, mine, headingRef }: { t: TitleDetail; mine: ReadonlySet<string>; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const isMine = (p: Provider) => mine.has(serviceKey(p.provider_name));
  // Within each group, your services come first, then TMDB's popularity order.
  const sorted = (list: Provider[]) => uniqueServices(list).sort((a, b) => Number(isMine(b)) - Number(isMine(a)));
  const backdrop = image(t.backdropPath, 'w1280');
  const any = groups.some((g) => t.availability[g.key].length);

  return (
    <>
      {/* The title's backdrop fills the top of the page behind everything; see .wtw-backdrop. */}
      {backdrop && <div className="wtw-backdrop" aria-hidden="true" style={{ '--backdrop': `url(${backdrop})` } as React.CSSProperties} />}
      <header className="title-head">
        <Poster title={t} size="w342" className="title-poster" />
        <div className="title-info">
          <p className="kicker">{facts(t)}</p>
          <h2 ref={headingRef} tabIndex={-1}>
            {t.title}
          </h2>
          {t.genres.length > 0 && <p className="genres">{t.genres.join(', ')}</p>}
          {t.overview && <p className="overview">{t.overview}</p>}
        </div>
      </header>

      <section className="where" aria-labelledby="where-title">
        {/* The lists speak for themselves; the heading is for screen readers. */}
        <h3 className="sr-only" id="where-title">
          Where to watch in the US
        </h3>
        {!any && <p className="muted">Not available to stream, rent or buy in the US right now.</p>}

        {any && (
          <div className="groups">
            {groups.map((g) => {
              const list = sorted(t.availability[g.key]);
              if (!list.length) return null;
              return (
                <div key={g.key} className="group">
                  <h4>
                    {g.label}
                    {g.note && <span className="group-note">{g.note}</span>}
                  </h4>
                  <ul className="tiles">
                    {list.map((p) => (
                      <ProviderTile key={p.provider_id} p={p} title={t} mine={isMine(p)} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        <p className="fine-print">
          {t.type === 'tv' && 'For the series as a whole; single seasons can differ. '}
          {any && 'Where a service has a search page, its tile opens a search for this title there. '}
          {t.availability.link && (
            <>
              Direct links and prices for every option are on{' '}
              <a href={t.availability.link} target="_blank" rel="noopener noreferrer">
                TMDB
              </a>
              .
            </>
          )}
        </p>
      </section>
    </>
  );
}
