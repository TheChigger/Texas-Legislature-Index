import React, { useEffect, useMemo, useState } from 'react';
import {
  Search,
  FileSpreadsheet,
  GitMerge,
  Clock,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  Layers,
  FileText,
} from 'lucide-react';
import type { SessionTimelineResponse, TimelineEventItem } from '../types.ts';
import { OutcomeIndicator } from './OutcomeIndicator.tsx';
import { csvDateStamp, downloadCsv } from '../utils/csv.ts';

interface TimelineViewProps {
  activeSession: string;
  onOpenBill: (billId: string) => void;
  refreshSignal: number;
}

const TRACK_LABELS: Record<TimelineEventItem['track'], { label: string; colorClass: string }> = {
  focus: { label: 'FOCUS BILL', colorClass: 'text-[#9A3412] font-semibold' },
  cohort: { label: 'COHORT', colorClass: 'text-[#1E3A5F] font-semibold' },
  session: { label: 'SESSION', colorClass: 'text-[#78716C]' },
};

const KIND_LABELS: Record<TimelineEventItem['kind'], { label: string; colorClass: string }> = {
  filing: { label: 'Filed', colorClass: 'text-[#57534E]' },
  hearing: { label: 'Hearing', colorClass: 'text-[#1E3A5F]' },
  substitute: { label: 'Substitute / Diff', colorClass: 'text-[#9A3412] font-semibold' },
  action: { label: 'Action', colorClass: 'text-[#57534E]' },
  stalled: { label: 'Stalled / Rejected', colorClass: 'text-[#991B1B] font-semibold' },
  enacted: { label: 'Enacted / Passed', colorClass: 'text-[#14532D] font-semibold' },
};

