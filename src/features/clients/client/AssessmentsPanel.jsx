import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mic, Square, Upload, Loader2, RotateCcw, Play, AlertTriangle, CheckCircle2, FilePlus2,
} from 'lucide-react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import {
  VoiceRecorder, isRecordingSupported,
} from '../../bd-portal/lib/voiceRecorder';
import {
  statusMeta, canRetry, buildSpeakerTurns, assessmentAudioPath,
  isLikelyAudio, formatAssessmentTimestamp, pickEmbeddedTranscription, formatElapsed,
  ASSESSMENT_MAX_RECORDING_SECONDS, MAX_UPLOAD_BYTES,
} from '../../../lib/assessmentTranscript';
import { describeDraftSummary } from '../../../lib/assessmentCarePlan';
import { draftCarePlanFromAssessment } from '../../care-plans/voice/assessmentDraftClient';
import cards from '../../../styles/cards.module.css';
import btn from '../../../styles/buttons.module.css';
import s from './assessments.module.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const AUDIO_BUCKET = 'assessment-audio';

const SELECT_COLS =
  'id, client_id, status, audio_path, audio_mime, duration_seconds, error_message, '
  + 'recorded_at, created_at, transcribe_attempts, '
  + 'assessment_transcriptions ( transcript, transcript_json, confidence )';

// Resolve the current org_id + access token from the live session.
async function getSessionContext() {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    token: session?.access_token ?? null,
    orgId: getOrgClaims(session).orgId,
  };
}

