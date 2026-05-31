// ─── QuickBooks Online connection panel ──────────────────────────────────
// Owner-only Settings card. Drives the OAuth handshake (delegates to the
// quickbooks-oauth-init edge function which redirects through Intuit's
// consent screen and back through quickbooks-oauth-callback), then shows
// connection status + scopes + expiry, with Reconnect and Disconnect
// actions.
//
// Renders nothing for non-owners — matches the visibility matrix locked
// in PR #1 (owner R/W on quickbooks_connections; admin SELECT-only).

import { useState, useEffect, useCallback } from 'react';
import {
  Building2, CheckCircle2, AlertCircle,
  Plug, Unplug, RefreshCw,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useApp } from '../../shared/context/AppContext';
import { isOwnerRole } from '../../lib/auth/roles';
import { CollapsibleCard } from '../../shared/components/CollapsibleCard';
import btn from '../../styles/buttons.module.css';

const ENV_LABEL = {
  sandbox: 'Sandbox',
  production: 'Production',
};

export function QuickBooksConnection({ showToast }) {
  const { currentOrgRole, currentOrgId } = useApp();
  const [connection, setConnection] = useState(null);
  const [loading, setLoading] = useState(true);
  // 'connecting' | 'disconnecting' | null — single in-flight action at a
  // time so the user can't double-click their way into a bad state.
  const [actioning, setActioning] = useState(null);

  const reload = useCallback(async () => {
    if (!currentOrgId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('quickbooks_connections')
        .select(
          'id, realm_id, environment, scopes, status, status_message, ' +
          'connected_by, connected_at, last_refreshed_at, last_sync_at, ' +
          'refresh_token_expires_at'
        )
        .eq('org_id', currentOrgId)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      setConnection(data || null);
    } catch (e) {
      console.error('Failed to load QuickBooks connection:', e);
    } finally {
      setLoading(false);
    }
  }, [currentOrgId]);

  useEffect(() => { reload(); }, [reload]);

  // Read ?qb= / ?qb_error= from the URL (set by the callback edge
  // function's redirect), toast the result, then strip the params so a
  // page reload doesn't re-toast or re-trigger anything.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const ok = params.get('qb');
    const err = params.get('qb_error');
    const detail = params.get('qb_detail');
    if (!ok && !err) return;

    if (ok === 'connected') {
      showToast?.('QuickBooks connected successfully.');
      reload();
    } else if (err) {
      // Toast shows the short error code; the longer detail (truncated
      // Intuit response, server stack) goes to the console so a tech-
      // savvy owner — or whoever is on the call with them — can paste
      // it into a bug report without copying the URL bar.
      const human = err.replace(/_/g, ' ');
      showToast?.(
        detail
          ? `QuickBooks connection failed (${human}). Open the console for the full Intuit response.`
          : `QuickBooks connection failed: ${human}`,
      );
      // eslint-disable-next-line no-console
      console.error('[QuickBooks] connect failed:', { qb_error: err, qb_detail: detail });
    }
    params.delete('qb');
    params.delete('qb_error');
    params.delete('qb_detail');
    const newSearch = params.toString();
    const newUrl =
      window.location.pathname +
      (newSearch ? `?${newSearch}` : '') +
      window.location.hash;
    window.history.replaceState({}, '', newUrl);
  }, [reload, showToast]);

  // Owner-only — non-owners don't even see the card.
  if (!isOwnerRole(currentOrgRole)) return null;

  const handleConnect = async () => {
    if (actioning) return;
    setActioning('connecting');
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('You must be signed in to connect QuickBooks.');

      const base = import.meta.env.VITE_SUPABASE_URL;
      if (!base) throw new Error('Supabase URL is not configured.');
      const resp = await fetch(`${base}/functions/v1/quickbooks-oauth-init`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `${resp.status} ${resp.statusText}`);
      }
      const payload = await resp.json();
      if (!payload.redirect_url) {
        throw new Error('Server did not return a redirect URL.');
      }
      // Browser leaves the SPA here — the callback will redirect back.
      window.location.href = payload.redirect_url;
    } catch (e) {
      console.error('QuickBooks init failed:', e);
      showToast?.(`Failed to start QuickBooks connection: ${e.message}`);
      setActioning(null);
    }
  };

  const handleDisconnect = async () => {
    if (actioning || !connection) return;
    if (!window.confirm('Disconnect QuickBooks? You can reconnect at any time.')) {
      return;
    }
    setActioning('disconnecting');
    try {
      const { error } = await supabase.rpc('clear_qb_connection', {
        p_org_id: currentOrgId,
        p_environment: connection.environment,
      });
      if (error) throw error;
      showToast?.('QuickBooks disconnected.');
      setConnection(null);
    } catch (e) {
      console.error('QuickBooks disconnect failed:', e);
      showToast?.(`Failed to disconnect QuickBooks: ${e.message}`);
    } finally {
      setActioning(null);
    }
  };

  return (
    <CollapsibleCard title="QuickBooks Online" description="Accounting Integration">
      <div style={{ padding: '20px 24px' }}>
        {loading && (
          <div style={{ color: '#7A8BA0', fontSize: 13 }}>Loading…</div>
        )}
        {!loading && !connection && (
          <NotConnectedView onConnect={handleConnect} actioning={actioning} />
        )}
        {!loading && connection && (
          <ConnectedView
            connection={connection}
            onReconnect={handleConnect}
            onDisconnect={handleDisconnect}
            actioning={actioning}
          />
        )}
      </div>
    </CollapsibleCard>
  );
}

