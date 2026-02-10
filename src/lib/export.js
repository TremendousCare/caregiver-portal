import { PHASES } from './constants';
import { getCurrentPhase, getOverallProgress, getDaysSinceApplication, getDaysInPhase, isGreenLight } from './utils';

export const exportToCSV = (caregivers, filterPhase = 'all') => {
  if (caregivers.length === 0) return;

  // ─── Pipeline Overview rows ────────────────────────────────
  const overviewRows = caregivers.map((cg) => {
    const phase = getCurrentPhase(cg);
    const phaseInfo = PHASES.find((p) => p.id === phase);
    const progress = getOverallProgress(cg);
    const daysTotal = getDaysSinceApplication(cg);
    const daysPhase = getDaysInPhase(cg);
    const gl = isGreenLight(cg);

    return {
      'First Name': cg.firstName || '',
      'Last Name': cg.lastName || '',
      'Phone': cg.phone || '',
      'Email': cg.email || '',
      'Address': [cg.address, cg.city, cg.state, cg.zip].filter(Boolean).join(', '),
      'HCA PER ID': cg.perId || '',
      'HCA Expiration': cg.hcaExpiration || '',
      'HCA Status': cg.hasHCA === 'yes' ? 'Valid' : cg.hasHCA === 'willing' ? 'Willing to register' : 'No',
      'DL & Car': cg.hasDL === 'yes' ? 'Yes' : 'No',
      'Source': cg.source || '',
      'Source Detail': cg.sourceDetail || '',
      'Application Date': cg.applicationDate || '',
      'Availability': cg.availability || '',
      'Years Experience': cg.yearsExperience || '',
      'Preferred Shift': cg.preferredShift || '',
      'Languages': cg.languages || '',
      'Specializations': cg.specializations || '',
      'Certifications': cg.certifications || '',
      'Current Phase': phaseInfo?.label || phase,
      'Phase Override': cg.phaseOverride ? PHASES.find((p) => p.id === cg.phaseOverride)?.label || cg.phaseOverride : 'Auto',
      'Overall Progress': `${progress}%`,
      'Days in Pipeline': daysTotal,
      'Days in Current Phase': daysPhase,
      'Green Light': gl ? 'YES' : 'No',
      'Board Status': cg.boardStatus || 'Not assigned',
      'Board Note': cg.boardNote || '',
      'Status': cg.archived ? 'Archived' : 'Active',
      'Archive Reason': cg.archiveReason || '',
      'Archive Detail': cg.archiveDetail || '',
      'Archive Phase': cg.archivePhase ? (PHASES.find((p) => p.id === cg.archivePhase)?.label || cg.archivePhase) : '',
      'Archived Date': cg.archivedAt ? new Date(cg.archivedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
      'Latest Note': (cg.notes || []).length > 0
        ? cg.notes[cg.notes.length - 1].text
        : '',
    };
  });

  // ─── Activity Notes rows ───────────────────────────────────
  const noteRows = [];
  caregivers.forEach((cg) => {
    (cg.notes || []).forEach((note) => {
      noteRows.push({
        'First Name': cg.firstName || '',
        'Last Name': cg.lastName || '',
        'Date': new Date(note.timestamp).toLocaleString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: 'numeric', minute: '2-digit',
        }),
        'Note': note.text,
      });
    });
  });
  if (noteRows.length === 0) {
    noteRows.push({ 'First Name': '', 'Last Name': '', 'Date': '', 'Note': 'No notes recorded' });
  }

  // ─── Phase Summary rows ────────────────────────────────────
  const summaryRows = PHASES.map((p) => {
    const inPhase = caregivers.filter((c) => getCurrentPhase(c) === p.id);
    const avgDays = inPhase.length
      ? Math.round(inPhase.reduce((s, c) => s + getDaysInPhase(c), 0) / inPhase.length)
      : 0;
    return { 'Phase': p.label, 'Count': inPhase.length, 'Avg Days in Phase': avgDays };
  });
  summaryRows.push({ 'Phase': 'TOTAL', 'Count': caregivers.length, 'Avg Days in Phase': '' });

  // ─── Build CSV ─────────────────────────────────────────────
  const csvEscape = (val) => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const toCsv = (rows) => {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const lines = [headers.map(csvEscape).join(',')];
    rows.forEach((row) => {
      lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    });
    return lines.join('\n');
  };

  const csvContent = [
    '=== PIPELINE OVERVIEW ===',
    toCsv(overviewRows),
    '',
    '=== ACTIVITY NOTES ===',
    toCsv(noteRows),
    '',
    '=== PHASE SUMMARY ===',
    toCsv(summaryRows),
  ].join('\n');

  const phaseLabel = filterPhase !== 'all'
    ? PHASES.find((p) => p.id === filterPhase)?.short || filterPhase
    : 'All';
  const date = new Date().toISOString().split('T')[0];
  const filename = `TremendousCare_Pipeline_${phaseLabel}_${date}.csv`;

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
