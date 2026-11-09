import { useEffect, useState } from 'react';
import { SITE_LABEL } from '../shared/board';
import {
  addSource, clampPages, effectiveSources, MAX_PAGES_PER_SOURCE, moveSource, removeSource, siteOfUrl, updateSource,
  type Source,
} from '../shared/sources';
import { load, save } from '../shared/store';

function siteLabel(url: string): string {
  try {
    const site = siteOfUrl(new URL(url));
    return site ? SITE_LABEL[site] : 'Other (saved, not read by refresh)';
  } catch {
    return '?';
  }
}

/** Edit the links refresh loads. Saving stores your own list; "Reset" goes back to sources.json. */
export function SourcesPanel() {
  const [list, setList] = useState<Source[] | null>(null);
  const [custom, setCustom] = useState(false);
  const [msg, setMsg] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [pages, setPages] = useState('1');
  const [savedSearch, setSavedSearch] = useState('');

  const reload = async () => {
    const stored = await load('sources');
    const { all, errors } = await effectiveSources(stored);
    setList(all);
    setCustom(stored !== null);
    if (errors.length) setMsg(`Skipped invalid entries: ${errors.join(' | ')}`);
  };
  useEffect(() => {
    reload().catch((e: unknown) => setMsg(String(e)));
  }, []);

  const commit = async (next: Source[]) => {
    setList(next);
    setCustom(true);
    await save('sources', next);
  };
  const change = (i: number, patch: Partial<Pick<Source, 'name' | 'maxPages' | 'enabled'>>) => {
    if (list) commit(updateSource(list, i, patch)).catch(() => undefined);
  };
  const move = (i: number, by: -1 | 1) => {
    if (list) commit(moveSource(list, i, by)).catch(() => undefined);
  };
  const remove = (i: number) => {
    if (!list) return;
    commit(removeSource(list, i)).catch(() => undefined);
    setMsg(`Removed "${list[i]!.name || list[i]!.url}".`);
  };

  const add = async () => {
    const res = addSource(list ?? [], { url, name, maxPages: clampPages(pages), savedSearch });
    if (!res.ok) {
      setMsg(`Not added: ${res.error}`);
      return;
    }
    await commit(res.list);
    setUrl('');
    setName('');
    setPages('1');
    setSavedSearch('');
    setMsg(`Added. It loads from the next refresh.`);
  };

  const reset = async () => {
    await save('sources', null);
    setMsg('Back to the sources.json defaults.');
    await reload();
  };

  return (
    <section className="panel" aria-labelledby="sources-h">
      <h2 id="sources-h">Sources</h2>
      <p className="hint">
        Refresh loads these links in order. Paste a Naukri (www.naukri.com), Indeed (in.indeed.com) or Wellfound
        (wellfound.com) page, such as a search with your filters. Searches are sorted newest first, and later pages load only while the previous page
        found new jobs. Instahyre ignores search links, so for Instahyre paste its opportunities page and name one of
        your saved searches there; refresh clicks it and reads the first page of results. LinkedIn links are not
        accepted: the app never opens LinkedIn, but jobs on LinkedIn job pages you open are saved.
        {' '}{custom ? 'Using your list.' : 'Using the sources.json defaults.'}
      </p>

      {list === null ? <p className="hint">Loading…</p> : list.length === 0 ? <p className="hint">No links yet.</p> : (
        <ol className="sources">
          {list.map((s, i) => (
            <li key={`${s.url} ${s.savedSearch ?? ''}`} className={s.enabled ? '' : 'off'}>
              <input type="checkbox" checked={s.enabled} aria-label={`Use ${s.name || s.url}`}
                onChange={(e) => change(i, { enabled: e.target.checked })} />
              <span className="tag tag-site">{siteLabel(s.url)}</span>
              <div className="source-text">
                <input type="text" className="source-name" placeholder="Name (optional)" defaultValue={s.name ?? ''}
                  aria-label="Name"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== (s.name ?? '')) change(i, { name: v || undefined });
                  }} />
                <a className="source-url" href={s.url} target="_blank" rel="noreferrer noopener" title={s.url}>{s.url}</a>
                {s.savedSearch && <span className="hint">Saved search: {s.savedSearch}</span>}
              </div>
              <label className="source-pages">
                Pages
                <input type="number" min={1} max={MAX_PAGES_PER_SOURCE} defaultValue={s.maxPages}
                  onBlur={(e) => {
                    const v = clampPages(e.target.value);
                    e.target.value = String(v);
                    if (v !== s.maxPages) change(i, { maxPages: v });
                  }} />
              </label>
              <div className="btn-row">
                <button type="button" className="btn ghost small" disabled={i === 0} onClick={() => move(i, -1)}
                  aria-label="Move up">↑</button>
                <button type="button" className="btn ghost small" disabled={i === list.length - 1} onClick={() => move(i, 1)}
                  aria-label="Move down">↓</button>
                <button type="button" className="btn ghost small" onClick={() => remove(i)}>Remove</button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <form className="source-add" onSubmit={(e) => { e.preventDefault(); add().catch(() => undefined); }}>
        <label className="grow">
          Link
          <input type="url" required placeholder="https://in.indeed.com/jobs?q=product+manager&l=Bengaluru"
            value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          Name
          <input type="text" placeholder="Optional" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Saved search
          <input type="text" placeholder="Instahyre only" value={savedSearch} onChange={(e) => setSavedSearch(e.target.value)} />
        </label>
        <label className="narrow">
          Pages
          <input type="number" min={1} max={MAX_PAGES_PER_SOURCE} value={pages} onChange={(e) => setPages(e.target.value)} />
        </label>
        <button type="submit" className="btn primary">Add link</button>
      </form>

      <div className="btn-row">
        {custom && <button type="button" className="btn ghost" onClick={() => reset().catch(() => undefined)}>
          Reset to sources.json defaults
        </button>}
      </div>
      {msg && <p role="status" className="hint">{msg}</p>}
    </section>
  );
}
