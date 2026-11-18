import React, { useEffect, useState } from 'react';
import {
  Search,
  Link2,
  Trash2,
  Plus,
  Share2,
  FilePlus2,
  Download,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  Sparkles,
  FileSpreadsheet,
} from 'lucide-react';
import type {
  BillDetail,
  BillSummary,
  LinkType,
  OverviewResponse,
} from '../types.ts';
import { RedlineDiffPane } from './RedlineDiffPane.tsx';
import { csvDateStamp, downloadCsv } from '../utils/csv.ts';

interface LegislationViewProps {
  overview: OverviewResponse | null;
  activeSession: string;
  selectedBillId: string;
  onSelectBill: (billId: string) => void;
  onInspectPoliticianName: (shortName: string) => void;
  onInspectInNetwork: (billId: string) => void;
  onOpenTloSync: () => void;
  onOpenNewBill: () => void;
  refreshSignal: number;
  onDataMutated: () => void;
}

const LINK_TYPES: LinkType[] = [
  'Companion',
  'Budget Rider',
  'Omnibus Vehicle',
  'Statutory Conflict',
  'Supersedes',
  'Related Policy',
];

export const LegislationView: React.FC<LegislationViewProps> = ({
  overview,
  activeSession,
  selectedBillId,
  onSelectBill,
  onInspectPoliticianName,
  onInspectInNetwork,
  onOpenTloSync,
  onOpenNewBill,
  refreshSignal,
  onDataMutated,
}) => {
  const [query, setQuery] = useState('');
  const [chamber, setChamber] = useState('');
  const [stage, setStage] = useState('');
  const [sort, setSort] = useState<'influence' | 'relevance' | 'amendments' | 'recent'>('influence');

  const [bills, setBills] = useState<BillSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [detail, setDetail] = useState<BillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [dossierTab, setDossierTab] = useState<'overview' | 'amendments' | 'links' | 'public' | 'actions'>('overview');
  const [witnessPosFilter, setWitnessPosFilter] = useState<'ALL' | 'For' | 'Against' | 'On'>('ALL');

  // Cross-bill linking form
  const [linkTargetId, setLinkTargetId] = useState('');
  const [linkType, setLinkType] = useState<LinkType>('Related Policy');
  const [linkNotes, setLinkNotes] = useState('');
  const [linking, setLinking] = useState(false);

  // Archive amendment form
  const [showAmendForm, setShowAmendForm] = useState(false);
  const [amLabel, setAmLabel] = useState('');
  const [amNumber, setAmNumber] = useState('');
  const [amSponsor, setAmSponsor] = useState('');
  const [amDisposition, setAmDisposition] = useState('Adopted');
  const [amYea, setAmYea] = useState(0);
  const [amNay, setAmNay] = useState(0);
  const [amSummary, setAmSummary] = useState('');
  const [amFullText, setAmFullText] = useState('');
  const [savingAmend, setSavingAmend] = useState(false);

  // Optional secondary AI brief state (collapsed by default, never primary)
  const [showAiDrawer, setShowAiDrawer] = useState(false);
  const [aiBrief, setAiBrief] = useState<string>('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  // Fetch filtered FTS5 bills
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoadingList(true);
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (activeSession) params.set('session', activeSession);
      if (chamber) params.set('chamber', chamber);
      if (stage) params.set('stage', stage);
      params.set('sort', query.trim() && sort === 'influence' ? 'relevance' : sort);

      fetch(`/api/bills?${params.toString()}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((data) => {
          const list: BillSummary[] = data.bills ?? [];
          setBills(list);
          if (list.length > 0 && (!selectedBillId || !list.some((b) => b.id === selectedBillId))) {
            onSelectBill(list[0].id);
          }
        })
        .catch(() => {})
        .finally(() => setLoadingList(false));
    }, 140);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, activeSession, chamber, stage, sort, refreshSignal]);

  // Fetch active bill dossier
  const loadBillDetail = (billId: string) => {
    if (!billId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    setAiBrief('');
    setAiError('');
    setShowAiDrawer(false);
    fetch(`/api/bills/${encodeURIComponent(billId)}`)
      .then((r) => r.json())
      .then((data: BillDetail) => setDetail(data))
      .catch(() => setDetail(null))
      .finally(() => setLoadingDetail(false));
  };

  useEffect(() => {
    loadBillDetail(selectedBillId);
  }, [selectedBillId, refreshSignal]);

  const handleCreateLink = async (e: React.FormEvent, overrideTargetId?: string, overrideType?: LinkType, overrideNotes?: string) => {
    e.preventDefault();
    if (!detail) return;
    const tgt = overrideTargetId || linkTargetId;
    if (!tgt || tgt === detail.id) return;
    setLinking(true);
    try {
      const res = await fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceBillId: detail.id,
          targetBillId: tgt,
          linkType: overrideType || linkType,
          notes: overrideNotes ?? linkNotes,
        }),
      });
      if (res.ok) {
        setLinkNotes('');
        loadBillDetail(detail.id);
        onDataMutated();
      }
    } finally {
      setLinking(false);
    }
  };

  const handleDeleteLink = async (linkId: string) => {
    await fetch(`/api/links/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
    if (detail) loadBillDetail(detail.id);
    onDataMutated();
  };

  const handleArchiveAmendment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || !amLabel.trim() || !amFullText.trim()) return;
    setSavingAmend(true);
    try {
      const res = await fetch(`/api/bills/${encodeURIComponent(detail.id)}/amendments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          versionCode: 'FA',
          versionLabel: amLabel,
          amendmentNumber: amNumber || amLabel,
          sponsor: amSponsor || detail.primaryAuthor,
          disposition: amDisposition,
          yeaVotes: amYea,
          nayVotes: amNay,
          summary: amSummary || amLabel,
          fullText: amFullText,
        }),
      });
      if (res.ok) {
        setShowAmendForm(false);
        setAmLabel('');
        setAmNumber('');
        setAmSummary('');
        setAmFullText('');
        loadBillDetail(detail.id);
        onDataMutated();
      }
    } finally {
      setSavingAmend(false);
    }
  };

  const handleGenerateOptionalAiBrief = async () => {
    if (!detail) return;
    setAiLoading(true);
    setAiError('');
    try {
      const res = await fetch(`/api/bills/${encodeURIComponent(detail.id)}/ai-brief`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not generate AI brief');
      setAiBrief(data.brief);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI brief failed');
    } finally {
      setAiLoading(false);
    }
  };

  const [exportingCsv, setExportingCsv] = useState(false);

  const handleExportBillsCsv = async () => {
    setExportingCsv(true);
    try {
      let rowsToExport = bills;
      if (bills.length >= 100) {
        const params = new URLSearchParams();
        if (query.trim()) params.set('q', query.trim());
        if (activeSession) params.set('session', activeSession);
        if (chamber) params.set('chamber', chamber);
        if (stage) params.set('stage', stage);
        params.set('sort', query.trim() && sort === 'influence' ? 'relevance' : sort);
        params.set('limit', '10000');
        const res = await fetch(`/api/bills?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.bills)) rowsToExport = data.bills;
        }
      }

      downloadCsv(
        `texas-bills-${activeSession || 'all'}-${csvDateStamp()}.csv`,
        [
          'Session',
          'Bill Number',
          'Chamber',
          'Stage',
          'Title',
          'Primary Author',
          'Co-Authors',
          'Sponsors',
          'Committees',
          'Subjects',
          'Statute Codes',
          'Influence Score',
          'Momentum',
          'Versions',
          'Actions',
          'Links',
          'Filed Date',
          'Last Action Date',
          'Last Action',
          'Source',
        ],
        rowsToExport.map((b) => [
          b.session,
          b.billNumber,
          b.chamber,
          b.stage,
          b.title,
          b.primaryAuthor,
          b.coauthors,
          b.sponsors,
          b.committees.map((c) => `${c.chamber} ${c.name} (${c.status})`),
          b.subjects,
          b.statuteCodes,
          b.influenceScore.toFixed(1),
          b.momentumLabel,
          b.amendmentCount,
          b.actionCount,
          b.linkCount,
          b.filedDate,
          b.lastActionDate,
          b.lastAction,
          b.source,
        ])
      );
    } finally {
      setExportingCsv(false);
    }
  };

  const handleExportDossierCsv = () => {
    if (!detail) return;
    const rows: Array<Array<unknown>> = [
      ...detail.actions.map((a) => [
        'Action',
        a.actionDate,
        a.actionNumber,
        a.description,
        '',
        '',
      ]),
      ...detail.amendments.map((am) => [
        'Version / Amendment',
        am.filedDate,
        am.amendmentNumber,
        `${am.versionLabel} (${am.disposition})`,
        am.sponsor,
        `${am.yeaVotes}-${am.nayVotes}`,
      ]),
      ...detail.witnesses.map((w) => [
        'Committee Witness',
        w.hearingDate,
        w.position,
        `${w.witnessName} (${w.affiliation})`,
        w.committeeName,
        w.testified ? 'Testified' : 'Registered',
      ]),
    ];

    downloadCsv(
      `dossier-${detail.session}-${detail.billNumber.replace(/\s+/g, '')}-${csvDateStamp()}.csv`,
      ['Record Type', 'Date', 'Code / Position', 'Detail', 'Actor / Committee', 'Outcome / Notes'],
      rows
    );
  };

  useEffect(() => {
    const onExport = () => {
      void handleExportBillsCsv();
    };
    const onStep = (ev: Event) => {
      const delta = (ev as CustomEvent<{ delta?: number }>).detail?.delta ?? 1;
      if (bills.length === 0) return;
      const curIdx = bills.findIndex((b) => b.id === selectedBillId);
      const nextIdx =
        curIdx === -1
          ? 0
          : Math.max(0, Math.min(bills.length - 1, curIdx + delta));
      if (bills[nextIdx]) onSelectBill(bills[nextIdx].id);
    };
    window.addEventListener('capitol:export-csv', onExport);
    window.addEventListener('capitol:step-item', onStep);
    return () => {
      window.removeEventListener('capitol:export-csv', onExport);
      window.removeEventListener('capitol:step-item', onStep);
    };
  }, [bills, selectedBillId, detail, query, activeSession, chamber, stage, sort]);

  return (
    <div className="space-y-6">
      {/* Section 1: Influential Legislation & Multi-Session Keyword Trends */}
      {overview && (
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 border-b border-[#DFD9CE] pb-6">
          {/* Left 7 cols: Cross-Session Keyword Trends (87R -> 88R -> 89R -> 891 -> 90R) */}
          <div className="lg:col-span-7 border border-[#DFD9CE] bg-[#FFFFFF] p-5">
            <div className="flex items-center justify-between gap-4 mb-3">
              <div>
                <h2 className="font-display text-base font-bold text-[#181715]">
                  Cross-Session Policy Keyword Trends
                </h2>
                <p className="text-xs text-[#57534E]">
                  Deterministic FTS5 volume across 87th–90th Texas Legislatures — click any topic to query
                </p>
              </div>
              <span className="text-xs font-mono text-[#78716C] tabular-nums whitespace-nowrap">
                87R · 88R · 89R · 89-1 · 90R
              </span>
            </div>

            <div className="divide-y divide-[#F4F0E8]">
              {overview.keywordTrends.map((trend) => {
                const maxVal = Math.max(1, ...trend.bySession.map((s) => s.count));
                return (
                  <button
                    key={trend.keyword}
                    type="button"
                    onClick={() => setQuery(trend.query)}
                    className="w-full py-2.5 flex items-center justify-between gap-4 text-left hover:bg-[#FBF9F5] transition-colors px-2 -mx-2 cursor-pointer"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-[#181715] truncate">
                        {trend.keyword}
                      </div>
                      <div className="text-xs text-[#78716C] font-mono truncate">
                        {trend.changeLabel} · {trend.totalHits} indexed bills
                      </div>
                    </div>

                    <div className="flex items-end gap-1.5 shrink-0 h-7">
                      {trend.bySession.map((pt) => {
                        const heightPct = pt.count > 0 ? Math.max(22, Math.round((pt.count / maxVal) * 100)) : 8;
                        const isLatest = pt.session === '90R' || pt.session === '89R';
                        return (
                          <div key={pt.session} className="flex flex-col items-center gap-0.5 w-7">
                            <div
                              className="w-full flex items-end justify-center h-5"
                              title={`${pt.session}: ${pt.count} bills`}
                            >
                              <div
                                style={{ height: `${heightPct}%` }}
                                className={`w-4 ${
                                  pt.count === 0
                                    ? 'bg-[#DFD9CE]'
                                    : isLatest
                                      ? 'bg-[#9A3412]'
                                      : 'bg-[#1E3A5F]'
                                }`}
                              />
                            </div>
                            <span className="text-[10px] font-mono text-[#78716C] tabular-nums leading-none">
                              {pt.session}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right 5 cols: Influential Legislation Ranking */}
          <div className="lg:col-span-5 border border-[#DFD9CE] bg-[#FFFFFF] p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <h2 className="font-display text-base font-bold text-[#181715] flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-[#9A3412]" />
                  Highest-Influence Legislation
                </h2>
                <p className="text-xs text-[#57534E]">
                  Ranked by co-authors, amendments, stage progression & cross-bill links
                </p>
              </div>
            </div>

            <div className="divide-y divide-[#F4F0E8]">
              {overview.influentialBills.slice(0, 5).map((ib, idx) => (
                <button
                  key={ib.id}
                  type="button"
                  onClick={() => onSelectBill(ib.id)}
                  className={`w-full py-2 px-2 -mx-2 flex items-start justify-between gap-3 text-left cursor-pointer transition-colors ${
                    selectedBillId === ib.id ? 'bg-[#F4F0E8]' : 'hover:bg-[#FBF9F5]'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-mono text-[#57534E]">
                      <span className="text-[#9A3412] font-semibold tabular-nums">
                        0{idx + 1}.
                      </span>
                      <span className="font-semibold text-[#181715]">
                        {ib.session} {ib.billNumber}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{ib.stage}</span>
                      <span aria-hidden="true">·</span>
                      <span>{ib.primaryAuthor}</span>
                    </div>
                    <p className="text-xs text-[#181715] truncate mt-0.5">{ib.title}</p>
                  </div>
                  <div className="shrink-0 text-right font-mono tabular-nums">
                    <div className="text-sm font-semibold text-[#181715]">
                      {ib.influenceScore.toFixed(1)}
                    </div>
                    <div className="text-[10px] text-[#78716C]">{ib.amendmentCount} ver.</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Section 2: FTS5 Boolean Keyword Search & Action Bar */}
      <section className="border border-[#DFD9CE] bg-[#F4F0E8] p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-[#57534E] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              data-global-search="true"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search Texas bills, statutory text & subjects (supports AND, OR, NOT, "exact phrase", prefix*)'
              className="w-full pl-9 pr-20 py-2.5 bg-[#FFFFFF] border border-[#C5BDB0] text-sm text-[#181715] rounded focus:outline-none focus:border-[#9A3412]"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#57534E] hover:text-[#181715] cursor-pointer"
              >
                Clear
              </button>
            ) : (
              <kbd className="hidden sm:inline-block absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] font-mono text-[#78716C] bg-[#FBF9F5] border border-[#DFD9CE] rounded pointer-events-none">
                /
              </kbd>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleExportBillsCsv}
              disabled={exportingCsv || bills.length === 0}
              className="px-3.5 py-2.5 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              title="Export matching bills to CSV (Shortcut: e)"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-[#14532D]" />
              {exportingCsv ? 'Exporting...' : 'Export CSV'}
            </button>
            <button
              type="button"
              onClick={onOpenTloSync}
              className="px-3.5 py-2.5 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              title="Sync TLO FTP Archive (Shortcut: t)"
            >
              <Download className="w-3.5 h-3.5 text-[#9A3412]" />
              Sync TLO FTP
            </button>
            <button
              type="button"
              onClick={onOpenNewBill}
              className="px-3.5 py-2.5 text-xs font-medium bg-[#181715] text-[#FBF9F5] rounded hover:bg-[#292524] inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              title="Index New Bill (Shortcut: n)"
            >
              <FilePlus2 className="w-3.5 h-3.5" />
              Index Bill
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex border border-[#C5BDB0] bg-[#FFFFFF] rounded overflow-hidden">
              {['', 'House', 'Senate'].map((ch) => (
                <button
                  key={ch || 'all'}
                  type="button"
                  onClick={() => setChamber(ch)}
                  className={`px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
                    chamber === ch
                      ? 'bg-[#181715] text-[#FBF9F5]'
                      : 'text-[#57534E] hover:text-[#181715]'
                  }`}
                >
                  {ch || 'All Chambers'}
                </button>
              ))}
            </div>

            <select
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              className="px-3 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded"
            >
              <option value="">All Legislative Stages</option>
              <option value="Pre-Filed">Pre-Filed (90th)</option>
              <option value="Filed">Filed</option>
              <option value="Committee Hearing">Committee Hearing</option>
              <option value="Committee Reported">Committee Reported</option>
              <option value="Engrossed">Engrossed</option>
              <option value="Enrolled">Enrolled</option>
              <option value="Signed">Signed into Law</option>
              <option value="Stalled">Stalled</option>
            </select>

            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className="px-3 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded"
            >
              <option value="influence">Sort: Influence Index</option>
              <option value="relevance">Sort: Keyword Relevance (BM25)</option>
              <option value="amendments">Sort: Most Amended</option>
              <option value="recent">Sort: Latest Action Date</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-[#57534E]">
            <span>Quick operators:</span>
            {['AND', 'OR', 'NOT', '"basic allotment"', 'nuclear*'].map((op) => (
              <button
                key={op}
                type="button"
                onClick={() => setQuery((prev) => (prev ? `${prev} ${op}` : op))}
                className="font-mono px-2 py-0.5 bg-[#FFFFFF] border border-[#DFD9CE] hover:border-[#9A3412] text-[#181715] rounded cursor-pointer"
              >
                {op}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Section 3: Two-Column Research Split (Bill Index + Broadsheet Dossier) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 5 cols: Ranked Bill Ledger */}
        <div className="lg:col-span-5 border border-[#DFD9CE] bg-[#FFFFFF]">
          <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between text-xs font-medium text-[#57534E]">
            <span className="font-mono tabular-nums">
              {loadingList ? 'Querying FTS5 index...' : `${bills.length} matching bills`}
            </span>
            <span>Click record to open dossier</span>
          </div>

          {bills.length === 0 && !loadingList ? (
            <div className="p-8 text-center space-y-3">
              <p className="text-sm text-[#57534E]">
                No Texas bills matched your keyword expression or chamber filter.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setChamber('');
                  setStage('');
                }}
                className="px-3 py-1.5 text-xs font-medium border border-[#C5BDB0] rounded hover:border-[#181715] cursor-pointer"
              >
                Reset Filters
              </button>
            </div>
          ) : (
            <div className="divide-y divide-[#DFD9CE] max-h-[780px] overflow-y-auto">
              {bills.map((b) => {
                const active = b.id === selectedBillId;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onSelectBill(b.id)}
                    className={`w-full p-4 text-left transition-colors cursor-pointer block ${
                      active ? 'bg-[#F4F0E8]' : 'hover:bg-[#FBF9F5]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs font-mono text-[#57534E]">
                      <div className="flex items-center gap-1.5 min-w-0 truncate">
                        <span className="font-semibold text-[#9A3412]">{b.session}</span>
                        <span className="font-semibold text-[#181715]">{b.billNumber}</span>
                        <span aria-hidden="true">·</span>
                        <span>{b.chamber}</span>
                        <span aria-hidden="true">·</span>
                        <span>{b.stage}</span>
                      </div>
                      <span className="tabular-nums font-medium text-[#181715] shrink-0">
                        IDX {b.influenceScore.toFixed(1)}
                      </span>
                    </div>

                    <h3 className="font-display text-sm font-semibold text-[#181715] mt-1 leading-snug">
                      {b.title}
                    </h3>

                    {b.snippet ? (
                      <p
                        className="text-xs text-[#57534E] mt-1.5 leading-relaxed line-clamp-2"
                        dangerouslySetInnerHTML={{ __html: b.snippet }}
                      />
                    ) : (
                      <p className="text-xs text-[#57534E] mt-1.5 line-clamp-2 leading-relaxed">
                        {b.summary}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#78716C] font-mono tabular-nums">
                      <span>Author: {b.primaryAuthor}</span>
                      <span aria-hidden="true">·</span>
                      <span>{b.amendmentCount} versions</span>
                      <span aria-hidden="true">·</span>
                      <span>{b.linkCount} linked</span>
                      <span aria-hidden="true">·</span>
                      <span>{b.lastActionDate || b.filedDate}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right 7 cols: Full Broadsheet Bill Dossier */}
        <div className="lg:col-span-7 border border-[#DFD9CE] bg-[#FFFFFF]">
          {loadingDetail ? (
            <div className="p-8 text-sm text-[#57534E]">Loading legislative dossier...</div>
          ) : !detail ? (
            <div className="p-8 text-sm text-[#57534E]">
              Select a bill from the keyword ledger to inspect its statutory text, amendments, and cross-bill links.
            </div>
          ) : (
            <div>
              {/* Dossier Masthead */}
              <div className="p-6 border-b border-[#DFD9CE] bg-[#FBF9F5]">
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-[#57534E]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[#9A3412]">{detail.session}</span>
                    <span className="font-semibold text-[#181715]">{detail.billNumber}</span>
                    <span aria-hidden="true">·</span>
                    <span>Texas {detail.chamber}</span>
                    <span aria-hidden="true">·</span>
                    <span>{detail.stage}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">Influence {detail.influenceScore.toFixed(1)}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleExportDossierCsv}
                      className="inline-flex items-center gap-1.5 text-xs font-sans font-medium text-[#14532D] hover:underline cursor-pointer whitespace-nowrap"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5" />
                      Dossier CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => onInspectInNetwork(detail.id)}
                      className="inline-flex items-center gap-1.5 text-xs font-sans font-medium text-[#1E3A5F] hover:text-[#9A3412] cursor-pointer whitespace-nowrap"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      Map in Network
                    </button>
                  </div>
                </div>

                <h2 className="font-display text-2xl font-bold text-[#181715] mt-2 leading-tight">
                  {detail.title}
                </h2>

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#57534E]">
                  <span>
                    Primary Author:{' '}
                    <button
                      type="button"
                      onClick={() => onInspectPoliticianName(detail.primaryAuthor)}
                      className="font-medium text-[#9A3412] hover:underline cursor-pointer"
                    >
                      {detail.primaryAuthor}
                    </button>
                  </span>
                  {detail.sponsors.length > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        Sponsor:{' '}
                        <button
                          type="button"
                          onClick={() => onInspectPoliticianName(detail.sponsors[0])}
                          className="font-medium text-[#1E3A5F] hover:underline cursor-pointer"
                        >
                          {detail.sponsors.join(', ')}
                        </button>
                      </span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>Status: {detail.status}</span>
                </div>

                {/* Dossier Sub-Tabs */}
                <div className="mt-5 flex items-center gap-6 border-t border-[#DFD9CE] pt-3 overflow-x-auto">
                  {[
                    { id: 'overview', label: 'Statutory Text & Influence' },
                    { id: 'amendments', label: `Amendments & Redlines (${detail.amendments.length})` },
                    { id: 'links', label: `Cross-Bill Links (${detail.links.length + detail.keywordOverlaps.length})` },
                    {
                      id: 'public',
                      label: `Public Testimony & Outreach (${detail.witnesses.length + detail.constituentLogs.length})`,
                    },
                    { id: 'actions', label: `Action History (${detail.actions.length})` },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setDossierTab(t.id as typeof dossierTab)}
                      className={`text-xs font-medium whitespace-nowrap pb-1 border-b-2 cursor-pointer transition-colors ${
                        dossierTab === t.id
                          ? 'border-[#9A3412] text-[#9A3412]'
                          : 'border-transparent text-[#57534E] hover:text-[#181715]'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Dossier Body */}
              <div className="p-6 space-y-6">
                {dossierTab === 'overview' && (
                  <>
                    <div>
                      <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] mb-2">
                        Legislative Summary & Indexed Scope
                      </h3>
                      <p className="text-sm text-[#181715] leading-relaxed">{detail.summary}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono text-[#57534E]">
                        <span className="text-[#78716C]">Statutes:</span>
                        <span>
                          {detail.statuteCodes.length ? detail.statuteCodes.join(' · ') : 'General Provisions'}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#57534E]">
                        <span className="text-[#78716C]">Indexed Subjects:</span>
                        <span>{detail.subjects.join(' · ') || 'Uncategorized'}</span>
                      </div>
                    </div>

                    {/* Deterministic Influence Breakdown */}
                    <div className="border-t border-[#DFD9CE] pt-4">
                      <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] mb-3">
                        Deterministic Influence Index Breakdown ({detail.influenceScore.toFixed(1)} / 100)
                      </h3>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs font-mono tabular-nums">
                        <div className="p-2.5 bg-[#FBF9F5] border border-[#DFD9CE]">
                          <div className="text-[#78716C]">Stage Progression</div>
                          <div className="text-sm font-semibold text-[#181715] mt-0.5">
                            +{detail.influenceBreakdown?.stageWeight ?? 0}
                          </div>
                        </div>
                        <div className="p-2.5 bg-[#FBF9F5] border border-[#DFD9CE]">
                          <div className="text-[#78716C]">Co-Authors ({detail.coauthors.length})</div>
                          <div className="text-sm font-semibold text-[#181715] mt-0.5">
                            +{detail.influenceBreakdown?.coauthorWeight ?? 0}
                          </div>
                        </div>
                        <div className="p-2.5 bg-[#FBF9F5] border border-[#DFD9CE]">
                          <div className="text-[#78716C]">Amendments ({detail.amendmentCount})</div>
                          <div className="text-sm font-semibold text-[#181715] mt-0.5">
                            +{detail.influenceBreakdown?.amendmentWeight ?? 0}
                          </div>
                        </div>
                        <div className="p-2.5 bg-[#FBF9F5] border border-[#DFD9CE]">
                          <div className="text-[#78716C]">Action Momentum</div>
                          <div className="text-sm font-semibold text-[#181715] mt-0.5">
                            +{detail.influenceBreakdown?.actionWeight ?? 0}
                          </div>
                        </div>
                        <div className="p-2.5 bg-[#FBF9F5] border border-[#DFD9CE]">
                          <div className="text-[#78716C]">Chair / Leadership</div>
                          <div className="text-sm font-semibold text-[#181715] mt-0.5">
                            +{detail.influenceBreakdown?.leadershipBonus ?? 0}
                          </div>
                        </div>
                        <div className="p-2.5 bg-[#FBF9F5] border border-[#DFD9CE]">
                          <div className="text-[#78716C]">Cross-Bill Links</div>
                          <div className="text-sm font-semibold text-[#181715] mt-0.5">
                            +{detail.influenceBreakdown?.linkWeight ?? 0}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Full Statutory Text Excerpt */}
                    <div className="border-t border-[#DFD9CE] pt-4">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E]">
                          Indexed Statutory Text
                        </h3>
                        <span className="text-[11px] font-mono text-[#78716C]">{detail.source}</span>
                      </div>
                      <pre className="p-4 bg-[#FBF9F5] border border-[#DFD9CE] text-xs font-mono text-[#181715] whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
                        {detail.fullText}
                      </pre>
                    </div>

                    {detail.documents && detail.documents.length > 0 && (
                      <div className="border-t border-[#DFD9CE] pt-4 space-y-2.5">
                        <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E]">
                          Bill Analyses &amp; LBB Fiscal Notes ({detail.documents.length})
                        </h3>
                        <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE] bg-[#FBF9F5]">
                          {detail.documents.map((doc) => (
                            <div key={doc.id} className="p-3 space-y-1">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className="font-medium text-[#181715]">{doc.title}</span>
                                <span className="font-mono text-[11px] text-[#78716C]">
                                  {doc.docType === 'analysis' ? 'Analysis' : 'Fiscal Note'} · {doc.versionLabel}
                                </span>
                              </div>
                              <p className="text-xs text-[#57534E] leading-relaxed">{doc.summary}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Committees & Co-Authors */}
                    <div className="border-t border-[#DFD9CE] pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                      <div>
                        <h4 className="font-medium text-[#57534E] mb-1.5">Committee Referrals</h4>
                        {detail.committees.length === 0 ? (
                          <p className="text-[#78716C]">No committee referral recorded yet.</p>
                        ) : (
                          <ul className="space-y-1">
                            {detail.committees.map((c, idx) => (
                              <li key={idx} className="text-[#181715] font-mono">
                                {c.chamber} {c.name} · {c.status}
                                {c.ayeVotes + c.nayVotes > 0 && ` (${c.ayeVotes}-${c.nayVotes})`}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div>
                        <h4 className="font-medium text-[#57534E] mb-1.5">
                          Co-Authors & Senate Co-Sponsors
                        </h4>
                        <p className="text-[#181715] leading-relaxed">
                          {[...detail.coauthors, ...detail.cosponsors].join(' · ') || 'None recorded'}
                        </p>
                      </div>
                    </div>

                    {/* Quiet Secondary Optional AI Policy Brief */}
                    <div className="border-t border-[#DFD9CE] pt-4">
                      <button
                        type="button"
                        onClick={() => setShowAiDrawer((v) => !v)}
                        className="w-full flex items-center justify-between text-xs text-[#78716C] hover:text-[#181715] cursor-pointer"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5" />
                          Optional Secondary Tool: Generate 3-Bullet AI Clerk Brief
                        </span>
                        {showAiDrawer ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                      {showAiDrawer && (
                        <div className="mt-3 p-4 bg-[#FBF9F5] border border-[#DFD9CE] space-y-2">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-xs text-[#57534E]">
                              Secondary synthesis strictly from the indexed bill text above.
                            </span>
                            <button
                              type="button"
                              onClick={handleGenerateOptionalAiBrief}
                              disabled={aiLoading}
                              className="px-3 py-1.5 text-xs font-medium border border-[#C5BDB0] bg-[#FFFFFF] hover:border-[#181715] rounded cursor-pointer"
                            >
                              {aiLoading ? 'Synthesizing...' : 'Generate Brief'}
                            </button>
                          </div>
                          {aiError && <p className="text-xs text-[#991B1B]">{aiError}</p>}
                          {aiBrief && (
                            <div className="text-xs text-[#181715] whitespace-pre-wrap leading-relaxed pt-2 border-t border-[#DFD9CE]">
                              {aiBrief}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {dossierTab === 'amendments' && (
                  <div className="space-y-5">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E]">
                        Chronological Version & Floor Amendment Archive
                      </h3>
                      <button
                        type="button"
                        onClick={() => setShowAmendForm((v) => !v)}
                        className="px-3 py-1.5 text-xs font-medium border border-[#C5BDB0] bg-[#FBF9F5] hover:border-[#9A3412] rounded inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Archive Amendment
                      </button>
                    </div>

                    {showAmendForm && (
                      <form
                        onSubmit={handleArchiveAmendment}
                        className="p-4 bg-[#F4F0E8] border border-[#C5BDB0] space-y-3"
                      >
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <input
                            type="text"
                            placeholder="Label (e.g. Floor Amend. #8)"
                            value={amLabel}
                            onChange={(e) => setAmLabel(e.target.value)}
                            className="px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                            required
                          />
                          <input
                            type="text"
                            placeholder="Short # (e.g. FA #8)"
                            value={amNumber}
                            onChange={(e) => setAmNumber(e.target.value)}
                            className="px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded font-mono"
                          />
                          <input
                            type="text"
                            placeholder="Sponsor (e.g. Bernal)"
                            value={amSponsor}
                            onChange={(e) => setAmSponsor(e.target.value)}
                            className="px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <select
                            value={amDisposition}
                            onChange={(e) => setAmDisposition(e.target.value)}
                            className="px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                          >
                            <option value="Adopted">Adopted</option>
                            <option value="Substituted">Substituted</option>
                            <option value="Tabled">Tabled</option>
                            <option value="Failed">Failed</option>
                            <option value="Withdrawn">Withdrawn</option>
                          </select>
                          <input
                            type="number"
                            placeholder="Yeas"
                            value={amYea}
                            onChange={(e) => setAmYea(Number(e.target.value))}
                            className="px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded font-mono"
                          />
                          <input
                            type="number"
                            placeholder="Nays"
                            value={amNay}
                            onChange={(e) => setAmNay(Number(e.target.value))}
                            className="px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded font-mono"
                          />
                        </div>
                        <input
                          type="text"
                          placeholder="Amendment summary"
                          value={amSummary}
                          onChange={(e) => setAmSummary(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                        />
                        <textarea
                          rows={3}
                          placeholder="Full statutory text of this version or amendment..."
                          value={amFullText}
                          onChange={(e) => setAmFullText(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs font-mono bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                          required
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setShowAmendForm(false)}
                            className="px-3 py-1.5 text-xs border border-[#C5BDB0] rounded cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            disabled={savingAmend}
                            className="px-3 py-1.5 text-xs bg-[#9A3412] text-[#FBF9F5] rounded cursor-pointer"
                          >
                            {savingAmend ? 'Archiving...' : 'Save & Update FTS5'}
                          </button>
                        </div>
                      </form>
                    )}

                    <RedlineDiffPane billId={detail.id} amendments={detail.amendments} />

                    <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                      {detail.amendments.length === 0 ? (
                        <div className="p-4 text-xs text-[#78716C]">
                          No historical amendments archived yet for this bill.
                        </div>
                      ) : (
                        detail.amendments.map((am) => (
                          <div key={am.id} className="p-4 space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                              <span className="font-semibold text-[#181715]">
                                {am.versionLabel}
                              </span>
                              <span
                                className={`font-medium ${
                                  am.disposition === 'Adopted' || am.disposition === 'Enacted'
                                    ? 'text-[#14532D]'
                                    : am.disposition === 'Tabled' || am.disposition === 'Failed'
                                      ? 'text-[#991B1B]'
                                      : 'text-[#57534E]'
                                }`}
                              >
                                {am.disposition}
                                {am.yeaVotes + am.nayVotes > 0 &&
                                  ` · ${am.yeaVotes}-${am.nayVotes}`}
                              </span>
                            </div>
                            <div className="text-xs text-[#57534E] font-mono">
                              Sponsor: {am.sponsor} · Filed {am.filedDate}
                            </div>
                            <p className="text-xs text-[#181715] leading-relaxed">{am.summary}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {dossierTab === 'links' && (
                  <div className="space-y-6">
                    {/* Create Manual Typed Link */}
                    <form
                      onSubmit={(e) => handleCreateLink(e)}
                      className="p-4 bg-[#F4F0E8] border border-[#DFD9CE] space-y-3"
                    >
                      <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E]">
                        Link Related Legislation
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <select
                          value={linkTargetId}
                          onChange={(e) => setLinkTargetId(e.target.value)}
                          className="px-2.5 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                          required
                        >
                          <option value="">Select target bill to link...</option>
                          {bills
                            .filter((b) => b.id !== detail.id)
                            .map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.session} {b.billNumber} — {b.title.slice(0, 56)}
                              </option>
                            ))}
                        </select>
                        <select
                          value={linkType}
                          onChange={(e) => setLinkType(e.target.value as LinkType)}
                          className="px-2.5 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                        >
                          {LINK_TYPES.map((lt) => (
                            <option key={lt} value={lt}>
                              {lt}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={linkNotes}
                          onChange={(e) => setLinkNotes(e.target.value)}
                          placeholder="Researcher note (e.g., Article III funding rider, statutory conflict)..."
                          className="flex-1 px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
                        />
                        <button
                          type="submit"
                          disabled={linking || !linkTargetId}
                          className="px-3.5 py-1.5 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                        >
                          <Link2 className="w-3.5 h-3.5" />
                          Save Link
                        </button>
                      </div>
                    </form>

                    {/* Curated Cross-Bill Links */}
                    <div>
                      <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] mb-2">
                        Curated Cross-Bill Relationships ({detail.links.length})
                      </h3>
                      {detail.links.length === 0 ? (
                        <p className="text-xs text-[#78716C]">No manual bill links created yet.</p>
                      ) : (
                        <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                          {detail.links.map((lnk) => (
                            <div key={lnk.id} className="p-3.5 flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 text-xs font-mono">
                                  <span className="font-semibold text-[#9A3412]">
                                    {lnk.linkType}
                                  </span>
                                  <span aria-hidden="true">·</span>
                                  <button
                                    type="button"
                                    onClick={() => onSelectBill(lnk.targetBillId)}
                                    className="font-semibold text-[#1E3A5F] hover:underline cursor-pointer"
                                  >
                                    {lnk.targetSession} {lnk.targetBillNumber}
                                  </button>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-[#57534E]">{lnk.targetStage}</span>
                                </div>
                                <p className="text-xs text-[#181715] mt-1">{lnk.targetTitle}</p>
                                {lnk.notes && (
                                  <p className="text-xs text-[#57534E] mt-1 italic">{lnk.notes}</p>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDeleteLink(lnk.id)}
                                className="p-1.5 text-[#78716C] hover:text-[#991B1B] cursor-pointer shrink-0"
                                aria-label="Remove bill link"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Deterministic Keyword-Overlap Matches */}
                    <div>
                      <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] mb-2">
                        Deterministic Keyword-Overlap Bills ({detail.keywordOverlaps.length})
                      </h3>
                      {detail.keywordOverlaps.length === 0 ? (
                        <p className="text-xs text-[#78716C]">
                          No cross-bill keyword overlaps exceeded the threshold.
                        </p>
                      ) : (
                        <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                          {detail.keywordOverlaps.map((ov) => {
                            const alreadyLinked = detail.links.some(
                              (l) => l.targetBillId === ov.billId
                            );
                            return (
                              <div key={ov.billId} className="p-3.5 flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 text-xs font-mono">
                                    <button
                                      type="button"
                                      onClick={() => onSelectBill(ov.billId)}
                                      className="font-semibold text-[#181715] hover:text-[#9A3412] cursor-pointer"
                                    >
                                      {ov.session} {ov.billNumber}
                                    </button>
                                    <span aria-hidden="true">·</span>
                                    <span className="text-[#57534E]">{ov.stage}</span>
                                    <span aria-hidden="true">·</span>
                                    <span className="text-[#14532D] font-medium tabular-nums">
                                      {ov.overlapScore} shared terms
                                    </span>
                                  </div>
                                  <p className="text-xs text-[#181715] mt-1">{ov.title}</p>
                                  <p className="text-[11px] font-mono text-[#78716C] mt-1">
                                    Matched terms: {ov.sharedKeywords.join(' · ')}
                                  </p>
                                </div>
                                {!alreadyLinked && (
                                  <button
                                    type="button"
                                    onClick={(e) =>
                                      handleCreateLink(
                                        e,
                                        ov.billId,
                                        'Related Policy',
                                        `Auto-linked via shared keywords: ${ov.sharedKeywords.join(', ')}`
                                      )
                                    }
                                    className="px-2.5 py-1 text-xs border border-[#C5BDB0] hover:border-[#9A3412] rounded shrink-0 cursor-pointer whitespace-nowrap"
                                  >
                                    + Pin Link
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {dossierTab === 'public' && (
                  <div className="space-y-6">
                    {/* Sentiment Breakdown Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
                      <div className="p-3 bg-[#FBF9F5] border border-[#DFD9CE]">
                        <div className="text-[#78716C]">Witnesses For</div>
                        <div className="text-base font-semibold text-[#14532D] mt-0.5">
                          {detail.publicSentiment?.forCount ?? 0}
                        </div>
                      </div>
                      <div className="p-3 bg-[#FBF9F5] border border-[#DFD9CE]">
                        <div className="text-[#78716C]">Witnesses Against</div>
                        <div className="text-base font-semibold text-[#991B1B] mt-0.5">
                          {detail.publicSentiment?.againstCount ?? 0}
                        </div>
                      </div>
                      <div className="p-3 bg-[#FBF9F5] border border-[#DFD9CE]">
                        <div className="text-[#78716C]">Citizen (Self) vs. Org</div>
                        <div className="text-base font-semibold text-[#181715] mt-0.5">
                          {detail.publicSentiment?.citizenSelfCount ?? 0} / {detail.publicSentiment?.orgCount ?? 0}
                        </div>
                      </div>
                      <div className="p-3 bg-[#FBF9F5] border border-[#DFD9CE]">
                        <div className="text-[#78716C]">Constituent Contacts</div>
                        <div className="text-base font-semibold text-[#9A3412] mt-0.5">
                          {(
                            (detail.publicSentiment?.constituentSupportVolume ?? 0) +
                            (detail.publicSentiment?.constituentOpposeVolume ?? 0) +
                            (detail.publicSentiment?.constituentAmendVolume ?? 0)
                          ).toLocaleString()}
                        </div>
                      </div>
                    </div>

                    {/* TLO Committee Witness Registrations */}
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E]">
                          TLO Committee Witness Registrations ({detail.witnesses.length})
                        </h3>
                        <div className="inline-flex border border-[#C5BDB0] bg-[#FFFFFF] rounded overflow-hidden text-xs">
                          {(['ALL', 'For', 'Against', 'On'] as const).map((pos) => (
                            <button
                              key={pos}
                              type="button"
                              onClick={() => setWitnessPosFilter(pos)}
                              className={`px-2.5 py-1 cursor-pointer ${
                                witnessPosFilter === pos
                                  ? 'bg-[#181715] text-[#FBF9F5]'
                                  : 'text-[#57534E] hover:text-[#181715]'
                              }`}
                            >
                              {pos === 'ALL' ? 'All' : pos}
                            </button>
                          ))}
                        </div>
                      </div>

                      {detail.witnesses.length === 0 ? (
                        <div className="p-4 border border-[#DFD9CE] text-xs text-[#78716C]">
                          No TLO witness registrations indexed for this bill yet. Sync from TLO FTP to pull available <span className="font-mono">witlistbill</span> HTML records.
                        </div>
                      ) : (
                        <div className="overflow-x-auto border border-[#DFD9CE]">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-[#F4F0E8] border-b border-[#DFD9CE] text-[#57534E]">
                              <tr>
                                <th className="px-3 py-2 font-medium">Witness</th>
                                <th className="px-3 py-2 font-medium">Affiliation / Entity</th>
                                <th className="px-3 py-2 font-medium">Type</th>
                                <th className="px-3 py-2 font-medium">Position</th>
                                <th className="px-3 py-2 font-medium text-right">Appearance</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[#DFD9CE]">
                              {detail.witnesses
                                .filter((w) => witnessPosFilter === 'ALL' || w.position === witnessPosFilter)
                                .map((w) => (
                                  <tr key={w.id} className="hover:bg-[#FBF9F5]">
                                    <td className="px-3 py-2 font-medium text-[#181715]">
                                      {w.witnessName}
                                    </td>
                                    <td className="px-3 py-2 text-[#57534E]">{w.affiliation}</td>
                                    <td className="px-3 py-2 font-mono text-[#78716C]">
                                      {w.isCitizenSelf ? 'Citizen (Self)' : 'Organization'}
                                    </td>
                                    <td
                                      className={`px-3 py-2 font-mono font-semibold ${
                                        w.position === 'For'
                                          ? 'text-[#14532D]'
                                          : w.position === 'Against'
                                            ? 'text-[#991B1B]'
                                            : 'text-[#1E3A5F]'
                                      }`}
                                    >
                                      {w.position}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-right text-[#57534E]">
                                      {w.testified ? 'Testified' : 'Registered'}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    {/* Constituent Outreach Logs */}
                    <div>
                      <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] mb-2">
                        Constituent Outreach & District Communications ({detail.constituentLogs.length})
                      </h3>
                      {detail.constituentLogs.length === 0 ? (
                        <div className="p-4 border border-[#DFD9CE] text-xs text-[#78716C]">
                          No constituent outreach batches logged for this bill. Use the Receptivity tab to record constituent call logs or email campaigns.
                        </div>
                      ) : (
                        <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                          {detail.constituentLogs.map((c) => (
                            <div key={c.id} className="p-3.5 space-y-1">
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-[#181715]">{c.channel}</span>
                                  <span aria-hidden="true">·</span>
                                  <span
                                    className={
                                      c.stance === 'Support'
                                        ? 'text-[#14532D] font-semibold'
                                        : c.stance === 'Oppose'
                                          ? 'text-[#991B1B] font-semibold'
                                          : 'text-[#92400E] font-semibold'
                                    }
                                  >
                                    {c.stance}
                                  </span>
                                </div>
                                <span className="tabular-nums text-[#57534E]">
                                  {c.volumeCount.toLocaleString()} contacts · {c.loggedDate}
                                </span>
                              </div>
                              <p className="text-xs text-[#181715] leading-relaxed">{c.summary}</p>
                              <div className="text-[11px] font-mono text-[#78716C]">
                                {c.committeeName && `Committee: ${c.committeeName}`}
                                {c.politicianName && ` · Office: ${c.politicianName}`}
                                {c.topicKeywords && ` · Keywords: ${c.topicKeywords}`}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {dossierTab === 'actions' && (
                  <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                    {detail.actions.length === 0 ? (
                      <div className="p-4 text-xs text-[#78716C]">No action history logged.</div>
                    ) : (
                      detail.actions.map((act) => (
                        <div key={act.id} className="p-3.5 flex items-start gap-4 text-xs">
                          <span className="font-mono text-[#57534E] tabular-nums w-24 shrink-0">
                            {act.actionDate}
                          </span>
                          <span className="font-mono text-[#78716C] w-14 shrink-0">
                            {act.actionNumber || '—'}
                          </span>
                          <span className="text-[#181715]">{act.description}</span>
                        </div>
                      ))
                    )}
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
