import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Square, AlertTriangle, CheckCircle2, X, Loader2 } from 'lucide-react';
import {
  VoiceRecorder,
  formatDuration,
  isRecordingSupported,
  MAX_RECORDING_SECONDS,
} from '../../bd-portal/lib/voiceRecorder';
import { buildVoiceFieldSchema, sectionSupportsVoiceCapture } from './voiceFieldSchema';
import { extractVoiceFields } from './voiceExtractClient';
import {
  buildProposalRows,
  defaultSelectedIds,
  formatValueForDisplay,
  groupProposalRows,
} from './voiceExtractDiff';
import btn from '../../../styles/buttons.module.css';
import s from './VoiceCaptureModal.module.css';

// ═══════════════════════════════════════════════════════════════
// VoiceCaptureModal
//
// Three-state modal: record → extract → review.
//
//   record:   mic button, live timer, stop button. Browser MediaRecorder
//             captures opus/webm (mp4 on iOS Safari).
//   extract:  upload audio + section schema to the edge function.
//             Whisper transcribes, Claude (Sonnet 4.6) maps to fields.
//             Shows a spinner with a status message.
//   review:   diff view of proposed changes. User checks/unchecks
//             per row, then clicks "Apply selected" → onApply(patch).
//             Caller writes through the existing saveDraft path.
//
// The modal NEVER writes to the database directly — it returns a
// field patch via `onApply` and the parent (SectionEditor) calls
// the same handleFieldChange / saveDraft path manual edits use. This
// keeps voice extraction a pure UX shortcut, not a separate code
// path that could drift.
// ═══════════════════════════════════════════════════════════════

const STATE = {
  RECORDING: 'recording',
  STOPPED:   'stopped',   // have audio, haven't sent yet
  EXTRACTING: 'extracting',
  REVIEW:    'review',
  ERROR:     'error',
};