// ── Subviews ───────────────────────────────────────────────────────────

function NotConnectedView({ onConnect, actioning }) {
  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16,
        }}
      >
        <Building2 size={32} color="#94A3B8" />
        <div>
          <h4
            style={{
              margin: 0, fontSize: 14, fontWeight: 600, color: '#1F2937',
            }}
          >
            No QuickBooks company connected
          </h4>
          <p
            style={{
              margin: '4px 0 0', fontSize: 12, color: '#7A8BA0', lineHeight: 1.5,
            }}
          >
            Connect QuickBooks Online to unlock profitability analytics that
            join QB revenue with caregiver cost per shift. Read-only — no
            invoices or transactions are written back to QB.
          </p>
        </div>
      </div>
      <button
        type="button"
        className={btn.primaryBtn}
        onClick={onConnect}
        disabled={actioning !== null}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <Plug size={14} />
        {actioning === 'connecting' ? 'Redirecting to Intuit…' : 'Connect QuickBooks'}
      </button>
    </div>
  );
}

function ConnectedView({ connection, onReconnect, onDisconnect, actioning }) {
  const isHealthy = connection.status === 'active';
  const envLabel = ENV_LABEL[connection.environment] ?? connection.environment;
  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16,
        }}
      >
        {isHealthy ? (
          <CheckCircle2 size={32} color="#22C55E" />
        ) : (
          <AlertCircle size={32} color="#F59E0B" />
        )}
        <div>
          <h4
            style={{
              margin: 0, fontSize: 14, fontWeight: 600, color: '#1F2937',
            }}
          >
            {isHealthy
              ? 'Connected to QuickBooks Online'
              : `Connection ${connection.status.replace(/_/g, ' ')}`}
          </h4>
          {!isHealthy && connection.status_message && (
            <p
              style={{
                margin: '4px 0 0', fontSize: 12, color: '#B91C1C', lineHeight: 1.5,
              }}
            >
              {connection.status_message}
            </p>
          )}
          <p
            style={{
              margin: '4px 0 0', fontSize: 12, color: '#7A8BA0', lineHeight: 1.5,
            }}
          >
            <EnvironmentTag>{envLabel}</EnvironmentTag>{' '}
            Realm <code style={{ fontSize: 11 }}>{connection.realm_id}</code> · connected
            by {connection.connected_by} on {formatDate(connection.connected_at)}
          </p>
        </div>
      </div>
      <Detail label="Last token refresh" value={formatDate(connection.last_refreshed_at)} />
      <Detail label="Refresh token expires" value={formatDate(connection.refresh_token_expires_at)} />
      <Detail label="Last data sync" value={formatDate(connection.last_sync_at) || 'Not yet synced'} />
      <Detail label="Scopes granted" value={(connection.scopes ?? []).join(', ')} />
      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={btn.secondaryBtn}
          onClick={onReconnect}
          disabled={actioning !== null}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={14} />
          {actioning === 'connecting' ? 'Redirecting…' : 'Reconnect'}
        </button>
        <button
          type="button"
          className={btn.dangerBtn}
          onClick={onDisconnect}
          disabled={actioning !== null}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Unplug size={14} />
          {actioning === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
    </div>
  );
}

function EnvironmentTag({ children }) {
  return (
    <span
      style={{
        display: 'inline-block', padding: '1px 8px', fontSize: 10, fontWeight: 600,
        color: '#475569', background: '#F0F2F5', borderRadius: 4,
        textTransform: 'uppercase', letterSpacing: '0.4px',
      }}
    >
      {children}
    </span>
  );
}

function Detail({ label, value }) {
  return (
    <div
      style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '6px 0', borderTop: '1px solid #F0F2F5', fontSize: 12,
      }}
    >
      <span style={{ color: '#7A8BA0' }}>{label}</span>
      <span style={{ color: '#1F2937', fontWeight: 500 }}>{value || '—'}</span>
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch {
    return iso;
  }
}
