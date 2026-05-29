/**
 * Tests for supabase/functions/_shared/operations/transcribeRecording.ts —
 * the shared op that backs both the call-transcription HTTP endpoint and
 * post-call-processor's cron loop.
 *
 * The op decides between RingSense (RC native, license-included) and
 * OpenAI Whisper (paid) based on the caller-resolved
 * communication_voice_config.transcription_provider. The HTTP endpoint
 * used to unconditionally call Whisper regardless of that column — this
 * test suite exists to lock in the new behavior and prevent regression.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  globalThis.Deno = {
    env: {
      get: (key) => {
        if (key === 'RINGCENTRAL_CLIENT_ID') return 'test-client-id';
        if (key === 'RINGCENTRAL_CLIENT_SECRET') return 'test-client-secret';
        return undefined;
      },
    },
  };
});

async function loadModule() {
  const helper = await import(
    '../../../supabase/functions/_shared/helpers/ringcentral.ts'
  );
  helper._resetRcTokenCacheForTests();
  const op = await import(
    '../../../supabase/functions/_shared/operations/transcribeRecording.ts'
  );
  return { ...helper, ...op };
}

// Minimal Supabase double — only the surface the op actually touches:
// .from(table).select(...).eq(col, val).maybeSingle()
// .from(table).insert(row)
function makeSupabaseMock({ cached = null, insertError = null } = {}) {
  const inserts = [];
  const queries = [];
  const builder = {
    select() { return builder; },
    eq() { return builder; },
    async maybeSingle() {
      return { data: cached, error: null };
    },
    async insert(row) {
      inserts.push(row);
      return { error: insertError };
    },
  };
  const client = {
    from(table) {
      queries.push(table);
      return builder;
    },
    _inserts: inserts,
    _queries: queries,
  };
  return client;
}

function ringSenseResponse({ transcript = 'Hello world.', durationMs = 30_000, language = 'en-US' } = {}) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      recordingDurationMs: durationMs,
      language,
      speakerInfo: [
        { speakerId: 1, name: 'Caregiver' },
        { speakerId: 2, name: 'Client' },
      ],
      insights: [
        {
          type: 'Transcript',
          transcript: [
            { speakerId: 1, startTime: 0, endTime: 2000, text: transcript },
          ],
        },
      ],
    }),
  };
}

describe('transcribeRecording — provider dispatch', () => {
  it('returns the cached row without calling RC or Whisper', async () => {
    const { transcribeRecording } = await loadModule();
    const supabase = makeSupabaseMock({
      cached: {
        transcript: 'previously-stored',
        duration_seconds: 12,
        language: 'en',
      },
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const result = await transcribeRecording({
      supabase,
      recordingId: '999',
      rcAccessToken: 'tok',
      provider: 'ringcentral_native',
    });

    expect(result).toEqual({
      transcript: 'previously-stored',
      duration_seconds: 12,
      language: 'en',
      source: 'cache',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(supabase._inserts).toHaveLength(0);
  });

  it('ringcentral_native: hits the RingSense endpoint, formats the transcript, caches it', async () => {
    const { transcribeRecording } = await loadModule();
    const supabase = makeSupabaseMock();
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      ringSenseResponse({ transcript: 'Hi there.', durationMs: 45_000, language: 'en-US' }),
    );
    globalThis.fetch = fetchSpy;

    const result = await transcribeRecording({
      supabase,
      recordingId: '123',
      rcAccessToken: 'rc-tok',
      provider: 'ringcentral_native',
    });

    expect(result?.source).toBe('ringcentral_native');
    expect(result?.transcript).toContain('Caregiver: Hi there.');
    expect(result?.duration_seconds).toBe(45);
    expect(result?.language).toBe('en-US');

    // Auth header should carry the passed-in RC token.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = fetchSpy.mock.calls[0];
    expect(calledUrl).toContain('/ai/ringsense/v1/public/accounts/~/domains/pbx/records/123/insights');
    expect(calledOpts.headers.Authorization).toBe('Bearer rc-tok');

    // Cached for next time.
    expect(supabase._inserts).toHaveLength(1);
    expect(supabase._inserts[0].recording_id).toBe('123');
    expect(supabase._inserts[0].transcript).toContain('Hi there.');
  });

  it('ringcentral_native: returns null on 404 (transcript not yet ready)', async () => {
    const { transcribeRecording } = await loadModule();
    const supabase = makeSupabaseMock();
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not found',
      json: async () => ({}),
    });

    const result = await transcribeRecording({
      supabase,
      recordingId: '404rec',
      rcAccessToken: 'tok',
      provider: 'ringcentral_native',
    });

    expect(result).toBeNull();
    expect(supabase._inserts).toHaveLength(0);
  });

  it('ringcentral_native: returns null when insights have no transcript', async () => {
    const { transcribeRecording } = await loadModule();
    const supabase = makeSupabaseMock();
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        recordingDurationMs: 5000,
        insights: [{ type: 'Summary', summary: 'short greeting' }],
      }),
    });

    const result = await transcribeRecording({
      supabase,
      recordingId: 'empty',
      rcAccessToken: 'tok',
      provider: 'ringcentral_native',
    });

    expect(result).toBeNull();
    expect(supabase._inserts).toHaveLength(0);
  });

  it('ringcentral_native: throws on 403 (missing RingSense scope) so caller can surface the misconfig', async () => {
    const { transcribeRecording } = await loadModule();
    const supabase = makeSupabaseMock();
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Insufficient scope',
      json: async () => ({}),
    });

    await expect(
      transcribeRecording({
        supabase,
        recordingId: '403rec',
        rcAccessToken: 'tok',
        provider: 'ringcentral_native',
      }),
    ).rejects.toThrow(/403/);
  });

  it('whisper: downloads the recording and posts it to Whisper', async () => {
    const { transcribeRecording } = await loadModule();
    const supabase = makeSupabaseMock();
    const audioBlob = new Blob(['fake-audio'], { type: 'audio/mpeg' });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'audio/mpeg' }),
        blob: async () => audioBlob,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          text: 'whisper transcript',
          duration: 33.4,
          language: 'en',
        }),
        text: async () => '',
      });
    globalThis.fetch = fetchSpy;

    const result = await transcribeRecording({
      supabase,
      recordingId: '777',
      rcAccessToken: 'rc-tok',
      provider: 'whisper',
      openaiApiKey: 'oa-key',
    });

    expect(result?.source).toBe('whisper');
    expect(result?.transcript).toBe('whisper transcript');
    expect(result?.duration_seconds).toBe(33);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toContain('/recording/777/content');
    expect(fetchSpy.mock.calls[1][0]).toContain('api.openai.com/v1/audio/transcriptions');
  });

  it('whisper: throws when called with provider=whisper and no openaiApiKey', async () => {
    const { transcribeRecording } = await loadModule();
    const supabase = makeSupabaseMock();
    globalThis.fetch = vi.fn();

    await expect(
      transcribeRecording({
        supabase,
        recordingId: '1',
        rcAccessToken: 'tok',
        provider: 'whisper',
        openaiApiKey: null,
      }),
    ).rejects.toThrow(/OpenAI API key/i);
  });

  it('both: prefers RingSense when it returns a transcript (no Whisper call)', async () => {
    const { transcribeRecording } = await loadModule();
    const supabase = makeSupabaseMock();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(ringSenseResponse({ transcript: 'native worked.' }));
    globalThis.fetch = fetchSpy;

    const result = await transcribeRecording({
      supabase,
      recordingId: 'b1',
      rcAccessToken: 'tok',
      provider: 'both',
      openaiApiKey: 'oa-key',
    });

    expect(result?.source).toBe('ringcentral_native');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the RingSense call
  });

  it('both: falls back to Whisper when RingSense returns null', async () => {
    const { transcribeRecording } = await loadModule();
    const supabase = makeSupabaseMock();
    const audioBlob = new Blob(['fake'], { type: 'audio/mpeg' });
    const fetchSpy = vi
      .fn()
      // 1. RingSense returns 404 (not ready)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
        json: async () => ({}),
      })
      // 2. RC recording download
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'audio/mpeg' }),
        blob: async () => audioBlob,
        text: async () => '',
      })
      // 3. Whisper
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ text: 'fallback transcript', duration: 10 }),
        text: async () => '',
      });
    globalThis.fetch = fetchSpy;

    const result = await transcribeRecording({
      supabase,
      recordingId: 'b2',
      rcAccessToken: 'tok',
      provider: 'both',
      openaiApiKey: 'oa-key',
    });

    expect(result?.source).toBe('whisper');
    expect(result?.transcript).toBe('fallback transcript');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe('resolveTranscriptionProvider', () => {
  it('falls back to whisper when org has no voice config row', async () => {
    const { resolveTranscriptionProvider } = await loadModule();
    const supabase = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: null, error: null }; },
        };
      },
    };
    const provider = await resolveTranscriptionProvider(supabase, 'some-org');
    expect(provider).toBe('whisper');
  });

  it('falls back to whisper when no orgId is passed', async () => {
    const { resolveTranscriptionProvider } = await loadModule();
    const provider = await resolveTranscriptionProvider({}, null);
    expect(provider).toBe('whisper');
  });

  it('returns the configured provider when set to whisper', async () => {
    const { resolveTranscriptionProvider } = await loadModule();
    const supabase = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return { data: { transcription_provider: 'whisper' }, error: null };
          },
        };
      },
    };
    const provider = await resolveTranscriptionProvider(supabase, 'org-x');
    expect(provider).toBe('whisper');
  });

  it('falls back to whisper when the column holds an unknown value', async () => {
    const { resolveTranscriptionProvider } = await loadModule();
    const supabase = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return { data: { transcription_provider: 'bogus' }, error: null };
          },
        };
      },
    };
    const provider = await resolveTranscriptionProvider(supabase, 'org-x');
    expect(provider).toBe('whisper');
  });
});

describe('fetchRingSenseInsights — speaker formatting', () => {
  it('groups consecutive segments from the same speaker without re-printing the label', async () => {
    const { fetchRingSenseInsights } = await loadModule();
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        recordingDurationMs: 60_000,
        speakerInfo: [{ speakerId: 1, name: 'Alex' }, { speakerId: 2, name: 'Pat' }],
        insights: [
          {
            type: 'Transcript',
            transcript: [
              { speakerId: 1, text: 'Hello.' },
              { speakerId: 1, text: 'How are you?' },
              { speakerId: 2, text: 'Doing well.' },
              { speakerId: 1, text: 'Great.' },
            ],
          },
        ],
      }),
    });

    const result = await fetchRingSenseInsights('tok', '999');
    expect(result?.transcript).toBe(
      'Alex: Hello. How are you?\nPat: Doing well.\nAlex: Great.',
    );
  });

  it('falls back to "Speaker N" when speakerInfo does not map the id', async () => {
    const { fetchRingSenseInsights } = await loadModule();
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        recordingDurationMs: 5000,
        speakerInfo: [],
        insights: [
          {
            type: 'Transcript',
            transcript: [
              { speakerId: 7, text: 'unknown speaker.' },
            ],
          },
        ],
      }),
    });

    const result = await fetchRingSenseInsights('tok', '1');
    expect(result?.transcript).toBe('Speaker 7: unknown speaker.');
  });
});
