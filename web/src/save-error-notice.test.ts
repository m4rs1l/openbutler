import { describe, expect, it } from 'vitest';
import { saveErrorNotice } from './use-session.js';

describe('save error notice', () => {
  it('is absent when there is no save error', () => {
    expect(saveErrorNotice(null)).toBeNull();
    expect(saveErrorNotice(undefined)).toBeNull();
    expect(saveErrorNotice('')).toBeNull();
  });

  it('names the error and the in-memory contract while a save keeps failing', () => {
    const notice = saveErrorNotice('EACCES: permission denied');
    expect(notice).toContain('EACCES: permission denied');
    expect(notice).toContain('kept in memory');
    expect(notice).toContain('retries automatically');
  });
});
