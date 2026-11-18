import React, { useEffect, useState } from 'react';
import { X, Download, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import type { TloSessionInfo, TloSyncResult } from '../server/tloFtp.ts';

interface TloSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSyncComplete: () => void;
}

export const TloSyncModal: React.FC<TloSyncModalProps> = ({
  isOpen,
  onClose,
  onSyncComplete,
}) => {
  const [sessions, setSessions] = useState<TloSessionInfo[]>([]);
  const [hostLabel, setHostLabel] = useState('ftp://ftp.legis.state.tx.us');
  const [warning, setWarning] = useState('');
  const [loadingSessions, setLoadingSessions] = useState(false);

  const [selectedSession, setSelectedSession] = useState('90R');
  const [billTypes, setBillTypes] = useState<string[]>(['house_bills', 'senate_bills']);
  const [startNumber, setStartNumber] = useState(1);
  const [limit, setLimit] = useState(14);
  const [includeBillText, setIncludeBillText] = useState(true);

  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<TloSyncResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setLoadingSessions(true);
    setError('');
    fetch('/api/tlo/sessions')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.sessions)) {
          setSessions(data.sessions);
          if (data.sessions.length > 0 && !data.sessions.some((s: TloSessionInfo) => s.code === selectedSession)) {
            setSelectedSession(data.sessions[0].code);
          }
        }
        if (data.host) setHostLabel(data.host);
        if (data.warning) setWarning(data.warning);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not list TLO sessions'))
      .finally(() => setLoadingSessions(false));
  }, [isOpen]);

  if (!isOpen) return null;

  const toggleBillType = (bt: string) => {
    setBillTypes((prev) =>
      prev.includes(bt) ? (prev.length > 1 ? prev.filter((x) => x !== bt) : prev) : [...prev, bt]
    );
  };

  const handleSync = async (e: React.FormEvent) => {
    e.preventDefault();
    setSyncing(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/tlo/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: selectedSession,
          billTypes,
          limit,
          startNumber,
          includeBillText,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'TLO FTP synchronization failed');
      }
      setResult(data);
      onSyncComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#181715]/50 flex items-center justify-center p-4">
      <div className="bg-[#FBF9F5] border border-[#C5BDB0] w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-[#DFD9CE] flex items-center justify-between bg-[#F4F0E8]">
          <div>
            <h2 className="font-display text-lg font-bold text-[#181715]">
              Texas Legislature Online (TLO) FTP Archive Sync
            </h2>
            <p className="text-xs font-mono text-[#57534E] mt-0.5">{hostLabel}/bills/</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-[#57534E] hover:text-[#181715] cursor-pointer"
            aria-label="Close TLO FTP sync modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSync} className="p-6 space-y-5">
          {warning && (
            <div className="p-3 border border-[#DFD9CE] bg-[#F4F0E8] text-xs text-[#92400E] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{warning}</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1.5">
                Legislative Session (from TLO /bills/)
              </label>
              <select
                value={selectedSession}
                onChange={(e) => setSelectedSession(e.target.value)}
                disabled={loadingSessions || syncing}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm text-[#181715] rounded"
              >
                {sessions.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.label} ({s.years})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[#57534E] mb-1.5">
                  Start Bill #
                </label>
                <input
                  type="number"
                  min={1}
                  max={9999}
                  value={startNumber}
                  onChange={(e) => setStartNumber(Math.max(1, Number(e.target.value)))}
                  className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm font-mono tabular-nums rounded"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#57534E] mb-1.5">
                  Batch Limit
                </label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={limit}
                  onChange={(e) => setLimit(Math.min(60, Math.max(1, Number(e.target.value))))}
                  className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm font-mono tabular-nums rounded"
                />
              </div>
            </div>
          </div>

          <div>
            <span className="block text-xs font-medium text-[#57534E] mb-2">
              Chambers & Instrument Directories
            </span>
            <div className="flex flex-wrap gap-2">
              {[
                { id: 'house_bills', label: 'House Bills (HB)' },
                { id: 'senate_bills', label: 'Senate Bills (SB)' },
                { id: 'house_joint_resolutions', label: 'House Joint Res. (HJR)' },
                { id: 'senate_joint_resolutions', label: 'Senate Joint Res. (SJR)' },
              ].map((opt) => {
                const active = billTypes.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => toggleBillType(opt.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded border cursor-pointer transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-[#181715] text-[#FBF9F5] border-[#181715]'
                        : 'bg-[#FFFFFF] text-[#57534E] border-[#C5BDB0] hover:border-[#181715]'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-[#181715] cursor-pointer">
            <input
              type="checkbox"
              checked={includeBillText}
              onChange={(e) => setIncludeBillText(e.target.checked)}
              className="w-4 h-4 accent-[#9A3412]"
            />
            <span>
              Download full HTML bill text versions (Introduced, Committee Report, Engrossed, Enrolled) into FTS5 & Redline Archive
            </span>
          </label>

          {error && (
            <div className="p-3 border border-[#991B1B]/40 bg-[#FEE2E2]/50 text-xs text-[#991B1B]">
              {error}
            </div>
          )}

          {result && (
            <div className="p-4 border border-[#14532D]/30 bg-[#DCFCE7]/35 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-[#14532D]">
                <CheckCircle2 className="w-4 h-4" />
                <span>
                  Synced {result.ingestedCount} bills from {result.session} ({result.amendmentsIngested} text versions, {result.witnessesIngested ?? 0} witnesses, {result.linksCreated} companion links, {result.alertsTriggered} new alerts triggered)
                </span>
              </div>
              {result.bills.length > 0 && (
                <ul className="text-xs font-mono text-[#181715] max-h-36 overflow-y-auto space-y-1 pt-1 border-t border-[#14532D]/20">
                  {result.bills.map((b) => (
                    <li key={b.id} className="truncate">
                      {b.billNumber} · {b.stage} · {b.title}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="pt-2 border-t border-[#DFD9CE] flex items-center justify-between gap-3">
            <span className="text-xs text-[#78716C]">
              Direct anonymous FTP ingestion into SQLite FTS5.
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-[#57534E] border border-[#C5BDB0] rounded hover:text-[#181715] cursor-pointer"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={syncing || loadingSessions}
                className="px-4 py-2 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] disabled:opacity-60 inline-flex items-center gap-2 cursor-pointer"
              >
                {syncing ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Downloading from TLO FTP...
                  </>
                ) : (
                  <>
                    <Download className="w-3.5 h-3.5" />
                    Fetch & Index Session
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
