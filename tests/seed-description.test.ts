import { describe, expect, it } from 'vitest';
import { normalizeProfile } from '../src/shared/ai-apply/profile';
import { seedPatch } from '../src/shared/ai-apply/seed';
import { buildWorkdayPlan } from '../src/shared/ats/workday-plan';

const job = (company: string, description: string) => ({ company, title: 'Product Manager', start_date: 'Jan 2020', end_date: 'Dec 2021', description });

describe('seed fills missing job descriptions', () => {
  it('adds the seed description to a saved job without one, keeping descriptions you wrote', () => {
    const saved = normalizeProfile({ name: 'A B', experience: [job('Dresma', ''), job('NU10', 'mine')] } as never);
    const seed = { version: 12, profile: { name: 'A B', experience: [job('Dresma', 'Built DoMyShoot'), job('NU10', 'seed')] } } as never;
    const patch = seedPatch(seed, { profileSaved: true, savedProfile: saved, memory: {}, resume: null, coverLetter: null });
    expect(patch.profile?.experience.map((e) => e.description)).toEqual(['Built DoMyShoot', 'mine']);
  });

  it('keeps "IIT Guwahati" for plain text School boxes', () => {
    const plan = buildWorkdayPlan(normalizeProfile({ name: 'A B', education: [{ institution: 'IIT Guwahati', degree: 'B.Tech' }] } as never));
    expect(plan.education[0]).toMatchObject({ school: 'Indian Institute of Technology Guwahati', schoolText: 'IIT Guwahati' });
  });
});
