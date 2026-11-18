import React, { useEffect, useRef, useState } from 'react';
import { X, Download, RefreshCw, CheckCircle2, AlertCircle, Square } from 'lucide-react';
import type { TloSessionInfo, TloSyncJob } from '../server/tloFtp.ts';

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
  const [mode, setMode] = useState<'full' | 'batch'>('full');
  const [billTypes, setBillTypes] = useState<string[]>(['house_bills', 'senate_bills']);
  const [startNumber, setStartNumber] = useState(1);
  const [limit, setLimit] = useState(100);
  const [concurrency, setConcurrency] = useState(4);
  const [includeBillText, setIncludeBillText] = useState(true);
  const [includeWitnesses, setIncludeWitnesses] = useState(true);
  const [skipUnchanged, setSkipUnchanged] = useState(true);

  const [activeJob, setActiveJob] = useState<TloSyncJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');

  const lastRefreshIngestedRef = useRef(0);
  const completedNotifiedJobRef = useRef<string | null>(null);

  const isJobRunning =
    activeJob !== null && (activeJob.status === 'discovering' || activeJob.status === 'syncing');

  // Load TLO sessions & attach to any active/recent background job when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setLoadingSessions(true);
    setError('');

    fetch('/api/tlo/sessions')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data.sessions)) {
          setSessions(data.sessions);
          if (
            data.sessions.length > 0 &&
            !data.sessions.some((s: TloSessionInfo) => s.code === selectedSession)
          ) {
            setSelectedSession(data.sessions[0].code);
          }
        }
        if (data.host) setHostLabel(data.host);
        if (data.warning) setWarning(data.warning);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not list TLO sessions'))
      .finally(() => setLoadingSessions(false));

    fetch('/api/tlo/sync-status')
      .then((r) => r.json())
      .then((data) => {
        if (data.job) {
          setActiveJob(data.job as TloSyncJob);
        }
      })
      .catch(() => {});
  }, [isOpen]);

  // Poll running background job status
  useEffect(() => {
    if (!isOpen || !activeJob) return;
    if (activeJob.status !== 'discovering' && activeJob.status !== 'syncing') {
      if (
        (activeJob.status === 'completed' || activeJob.status === 'cancelled') &&
        completedNotifiedJobRef.current !== activeJob.id
      ) {
        completedNotifiedJobRef.current = activeJob.id;
        onSyncComplete();
      }
      return;
    }

    const timer = window.setInterval(() => {
      fetch(`/api/tlo/sync-status/${encodeURIComponent(activeJob.id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data?.job) return;
          const job = data.job as TloSyncJob;
          setActiveJob(job);

          if (job.ingestedCount - lastRefreshIngestedRef.current >= 150) {
            lastRefreshIngestedRef.current = job.ingestedCount;
            onSyncComplete();
          }

          if (job.status === 'completed' || job.status === 'cancelled') {
            if (completedNotifiedJobRef.current !== job.id) {
              completedNotifiedJobRef.current = job.id;
              onSyncComplete();
            }
          }
        })
        .catch(() => {});
    }, 1200);

    return () => window.clearInterval(timer);
  }, [isOpen, activeJob?.id, activeJob?.status]);

  if (!isOpen) return null;

  const toggleBillType = (bt: string) => {
    setBillTypes((prev) =>
      prev.includes(bt) ? (prev.length > 1 ? prev.filter((x) => x !== bt) : prev) : [...prev, bt]
    );
  };

  const handleStartSync = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    setCancelling(false);
    lastRefreshIngestedRef.current = 0;
    completedNotifiedJobRef.current = null;

    try {
      const res = await fetch('/api/tlo/sync-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: selectedSession,
          mode,
          billTypes,
          limit: mode === 'batch' ? limit : undefined,
          startNumber: mode === 'batch' ? startNumber : 1,
          includeBillText,
          includeWitnesses,
          skipUnchanged,
          concurrency,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to launch background TLO FTP sync');
      }
      setActiveJob(data.job as TloSyncJob);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync launch failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!activeJob) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/tlo/sync-cancel/${encodeURIComponent(activeJob.id)}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok && data.job) {
        setActiveJob(data.job as TloSyncJob);
      }
    } catch {
      // keep polling status
    } finally {
      setCancelling(false);
    }
  };

  const progressPct =
    activeJob && activeJob.totalDiscovered > 0
      ? Math.min(100, Math.round((activeJob.processedCount / activeJob.totalDiscovered) * 100))
      : 0;

  return (
    <div className="fixed inset-0 z-50 bg-[#181715]/50 flex items-center justify-center p-4">
      <div className="bg-[#FBF9F5] border border-[#C5BDB0] w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-[#DFD9CE] flex items-center justify-between bg-[#F4F0E8]">
          <div>
            <h2 className="font-display text-lg font-bold text-[#181715]">
              Texas Legislature Online (TLO) FTP Archive Sync
            </h2>
            <p className="text-xs font-mono text-[#57534E] mt-0.5">
              {hostLabel}/bills/ · Background Concurrent Worker Pool
            </p>
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

        <form onSubmit={handleStartSync} className="p-6 space-y-5">
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
                disabled={loadingSessions || isJobRunning}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm text-[#181715] rounded disabled:opacity-60"
              >
                {sessions.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.label} ({s.years})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1.5">
                Sync Scope
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isJobRunning}
                  onClick={() => setMode('full')}
                  className={`px-3 py-2 text-xs font-medium rounded border cursor-pointer transition-colors disabled:opacity-60 ${
                    mode === 'full'
                      ? 'bg-[#181715] text-[#FBF9F5] border-[#181715]'
                      : 'bg-[#FFFFFF] text-[#57534E] border-[#C5BDB0] hover:border-[#181715]'
                  }`}
                >
                  Entire Session
                </button>
                <button
                  type="button"
                  disabled={isJobRunning}
                  onClick={() => setMode('batch')}
                  className={`px-3 py-2 text-xs font-medium rounded border cursor-pointer transition-colors disabled:opacity-60 ${
                    mode === 'batch'
                      ? 'bg-[#181715] text-[#FBF9F5] border-[#181715]'
                      : 'bg-[#FFFFFF] text-[#57534E] border-[#C5BDB0] hover:border-[#181715]'
                  }`}
                >
                  Custom Batch
                </button>
              </div>
            </div>
          </div>

          {mode === 'batch' && (
            <div className="grid grid-cols-2 gap-4 p-3 border border-[#DFD9CE] bg-[#F4F0E8]/50">
              <div>
                <label className="block text-xs font-medium text-[#57534E] mb-1.5">
                  Start Bill #
                </label>
                <input
                  type="number"
                  min={1}
                  max={9999}
                  disabled={isJobRunning}
                  value={startNumber}
                  onChange={(e) => setStartNumber(Math.max(1, Number(e.target.value)))}
                  className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm font-mono tabular-nums rounded disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#57534E] mb-1.5">
                  Batch Limit (up to 5,000)
                </label>
                <input
                  type="number"
                  min={1}
                  max={5000}
                  disabled={isJobRunning}
                  value={limit}
                  onChange={(e) => setLimit(Math.min(5000, Math.max(1, Number(e.target.value))))}
                  className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm font-mono tabular-nums rounded disabled:opacity-60"
                />
              </div>
            </div>
          )}

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
                    disabled={isJobRunning}
                    onClick={() => toggleBillType(opt.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded border cursor-pointer transition-colors whitespace-nowrap disabled:opacity-60 ${
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
            <div className="md:col-span-2 space-y-2.5">
              <label className="flex items-start gap-2.5 text-xs text-[#181715] cursor-pointer">
                <input
                  type="checkbox"
                  disabled={isJobRunning}
                  checked={includeBillText}
                  onChange={(e) => setIncludeBillText(e.target.checked)}
                  className="w-4 h-4 accent-[#9A3412] mt-0.5 shrink-0"
                />
                <span>
                  Download full HTML bill text versions (uncheck for fast Stage-1 metadata & history index)
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-xs text-[#181715] cursor-pointer">
                <input
                  type="checkbox"
                  disabled={isJobRunning}
                  checked={includeWitnesses}
                  onChange={(e) => setIncludeWitnesses(e.target.checked)}
                  className="w-4 h-4 accent-[#9A3412] mt-0.5 shrink-0"
                />
                <span>
                  Ingest committee witness registration lists (Self citizens vs. organizations)
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-xs text-[#181715] cursor-pointer">
                <input
                  type="checkbox"
                  disabled={isJobRunning}
                  checked={skipUnchanged}
                  onChange={(e) => setSkipUnchanged(e.target.checked)}
                  className="w-4 h-4 accent-[#9A3412] mt-0.5 shrink-0"
                />
                <span>
                  Skip unchanged bills already indexed (incremental re-sync)
                </span>
              </label>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1.5">
                FTP Worker Pool
              </label>
              <select
                value={concurrency}
                disabled={isJobRunning}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-xs text-[#181715] rounded disabled:opacity-60"
              >
                <option value={2}>2 workers (gentle)</option>
                <option value={4}>4 workers (balanced)</option>
                <option value={6}>6 workers (fast)</option>
              </select>
            </div>
          </div>

          {error && (
            <div className="p-3 border border-[#991B1B]/40 bg-[#FEE2E2]/50 text-xs text-[#991B1B]">
              {error}
            </div>
          )}

          {activeJob && (
            <div
              className={`p-4 border space-y-3 ${
                activeJob.status === 'error'
                  ? 'border-[#991B1B]/40 bg-[#FEE2E2]/30'
                  : activeJob.status === 'completed'
                    ? 'border-[#14532D]/30 bg-[#DCFCE7]/35'
                    : 'border-[#C5BDB0] bg-[#F4F0E8]/70'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-medium text-[#181715]">
                  {isJobRunning ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#9A3412] shrink-0" />
                  ) : activeJob.status === 'completed' ? (
                    <CheckCircle2 className="w-4 h-4 text-[#14532D] shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-[#92400E] shrink-0" />
                  )}
                  <span>
                    {activeJob.session} ({activeJob.mode === 'full' ? 'Full Session' : 'Batch'}) ·{' '}
                    {activeJob.phase}
                  </span>
                </div>

                {activeJob.totalDiscovered > 0 && (
                  <span className="font-mono text-xs tabular-nums text-[#57534E] shrink-0">
                    {activeJob.processedCount.toLocaleString()} /{' '}
                    {activeJob.totalDiscovered.toLocaleString()} ({progressPct}%)
                  </span>
                )}
              </div>

              {activeJob.totalDiscovered > 0 && (
                <div className="w-full h-2 bg-[#DFD9CE] overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      activeJob.status === 'completed'
                        ? 'bg-[#14532D]'
                        : activeJob.status === 'cancelled'
                          ? 'bg-[#92400E]'
                          : 'bg-[#9A3412]'
                    }`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              )}

              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-[11px] font-mono tabular-nums text-[#57534E]">
                <div>
                  <span className="block text-[10px] uppercase">Synced</span>
                  <span className="text-[#181715] font-semibold">
                    {activeJob.ingestedCount.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase">Skipped</span>
                  <span className="text-[#181715] font-semibold">
                    {activeJob.skippedCount.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase">Versions</span>
                  <span className="text-[#181715] font-semibold">
                    {activeJob.amendmentsIngested.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase">Witnesses</span>
                  <span className="text-[#181715] font-semibold">
                    {activeJob.witnessesIngested.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase">Links</span>
                  <span className="text-[#181715] font-semibold">
                    {activeJob.linksCreated.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="block text-[10px] uppercase">Alerts</span>
                  <span className="text-[#181715] font-semibold">
                    {activeJob.alertsTriggered.toLocaleString()}
                  </span>
                </div>
              </div>

              {activeJob.recentBills.length > 0 && (
                <ul className="text-xs font-mono text-[#181715] max-h-32 overflow-y-auto space-y-1 pt-2 border-t border-[#DFD9CE]">
                  {activeJob.recentBills.slice(0, 12).map((b) => (
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
              Bucket-cached FTP pool. Runs in background if you close this window.
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-[#57534E] border border-[#C5BDB0] rounded hover:text-[#181715] cursor-pointer"
              >
                {isJobRunning ? 'Run in Background' : 'Close'}
              </button>

              {isJobRunning ? (
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={handleCancel}
                  className="px-4 py-2 text-xs font-medium bg-[#181715] text-[#FBF9F5] rounded hover:bg-[#33312E] disabled:opacity-60 inline-flex items-center gap-2 cursor-pointer"
                >
                  <Square className="w-3 h-3 fill-current" />
                  {cancelling ? 'Stopping…' : 'Cancel Sync'}
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={submitting || loadingSessions}
                  className="px-4 py-2 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] disabled:opacity-60 inline-flex items-center gap-2 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  {mode === 'full'
                    ? `Sync Entire ${selectedSession} Session`
                    : `Fetch ${limit} Bills (${selectedSession})`}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
