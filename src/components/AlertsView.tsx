import React, { useEffect, useState } from 'react';
import { Bell, RefreshCw, Trash2, Check, Plus } from 'lucide-react';
import type { AlertEvent, AlertRule } from '../types.ts';

interface AlertsViewProps {
  onNewRule: () => void;
  onOpenBill: (billId: string) => void;
  refreshSignal: number;
  onAlertsUpdated: () => void;
}

export const AlertsView: React.FC<AlertsViewProps> = ({
  onNewRule,
  onOpenBill,
  refreshSignal,
  onAlertsUpdated,
}) => {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanBanner, setScanBanner] = useState('');

  const loadAlerts = () => {
    fetch('/api/alerts')
      .then((r) => r.json())
      .then((data) => {
        setRules(data.rules ?? []);
        setEvents(data.events ?? []);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadAlerts();
  }, [refreshSignal]);

  const handleRunScan = async () => {
    setScanning(true);
    setScanBanner('');
    try {
      const res = await fetch('/api/alerts/scan', { method: 'POST' });
      const data = await res.json();
      setScanBanner(
        data.triggered > 0
          ? `FTS5 matcher triggered ${data.triggered} new alert dispatch(es).`
          : 'All active FTS5 rules are up to date with current legislative records.'
      );
      loadAlerts();
      onAlertsUpdated();
    } finally {
      setScanning(false);
    }
  };

  const handleToggleRule = async (rule: AlertRule) => {
    await fetch(`/api/alerts/rules/${encodeURIComponent(rule.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !rule.isActive }),
    });
    loadAlerts();
    onAlertsUpdated();
  };

  const handleDeleteRule = async (ruleId: string) => {
    await fetch(`/api/alerts/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
    loadAlerts();
    onAlertsUpdated();
  };

  const handleMarkRead = async (eventId: string, isRead: boolean) => {
    await fetch(`/api/alerts/events/${encodeURIComponent(eventId)}/read`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead }),
    });
    loadAlerts();
    onAlertsUpdated();
  };

  return (
    <div className="space-y-6">
      <div className="border border-[#DFD9CE] bg-[#F4F0E8] p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-bold text-[#181715]">
            Automated Keyword Alert Engine
          </h2>
          <p className="text-xs text-[#57534E]">
            Deterministic SQLite FTS5 watchlists evaluate newly filed bills, TLO FTP sync batches, and floor amendments automatically.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleRunScan}
            disabled={scanning}
            className="px-3.5 py-2 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] hover:border-[#181715] rounded inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            Run FTS5 Rule Scan
          </button>
          <button
            type="button"
            onClick={onNewRule}
            className="px-3.5 py-2 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] hover:bg-[#7C2D12] rounded inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            New Alert Rule
          </button>
        </div>
      </div>

      {scanBanner && (
        <div className="px-4 py-2.5 border border-[#DFD9CE] bg-[#FFFFFF] text-xs text-[#14532D] font-medium">
          {scanBanner}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Watchlist Rules */}
        <div className="lg:col-span-5 border border-[#DFD9CE] bg-[#FFFFFF]">
          <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] text-xs font-mono text-[#57534E]">
            Active Keyword Watchlist Rules ({rules.length})
          </div>
          <div className="divide-y divide-[#DFD9CE]">
            {rules.map((r) => (
              <div key={r.id} className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-[#181715]">{r.name}</h3>
                    <div className="text-xs font-mono text-[#9A3412] mt-0.5">{r.query}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleRule(r)}
                      className={`px-2 py-1 text-[11px] font-medium border rounded cursor-pointer ${
                        r.isActive
                          ? 'border-[#14532D]/40 bg-[#DCFCE7]/50 text-[#14532D]'
                          : 'border-[#C5BDB0] bg-[#F4F0E8] text-[#57534E]'
                      }`}
                    >
                      {r.isActive ? 'Active' : 'Paused'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteRule(r.id)}
                      className="p-1 text-[#78716C] hover:text-[#991B1B] cursor-pointer"
                      aria-label="Delete rule"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="text-[11px] font-mono text-[#78716C] tabular-nums">
                  {r.matchCount} matched records · Scope: {r.session || 'All Sessions'} ·{' '}
                  {r.chamber || 'House & Senate'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Triggered Dispatches */}
        <div className="lg:col-span-7 border border-[#DFD9CE] bg-[#FFFFFF]">
          <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between text-xs font-mono text-[#57534E]">
            <span className="inline-flex items-center gap-1.5">
              <Bell className="w-3.5 h-3.5 text-[#9A3412]" />
              Alert Dispatches ({events.filter((e) => !e.isRead).length} unread)
            </span>
            <span>Sorted by unread priority</span>
          </div>

          <div className="divide-y divide-[#DFD9CE] max-h-[720px] overflow-y-auto">
            {events.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#57534E]">
                No legislative matches triggered yet. Add a rule or sync new records from TLO FTP.
              </div>
            ) : (
              events.map((ev) => (
                <div
                  key={ev.id}
                  className={`p-4 space-y-1.5 ${ev.isRead ? 'bg-[#FFFFFF]' : 'bg-[#FBF9F5]'}`}
                >
                  <div className="flex items-center justify-between gap-3 text-xs font-mono">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={ev.isRead ? 'text-[#78716C]' : 'font-semibold text-[#9A3412]'}>
                        {ev.isRead ? 'Read' : 'Unread Match'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="text-[#57534E] truncate">{ev.ruleName}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleMarkRead(ev.id, !ev.isRead)}
                      className="text-xs font-sans text-[#57534E] hover:text-[#181715] inline-flex items-center gap-1 cursor-pointer shrink-0"
                    >
                      <Check className="w-3 h-3" />
                      {ev.isRead ? 'Mark Unread' : 'Acknowledge'}
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenBill(ev.billId)}
                      className="font-display text-sm font-bold text-[#1E3A5F] hover:text-[#9A3412] hover:underline text-left cursor-pointer"
                    >
                      {ev.session} {ev.billNumber} — {ev.billTitle}
                    </button>
                  </div>

                  <p
                    className="text-xs text-[#57534E] leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: ev.snippet }}
                  />

                  <div className="text-[11px] font-mono text-[#78716C] tabular-nums">
                    Source: {ev.matchType === 'amendment' ? 'Archived Amendment Text' : 'Bill Statutory Index'} ·{' '}
                    {new Date(ev.triggeredAt).toLocaleDateString()}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