export function VoiceCaptureModal({
  section,
  currentValues,
  versionId,
  clientId,
  currentUser,
  onApply,
  onClose,
}) {
  const [state, setState] = useState(STATE.RECORDING);
  const [elapsed, setElapsed] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [error, setError] = useState(null);
  const [transcript, setTranscript] = useState('');
  const [extracted, setExtracted] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [showRejected, setShowRejected] = useState(false);

  const recorderRef = useRef(null);
  const tickRef = useRef(null);
  const autoStopTimerRef = useRef(null);

  const schema = useMemo(() => buildVoiceFieldSchema(section), [section]);

  // ── Recording lifecycle ──────────────────────────────────────

  const startRecording = useCallback(async () => {
    setError(null);
    if (!isRecordingSupported()) {
      setError('Voice recording is not supported on this device or browser.');
      setState(STATE.ERROR);
      return;
    }
    try {
      recorderRef.current = new VoiceRecorder();
      await recorderRef.current.start();
      setElapsed(0);
      tickRef.current = setInterval(() => {
        const seconds = recorderRef.current?.elapsedSeconds() || 0;
        setElapsed(seconds);
      }, 200);
      // Hard cap to keep us under Whisper's per-request budget. We
      // auto-stop instead of just refusing, so the user gets what
      // they've already said rather than losing the whole recording.
      autoStopTimerRef.current = setTimeout(() => {
        stopRecording();
      }, MAX_RECORDING_SECONDS * 1000);
      setState(STATE.RECORDING);
    } catch (e) {
      setError(e?.message || 'Could not start recording');
      setState(STATE.ERROR);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!recorderRef.current) return;
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (autoStopTimerRef.current) { clearTimeout(autoStopTimerRef.current); autoStopTimerRef.current = null; }
    try {
      const blob = await recorderRef.current.stop();
      setAudioBlob(blob);
      setState(STATE.STOPPED);
    } catch (e) {
      setError(e?.message || 'Recording failed');
      setState(STATE.ERROR);
    }
  }, []);

  // Auto-start on mount so the user doesn't have to tap twice.
  useEffect(() => {
    startRecording();
    return () => {
      // Cleanup on unmount: stop the tick, release the mic.
      if (tickRef.current) clearInterval(tickRef.current);
      if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
      recorderRef.current?.cancel();
    };
  }, [startRecording]);


  // ── Extraction ──────────────────────────────────────────────

  const runExtraction = useCallback(async () => {
    if (!audioBlob) return;
    setState(STATE.EXTRACTING);
    setError(null);
    try {
      const result = await extractVoiceFields({
        audio: audioBlob,
        schema,
        currentValues: currentValues || {},
        versionId,
        clientId,
        userId: currentUser?.displayName || currentUser?.email || null,
      });
      const tx = result?.transcript || '';
      const ex = Array.isArray(result?.extracted) ? result.extracted : [];
      const rj = Array.isArray(result?.rejected) ? result.rejected : [];
      setTranscript(tx);
      setExtracted(ex);
      setRejected(rj);
      const rows = buildProposalRows(ex, currentValues || {});
      setSelected(defaultSelectedIds(rows));
      setState(STATE.REVIEW);
    } catch (e) {
      setError(e?.message || 'Voice extraction failed');
      setState(STATE.ERROR);
    }
  }, [audioBlob, schema, currentValues, versionId, clientId, currentUser]);


  // ── Apply selected ──────────────────────────────────────────

  const rows = useMemo(
    () => buildProposalRows(extracted, currentValues || {}),
    [extracted, currentValues],
  );

  const handleToggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    const patch = {};
    for (const row of rows) {
      if (!selected.has(row.id)) continue;
      if (row.isUnchanged) continue;
      patch[row.id] = row.proposedValue;
    }
    if (Object.keys(patch).length > 0) {
      onApply?.(patch);
    }
    onClose?.();
  }, [rows, selected, onApply, onClose]);


  const selectedCount = useMemo(
    () => rows.filter((r) => selected.has(r.id) && !r.isUnchanged).length,
    [rows, selected],
  );

  // ── Render ──────────────────────────────────────────────────
  // Defense in depth — SectionEditor already gates the trigger button
  // by sectionSupportsVoiceCapture, but bail safely if this modal is
  // ever rendered for an unsupported section.
  if (!sectionSupportsVoiceCapture(section)) {
    return null;
  }

  return (
    <div className={s.backdrop} onClick={onClose}>
      <div
        className={s.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Voice capture for ${section.label}`}
      >
        <header className={s.header}>
          <div>
            <div className={s.eyebrow}>Voice capture</div>
            <h2 className={s.title}>{section.label}</h2>
          </div>
          <button className={s.closeBtn} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className={s.body}>
          {state === STATE.RECORDING && (
            <RecordingPanel elapsed={elapsed} onStop={stopRecording} />
          )}
          {state === STATE.STOPPED && (
            <StoppedPanel
              elapsed={elapsed}
              onSend={runExtraction}
              onRetry={() => { setAudioBlob(null); startRecording(); }}
            />
          )}
          {state === STATE.EXTRACTING && <ExtractingPanel />}
          {state === STATE.REVIEW && (
            <ReviewPanel
              transcript={transcript}
              rows={rows}
              schemaGroups={schema?.groups}
              rejected={rejected}
              selected={selected}
              onToggle={handleToggle}
              showRejected={showRejected}
              onToggleShowRejected={() => setShowRejected((v) => !v)}
            />
          )}
          {state === STATE.ERROR && (
            <ErrorPanel error={error} onRetry={() => { setAudioBlob(null); startRecording(); }} />
          )}
        </div>

        <footer className={s.footer}>
          {state === STATE.REVIEW ? (
            <>
              <span className={s.footerCount}>
                {selectedCount} field{selectedCount === 1 ? '' : 's'} selected to apply
              </span>
              <div className={s.footerActions}>
                <button className={btn.secondaryBtn} onClick={onClose}>Cancel</button>
                <button
                  className={btn.primaryBtn}
                  onClick={handleApply}
                  disabled={selectedCount === 0}
                >
                  Apply {selectedCount > 0 ? `(${selectedCount})` : ''}
                </button>
              </div>
            </>
          ) : (
            <div className={s.footerActions}>
              <button className={btn.secondaryBtn} onClick={onClose}>Cancel</button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}


// ─── Sub-panels ────────────────────────────────────────────────

function RecordingPanel({ elapsed, onStop }) {
  return (
    <div className={s.panel}>
      <div className={s.recordingIndicator}>
        <span className={s.recordingDot} />
        <span className={s.recordingLabel}>Recording</span>
      </div>
      <div className={s.timer}>{formatDuration(elapsed)}</div>
      <p className={s.hint}>
        Speak naturally about what you know. When you're done, tap stop —
        you'll review what was captured before anything is saved.
      </p>
      <button className={s.stopBtn} onClick={onStop} aria-label="Stop recording">
        <Square size={18} fill="currentColor" />
        <span>Stop</span>
      </button>
    </div>
  );
}


function StoppedPanel({ elapsed, onSend, onRetry }) {
  return (
    <div className={s.panel}>
      <div className={s.stoppedIcon}>
        <CheckCircle2 size={48} />
      </div>
      <div className={s.stoppedHeading}>Recorded {formatDuration(elapsed)}</div>
      <p className={s.hint}>Send it for transcription and field extraction?</p>
      <div className={s.actionRow}>
        <button className={btn.secondaryBtn} onClick={onRetry}>
          <Mic size={14} /> Re-record
        </button>
        <button className={btn.primaryBtn} onClick={onSend}>
          Send & extract
        </button>
      </div>
    </div>
  );
}


function ExtractingPanel() {
  return (
    <div className={s.panel}>
      <div className={s.spinnerWrap}>
        <Loader2 size={48} className={s.spinner} />
      </div>
      <div className={s.stoppedHeading}>Transcribing and extracting fields…</div>
      <p className={s.hint}>
        Whisper is transcribing your dictation, then Claude is mapping
        what you said to the form fields. Usually 5-15 seconds.
      </p>
    </div>
  );
}


function ErrorPanel({ error, onRetry }) {
  return (
    <div className={s.panel}>
      <div className={s.errorIcon}>
        <AlertTriangle size={48} />
      </div>
      <div className={s.stoppedHeading}>Something went wrong</div>
      <p className={s.errorMessage}>{error}</p>
      <button className={btn.primaryBtn} onClick={onRetry}>
        <Mic size={14} /> Try again
      </button>
    </div>
  );
}


function ReviewPanel({
  transcript, rows, schemaGroups, rejected, selected, onToggle,
  showRejected, onToggleShowRejected,
}) {
  // Sort: changed-and-high-confidence first, then changed-medium,
  // then unchanged, then anything else. Keeps the user's eye on
  // the actionable rows. The sort runs BEFORE grouping so the order
  // within each accordion group is also priority-driven.
  const sorted = useMemo(() => {
    const score = (r) => {
      if (r.isUnchanged) return 100;
      if (!r.quoteVerified) return 50;
      if (r.confidence === 'high')   return 0;
      if (r.confidence === 'medium') return 10;
      return 20;
    };
    return [...rows].sort((a, b) => score(a) - score(b));
  }, [rows]);

  // For grouped sections (ADLs, IADLs) we render the proposals as
  // an accordion-style breakdown so the nurse can scan changes by
  // sub-area. For flat sections, this collapses to a single ungrouped
  // bucket and renders the same as Phase 1.
  const buckets = useMemo(
    () => groupProposalRows(sorted, schemaGroups),
    [sorted, schemaGroups],
  );
  const hasGroups = Array.isArray(schemaGroups) && schemaGroups.length > 0;

  return (
    <div className={s.reviewWrap}>
      <details className={s.transcriptDetails}>
        <summary className={s.transcriptSummary}>
          Transcript ({transcript.length.toLocaleString()} characters)
        </summary>
        <div className={s.transcriptBody}>
          {transcript || <em>Empty transcript</em>}
        </div>
      </details>

      {sorted.length === 0 && (
        <div className={s.emptyResult}>
          No fields could be extracted from this dictation. Try recording
          again with more specific details about each field you want to fill.
        </div>
      )}

      <div className={s.proposalList}>
        {buckets.map((bucket) => (
          <div
            key={bucket.groupId || '_ungrouped'}
            className={hasGroups ? s.groupBucket : ''}
          >
            {hasGroups && bucket.groupLabel && (
              <div className={s.groupHeader}>
                {bucket.groupLabel}
                <span className={s.groupCount}>
                  {bucket.rows.filter((r) => !r.isUnchanged).length} change{
                    bucket.rows.filter((r) => !r.isUnchanged).length === 1 ? '' : 's'
                  }
                </span>
              </div>
            )}
            {bucket.rows.map((row) => (
              <ProposalRow
                key={row.id}
                row={row}
                checked={selected.has(row.id)}
                onToggle={() => onToggle(row.id)}
              />
            ))}
          </div>
        ))}
      </div>

      {rejected.length > 0 && (
        <div className={s.rejectedBlock}>
          <button className={s.rejectedToggle} onClick={onToggleShowRejected}>
            {showRejected ? 'Hide' : 'Show'} {rejected.length} rejected{' '}
            extraction{rejected.length === 1 ? '' : 's'}
          </button>
          {showRejected && (
            <ul className={s.rejectedList}>
              {rejected.map((r, i) => (
                <li key={i} className={s.rejectedItem}>
                  <code>{r.claim?.id || '?'}</code>: {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}


function ProposalRow({ row, checked, onToggle }) {
  const cls = [
    s.proposalRow,
    row.isUnchanged ? s.proposalUnchanged : '',
    !row.quoteVerified ? s.proposalUnverified : '',
  ].filter(Boolean).join(' ');

  return (
    <label className={cls}>
      <input
        type="checkbox"
        className={s.proposalCheckbox}
        checked={checked}
        onChange={onToggle}
        disabled={row.isUnchanged}
      />
      <div className={s.proposalContent}>
        <div className={s.proposalLabel}>
          {row.fieldLabel}
          <ConfidenceChip confidence={row.confidence} verified={row.quoteVerified} />
          {row.isUnchanged && <span className={s.unchangedChip}>unchanged</span>}
        </div>
        <div className={s.proposalDiff}>
          <div className={s.proposalCurrent}>
            <span className={s.proposalDiffLabel}>Current:</span>{' '}
            {formatValueForDisplay(row.currentValue)}
          </div>
          <div className={s.proposalProposed}>
            <span className={s.proposalDiffLabel}>Proposed:</span>{' '}
            {formatValueForDisplay(row.proposedValue)}
          </div>
        </div>
        {row.quote && (
          <div className={s.proposalQuote}>
            <span aria-hidden="true">“</span>{row.quote}<span aria-hidden="true">”</span>
          </div>
        )}
      </div>
    </label>
  );
}


function ConfidenceChip({ confidence, verified }) {
  if (!verified) {
    return (
      <span className={`${s.chip} ${s.chipDanger}`} title="Quote not found in transcript — likely hallucination">
        <AlertTriangle size={11} /> unverified
      </span>
    );
  }
  if (confidence === 'high') {
    return <span className={`${s.chip} ${s.chipSuccess}`}>high</span>;
  }
  if (confidence === 'medium') {
    return <span className={`${s.chip} ${s.chipWarning}`}>medium</span>;
  }
  return <span className={`${s.chip} ${s.chipMuted}`}>low</span>;
}
