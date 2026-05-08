import { describe, expect, it } from 'vitest';
import { narrowestScope, readChain } from './precedence.ts';

describe('narrowestScope (F3b — write precedence)', () => {
  it('returns undefined when no env scope keys are set', () => {
    expect(narrowestScope({})).toBeUndefined();
  });

  it('jobId wins over everything else', () => {
    expect(
      narrowestScope({
        JOB_ID: 'j1',
        SESSION_ID: 's1',
        PRODUCT_ID: 'p1',
        USER_ID: 'u1',
        ORG_ID: 'o1',
        TOPIC: 't1',
      }),
    ).toEqual({ jobId: 'j1' });
  });

  it('falls through to sessionId when jobId is unset', () => {
    expect(
      narrowestScope({
        SESSION_ID: 's1',
        PRODUCT_ID: 'p1',
        USER_ID: 'u1',
      }),
    ).toEqual({ sessionId: 's1' });
  });

  it('falls through to productId when jobId + sessionId are unset', () => {
    expect(
      narrowestScope({
        PRODUCT_ID: 'p1',
        USER_ID: 'u1',
      }),
    ).toEqual({ productId: 'p1' });
  });

  it('treats empty-string env vars as unset', () => {
    expect(narrowestScope({ JOB_ID: '', SESSION_ID: 's1' })).toEqual({ sessionId: 's1' });
  });
});

describe('readChain (F3a — read precedence)', () => {
  it('returns empty list when no env scope keys are set', () => {
    expect(readChain({})).toEqual([]);
  });

  it('produces narrow→wide ordering: jobId, productId, userId, organizationId, topic', () => {
    expect(
      readChain({
        JOB_ID: 'j1',
        PRODUCT_ID: 'p1',
        USER_ID: 'u1',
        ORG_ID: 'o1',
        TOPIC: 't1',
      }),
    ).toEqual([
      { jobId: 'j1' },
      { productId: 'p1' },
      { userId: 'u1' },
      { organizationId: 'o1' },
      { topic: 't1' },
    ]);
  });

  it('does NOT include sessionId in the read chain (write-only key)', () => {
    expect(readChain({ SESSION_ID: 's1', PRODUCT_ID: 'p1' })).toEqual([{ productId: 'p1' }]);
  });

  it('skips unset env keys', () => {
    expect(readChain({ JOB_ID: 'j1', USER_ID: 'u1' })).toEqual([{ jobId: 'j1' }, { userId: 'u1' }]);
  });
});
