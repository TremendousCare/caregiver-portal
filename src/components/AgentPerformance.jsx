import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import s from './AgentPerformance.module.css';

const RANGES = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
];

export function AgentPerformance() {
  const [range, setRange] = useState(24);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    const since = new Date(Date.now() - range * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('system_metrics')
      .select('function_name, event_type, duration_ms, success, metadata, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error || !data) {
      setMetrics(null);
      setLoading(false);
      return;
    }

    // Message-router specific stats
    const routerInvocations = data.filter(r => r.function_name === 'message-router' && r.event_type === 'invocation');
    const totalProcessed = routerInvocations.reduce((sum, r) => sum + (r.metadata?.processed || 0), 0);
    const totalAutoExec = routerInvocations.reduce((sum, r) => sum + (r.metadata?.auto_executed || 0), 0);

    // Classification latency
    const classifyRows = data.filter(r => r.event_type === 'classification' && r.duration_ms);
    const avgClassifyMs = classifyRows.length > 0
      ? Math.round(classifyRows.reduce((sum, r) => sum + r.duration_ms, 0) / classifyRows.length)
      : null;

    // Error rate
    const totalEvents = data.length;
    const totalErrors = data.filter(r => !r.success).length;
    const errorRate = totalEvents > 0 ? Math.round((totalErrors / totalEvents) * 1000) / 10 : 0;

    // ai-chat token usage
    const chatInvocations = data.filter(r => r.function_name === 'ai-chat' && r.event_type === 'invocation');
    const totalInputTokens = chatInvocations.reduce((sum, r) => sum + (r.metadata?.input_tokens || 0), 0);
    const totalOutputTokens = chatInvocations.reduce((sum, r) => sum + (r.metadata?.output_tokens || 0), 0);

    setMetrics({
      totalEvents,
      totalErrors,
      errorRate,
      totalProcessed,
      totalAutoExec,
      avgClassifyMs,
      chatInvocations: chatInvocations.length,
      totalInputTokens,
      totalOutputTokens,
      recentErrors: data.filter(r => !r.success).slice(0, 5),
    });
    setLoading(false);
  }, [range]);

  useEffect(() => { fetchMetrics(); }, [fetchMetrics]);

  if (loading) return <div className={s.loading}>Loading metrics...</div>;
  if (!metrics) return <div className={s.empty}>No metrics data available yet.</div>;

  return (
    <div className={s.container}>
      <div className={s.header}>
        <h3 className={s.title}>Agent Performance</h3>
        <div className={s.rangeToggle}>
          {RANGES.map(r => (
            <button
              key={r.hours}
              className={`${s.rangeBtn} ${range === r.hours ? s.rangeBtnActive : ''}`}
              onClick={() => setRange(r.hours)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className={s.grid}>
        <div className={s.card}>
          <div className={s.cardValue}>{metrics.totalProcessed}</div>
          <div className={s.cardLabel}>Messages Processed</div>
        </div>
        <div className={s.card}>
          <div className={s.cardValue}>{metrics.avgClassifyMs ? `${metrics.avgClassifyMs}ms` : '\u2014'}</div>
          <div className={s.cardLabel}>Avg Classification</div>
        </div>
        <div className={s.card}>
          <div className={s.cardValue}>{metrics.totalAutoExec}</div>
          <div className={s.cardLabel}>Auto-Executed</div>
        </div>
        <div className={s.card}>
          <div className={`${s.cardValue} ${metrics.errorRate > 5 ? s.cardValueDanger : ''}`}>
            {metrics.errorRate}%
          </div>
          <div className={s.cardLabel}>Error Rate</div>
        </div>
      </div>

      <div className={s.grid}>
        <div className={s.card}>
          <div className={s.cardValue}>{metrics.chatInvocations}</div>
          <div className={s.cardLabel}>Chat Sessions</div>
        </div>
        <div className={s.card}>
          <div className={s.cardValue}>{metrics.totalInputTokens.toLocaleString()}</div>
          <div className={s.cardLabel}>Input Tokens</div>
        </div>
        <div className={s.card}>
          <div className={s.cardValue}>{metrics.totalOutputTokens.toLocaleString()}</div>
          <div className={s.cardLabel}>Output Tokens</div>
        </div>
        <div className={s.card}>
          <div className={s.cardValue}>{metrics.totalEvents}</div>
          <div className={s.cardLabel}>Total Events</div>
        </div>
      </div>

      {metrics.recentErrors.length > 0 && (
        <div className={s.section}>
          <h4 className={s.sectionTitle}>Recent Errors</h4>
          <div className={s.errorList}>
            {metrics.recentErrors.map((err, i) => (
              <div key={i} className={s.errorRow}>
                <span className={s.errorFn}>{err.function_name}</span>
                <span className={s.errorMsg}>{err.metadata?.error || 'Unknown error'}</span>
                <span className={s.errorTime}>{new Date(err.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
