/**
 * Tests for supabase/functions/_shared/helpers/deepgram.ts — the pure
 * Deepgram protocol helper backing the assessment transcription
 * pipeline (assessment-transcribe, deepgram-callback, reconcile cron).
 *
 * These exercise URL building and callback parsing with no live
 * Deepgram account; submitDeepgramAsync is driven through an injected
 * fetch double.
 */

import { describe, it, expect } from 'vitest';
import {
  buildListenUrl,
  submitDeepgramAsync,
  parseDeepgramCallback,
  normalizeUtterances,
  DG_MODEL,
} from '../../../supabase/functions/_shared/helpers/deepgram.ts';

function fetchDouble({ ok = true, status = 200, body = '' } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  impl.calls = calls;
  return impl;
}

describe('buildListenUrl', () => {
  it('sets the medical model and diarization/utterance options', () => {
    const u = new URL(buildListenUrl('https://cb.example/x'));
    expect(u.origin + u.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(u.searchParams.get('model')).toBe('nova-3-medical');
    expect(u.searchParams.get('diarize')).toBe('true');
    expect(u.searchParams.get('utterances')).toBe('true');
    expect(u.searchParams.get('punctuate')).toBe('true');
    expect(u.searchParams.get('smart_format')).toBe('true');
    expect(u.searchParams.get('language')).toBe('en');
  });

  it('round-trips the callback URL (including its own query params)', () => {
    const cb = 'https://proj.supabase.co/functions/v1/deepgram-callback?token=s3cret&assessment_id=abc&org_id=xyz';
    const u = new URL(buildListenUrl(cb));
    // URLSearchParams must have encoded the nested query string so it
    // survives intact for Deepgram to POST back to.
    expect(u.searchParams.get('callback')).toBe(cb);
  });

  it('honors model/language overrides', () => {
    const u = new URL(buildListenUrl('https://cb', { model: 'nova-3', language: 'es' }));
    expect(u.searchParams.get('model')).toBe('nova-3');
    expect(u.searchParams.get('language')).toBe('es');
  });
});

describe('submitDeepgramAsync', () => {
  it('returns the request_id on success and uses Token auth', async () => {
    const f = fetchDouble({ body: { request_id: 'req-123' } });
    const res = await submitDeepgramAsync({
      apiKey: 'KEY', audioUrl: 'https://a/x.webm', callbackUrl: 'https://cb', fetchImpl: f,
    });
    expect(res.ok).toBe(true);
    expect(res.requestId).toBe('req-123');
    expect(f.calls[0].init.headers.Authorization).toBe('Token KEY');
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ url: 'https://a/x.webm' });
  });

  it('reads request_id from metadata when top-level is absent', async () => {
    const f = fetchDouble({ body: { metadata: { request_id: 'meta-req' } } });
    const res = await submitDeepgramAsync({ apiKey: 'K', audioUrl: 'u', callbackUrl: 'c', fetchImpl: f });
    expect(res.requestId).toBe('meta-req');
  });

  it('returns ok:false with status on a Deepgram error response', async () => {
    const f = fetchDouble({ ok: false, status: 401, body: 'unauthorized' });
    const res = await submitDeepgramAsync({ apiKey: 'bad', audioUrl: 'u', callbackUrl: 'c', fetchImpl: f });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error).toContain('401');
  });

  it('returns ok:false when Deepgram is unreachable', async () => {
    const impl = async () => { throw new Error('ECONNREFUSED'); };
    const res = await submitDeepgramAsync({ apiKey: 'K', audioUrl: 'u', callbackUrl: 'c', fetchImpl: impl });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toContain('unreachable');
  });
});

describe('parseDeepgramCallback', () => {
  const happy = {
    metadata: { request_id: 'r1', duration: 92.6 },
    results: {
      channels: [{ alternatives: [{ transcript: 'Hello there.', confidence: 0.97 }], detected_language: 'en' }],
      utterances: [
        { speaker: 0, transcript: 'How are you feeling today?', start: 0.1, end: 2.4, confidence: 0.95 },
        { speaker: 1, transcript: 'A bit tired.', start: 2.5, end: 3.9, confidence: 0.9 },
      ],
    },
  };

  it('parses transcript, confidence, rounded duration, language, utterances', () => {
    const p = parseDeepgramCallback(happy);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.requestId).toBe('r1');
    expect(p.transcript).toBe('Hello there.');
    expect(p.confidence).toBe(0.97);
    expect(p.durationSeconds).toBe(93); // rounded from 92.6
    expect(p.language).toBe('en');
    expect(p.utterances).toHaveLength(2);
    expect(p.utterances[0]).toEqual({ speaker: 0, text: 'How are you feeling today?', start: 0.1, end: 2.4, confidence: 0.95 });
  });

  it('flags an explicit Deepgram error payload', () => {
    const p = parseDeepgramCallback({ err_code: 'Bad', err_msg: 'audio corrupt', metadata: { request_id: 'r2' } });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error).toContain('audio corrupt');
    expect(p.requestId).toBe('r2');
  });

  it('flags a payload with no alternatives (no speech)', () => {
    const p = parseDeepgramCallback({ metadata: { request_id: 'r3' }, results: { channels: [{ alternatives: [] }] } });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error).toContain('no transcription');
  });

  it('tolerates a missing utterances array', () => {
    const p = parseDeepgramCallback({
      metadata: { request_id: 'r4', duration: 5 },
      results: { channels: [{ alternatives: [{ transcript: 'hi', confidence: 0.8 }] }] },
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.utterances).toEqual([]);
    // No detected_language → null; callback falls back to DG_LANGUAGE.
    expect(p.language).toBeNull();
  });
});

describe('normalizeUtterances', () => {
  it('coerces missing/odd fields to null without throwing', () => {
    const out = normalizeUtterances({ results: { utterances: [{ transcript: 'x' }, { speaker: 2, start: 1 }] } });
    expect(out).toEqual([
      { speaker: null, text: 'x', start: null, end: null, confidence: null },
      { speaker: 2, text: '', start: 1, end: null, confidence: null },
    ]);
  });

  it('returns [] for absent utterances', () => {
    expect(normalizeUtterances({})).toEqual([]);
    expect(normalizeUtterances({ results: {} })).toEqual([]);
  });
});

describe('module constants', () => {
  it('exposes the medical model', () => {
    expect(DG_MODEL).toBe('nova-3-medical');
  });
});
