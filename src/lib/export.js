import { PHASES } from './constants';
import { getCurrentPhase, getOverallProgress, getDaysSinceApplication, getDaysInPhase, isGreenLight, getPhaseProgress } from './utils';
import { getPhaseTasks } from './storage';

export const exportToCSV = (caregivers, filterPhase = 'all') => {
  const rows = caregivers.map((cg) => {
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
      'Source': cg.source || '',
      'Application Date': cg.applicationDate || '',
      'Availability': cg.availability || '',
      'Current Phase': phaseInfo?.label || '',
      'Overall Progress': `${progress}%`,
      'Days Since Application': daysTotal,
      'Days in Current Phase': daysPhase,
      'Green Light': gl ? 'YES' : 'No',
      'Notes Count': (cg.notes || []).length,
      'Last Note': (cg.notes || []).length > 0
        ? cg.notes[cg.notes.length - 1].text
        : '',
    };
  });

  if (rows.length === 0) return;

  const headers = Object.keys(rows[0]);
  const csvContent = [
    headers.join(','),
    ...rows.map((row) =>
      headers.map((h) => {
        const val = String(row[h] ?? '');
        // Escape commas, quotes, and newlines
        return val.includes(',') || val.includes('"') || val.includes('\n')
          ? `"${val.replace(/"/g, '""')}"`
          : val;
      }).join(',')
    ),
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
  link.click();
  URL.revokeObjectURL(url);
};
