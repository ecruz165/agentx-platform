/**
 * Direct unit tests for the error classifier.
 *
 * The HTTP-status → AdapterError-subclass mapping is the load-bearing
 * piece all three direct adapters depend on. Tests pin the heuristics:
 *   - status code → primary subclass
 *   - 400 with body fingerprints (credit/balance/quota) → BillingError
 *   - 400 with model-not-found → ConfigError
 *   - Retry-After header parsing on 429
 *   - context prefix flows through
 */

import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  AuthError,
  BillingError,
  ConfigError,
  NetworkError,
  ProviderError,
  RateLimitError,
  classifyHttpError,
  classifyNetworkError,
} from './errors.ts';

describe('classifyHttpError — status code routing', () => {
  it('401 → AuthError', () => {
    const err = classifyHttpError({ status: 401, body: 'invalid_api_key' });
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(AdapterError);
  });

  it('402 → BillingError', () => {
    const err = classifyHttpError({ status: 402, body: 'payment_required' });
    expect(err).toBeInstanceOf(BillingError);
  });

  it('404 → ConfigError', () => {
    const err = classifyHttpError({ status: 404, body: 'not found' });
    expect(err).toBeInstanceOf(ConfigError);
  });

  it('429 → RateLimitError', () => {
    const err = classifyHttpError({ status: 429, body: 'rate limit exceeded' });
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('500 → ProviderError', () => {
    const err = classifyHttpError({ status: 500, body: 'upstream broke' });
    expect(err).toBeInstanceOf(ProviderError);
  });

  it('503 → ProviderError', () => {
    const err = classifyHttpError({ status: 503, body: 'service unavailable' });
    expect(err).toBeInstanceOf(ProviderError);
  });
});

describe('classifyHttpError — 400 body fingerprinting', () => {
  it('400 with "credit balance" → BillingError (Anthropic-style)', () => {
    const err = classifyHttpError({
      status: 400,
      body: '{"type":"invalid_request_error","message":"Your credit balance is too low"}',
    });
    expect(err).toBeInstanceOf(BillingError);
  });

  it('400 with "quota" → BillingError (OpenAI-style)', () => {
    const err = classifyHttpError({
      status: 400,
      body: 'You exceeded your current quota',
    });
    expect(err).toBeInstanceOf(BillingError);
  });

  it('400 with "insufficient" → BillingError', () => {
    const err = classifyHttpError({
      status: 400,
      body: 'Insufficient credits to process request',
    });
    expect(err).toBeInstanceOf(BillingError);
  });

  it('400 with "model not found" → ConfigError', () => {
    const err = classifyHttpError({
      status: 400,
      body: 'Model not found: gpt-99-imaginary',
    });
    expect(err).toBeInstanceOf(ConfigError);
  });

  it('400 with "model does not exist" → ConfigError', () => {
    const err = classifyHttpError({
      status: 400,
      body: 'The model fake-model does not exist',
    });
    expect(err).toBeInstanceOf(ConfigError);
  });

  it('400 with neither billing nor config fingerprint → ProviderError', () => {
    const err = classifyHttpError({
      status: 400,
      body: 'malformed request',
    });
    expect(err).toBeInstanceOf(ProviderError);
  });
});

describe('classifyHttpError — RateLimitError retry-after parsing', () => {
  it('parses integer Retry-After (delta-seconds)', () => {
    const err = classifyHttpError({ status: 429, body: 'rate limited', retryAfter: '30' });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(30);
  });

  it('parses HTTP-date Retry-After', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const err = classifyHttpError({ status: 429, body: 'rate limited', retryAfter: future });
    expect(err).toBeInstanceOf(RateLimitError);
    const after = (err as RateLimitError).retryAfterSeconds!;
    // Allow ±5s for clock skew between test and parse moments
    expect(after).toBeGreaterThan(50);
    expect(after).toBeLessThan(70);
  });

  it('omits retryAfterSeconds when no header is provided', () => {
    const err = classifyHttpError({ status: 429, body: 'rate limited' });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBeUndefined();
  });

  it('omits retryAfterSeconds for malformed Retry-After', () => {
    const err = classifyHttpError({ status: 429, body: 'rate limited', retryAfter: 'not-a-time' });
    expect((err as RateLimitError).retryAfterSeconds).toBeUndefined();
  });
});

describe('classifyHttpError — context prefix', () => {
  it('prepends context to the message', () => {
    const err = classifyHttpError({ status: 401, body: 'unauthorized', context: 'openai' });
    expect(err.message).toMatch(/^openai: /);
  });

  it('omits prefix when no context is provided', () => {
    const err = classifyHttpError({ status: 401, body: 'unauthorized' });
    expect(err.message).not.toMatch(/^[a-z-]+: /);
  });
});

describe('classifyNetworkError', () => {
  it('returns NetworkError with the original message', () => {
    const err = classifyNetworkError(new Error('ECONNREFUSED'));
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('handles non-Error thrown values (string, etc.)', () => {
    const err = classifyNetworkError('something went wrong');
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).toContain('something went wrong');
  });

  it('preserves cause chain for diagnostics', () => {
    const original = new Error('TLS handshake failed');
    const err = classifyNetworkError(original, 'github-copilot');
    expect((err as NetworkError & { cause?: unknown }).cause).toBe(original);
    expect(err.message).toContain('github-copilot');
  });
});

describe('AdapterError class hierarchy', () => {
  it('all subclasses extend AdapterError', () => {
    expect(new AuthError('x')).toBeInstanceOf(AdapterError);
    expect(new BillingError('x')).toBeInstanceOf(AdapterError);
    expect(new RateLimitError('x')).toBeInstanceOf(AdapterError);
    expect(new ConfigError('x')).toBeInstanceOf(AdapterError);
    expect(new NetworkError('x')).toBeInstanceOf(AdapterError);
    expect(new ProviderError('x')).toBeInstanceOf(AdapterError);
  });

  it('all subclasses extend Error (so existing message-string handling still works)', () => {
    expect(new AuthError('x')).toBeInstanceOf(Error);
    expect(new BillingError('x')).toBeInstanceOf(Error);
  });

  it('subclasses have distinct names for instanceof-bypass debugging', () => {
    expect(new AuthError('x').name).toBe('AuthError');
    expect(new BillingError('x').name).toBe('BillingError');
    expect(new RateLimitError('x').name).toBe('RateLimitError');
    expect(new ConfigError('x').name).toBe('ConfigError');
    expect(new NetworkError('x').name).toBe('NetworkError');
    expect(new ProviderError('x').name).toBe('ProviderError');
  });
});
