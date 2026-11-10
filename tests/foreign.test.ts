import { describe, expect, it } from 'vitest';
import { isForeignOnsite } from '../src/shared/foreign';
describe('foreign jobs only when remote (2026-11-10)', () => {
  it('hides foreign on-site and hybrid jobs, keeps remote and Indian ones', () => {
    expect(isForeignOnsite('Barcelona, Catalonia, Spain (Hybrid)')).toBe(true);
    expect(isForeignOnsite('United States (On-site)')).toBe(true);
    expect(isForeignOnsite('London, England, United Kingdom')).toBe(true);
    expect(isForeignOnsite('United States (Remote)')).toBe(false);
    expect(isForeignOnsite('European Union (Remote)')).toBe(false);
    expect(isForeignOnsite('Bengaluru (Hybrid)')).toBe(false);
    expect(isForeignOnsite('Pune Division (On-site)')).toBe(false);
    expect(isForeignOnsite('Some Indian Town')).toBe(false);
    expect(isForeignOnsite('')).toBe(false);
  });
});
