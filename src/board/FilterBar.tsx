import { forwardRef } from 'react';
import { DEFAULT_FILTERS, type Filters } from '../shared/board';

interface Props {
  filters: Filters;
  onChange: (f: Filters) => void;
}

function num(v: string): number | null {
  const n = Number(v);
  return v.trim() === '' || !Number.isFinite(n) ? null : n;
}

export const FilterBar = forwardRef<HTMLInputElement, Props>(function FilterBar({ filters: f, onChange }, keywordRef) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...f, [k]: v });
  return (
    <form className="filters" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
      <label>
        Site
        <select value={f.site} onChange={(e) => set('site', e.target.value as Filters['site'])}>
          <option value="all">All</option>
          <option value="naukri">Naukri</option>
          <option value="indeed">Indeed</option>
          <option value="instahyre">Instahyre</option>
          <option value="wellfound">Wellfound</option>
        </select>
      </label>
      <label>
        Posted within
        <select
          value={f.postedWithinDays ?? 'all'}
          onChange={(e) => set('postedWithinDays', e.target.value === 'all' ? null : Number(e.target.value))}
        >
          <option value="1">24 hours</option>
          <option value="3">3 days</option>
          <option value="7">7 days</option>
          <option value="all">All</option>
        </select>
      </label>
      <label>
        Keywords
        <input ref={keywordRef} type="search" placeholder="react, product (press /)" value={f.keywordsInclude}
          onChange={(e) => set('keywordsInclude', e.target.value)} />
      </label>
      <label>
        Exclude
        <input type="search" placeholder="intern, sales" value={f.keywordsExclude}
          onChange={(e) => set('keywordsExclude', e.target.value)} />
      </label>
      <label>
        Location
        <input type="search" placeholder="Bengaluru, Remote" value={f.location}
          onChange={(e) => set('location', e.target.value)} />
      </label>
      <label className="narrow">
        My exp. (yrs)
        <input type="number" min={0} max={50} value={f.expYears ?? ''}
          onChange={(e) => set('expYears', num(e.target.value))} />
      </label>
      <label className="narrow">
        Min LPA
        <input type="number" min={0} max={500} value={f.salaryFloorLpa ?? ''}
          onChange={(e) => set('salaryFloorLpa', num(e.target.value))} />
      </label>
      <label className="check">
        <input type="checkbox" checked={f.includeUndisclosedSalary}
          onChange={(e) => set('includeUndisclosedSalary', e.target.checked)} />
        Include undisclosed salary
      </label>
      <label>
        Block companies
        <input type="search" placeholder="Acme, Foo Corp" value={f.companyBlocklist}
          onChange={(e) => set('companyBlocklist', e.target.value)} />
      </label>
      <button type="button" className="btn ghost" onClick={() => onChange(DEFAULT_FILTERS)}>Reset</button>
    </form>
  );
});
