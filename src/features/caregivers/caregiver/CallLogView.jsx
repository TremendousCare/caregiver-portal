import { useState, useRef } from 'react';
import { buildRecordingUrl, buildTranscriptionUrl } from '../../../lib/recording';
import styles from './messaging.module.css';

/**
 * Format call duration from seconds to "Xm Ys" or "Xs".
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

/**
 * Format a timestamp for the call log.
 */
function formatCallTime(ts) {
  const date = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const callDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today - callDay) / (1000 * 60 * 60 * 24));

  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  if (diffDays === 0) return `Today, ${time}`;
  if (diffDays === 1) return `Yesterday, ${time}`;
  if (diffDays < 7) {
    const day = date.toLocaleDateString('en-US', { weekday: 'short' });
    return `${day}, ${time}`;
  }
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dateStr}, ${time}`;
}

/**
 * Get the outcome style config for a call result.
 */
function getOutcomeStyle(outcome) {
  switch (outcome) {
    case 'connected':
      return { label: 'Connected', bg: '#DCFCE7', color: '#166534' };
    case 'no_answer':
      return { label: 'No Answer', bg: '#FEE2E2', color: '#991B1B' };
    case 'left_vm':
      return { label: 'Left Voicemail', bg: '#FEF9C3', color: '#854D0E' };
    case 'responded':
      return { label: 'Responded', bg: '#DCFCE7', color: '#166534' };
    case 'no_response':
      return { label: 'No Response', bg: '#FEE2E2', color: '#991B1B' };
    default:
      return outcome ? { label: outcome, bg: '#F5F5F5', color: '#556270' } : null;
  }
}

/**
 * Call log view — structured list of phone calls and voicemails
 * with recording playback and transcription support.
 */
export function CallLogView({ calls, accessToken }) {
  const [playingId, setPlayingId] = useState(null);
  const [recordingError, setRecordingError] = useState(null);
  const [expandedTranscript, setExpandedTranscript] = useState(null);
  const [transcriptLoading, setTranscriptLoading] = useState(null);
  const [transcriptError, setTranscriptError] = useState(null);
  const transcriptCache = useRef({});

  const fetchTranscript = async (recordingId) => {
    if (expandedTranscript === recordingId) {
      setExpandedTranscript(null);
      return;
    }
    if (transcriptCache.current[recordingId]) {
      setExpandedTranscript(recordingId);
      return;
    }
    setTranscriptLoading(recordingId);
    setTranscriptError(null);
    try {
      const url = buildTranscriptionUrl(recordingId, accessToken.current);
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Transcription failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      transcriptCache.current[recordingId] = data;
      setExpandedTranscript(recordingId);
    } catch (err) {
      console.error('[CallLogView] Transcript error:', err);
      setTranscriptError(recordingId);
    } finally {
      setTranscriptLoading(null);
    }
  };

  if (calls.length === 0) {
    return (
      <div className={styles.chatContainer}>
        <div className={styles.chatEmpty}>
          <span className={styles.chatEmptyIcon}>📞</span>
          <div>No call records yet</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.callLogContainer}>
      {calls.map((call, i) => {
        const isVoicemail = call.type === 'voicemail';
        const isInbound = call.direction === 'inbound';
        const outcomeStyle = getOutcomeStyle(call.outcome);
        const duration = formatDuration(call.duration);
        const isPlaying = playingId === call.recordingId;

        return (
          <div key={call.id || `call-${i}`} className={styles.callEntry}>
            {/* Direction icon */}
            <div className={`${styles.callIcon} ${isInbound ? styles.callIconInbound : styles.callIconOutbound}`}>
              {isVoicemail ? '📱' : isInbound ? '↙' : '↗'}
            </div>

            {/* Call info */}
            <div className={styles.callInfo}>
              <div className={styles.callTopRow}>
                <span className={styles.callType}>
                  {isVoicemail ? 'Voicemail' : isInbound ? 'Incoming Call' : 'Outgoing Call'}
                </span>
                {outcomeStyle && (
                  <span className={styles.callOutcome} style={{ background: outcomeStyle.bg, color: outcomeStyle.color }}>
                    {outcomeStyle.label}
                  </span>
                )}
                {duration && (
                  <span className={styles.callDuration}>{duration}</span>
                )}
              </div>

              <div className={styles.callBottomRow}>
                <span className={styles.callTime}>{formatCallTime(call.timestamp)}</span>
                {call.author && <span className={styles.callAuthor}>{call.author}</span>}
              </div>

              {/* Note text if any */}
              {call.text && (
                <div className={styles.callNote}>{call.text}</div>
              )}

              {/* Recording controls */}
              {call.hasRecording && call.recordingId && (
                <div className={styles.callRecordingRow}>
                  <button
                    className={`${styles.callRecordingBtn} ${isPlaying ? styles.callRecordingBtnActive : ''}`}
                    onClick={() => {
                      setPlayingId(isPlaying ? null : call.recordingId);
                      setRecordingError(null);
                    }}
                  >
                    {isPlaying ? '⏹ Stop' : '▶ Play Recording'}
                  </button>
                  <button
                    className={`${styles.callTranscriptBtn} ${expandedTranscript === call.recordingId ? styles.callTranscriptBtnActive : ''}`}
                    onClick={() => fetchTranscript(call.recordingId)}
                    disabled={transcriptLoading === call.recordingId}
                  >
                    {transcriptLoading === call.recordingId
                      ? 'Transcribing...'
                      : expandedTranscript === call.recordingId
                        ? 'Hide Transcript'
                        : 'Transcript'}
                  </button>
                </div>
              )}

              {/* Audio player */}
              {isPlaying && (
                <div className={styles.callAudioPlayer}>
                  <audio
                    controls
                    autoPlay
                    src={buildRecordingUrl(call.recordingId, accessToken.current)}
                    onError={() => setRecordingError(call.recordingId)}
                    onEnded={() => setPlayingId(null)}
                    style={{ width: '100%', height: 36, borderRadius: 8 }}
                  />
                  {recordingError === call.recordingId && (
                    <div className={styles.callError}>
                      Failed to load recording. It may have expired or been removed.
                    </div>
                  )}
                </div>
              )}

              {/* Transcript */}
              {expandedTranscript === call.recordingId && transcriptCache.current[call.recordingId] && (
                <div className={styles.callTranscript}>
                  <div className={styles.callTranscriptHeader}>
                    Transcript
                    {transcriptCache.current[call.recordingId].duration_seconds && (
                      <span> ({Math.floor(transcriptCache.current[call.recordingId].duration_seconds / 60)}m {transcriptCache.current[call.recordingId].duration_seconds % 60}s)</span>
                    )}
                  </div>
                  {transcriptCache.current[call.recordingId].transcript || '(No speech detected)'}
                </div>
              )}
              {transcriptError === call.recordingId && (
                <div className={styles.callError}>
                  Failed to transcribe recording. Please try again.
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