export const TimelineView: React.FC<TimelineViewProps> = ({
  activeSession,
  onOpenBill,
  refreshSignal,
}) => {
  const [query, setQuery] = useState('');
  const [committee, setCommittee] = useState('');
  const [focusBillId, setFocusBillId] = useState('');
  const [trackFilter, setTrackFilter] = useState<'all' | 'focus_cohort' | 'substitutes_stalls'>('all');
  const [data, setData] = useState<SessionTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedEventIds, setExpandedEventIds] = useState<Record<string, boolean>>({});
  const [activeEventIdx, setActiveEventIdx] = useState<number>(0);
  const [concurrentWindowDate, setConcurrentWindowDate] = useState<string>('');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    // Default to 89R if user has All Sessions selected only if needed, otherwise pass activeSession directly
    if (activeSession) params.set('session', activeSession);
    if (query.trim()) params.set('q', query.trim());
    if (committee) params.set('committee', committee);
    if (focusBillId) params.set('focusBillId', focusBillId);

    fetch(`/api/timeline?${params.toString()}`)
      .then((r) => r.json())
      .then((res: SessionTimelineResponse) => {
        setData(res);
        if (!focusBillId && res.focusBillId) {
          setFocusBillId(res.focusBillId);
        }
        setActiveEventIdx(0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [activeSession, query, committee, focusBillId, refreshSignal]);

  const visibleEvents = useMemo(() => {
    const all = data?.events ?? [];
    return all.filter((ev) => {
      if (trackFilter === 'focus_cohort' && ev.track === 'session') return false;
      if (
        trackFilter === 'substitutes_stalls' &&
        ev.kind !== 'substitute' &&
        ev.kind !== 'stalled' &&
        ev.kind !== 'enacted'
      ) {
        return false;
      }
      if (concurrentWindowDate) {
        const targetMs = Date.parse(`${concurrentWindowDate}T12:00:00Z`);
        const evMs = Date.parse(`${ev.date}T12:00:00Z`);
        if (Math.abs(targetMs - evMs) > 3 * 86400 * 1000) return false;
      }
      return true;
    });
  }, [data, trackFilter, concurrentWindowDate]);

  const handleExportCsv = () => {
    if (!visibleEvents.length) return;
    downloadCsv(
      `texas-session-timeline-${data?.session || 'all'}-${csvDateStamp()}.csv`,
      [
        'Date',
        'Session',
        'Bill Number',
        'Track',
        'Event Kind',
        'Stage',
        'Committee',
        'Title',
        'Detail',
        'Witnesses',
        'Citizen Self',
        'Diff Added Lines',
        'Diff Removed Lines',
        'Concurrent Bills (+/-3d)',
        'Analysis / Fiscal Note',
      ],
      visibleEvents.map((ev) => [
        ev.date,
        ev.session,
        ev.billNumber,
        ev.track,
        ev.kind,
        ev.stage,
        ev.committee,
        ev.title,
        ev.detail,
        ev.witnessCount ?? '',
        ev.citizenSelfCount ?? '',
        ev.diffMeta?.addedCount ?? '',
        ev.diffMeta?.removedCount ?? '',
        ev.concurrentEventsCount,
        ev.documentNote ? `${ev.documentNote.docType}: ${ev.documentNote.summary}` : '',
      ])
    );
  };

  useEffect(() => {
    const onExport = () => handleExportCsv();
    const onStep = (e: Event) => {
      const delta = (e as CustomEvent<{ delta?: number }>).detail?.delta ?? 1;
      if (!visibleEvents.length) return;
      setActiveEventIdx((prev) => Math.max(0, Math.min(visibleEvents.length - 1, prev + delta)));
    };
    window.addEventListener('capitol:export-csv', onExport);
    window.addEventListener('capitol:step-item', onStep);
    return () => {
      window.removeEventListener('capitol:export-csv', onExport);
      window.removeEventListener('capitol:step-item', onStep);
    };
  }, [visibleEvents, data]);

  const toggleExpand = (id: string) => {
    setExpandedEventIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="space-y-6">
      {/* Control Strip */}
      <section className="border border-[#DFD9CE] bg-[#F4F0E8] p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-lg font-bold text-[#181715]">
              Session Legislative Timeline & Consolidation Tracker
            </h1>
            <p className="text-xs text-[#57534E]">
              Traces pre-filed policy cohorts, stalled-to-vehicle line absorption, committee substitutes, public hearings, and concurrent floor activity.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={visibleEvents.length === 0}
              className="px-3.5 py-2 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              title="Export synchronized timeline to CSV (Shortcut: e)"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-[#14532D]" />
              Export CSV
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="relative md:col-span-5">
            <Search className="w-4 h-4 text-[#57534E] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              data-global-search="true"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter timeline by bill #, keyword, statute, or author..."
              className="w-full pl-9 pr-10 py-2 bg-[#FFFFFF] border border-[#C5BDB0] text-xs text-[#181715] rounded focus:outline-none focus:border-[#9A3412]"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[#57534E] hover:text-[#181715] cursor-pointer"
              >
                Clear
              </button>
            ) : (
              <kbd className="hidden sm:inline-block absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] font-mono text-[#78716C] bg-[#FBF9F5] border border-[#DFD9CE] rounded pointer-events-none">
                /
              </kbd>
            )}
          </div>

          <div className="md:col-span-4">
            <select
              value={focusBillId}
              onChange={(e) => setFocusBillId(e.target.value)}
              aria-label="Focus bill for timeline cohort tracking"
              className="w-full px-3 py-2 bg-[#FFFFFF] border border-[#C5BDB0] text-xs text-[#181715] rounded"
            >
              <option value="">Focus Bill: Auto-Select Highest Influence</option>
              {(data?.availableBills ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.session} {b.billNumber} — {b.title.slice(0, 58)}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <select
              value={committee}
              onChange={(e) => setCommittee(e.target.value)}
              aria-label="Filter by committee"
              className="w-full px-3 py-2 bg-[#FFFFFF] border border-[#C5BDB0] text-xs text-[#181715] rounded"
            >
              <option value="">All Committees</option>
              {(data?.availableCommittees ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Summary Metrics + Track Filter Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs">
          <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-[#57534E]">
            <span>
              <strong className="text-[#181715]">{data?.totals.billsEvaluated ?? 0}</strong> Bills Evaluated
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <strong className="text-[#181715]">{data?.totals.cohortsDetected ?? 0}</strong> Policy Cohorts
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <strong className="text-[#9A3412]">{data?.totals.consolidationsDetected ?? 0}</strong> Consolidation Signals
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <strong className="text-[#181715]">{visibleEvents.length}</strong> Timeline Events
            </span>
            {concurrentWindowDate && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => setConcurrentWindowDate('')}
                  className="text-[#9A3412] underline cursor-pointer"
                >
                  Showing ±3d around {concurrentWindowDate} (Clear)
                </button>
              </>
            )}
          </div>

          <div className="inline-flex border border-[#C5BDB0] bg-[#FFFFFF] rounded overflow-hidden">
            {[
              { id: 'all', label: 'All Tracks' },
              { id: 'focus_cohort', label: 'Focus + Cohort' },
              { id: 'substitutes_stalls', label: 'Substitutes & Stalls' },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setTrackFilter(opt.id as typeof trackFilter)}
                className={`px-3 py-1 text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
                  trackFilter === opt.id
                    ? 'bg-[#181715] text-[#FBF9F5]'
                    : 'text-[#57534E] hover:text-[#181715]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Top Two-Column Intelligence Strip: Policy Cohorts + Consolidation Signals */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 6 cols: Policy Cohorts */}
        <section className="lg:col-span-6 border border-[#DFD9CE] bg-[#FFFFFF]">
          <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-[#1E3A5F]" />
              <h2 className="font-display text-sm font-bold text-[#181715]">
                Pre-Filed & Parallel Policy Cohorts
              </h2>
            </div>
            <span className="text-[11px] font-mono text-[#78716C] tabular-nums">
              {data?.cohorts.length ?? 0} clusters
            </span>
          </div>

          {!data || data.cohorts.length === 0 ? (
            <div className="p-6 text-xs text-[#78716C]">
              No multi-bill cohorts matched the current session filter.
            </div>
          ) : (
            <div className="divide-y divide-[#DFD9CE] max-h-[420px] overflow-y-auto">
              {data.cohorts.map((coh) => (
                <div key={coh.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[#181715]">{coh.topicLabel}</div>
                      <div className="text-xs text-[#57534E] mt-0.5">{coh.sharedBasis}</div>
                    </div>
                    <span className="text-[11px] font-mono text-[#78716C] tabular-nums shrink-0">
                      {coh.earliestFiled} → {coh.latestAction}
                    </span>
                  </div>

                  <div className="divide-y divide-[#F4F0E8] border-t border-[#F4F0E8] pt-1">
                    {coh.bills.map((cb) => {
                      const isFocused = cb.id === focusBillId;
                      return (
                        <div
                          key={cb.id}
                          className={`py-1.5 flex items-center justify-between gap-3 text-xs ${
                            isFocused ? 'bg-[#F4F0E8]/70 px-2 -mx-2' : ''
                          }`}
                        >
                          <div className="min-w-0 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setFocusBillId(cb.id)}
                              className="font-mono font-semibold text-[#9A3412] hover:underline whitespace-nowrap cursor-pointer"
                              title="Set as Timeline Focus Bill"
                            >
                              {cb.session} {cb.billNumber}
                            </button>
                            <span className="text-[#57534E] truncate">{cb.title}</span>
                          </div>

                          <div className="flex items-center gap-2 shrink-0 font-mono text-[11px] tabular-nums">
                            {cb.outcome !== 'Active' ? (
                              <OutcomeIndicator outcome={cb.outcome} detail={cb.outcomeDetail} />
                            ) : (
                              <span
                                className={
                                  cb.roleInCohort === 'Vehicle / Enacted'
                                    ? 'text-[#14532D]'
                                    : cb.roleInCohort === 'Stalled / Pending'
                                      ? 'text-[#991B1B]'
                                      : 'text-[#57534E]'
                                }
                              >
                                {cb.roleInCohort}
                              </span>
                            )}
                            <span aria-hidden="true">·</span>
                            <button
                              type="button"
                              onClick={() => onOpenBill(cb.id)}
                              className="text-[#1E3A5F] hover:underline inline-flex items-center gap-0.5 cursor-pointer"
                            >
                              Dossier
                              <ArrowUpRight className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Right 6 cols: Consolidation & Line-Absorption Signals */}
        <section className="lg:col-span-6 border border-[#DFD9CE] bg-[#FFFFFF]">
          <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GitMerge className="w-4 h-4 text-[#9A3412]" />
              <h2 className="font-display text-sm font-bold text-[#181715]">
                Consolidation & Line-Absorption Signals
              </h2>
            </div>
            <span className="text-[11px] font-mono text-[#78716C] tabular-nums">
              {data?.consolidations.length ?? 0} signals
            </span>
          </div>

          {!data || data.consolidations.length === 0 ? (
            <div className="p-6 text-xs text-[#78716C]">
              No stalled-bill-to-vehicle consolidations detected in the current filter. Sync full session substitutes via TLO FTP to uncover multi-version absorption.
            </div>
          ) : (
            <div className="divide-y divide-[#DFD9CE] max-h-[420px] overflow-y-auto">
              {data.consolidations.map((cons) => (
                <div key={cons.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onOpenBill(cons.stalledBillId)}
                        className="font-semibold text-[#991B1B] hover:underline cursor-pointer"
                      >
                        {cons.stalledBillNumber}
                      </button>
                      <span className="text-[#78716C]">({cons.stalledStage})</span>
                      <span className="text-[#57534E]">→</span>
                      <button
                        type="button"
                        onClick={() => onOpenBill(cons.vehicleBillId)}
                        className="font-semibold text-[#14532D] hover:underline cursor-pointer"
                      >
                        {cons.vehicleBillNumber}
                      </button>
                      <span className="text-[#78716C]">({cons.vehicleStage})</span>
                    </div>

                    <span className="text-[11px] text-[#57534E] tabular-nums">
                      +{cons.addedCount} / -{cons.removedCount} lines
                    </span>
                  </div>

                  <p className="text-xs text-[#181715]">
                    {cons.basis} · <span className="text-[#57534E]">{cons.committee}</span>
                  </p>

                  {cons.analysisNote && (
                    <p className="text-xs text-[#57534E] leading-relaxed">
                      <span className="font-mono text-[11px] text-[#1E3A5F] mr-1.5">Analysis:</span>
                      {cons.analysisNote}
                    </p>
                  )}

                  {cons.addedLinePreviews.length > 0 && (
                    <div className="bg-[#FBF9F5] border border-[#DFD9CE] p-2.5 space-y-1 font-mono text-[11px] text-[#14532D] overflow-x-auto">
                      {cons.addedLinePreviews.map((line, i) => (
                        <div key={i} className="truncate">
                          + {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Synchronized Chronological Multi-Track Timeline */}
      <section className="border border-[#DFD9CE] bg-[#FFFFFF]">
        <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#9A3412]" />
            <h2 className="font-display text-sm font-bold text-[#181715]">
              Synchronized Session Chronology (Multi-Track)
            </h2>
          </div>
          <div className="text-xs font-mono text-[#57534E] flex flex-wrap items-center gap-3">
            <span className="text-[#9A3412] font-semibold">FOCUS BILL</span>
            <span className="text-[#1E3A5F] font-semibold">COHORT</span>
            <span className="text-[#78716C]">SESSION</span>
            <span className="text-[#78716C]">· Click any ±3d window to isolate concurrent events</span>
          </div>
        </div>

        {loading && !data ? (
          <div className="p-8 text-center text-xs font-mono text-[#78716C]">
            Constructing synchronized legislative timeline…
          </div>
        ) : visibleEvents.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#57534E] space-y-2">
            <p>No legislative events matched your current track or keyword filter.</p>
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setCommittee('');
                setTrackFilter('all');
                setConcurrentWindowDate('');
              }}
              className="px-3 py-1 border border-[#C5BDB0] rounded hover:border-[#181715] cursor-pointer"
            >
              Reset Timeline Filters
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[#DFD9CE]">
            {visibleEvents.map((ev, idx) => {
              const trackStyle = TRACK_LABELS[ev.track];
              const kindStyle = KIND_LABELS[ev.kind];
              const hasDiff = Boolean(ev.diffMeta && (ev.diffMeta.addedCount > 0 || ev.diffMeta.removedCount > 0));
              const isExpanded = Boolean(expandedEventIds[ev.id]);
              const isSelected = idx === activeEventIdx;

              return (
                <div
                  key={ev.id}
                  onClick={() => setActiveEventIdx(idx)}
                  className={`px-4 py-3 transition-colors ${
                    isSelected
                      ? 'bg-[#FBF9F5]'
                      : ev.track === 'focus'
                        ? 'bg-[#F4F0E8]/45'
                        : 'hover:bg-[#FBF9F5]'
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-start gap-3">
                    {/* Date & Concurrent Window Column */}
                    <div className="md:w-40 shrink-0 font-mono text-xs tabular-nums">
                      <div className="font-semibold text-[#181715]">{ev.date}</div>
                      <div className={`text-[11px] mt-0.5 ${trackStyle.colorClass}`}>
                        {trackStyle.label}
                      </div>
                      {ev.concurrentEventsCount > 0 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConcurrentWindowDate((prev) => (prev === ev.date ? '' : ev.date));
                          }}
                          className="mt-1 text-[11px] text-[#1E3A5F] hover:underline cursor-pointer block"
                          title="Filter to bills active within ±3 days of this date"
                        >
                          ±3d: {ev.concurrentEventsCount} other bill{ev.concurrentEventsCount === 1 ? '' : 's'}
                        </button>
                      )}
                    </div>

                    {/* Main Event Content */}
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`font-mono ${kindStyle.colorClass}`}>
                            {kindStyle.label}
                          </span>
                          <span aria-hidden="true" className="text-[#C5BDB0]">·</span>
                          <span className="font-mono text-[#57534E]">{ev.committee}</span>
                          {ev.witnessCount !== undefined && (
                            <>
                              <span aria-hidden="true" className="text-[#C5BDB0]">·</span>
                              <span className="font-mono text-[#1E3A5F] tabular-nums">
                                {ev.witnessCount} witnesses ({ev.citizenSelfCount ?? 0} Self)
                              </span>
                            </>
                          )}
                        </div>

                        <div className="flex items-center gap-3 text-xs font-mono shrink-0">
                          {hasDiff && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpand(ev.id);
                              }}
                              className="text-[#9A3412] hover:underline inline-flex items-center gap-1 cursor-pointer tabular-nums"
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                              +{ev.diffMeta!.addedCount} / -{ev.diffMeta!.removedCount} lines
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusBillId(ev.billId);
                            }}
                            className="text-[#57534E] hover:text-[#181715] cursor-pointer"
                          >
                            Focus
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenBill(ev.billId);
                            }}
                            className="text-[#1E3A5F] hover:underline inline-flex items-center gap-0.5 cursor-pointer"
                          >
                            Dossier
                            <ArrowUpRight className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      <div className="text-sm font-medium text-[#181715]">{ev.title}</div>
                      {ev.detail && (
                        <p className="text-xs text-[#57534E] leading-relaxed">{ev.detail}</p>
                      )}

                      {ev.documentNote && (
                        <div className="pt-1 flex items-start gap-1.5 text-xs text-[#57534E]">
                          <FileText className="w-3.5 h-3.5 text-[#1E3A5F] shrink-0 mt-0.5" />
                          <span>
                            <strong className="text-[#181715] font-medium">
                              {ev.documentNote.docType === 'analysis' ? 'Bill Analysis' : 'LBB Fiscal Note'} ({ev.documentNote.versionLabel}):
                            </strong>{' '}
                            {ev.documentNote.summary}
                          </span>
                        </div>
                      )}

                      {isExpanded && ev.diffMeta && (
                        <div className="mt-2 p-3 bg-[#FBF9F5] border border-[#DFD9CE] space-y-1.5 font-mono text-[11px]">
                          <div className="text-[#57534E] pb-1 border-b border-[#DFD9CE]">
                            Statutory Redline: {ev.diffMeta.fromLabel} → {ev.diffMeta.toLabel}
                          </div>
                          {ev.diffMeta.removedLines.map((line, i) => (
                            <div key={`rem-${i}`} className="text-[#991B1B] whitespace-pre-wrap">
                              - {line}
                            </div>
                          ))}
                          {ev.diffMeta.addedLines.map((line, i) => (
                            <div key={`add-${i}`} className="text-[#14532D] whitespace-pre-wrap">
                              + {line}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
