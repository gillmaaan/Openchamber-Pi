import { describe, expect, it } from 'vitest';

import { createJobRegistry } from './jobs.js';

describe('subagent jobs', () => {
  it('lists a started child as running for its parent, with what a status reader needs', () => {
    const jobs = createJobRegistry({ now: () => 1000 });
    jobs.start({ parentSessionID: 'ses_parent', childSessionID: 'ses_child', agent: 'general', description: 'Look around' });
    expect(jobs.list()).toEqual([{
      kind: 'subagent',
      id: 'ses_child',
      sessionID: 'ses_parent',
      childSessionID: 'ses_child',
      status: 'running',
      agent: 'general',
      title: 'Look around',
      description: 'Look around',
      time: { started: 1000 },
    }]);
  });

  it('ends the job on the child\'s own terminal event, and ignores another session\'s', () => {
    const jobs = createJobRegistry({ now: () => 2000 });
    jobs.start({ parentSessionID: 'ses_parent', childSessionID: 'ses_child', agent: 'general' });
    jobs.onWireEvent('ses_other', { type: 'session.execution.succeeded' });
    expect(jobs.list()[0].status).toBe('running');
    jobs.onWireEvent('ses_child', { type: 'session.execution.interrupted' });
    expect(jobs.list()[0]).toMatchObject({ status: 'interrupted', time: { started: 2000, ended: 2000 } });
  });

  it('keeps a finished job for five minutes and then drops it', () => {
    let now = 0;
    const jobs = createJobRegistry({ now: () => now });
    jobs.start({ parentSessionID: 'ses_parent', childSessionID: 'ses_child', agent: 'general' });
    jobs.finish('ses_child', 'failed');
    now = 300_000;
    expect(jobs.list()).toHaveLength(1);
    now = 300_001;
    expect(jobs.list()).toEqual([]);
  });
});
