import React, { useEffect, useState } from 'react';
import { Search, Download, History, BookOpen, RefreshCw, ArrowUpRight } from 'lucide-react';
import type {
  DiffLine,
  StatuteCodeInfo,
  StatuteSectionDetail,
  StatuteSectionSummary,
} from '../types.ts';

interface StatutesViewProps {
  onOpenBill: (billId: string) => void;
  refreshSignal: number;
  onDataMutated: () => void;
}

export const StatutesView: React.FC<StatutesViewProps> = ({
  onOpenBill,
  refreshSignal,
  onDataMutated,
}) => {
  const [codes, setCodes] = useState<StatuteCodeInfo[]>([]);
  const [syncCode, setSyncCode] = useState('PE');
  const [syncingCode, setSyncingCode] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [syncErr, setSyncErr] = useState('');

  const [query, setQuery] = useState('');
  const [codeFilter, setCodeFilter] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [sections, setSections] = useState<StatuteSectionSummary[]>([]);
  const [selectedId, setSelectedId] = useState('ED-48.051');
  const [detail, setDetail] = useState<StatuteSectionDetail | null>(null);

  // Historical StatutesByDate snapshot fetcher + diff
  const [snapshotDate, setSnapshotDate] = useState('2005-01-01');
  const [fetchingSnap, setFetchingSnap] = useState(false);
  const [snapError, setSnapError] = useState('');
  const [fromSnapId, setFromSnapId] = useState('');
  const [toSnapId, setToSnapId] = useState('current');
  const [diffResult, setDiffResult] = useState<{
    fromLabel: string;
    toLabel: string;
    addedCount: number;
    removedCount: number;
    lines: DiffLine[];
  } | null>(null);

  const loadCodes = () => {
    fetch('/api/statutes/codes')
      .then((r) => r.json())
      .then((d) => setCodes(d.codes ?? []))
      .catch(() => {});
  };

  useEffect(() => {
    loadCodes();
  }, [refreshSignal]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (codeFilter) params.set('code', codeFilter);
      if (sessionFilter.trim()) params.set('session', sessionFilter.trim());

      fetch(`/api/statutes?${params.toString()}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((d) => {
          const list: StatuteSectionSummary[] = d.sections ?? [];
          setSections(list);
          if (list.length > 0 && (!selectedId || !list.some((s) => s.id === selectedId))) {
            setSelectedId(list[0].id);
          }
        })
        .catch(() => {});
    }, 150);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, codeFilter, sessionFilter, refreshSignal]);

  const loadDetail = (id: string) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setSnapError('');
    setDiffResult(null);
    fetch(`/api/statutes/${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((data: StatuteSectionDetail) => {
        setDetail(data);
        if (data.snapshots?.length > 0) {
          setFromSnapId(data.snapshots[0].id);
          setToSnapId('current');
        } else {
          setFromSnapId('');
          setToSnapId('current');
        }
      })
      .catch(() => setDetail(null));
  };

  useEffect(() => {
    loadDetail(selectedId);
  }, [selectedId, refreshSignal]);

  useEffect(() => {
    if (!detail || !fromSnapId || !toSnapId || fromSnapId === toSnapId) {
      setDiffResult(null);
      return;
    }
    fetch(
      `/api/statutes/${encodeURIComponent(detail.id)}/diff?from=${encodeURIComponent(fromSnapId)}&to=${encodeURIComponent(toSnapId)}`
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDiffResult(d))
      .catch(() => setDiffResult(null));
  }, [detail?.id, fromSnapId, toSnapId]);

  const handleSyncFullCode = async () => {
    setSyncingCode(true);
    setSyncMsg('');
    setSyncErr('');
    try {
      const res = await fetch('/api/statutes/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: syncCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Statute sync failed');
      setSyncMsg(
        `Indexed ${data.sectionsIndexed.toLocaleString()} sections across ${data.chaptersSynced} chapters of the ${data.codeName} from TLO FTP.`
      );
      setCodeFilter(data.code);
      loadCodes();
      onDataMutated();
    } catch (err) {
      setSyncErr(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncingCode(false);
    }
  };

  const handleFetchSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || !snapshotDate) return;
    setFetchingSnap(true);
    setSnapError('');
    try {
      const res = await fetch(`/api/statutes/${encodeURIComponent(detail.id)}/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not fetch historical snapshot');
      loadDetail(detail.id);
      if (data.snapshot?.id) {
        setFromSnapId(data.snapshot.id);
        setToSnapId('current');
      }
    } catch (err) {
      setSnapError(err instanceof Error ? err.message : 'Snapshot lookup failed');
    } finally {
      setFetchingSnap(false);
    }
  };

  const totalIndexedSections = codes.reduce((acc, c) => acc + c.sectionCount, 0);

  return (
    <div className="space-y-6">
      {/* Code Archive Sync Masthead */}
      <div className="border border-[#DFD9CE] bg-[#FFFFFF] p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <h1 className="font-display text-2xl font-bold text-[#181715]">
              Texas Legal Code & Historical Statute Archive
            </h1>
            <p className="text-sm text-[#57534E] mt-1">
              Full-text <span className="font-mono">FTS5</span> index of Texas statutory codes & Constitution synced from{' '}
              <span className="font-mono">ftp://ftp.legis.state.tx.us/pub/statutes/</span> (39.7 MB total across all 31 codes) paired with point-in-time historical snapshots back to <span className="font-mono">2004-01-01</span>.
            </p>
          </div>
          <div className="text-right font-mono text-xs text-[#57534E] tabular-nums">
            <div className="text-lg font-semibold text-[#181715]">
              {totalIndexedSections.toLocaleString()}
            </div>
            <div>Sections Indexed Locally</div>
          </div>
        </div>

        <div className="pt-4 border-t border-[#DFD9CE] flex flex-wrap items-center gap-3">
          <label className="text-xs font-medium text-[#57534E]">
            Pull Full Code from TLO FTP:
          </label>
          <select
            value={syncCode}
            onChange={(e) => setSyncCode(e.target.value)}
            disabled={syncingCode}
            className="px-3 py-2 text-xs bg-[#FBF9F5] border border-[#C5BDB0] rounded min-w-[260px]"
          >
            {codes.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name} ({c.sectionCount} indexed)
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleSyncFullCode}
            disabled={syncingCode}
            className="px-4 py-2 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] disabled:opacity-60 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            {syncingCode ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Extracting .htm.zip...
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                Sync Full Code
              </>
            )}
          </button>
          {syncMsg && <span className="text-xs text-[#14532D] font-medium">{syncMsg}</span>}
          {syncErr && <span className="text-xs text-[#991B1B]">{syncErr}</span>}
        </div>
      </div>

      {/* FTS5 Search & Filter Bar */}
      <div className="border border-[#DFD9CE] bg-[#F4F0E8] p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-4 h-4 text-[#57534E] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search Texas statutes, section numbers, & Acts lineage (e.g. "basic allotment" OR homestead OR 12.01)...'
            className="w-full pl-9 pr-4 py-2 text-sm bg-[#FFFFFF] border border-[#C5BDB0] rounded"
          />
        </div>

        <select
          value={codeFilter}
          onChange={(e) => setCodeFilter(e.target.value)}
          className="px-3 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
        >
          <option value="">All Texas Codes</option>
          {codes.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value)}
          placeholder="Amended Leg. (e.g. 88th, 73rd)"
          className="px-3 py-2 text-xs font-mono bg-[#FFFFFF] border border-[#C5BDB0] rounded w-48"
        />
      </div>

      {/* Two-Column Split: Section Index + Section History Dossier */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5 border border-[#DFD9CE] bg-[#FFFFFF]">
          <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] text-xs font-mono text-[#57534E] tabular-nums">
            {sections.length} matching statutory sections
          </div>
          <div className="divide-y divide-[#DFD9CE] max-h-[760px] overflow-y-auto">
            {sections.map((s) => {
              const active = s.id === selectedId;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  className={`w-full p-4 text-left block cursor-pointer transition-colors ${
                    active ? 'bg-[#F4F0E8]' : 'hover:bg-[#FBF9F5]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-mono text-[#57534E]">
                    <span>
                      <span className="font-semibold text-[#9A3412]">{s.codeName}</span> · Sec.{' '}
                      {s.sectionNumber}
                    </span>
                    {s.lastAmendedSession && (
                      <span className="text-[#1E3A5F] tabular-nums">
                        Last: {s.lastAmendedSession} Leg.
                      </span>
                    )}
                  </div>
                  <div className="font-display text-sm font-bold text-[#181715] mt-1">
                    {s.sectionTitle}
                  </div>
                  {s.snippet ? (
                    <p
                      className="text-xs text-[#57534E] mt-1 line-clamp-2"
                      dangerouslySetInnerHTML={{ __html: s.snippet }}
                    />
                  ) : (
                    <p className="text-xs text-[#78716C] mt-1 line-clamp-1 font-mono">
                      {s.chapterTitle}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right 7 cols: Statute Detail, Acts Lineage & Historical Point-in-Time Redline */}
        <div className="lg:col-span-7 border border-[#DFD9CE] bg-[#FFFFFF]">
          {!detail ? (
            <div className="p-8 text-sm text-[#57534E]">
              Select a statutory section to read its full text, session amendment history, and point-in-time diffs.
            </div>
          ) : (
            <div className="divide-y divide-[#DFD9CE]">
              <div className="p-6 bg-[#FBF9F5]">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-[#57534E]">
                  <span>
                    <span className="font-semibold text-[#9A3412]">{detail.codeName}</span> ·{' '}
                    {detail.chapterTitle}
                  </span>
                  <span>Sec. {detail.sectionNumber}</span>
                </div>
                <h2 className="font-display text-2xl font-bold text-[#181715] mt-1.5">
                  {detail.sectionTitle}
                </h2>
                {detail.sessionsAmended.length > 0 && (
                  <div className="mt-2.5 text-xs font-mono text-[#57534E]">
                    Legislatures touching this section:{' '}
                    <span className="text-[#181715] font-medium">
                      {detail.sessionsAmended.join(' → ')}
                    </span>
                  </div>
                )}
              </div>

              {/* Current Codified Text */}
              <div className="p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] inline-flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5" />
                    Codified Statutory Text
                  </h3>
                  <span className="text-[11px] font-mono text-[#78716C]">{detail.source}</span>
                </div>
                <pre className="p-4 bg-[#FBF9F5] border border-[#DFD9CE] text-xs font-mono text-[#181715] whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
                  {detail.fullText}
                </pre>
                {detail.actsHistory && (
                  <div className="p-3 bg-[#F4F0E8]/70 border border-[#DFD9CE] text-xs text-[#57534E]">
                    <span className="font-semibold text-[#181715]">Session Law Lineage: </span>
                    {detail.actsHistory}
                  </div>
                )}
              </div>

              {/* Point-in-Time Historical Snapshot Fetcher (StatutesByDate since 2004) */}
              <div className="p-6 space-y-4">
                <div>
                  <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] inline-flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-[#9A3412]" />
                    Point-in-Time Statute History (Since Jan 1, 2004)
                  </h3>
                  <p className="text-xs text-[#57534E] mt-1">
                    Pull the exact wording of Sec. {detail.sectionNumber} as it stood on any date since 2004 from the Texas Legislative Council archive, then redline it against today’s text.
                  </p>
                </div>

                <form onSubmit={handleFetchSnapshot} className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    min="2004-01-01"
                    value={snapshotDate}
                    onChange={(e) => setSnapshotDate(e.target.value)}
                    className="px-3 py-1.5 text-xs font-mono bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                    required
                  />
                  <button
                    type="submit"
                    disabled={fetchingSnap}
                    className="px-3.5 py-1.5 text-xs font-medium bg-[#181715] text-[#FBF9F5] rounded hover:bg-[#292524] disabled:opacity-50 cursor-pointer"
                  >
                    {fetchingSnap ? 'Fetching Historical Text...' : 'Pull Snapshot for Date'}
                  </button>
                  {['2005-01-01', '2015-09-01', '2021-09-01'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setSnapshotDate(preset)}
                      className="px-2 py-1 text-[11px] font-mono border border-[#DFD9CE] hover:border-[#9A3412] rounded cursor-pointer"
                    >
                      {preset}
                    </button>
                  ))}
                </form>

                {snapError && <p className="text-xs text-[#991B1B]">{snapError}</p>}

                {detail.snapshots.length > 0 && (
                  <div className="space-y-3 pt-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-[#57534E]">Redline Compare:</span>
                      <select
                        value={fromSnapId}
                        onChange={(e) => setFromSnapId(e.target.value)}
                        className="px-2.5 py-1.5 text-xs font-mono bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                      >
                        {detail.snapshots.map((sn) => (
                          <option key={sn.id} value={sn.id}>
                            {sn.snapshotDate} Snapshot
                          </option>
                        ))}
                        <option value="current">Current Codified Text</option>
                      </select>
                      <span className="text-[#78716C]">→</span>
                      <select
                        value={toSnapId}
                        onChange={(e) => setToSnapId(e.target.value)}
                        className="px-2.5 py-1.5 text-xs font-mono bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                      >
                        {detail.snapshots.map((sn) => (
                          <option key={sn.id} value={sn.id}>
                            {sn.snapshotDate} Snapshot
                          </option>
                        ))}
                        <option value="current">Current Codified Text</option>
                      </select>
                    </div>

                    {diffResult && (
                      <div className="border border-[#DFD9CE] bg-[#FBF9F5]">
                        <div className="px-3 py-2 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between text-xs font-mono tabular-nums">
                          <span>
                            {diffResult.fromLabel} → {diffResult.toLabel}
                          </span>
                          <span>
                            <span className="text-[#14532D] font-semibold">
                              +{diffResult.addedCount}
                            </span>{' '}
                            /{' '}
                            <span className="text-[#991B1B] font-semibold">
                              -{diffResult.removedCount}
                            </span>
                          </span>
                        </div>
                        <div className="max-h-64 overflow-y-auto font-mono text-xs divide-y divide-[#F4F0E8]">
                          {diffResult.lines.map((line, idx) => (
                            <div
                              key={idx}
                              className={`px-3 py-1 whitespace-pre-wrap ${
                                line.type === 'added'
                                  ? 'bg-[#DCFCE7]/60 text-[#14532D]'
                                  : line.type === 'removed'
                                    ? 'bg-[#FEE2E2]/60 text-[#991B1B] line-through'
                                    : 'text-[#181715]'
                              }`}
                            >
                              <span className="inline-block w-5 select-none opacity-60">
                                {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                              </span>
                              {line.text}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Related Indexed Bills */}
              <div className="p-6 space-y-2.5">
                <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E]">
                  Indexed Texas Bills Touching {detail.codeName} ({detail.relatedBills.length})
                </h3>
                {detail.relatedBills.length === 0 ? (
                  <p className="text-xs text-[#78716C]">
                    No indexed bills currently cite {detail.codeName} Sec. {detail.sectionNumber}.
                  </p>
                ) : (
                  <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                    {detail.relatedBills.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => onOpenBill(b.id)}
                        className="w-full p-3 text-left hover:bg-[#FBF9F5] flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-mono">
                            <span className="font-semibold text-[#9A3412]">{b.session}</span>{' '}
                            <span className="font-semibold text-[#181715]">{b.billNumber}</span>
                            <span className="text-[#57534E]"> · {b.stage}</span>
                          </div>
                          <p className="text-xs text-[#181715] truncate mt-0.5">{b.title}</p>
                        </div>
                        <ArrowUpRight className="w-4 h-4 text-[#1E3A5F] shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