export function AssessmentsPanel({ client, currentUser, showToast, canDraftCarePlan = false, onCarePlanDrafted }) {
  const [assessments, setAssessments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [captureState, setCaptureState] = useState('idle'); // idle | recording | processing
  const [elapsed, setElapsed] = useState(0);
  const [captureError, setCaptureError] = useState(null);

  const [expandedId, setExpandedId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
  const [draftingId, setDraftingId] = useState(null);
  const [audioUrls, setAudioUrls] = useState({});

  const recorderRef = useRef(null);
  const tickRef = useRef(null);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    if (!supabase || !client?.id) { setLoading(false); return; }
    try {
      const { data, error } = await supabase
        .from('assessments')
        .select(SELECT_COLS)
        .eq('client_id', client.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setAssessments(data || []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message || 'Failed to load assessments.');
    } finally {
      setLoading(false);
    }
  }, [client?.id]);

  useEffect(() => { load(); }, [load]);

  // Live status updates via polling. The `assessments` table is not in
  // the realtime publication, so we poll (every 8s) only while at least
  // one assessment is still in-flight — transcription typically lands in
  // 1–2 minutes — and stop once everything has settled.
  const hasInFlight = assessments.some(
    (a) => a.status === 'uploaded' || a.status === 'transcribing',
  );
  useEffect(() => {
    if (!hasInFlight) return undefined;
    const interval = setInterval(() => { load(); }, 8000);
    return () => clearInterval(interval);
  }, [hasInFlight, load]);

  // Teardown any in-progress recording on unmount.
  useEffect(() => () => {
    if (tickRef.current) clearInterval(tickRef.current);
    recorderRef.current?.cancel();
  }, []);

  const stopTick = () => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  };

  async function handleStartRecording() {
    setCaptureError(null);
    if (!isRecordingSupported()) {
      setCaptureError('Voice recording is not supported on this device — use "Upload audio" instead.');
      return;
    }
    try {
      const recorder = new VoiceRecorder();
      recorderRef.current = recorder;
      await recorder.start();
      setCaptureState('recording');
      setElapsed(0);
      tickRef.current = setInterval(() => {
        const e = recorder.elapsedSeconds();
        setElapsed(e);
        if (e >= ASSESSMENT_MAX_RECORDING_SECONDS) handleStopRecording();
      }, 250);
    } catch (err) {
      setCaptureError(err.message || 'Could not start recording.');
      setCaptureState('idle');
    }
  }

  async function handleStopRecording() {
    stopTick();
    // Claim the recorder up front so a double Stop click (or the
    // max-duration tick racing the button) can't process twice.
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    try {
      const seconds = recorder.elapsedSeconds();
      const blob = await recorder.stop();
      if (!blob || blob.size === 0) throw new Error('No audio captured. Try again.');
      await processAudio(blob, seconds, blob.type);
    } catch (err) {
      setCaptureError(err.message || 'Recording failed.');
      setCaptureState('idle');
    }
  }

  function handleCancelRecording() {
    stopTick();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setCaptureState('idle');
    setElapsed(0);
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    setCaptureError(null);
    if (!isLikelyAudio(file)) {
      setCaptureError('That file does not look like audio. Upload a recording (webm, m4a, mp3, wav…).');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setCaptureError('That audio file is too large.');
      return;
    }
    processAudio(file, null, file.type);
  }

  // Core: upload audio → create assessment row → kick off transcription.
  async function processAudio(audio, durationSeconds, mime) {
    setCaptureState('processing');
    setCaptureError(null);
    let uploadedPath = null;
    try {
      if (!supabase) throw new Error('Not connected.');
      const { token, orgId } = await getSessionContext();
      if (!orgId) throw new Error('Unable to determine your organization. Sign out and back in, then retry.');
      if (!token) throw new Error('Not signed in.');

      const id = crypto.randomUUID();
      const path = assessmentAudioPath(orgId, id, mime);

      const { error: upErr } = await supabase.storage
        .from(AUDIO_BUCKET)
        .upload(path, audio, { contentType: mime || 'application/octet-stream', upsert: false });
      if (upErr) throw new Error(`Audio upload failed: ${upErr.message}`);
      uploadedPath = path;

      const { error: insErr } = await supabase.from('assessments').insert({
        id,
        org_id: orgId,
        client_id: client.id,
        status: 'uploaded',
        audio_path: path,
        audio_mime: mime || null,
        duration_seconds: durationSeconds != null ? Math.round(durationSeconds) : null,
        recorded_at: new Date().toISOString(),
        created_by: currentUser?.displayName || currentUser?.email || null,
      });
      if (insErr) throw new Error(`Could not save assessment: ${insErr.message}`);

      // Kick off transcription. A failure here is non-fatal: the row is
      // 'uploaded' and the reconcile cron will submit it within minutes.
      let queued = false;
      try {
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/assessment-transcribe`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ assessment_id: id }),
        });
        queued = resp.ok;
      } catch { queued = false; }

      showToast?.(queued ? 'Assessment uploaded — transcribing now.' : 'Assessment uploaded — transcription will start shortly.');
      setCaptureState('idle');
      setElapsed(0);
      await load();
    } catch (err) {
      // Roll back the orphaned audio object if the row never got created.
      if (uploadedPath && supabase) {
        await supabase.storage.from(AUDIO_BUCKET).remove([uploadedPath]).catch(() => {});
      }
      setCaptureError(err.message || 'Something went wrong.');
      setCaptureState('idle');
    }
  }

  async function handleRetry(a) {
    setRetryingId(a.id);
    try {
      const { token } = await getSessionContext();
      if (!token) throw new Error('Not signed in.');
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/assessment-transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ assessment_id: a.id }),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`Retry failed (${resp.status}): ${t.slice(0, 140)}`);
      }
      await load();
    } catch (err) {
      showToast?.(err.message || 'Retry failed.');
    } finally {
      setRetryingId(null);
    }
  }

  async function handlePlay(a) {
    if (audioUrls[a.id] || !a.audio_path || !supabase) return;
    const { data, error } = await supabase.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(a.audio_path, 3600);
    if (error || !data?.signedUrl) {
      showToast?.('Could not load audio.');
      return;
    }
    setAudioUrls((prev) => ({ ...prev, [a.id]: data.signedUrl }));
  }

  async function handleDraftCarePlan(a) {
    setDraftingId(a.id);
    try {
      const { summary } = await draftCarePlanFromAssessment({
        assessmentId: a.id,
        clientId: client.id,
        userId: currentUser?.email || currentUser?.displayName || 'unknown',
      });
      showToast?.(describeDraftSummary(summary));
      onCarePlanDrafted?.();
    } catch (err) {
      showToast?.(err.message || 'Could not draft care plan.');
    } finally {
      setDraftingId(null);
    }
  }

  const recording = captureState === 'recording';
  const processing = captureState === 'processing';

  return (
    <div className={cards.profileCard}>
      <div className={cards.profileCardHeader}>
        <h3 className={cards.profileCardTitle}>In-Home Assessments</h3>
        {assessments.length > 0 && (
          <span style={{ fontSize: 12, color: '#7A8BA0', fontWeight: 500 }}>
            {assessments.length} recorded
          </span>
        )}
      </div>

      <div className={s.body}>
        {!supabase ? (
          <div className={s.empty}>Not connected.</div>
        ) : (
          <>
            {/* Capture controls */}
            {recording ? (
              <div className={s.recordingRow}>
                <span className={s.pulseDot} aria-hidden />
                <span className={s.elapsed}>{formatElapsed(elapsed)}</span>
                <button type="button" className={btn.primaryBtn} onClick={handleStopRecording}>
                  <Square size={14} fill="currentColor" aria-hidden /> Stop &amp; transcribe
                </button>
                <button type="button" className={btn.secondaryBtn} onClick={handleCancelRecording}>
                  Cancel
                </button>
              </div>
            ) : processing ? (
              <div className={s.processing}>
                <Loader2 size={18} className={s.spinner} aria-hidden />
                Uploading &amp; queuing transcription…
              </div>
            ) : (
              <div className={s.controls}>
                <button type="button" className={btn.primaryBtn} onClick={handleStartRecording}>
                  <Mic size={16} aria-hidden /> Record assessment
                </button>
                <button type="button" className={btn.secondaryBtn} onClick={() => fileInputRef.current?.click()}>
                  <Upload size={16} aria-hidden /> Upload audio
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
              </div>
            )}

            {captureError && (
              <div className={s.errorMsg}>
                <AlertTriangle size={13} aria-hidden style={{ verticalAlign: '-2px', marginRight: 4 }} />
                {captureError}
              </div>
            )}

            {/* List */}
            {loading ? (
              <div className={s.empty}>Loading…</div>
            ) : loadError ? (
              <div className={s.errorMsg}>{loadError}</div>
            ) : assessments.length === 0 ? (
              <div className={s.empty}>No assessments recorded yet.</div>
            ) : (
              <div className={s.list}>
                {assessments.map((a) => {
                  const meta = statusMeta(a.status);
                  const tx = pickEmbeddedTranscription(a.assessment_transcriptions);
                  const isOpen = expandedId === a.id;
                  const turns = isOpen ? buildSpeakerTurns(tx?.transcript_json, tx?.transcript) : [];
                  return (
                    <div key={a.id} className={s.item}>
                      <div className={s.itemHeader}>
                        <div className={s.itemMeta}>
                          <span>{formatAssessmentTimestamp(a.recorded_at || a.created_at)}</span>
                          {a.duration_seconds != null && <span>· {formatElapsed(a.duration_seconds)}</span>}
                          <span className={`${s.badge} ${s[`tone_${meta.tone}`]}`}>
                            {meta.tone === 'success' && <CheckCircle2 size={12} aria-hidden />}
                            {meta.tone === 'active' && <Loader2 size={12} className={s.spinner} aria-hidden />}
                            {meta.tone === 'error' && <AlertTriangle size={12} aria-hidden />}
                            {meta.label}
                          </span>
                        </div>
                        <div className={s.itemActions}>
                          {a.status === 'transcribed' && (
                            <>
                              <button
                                type="button"
                                className={s.linkBtn}
                                onClick={() => setExpandedId(isOpen ? null : a.id)}
                              >
                                {isOpen ? 'Hide transcript' : 'View transcript'}
                              </button>
                              {a.audio_path && !audioUrls[a.id] && (
                                <button type="button" className={s.linkBtn} onClick={() => handlePlay(a)}>
                                  <Play size={13} aria-hidden style={{ verticalAlign: '-2px' }} /> Play
                                </button>
                              )}
                              {canDraftCarePlan && (
                                <button
                                  type="button"
                                  className={btn.secondaryBtn}
                                  disabled={draftingId === a.id}
                                  onClick={() => handleDraftCarePlan(a)}
                                  title="Use this transcript to draft care plan fields and tasks for review"
                                >
                                  {draftingId === a.id
                                    ? <><Loader2 size={13} className={s.spinner} aria-hidden /> Drafting…</>
                                    : <><FilePlus2 size={13} aria-hidden /> Draft care plan</>}
                                </button>
                              )}
                            </>
                          )}
                          {canRetry(a.status) && (
                            <button
                              type="button"
                              className={btn.secondaryBtn}
                              disabled={retryingId === a.id}
                              onClick={() => handleRetry(a)}
                            >
                              {retryingId === a.id
                                ? <><Loader2 size={13} className={s.spinner} aria-hidden /> Retrying…</>
                                : <><RotateCcw size={13} aria-hidden /> Retry</>}
                            </button>
                          )}
                        </div>
                      </div>

                      {a.status === 'failed' && a.error_message && (
                        <div className={s.errorMsg}>{a.error_message}</div>
                      )}

                      {audioUrls[a.id] && (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <audio className={s.audio} controls src={audioUrls[a.id]} />
                      )}

                      {isOpen && (
                        <div className={s.transcript}>
                          {turns.length === 0 ? (
                            <div className={s.empty}>Transcript is empty.</div>
                          ) : (
                            turns.map((turn, i) => (
                              <div key={i} className={s.turn}>
                                {turn.label && <span className={s.turnSpeaker}>{turn.label}</span>}
                                <span className={s.turnText}>{turn.text}</span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
