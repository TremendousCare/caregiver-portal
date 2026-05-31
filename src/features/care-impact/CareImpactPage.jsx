import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Building2,
  Ambulance,
  TrendingDown,
  RotateCcw,
  ShieldCheck,
  Clock,
  Printer,
  Info,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useCareImpact } from './useCareImpact';
import { TIME_RANGES } from './careImpactAggregation';

function pct(n) {
  if (n == null) return '—';
  return `${Math.round(n * 100)}%`;
}

function StatCard({ icon: Icon, label, value, sub, tone = 'neutral' }) {
  const color = { danger: '#dc2626', warning: '#d97706', good: '#059669', neutral: '#334155' }[tone];
  return (
    <div style={{ background: '#fff', border: '1px solid #e8eef5', borderRadius: 14, padding: 18, flex: '1 1 180px', minWidth: 180 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        <Icon size={14} /> {label}
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, children, note }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1e293b', margin: '0 0 4px' }}>{title}</h2>
      {note && <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 12px' }}>{note}</p>}
      {children}
    </section>
  );
}

export function CareImpactPage() {
  const [rangeId, setRangeId] = useState('90d');
  const { range, loading, available, summary, trend } = useCareImpact(rangeId);

  const handlePrint = () => window.print();

  if (!available && !loading) {
    return (
      <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Care Impact</h1>
        <p style={{ color: '#64748b', fontSize: 14 }}>
          Impact data isn’t available yet. It populates once the Care Coordinator is enabled and
          health events are being logged.
        </p>
      </div>
    );
  }

  const { funnel, latency, outcomes, attribution } = summary;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1e293b', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Activity size={22} color="#2563eb" /> Care Impact
          </h1>
          <p style={{ color: '#64748b', fontSize: 13, margin: '4px 0 0' }}>
            Observed care-coordination metrics for the last {range.label.toLowerCase()}. Internal view —
            use “Export report” for a partner-ready summary.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} className="no-print">
          <select
            value={rangeId}
            onChange={(e) => setRangeId(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 13 }}
          >
            {TIME_RANGES.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
          <button
            onClick={handlePrint}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#334155' }}
          >
            <Printer size={14} /> Export report
          </button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#94a3b8', marginTop: 24 }}>Loading…</p>
      ) : (
        <>
          {/* Outcomes */}
          <Section
            title="Health outcomes"
            note="Observed counts from staff-logged health events in the period. These are agency-wide observed metrics, not claims about cause."
          >
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <StatCard icon={Building2} label="Hospitalizations" value={outcomes.hospitalizations} tone="danger" />
              <StatCard icon={RotateCcw} label="30-day readmissions" value={outcomes.readmissions} tone="danger" />
              <StatCard icon={Ambulance} label="ED visits" value={outcomes.edVisits} tone="warning" />
              <StatCard icon={TrendingDown} label="Falls" value={outcomes.falls} tone="warning" />
            </div>
          </Section>

          {/* Trend */}
          <Section title="Monthly trend" note="Your own trend over time. No external benchmark is applied in this version.">
            <div style={{ background: '#fff', border: '1px solid #e8eef5', borderRadius: 14, padding: 16, height: 280 }}>
              {trend.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: 13 }}>Not enough data to chart yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="hospitalizations" name="Hospitalizations" stroke="#dc2626" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="readmissions" name="30-day readmissions" stroke="#b45309" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="edVisits" name="ED visits" stroke="#2563eb" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </Section>

          {/* Signal funnel */}
          <Section
            title="Early-warning activity"
            note="How the Care Coordinator’s change-of-condition signals were triaged by staff."
          >
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <StatCard icon={AlertTriangle} label="Signals surfaced" value={funnel.total} />
              <StatCard icon={ShieldCheck} label="Acted on" value={funnel.actedOn} sub={`${pct(funnel.actionRate)} of signals`} tone="good" />
              <StatCard icon={Clock} label="Median response" value={latency.medianMinutes != null ? `${latency.medianMinutes} min` : '—'} sub={latency.n ? `${latency.n} dispositioned` : ''} />
            </div>
          </Section>

          {/* Attribution */}
          <Section
            title="Signal ↔ outcome"
            note="How early-warning signals related to outcomes. “Estimated avoided escalations” is a leading indicator, defined below — not a proven causal reduction."
          >
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <StatCard icon={ShieldCheck} label="Caught early" value={attribution.caughtEarly} sub="event had a preceding signal" tone="good" />
              <StatCard icon={AlertTriangle} label="No prior signal" value={attribution.missed} sub="event with no preceding signal" tone="warning" />
              <StatCard icon={ShieldCheck} label="Est. avoided escalations" value={attribution.estimatedAvoided} sub="actioned signal, no event followed" tone="good" />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 12 }}>
              <Info size={16} color="#64748b" style={{ marginTop: 1, flexShrink: 0 }} />
              <p style={{ margin: 0, fontSize: 12, color: '#475569', lineHeight: 1.5 }}>
                <strong>How to read this.</strong> “Caught early” counts hospitalizations/ED visits that had a
                care signal in the days before them. “Estimated avoided escalations” counts signals that staff
                acted on where no hospitalization or ED visit followed within {14} days — a <strong>leading
                indicator</strong> of value, not a proof of causation. We do not claim the tool caused any
                specific outcome; establishing that requires a controlled baseline we don’t yet have.
              </p>
            </div>
          </Section>

          <p className="no-print" style={{ marginTop: 28, fontSize: 11, color: '#cbd5e1' }}>
            Care Coordinator — decision support, not diagnosis. Metrics reflect staff-logged data and may be incomplete.
          </p>
        </>
      )}
    </div>
  );
}

export default CareImpactPage;
