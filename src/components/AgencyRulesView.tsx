import React, { useEffect, useState } from 'react';
import {
  Search,
  RefreshCw,
  FilePlus2,
  ExternalLink,
  ArrowUpRight,
  Link2,
  Scale,
  DollarSign,
  X,
  FileSpreadsheet,
} from 'lucide-react';
import type {
  AgencyRuleActionType,
  AgencyRuleDetail,
  AgencyRuleSummary,
  TexRegSyncJob,
} from '../types.ts';
import { OutcomeIndicator } from './OutcomeIndicator.tsx';
import { csvDateStamp, downloadCsv } from '../utils/csv.ts';

interface AgencyRulesViewProps {
  selectedRuleId: string;
  onSelectRule: (ruleId: string) => void;
  onOpenBill: (billId: string) => void;
  refreshSignal: number;
  onDataMutated: () => void;
}

const ACTION_TYPES: Array<'' | AgencyRuleActionType> = [
  '',
  'Proposed',
  'Adopted',
  'Emergency',
  'Withdrawn',
  'Rule Review',
];

function formatDollars(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  if (amount === 0) return '$0 (No Sig. Cost)';
  const sign = amount < 0 ? '-' : '+';
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000).toLocaleString()}K`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

export const AgencyRulesView: React.FC<AgencyRulesViewProps> = ({
  selectedRuleId,
  onSelectRule,
  onOpenBill,
  refreshSignal,
  onDataMutated,
}) => {
  const [query, setQuery] = useState('');
  const [agency, setAgency] = useState('');
  const [actionType, setActionType] = useState<'' | AgencyRuleActionType>('');
  const [linkedOnly, setLinkedOnly] = useState(false);

  const [rules, setRules] = useState<AgencyRuleSummary[]>([]);
  const [agencies, setAgencies] = useState<string[]>([]);
  const [stats, setStats] = useState({
    totalRules: 0,
    linkedRules: 0,
    totalBillLinks: 0,
    agenciesCount: 0,
    issuesCount: 0,
  });
  const [loadingList, setLoadingList] = useState(false);

  const [detail, setDetail] = useState<AgencyRuleDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Sync panel state
  const [showSyncBar, setShowSyncBar] = useState(false);
  const [syncFromDate, setSyncFromDate] = useState('2025-01-01');
  const [syncMaxIssues, setSyncMaxIssues] = useState(3);
  const [syncJob, setSyncJob] = useState<TexRegSyncJob | null>(null);
  const [syncError, setSyncError] = useState('');
  const [relinking, setRelinking] = useState(false);

  // Manual SOS Import Modal state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [importDate, setImportDate] = useState(new Date().toISOString().slice(0, 10));
  const [importAgency, setImportAgency] = useState('');
  const [importAction, setImportAction] = useState<'' | AgencyRuleActionType>('');
  const [importUrl, setImportUrl] = useState('https://www.sos.state.tx.us/texreg/index.shtml');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState('');

  const [localRefresh, setLocalRefresh] = useState(0);

  // Load filtered rules
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoadingList(true);
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (agency) params.set('agency', agency);
      if (actionType) params.set('actionType', actionType);
      if (linkedOnly) params.set('linkedOnly', 'true');

      fetch(`/api/rules?${params.toString()}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((data) => {
          const list: AgencyRuleSummary[] = data.rules ?? [];
          setRules(list);
          setAgencies(data.agencies ?? []);
          if (data.stats) setStats(data.stats);
          if (list.length > 0 && (!selectedRuleId || !list.some((r) => r.id === selectedRuleId))) {
            onSelectRule(list[0].id);
          } else if (list.length === 0) {
            setDetail(null);
          }
        })
        .catch(() => {})
        .finally(() => setLoadingList(false));
    }, 120);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, agency, actionType, linkedOnly, refreshSignal, localRefresh]);

  // Load active rule detail
  useEffect(() => {
    if (!selectedRuleId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    fetch(`/api/rules/${encodeURIComponent(selectedRuleId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AgencyRuleDetail | null) => setDetail(data))
      .catch(() => setDetail(null))
      .finally(() => setLoadingDetail(false));
  }, [selectedRuleId, refreshSignal, localRefresh]);

  // Check & poll Texas Register sync status
  useEffect(() => {
    let active = true;
    const fetchStatus = () => {
      fetch('/api/rules/sync/status')
        .then((r) => r.json())
        .then((data) => {
          if (!active) return;
          const job: TexRegSyncJob | null = data.job ?? null;
          setSyncJob(job);
        })
        .catch(() => {});
    };
    fetchStatus();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!syncJob || syncJob.status !== 'running') return;
    const interval = setInterval(() => {
      fetch('/api/rules/sync/status')
        .then((r) => r.json())
        .then((data) => {
          const job: TexRegSyncJob | null = data.job ?? null;
          setSyncJob(job);
          if (job && job.status !== 'running') {
            setLocalRefresh((n) => n + 1);
            onDataMutated();
          }
        })
        .catch(() => {});
    }, 2500);
    return () => clearInterval(interval);
  }, [syncJob?.status]);

  const handleStartSync = async () => {
    setSyncError('');
    try {
      const res = await fetch('/api/rules/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromDate: syncFromDate, maxIssues: syncMaxIssues }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start Texas Register sync');
      setSyncJob(data.job);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    }
  };

  const handleRelink = async () => {
    setRelinking(true);
    try {
      await fetch('/api/rules/relink', { method: 'POST' });
      setLocalRefresh((n) => n + 1);
      onDataMutated();
    } finally {
      setRelinking(false);
    }
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportError('');
    setImportResult('');
    setImporting(true);
    try {
      const res = await fetch('/api/rules/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawText: importText,
          issueDate: importDate,
          agencyName: importAgency,
          actionType: importAction,
          sourceUrl: importUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to import Texas Register notice');
      setImportResult(
        `Indexed ${data.rulesUpserted} rule notice(s) and created ${data.billLinksCreated} bill link(s).`
      );
      setImportText('');
      if (Array.isArray(data.ruleIds) && data.ruleIds[0]) {
        onSelectRule(data.ruleIds[0]);
      }
      setLocalRefresh((n) => n + 1);
      onDataMutated();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleExportCsv = () => {
    downloadCsv(
      `texas-register-rules-${csvDateStamp()}.csv`,
      [
        'Issue Date',
        'Action Type',
        'Agency',
        'TAC Citation',
        'Title',
        'Cited Bills',
        'Linked Bills Count',
        'Rule Fiscal Estimate',
        'Statutory Authority',
        'Source',
      ],
      rules.map((r) => [
        r.issueDate,
        r.actionType,
        r.agencyName,
        r.tacCitation,
        r.title,
        r.citedBills.join('; '),
        r.linkedBillsCount,
        r.fiscalImpactAmount ?? '',
        r.statutoryAuthority,
        r.source,
      ])
    );
  };

  useEffect(() => {
    const onExport = () => handleExportCsv();
    const onStep = (ev: Event) => {
      const delta = (ev as CustomEvent<{ delta?: number }>).detail?.delta ?? 1;
      if (rules.length === 0) return;
      const curIdx = rules.findIndex((r) => r.id === selectedRuleId);
      const nextIdx =
        curIdx === -1 ? 0 : Math.max(0, Math.min(rules.length - 1, curIdx + delta));
      if (rules[nextIdx]) onSelectRule(rules[nextIdx].id);
    };
    window.addEventListener('capitol:export-csv', onExport);
    window.addEventListener('capitol:step-item', onStep);
    return () => {
      window.removeEventListener('capitol:export-csv', onExport);
      window.removeEventListener('capitol:step-item', onStep);
    };
  }, [rules, selectedRuleId]);

  return (
    <div className="space-y-6">
      {/* Masthead & Summary Strip */}
      <section className="border border-[#DFD9CE] bg-[#FFFFFF] p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#78716C] tabular-nums">
              <span className="text-[#9A3412] font-semibold uppercase font-condensed tracking-wider">
                Texas Secretary of State · Weekly Publication
              </span>
              <span aria-hidden="true">·</span>
              <span>{stats.totalRules} Rule Notices</span>
              <span aria-hidden="true">·</span>
              <span>{stats.linkedRules} Linked to Bills</span>
              <span aria-hidden="true">·</span>
              <span>{stats.agenciesCount} Agencies</span>
              <span aria-hidden="true">·</span>
              <span>{stats.issuesCount} Weekly Issues</span>
            </div>
            <h1 className="font-display text-2xl font-bold text-[#181715]">
              Texas Register Agency Rulemaking
            </h1>
            <p className="text-xs text-[#57534E] max-w-3xl leading-relaxed">
              Tracks weekly state agency rule proposals, adoptions, and emergency rules from the Texas Register,
              automatically cross-referenced to authorizing Texas Legislature bills and paired with each rule&apos;s
              statutory fiscal note and government growth impact statement.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <a
              href="https://www.sos.state.tx.us/texreg/index.shtml"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 text-xs font-medium bg-[#FBF9F5] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <ExternalLink className="w-3.5 h-3.5 text-[#57534E]" />
              Texas SOS Index
            </a>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={rules.length === 0}
              className="px-3 py-2 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-[#14532D]" />
              Export CSV
            </button>
            <button
              type="button"
              onClick={handleRelink}
              disabled={relinking}
              className="px-3 py-2 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Link2 className="w-3.5 h-3.5 text-[#1E3A5F]" />
              {relinking ? 'Re-Linking…' : 'Re-Link Bills'}
            </button>
            <button
              type="button"
              onClick={() => setShowSyncBar((v) => !v)}
              className="px-3 py-2 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#9A3412] inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-[#9A3412] ${syncJob?.status === 'running' ? 'animate-spin' : ''}`} />
              Sync Weekly Archive
            </button>
            <button
              type="button"
              onClick={() => {
                setImportError('');
                setImportResult('');
                setShowImportModal(true);
              }}
              className="px-3.5 py-2 text-xs font-medium bg-[#181715] text-[#FBF9F5] rounded hover:bg-[#9A3412] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <FilePlus2 className="w-3.5 h-3.5" />
              Import SOS Report
            </button>
          </div>
        </div>

        {/* Collapsible Weekly UNT/SOS Archive Sync Controls */}
        {(showSyncBar || syncJob?.status === 'running') && (
          <div className="border-t border-[#DFD9CE] pt-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4 bg-[#FBF9F5] -mx-5 px-5 py-3.5 -mb-5">
            <div className="space-y-1 max-w-xl">
              <div className="text-xs font-medium text-[#181715]">
                Official Texas Register Weekly Depository Sync (UNT / Texas SOS)
              </div>
              <p className="text-[11px] text-[#57534E] leading-relaxed">
                Pulls official weekly Texas Register PDF issues from the UNT Portal to Texas History depository,
                extracts TAC rule notices and fiscal preambles, and links them to bills in your archive.
              </p>
              {syncJob && (
                <p className="text-[11px] font-mono text-[#181715] pt-1">
                  [{syncJob.status.toUpperCase()}] {syncJob.message}
                  {syncJob.status === 'running' && syncJob.issuesDiscovered > 0
                    ? ` (${syncJob.issuesProcessed}/${syncJob.issuesDiscovered} issues · ${syncJob.rulesUpserted} rules)`
                    : ''}
                </p>
              )}
              {syncError && <p className="text-xs text-[#991B1B]">{syncError}</p>}
            </div>

            <div className="flex flex-wrap items-end gap-2.5 shrink-0">
              <label className="text-[11px] text-[#57534E] space-y-1 block">
                <span className="block font-mono">From Date</span>
                <input
                  type="date"
                  value={syncFromDate}
                  onChange={(e) => setSyncFromDate(e.target.value)}
                  className="px-2.5 py-1.5 text-xs font-mono bg-[#FFFFFF] border border-[#C5BDB0] rounded text-[#181715]"
                />
              </label>
              <label className="text-[11px] text-[#57534E] space-y-1 block">
                <span className="block font-mono">Max Issues</span>
                <select
                  value={syncMaxIssues}
                  onChange={(e) => setSyncMaxIssues(Number(e.target.value))}
                  className="px-2.5 py-1.5 text-xs font-mono bg-[#FFFFFF] border border-[#C5BDB0] rounded text-[#181715]"
                >
                  <option value={1}>1 latest issue</option>
                  <option value={3}>3 weekly issues</option>
                  <option value={6}>6 weekly issues</option>
                  <option value={12}>12 weekly issues</option>
                </select>
              </label>
              <button
                type="button"
                onClick={handleStartSync}
                disabled={syncJob?.status === 'running'}
                className="px-3.5 py-1.5 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                {syncJob?.status === 'running' ? 'Syncing Weekly PDFs…' : 'Start Sync'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Search & Filter Bar */}
      <section className="border border-[#DFD9CE] bg-[#F4F0E8] p-4 space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-[#57534E] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            data-global-search="true"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search Texas Register rules by TAC citation, agency, bill number (e.g. "HB 2"), statutory code, or keyword'
            className="w-full pl-9 pr-16 py-2.5 bg-[#FFFFFF] border border-[#C5BDB0] text-sm text-[#181715] rounded focus:outline-none focus:border-[#9A3412]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#57534E] hover:text-[#181715] cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex border border-[#C5BDB0] bg-[#FFFFFF] rounded overflow-hidden">
              {ACTION_TYPES.map((t) => (
                <button
                  key={t || 'all'}
                  type="button"
                  onClick={() => setActionType(t)}
                  className={`px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
                    actionType === t
                      ? 'bg-[#181715] text-[#FBF9F5]'
                      : 'text-[#57534E] hover:text-[#181715]'
                  }`}
                >
                  {t || 'All Actions'}
                </button>
              ))}
            </div>

            <select
              value={agency}
              onChange={(e) => setAgency(e.target.value)}
              aria-label="Filter by state agency"
              className="px-3 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded max-w-xs"
            >
              <option value="">All State Agencies ({agencies.length})</option>
              {agencies.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>

            <label className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded text-[#181715] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={linkedOnly}
                onChange={(e) => setLinkedOnly(e.target.checked)}
                className="accent-[#9A3412]"
              />
              Linked to Bills Only
            </label>
          </div>
        </div>
      </section>

      {/* Two-Column Split Ledger (Matched Height) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:items-stretch">
        {/* Left 5 cols: Scrollable Agency Rules Ledger */}
        <div className="lg:col-span-5 lg:relative">
          <div className="border border-[#DFD9CE] bg-[#FFFFFF] flex flex-col lg:absolute lg:inset-0">
            <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between text-xs font-medium text-[#57534E] shrink-0">
              <span className="font-mono tabular-nums">
                {loadingList ? 'Querying rules_fts…' : `${rules.length} rule notice${rules.length === 1 ? '' : 's'}`}
              </span>
              <span>Ordered by weekly issue date</span>
            </div>

            {rules.length === 0 && !loadingList ? (
              <div className="p-8 text-center space-y-3 flex-1 flex flex-col items-center justify-center">
                <p className="text-sm text-[#57534E]">
                  No Texas Register rule notices matched your filters.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setAgency('');
                    setActionType('');
                    setLinkedOnly(false);
                  }}
                  className="px-3 py-1.5 text-xs font-medium border border-[#C5BDB0] rounded hover:border-[#181715] cursor-pointer"
                >
                  Reset Filters
                </button>
              </div>
            ) : (
              <div className="divide-y divide-[#DFD9CE] flex-1 min-h-0 max-h-[640px] lg:max-h-none overflow-y-auto">
                {rules.map((r) => {
                  const active = r.id === selectedRuleId;
                  const actionColor =
                    r.actionType === 'Adopted'
                      ? 'text-[#14532D]'
                      : r.actionType === 'Emergency'
                        ? 'text-[#991B1B]'
                        : r.actionType === 'Withdrawn'
                          ? 'text-[#78716C]'
                          : 'text-[#9A3412]';
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onSelectRule(r.id)}
                      className={`w-full p-4 text-left transition-colors cursor-pointer block ${
                        active ? 'bg-[#F4F0E8]' : 'hover:bg-[#FBF9F5]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs font-mono text-[#57534E] tabular-nums">
                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                          <span className={`font-semibold ${actionColor}`}>{r.actionType}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-[#181715]">{r.tacCitation}</span>
                        </div>
                        <span className="text-[#78716C] shrink-0">{r.issueDate}</span>
                      </div>

                      <div className="text-[11px] font-medium text-[#1E3A5F] mt-1">
                        {r.agencyName}
                      </div>

                      <h3 className="font-display text-sm font-semibold text-[#181715] mt-0.5 leading-snug">
                        {r.title}
                      </h3>

                      <p className="text-xs text-[#57534E] mt-1.5 line-clamp-2 leading-relaxed">
                        {r.summary}
                      </p>

                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono tabular-nums text-[#78716C]">
                        <span className={r.linkedBillsCount > 0 ? 'text-[#9A3412] font-medium' : ''}>
                          {r.linkedBillsCount > 0
                            ? `${r.linkedBillsCount} linked (${r.linkedBillsPreview.map((p) => p.billNumber).join(', ')})`
                            : '0 linked bills'}
                        </span>
                        {r.fiscalImpactAmount !== null && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span
                              className={
                                r.fiscalImpactAmount < 0
                                  ? 'text-[#991B1B] font-medium'
                                  : r.fiscalImpactAmount > 0
                                    ? 'text-[#14532D] font-medium'
                                    : 'text-[#57534E]'
                              }
                            >
                              Fiscal: {formatDollars(r.fiscalImpactAmount)}
                            </span>
                          </>
                        )}
                        {r.volume > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              Vol. {r.volume}, No. {r.issueNumber}
                            </span>
                          </>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right 7 cols: Full Agency Rule Dossier */}
        <div className="lg:col-span-7 border border-[#DFD9CE] bg-[#FFFFFF] lg:min-h-[640px]">
          {loadingDetail ? (
            <div className="p-8 text-sm text-[#57534E]">Loading Texas Register rule dossier…</div>
          ) : !detail ? (
            <div className="p-8 text-sm text-[#57534E]">
              Select a Texas Register rule notice from the left ledger to inspect its statutory authority,
              linked Texas Legislature bills, and preamble fiscal note.
            </div>
          ) : (
            <div>
              {/* Rule Masthead */}
              <div className="p-6 border-b border-[#DFD9CE] bg-[#FBF9F5] space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-[#57534E] tabular-nums">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[#9A3412]">{detail.actionType}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-semibold text-[#181715]">{detail.tacCitation}</span>
                    <span aria-hidden="true">·</span>
                    <span>Issue {detail.issueDate}</span>
                    {detail.volume > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          Vol. {detail.volume}, No. {detail.issueNumber}
                          {detail.pageRange ? ` (pp. ${detail.pageRange})` : ''}
                        </span>
                      </>
                    )}
                  </div>
                  {detail.sourceUrl && (
                    <a
                      href={detail.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-sans font-medium text-[#1E3A5F] hover:text-[#9A3412]"
                    >
                      Source Issue <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>

                <div className="text-xs font-medium text-[#1E3A5F]">
                  {detail.agencyName}
                  {detail.tacTitle ? ` — ${detail.tacTitle}` : ''}
                </div>

                <h2 className="font-display text-2xl font-bold text-[#181715] leading-tight">
                  {detail.title}
                </h2>

                <p className="text-sm text-[#181715] leading-relaxed">{detail.summary}</p>
              </div>

              <div className="p-6 space-y-6">
                {/* Linked Authorizing Texas Legislature Bills */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] flex items-center gap-1.5">
                      <Scale className="w-3.5 h-3.5 text-[#9A3412]" />
                      Linked Authorizing Legislation ({detail.linkedBills.length})
                    </h3>
                    {detail.citedBills.length > 0 && (
                      <span className="text-[11px] font-mono text-[#78716C]">
                        Cited in notice: {detail.citedBills.join(' · ')}
                      </span>
                    )}
                  </div>

                  {detail.linkedBills.length === 0 ? (
                    <div className="p-4 border border-[#DFD9CE] bg-[#FBF9F5] text-xs text-[#57534E]">
                      No indexed bills in your local archive matched this rule&apos;s bill citations or specific statutory sections yet.
                      Sync additional legislative sessions via TLO FTP and click <span className="font-medium text-[#181715]">Re-Link Bills</span>.
                    </div>
                  ) : (
                    <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE] bg-[#FBF9F5]">
                      {detail.linkedBills.map((lb) => {
                        const gr = lb.biennialGrImpact;
                        return (
                          <button
                            key={lb.billId}
                            type="button"
                            onClick={() => onOpenBill(lb.billId)}
                            className="w-full p-3.5 text-left hover:bg-[#F4F0E8] transition-colors cursor-pointer flex items-start justify-between gap-4"
                          >
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                                <span className="font-semibold text-[#9A3412]">{lb.session}</span>
                                <span className="font-semibold text-[#181715]">{lb.billNumber}</span>
                                <OutcomeIndicator outcome={lb.outcome} detail={lb.outcomeDetail} />
                                <span aria-hidden="true" className="text-[#C5BDB0]">·</span>
                                <span className="text-[#1E3A5F]">{lb.linkBasis}</span>
                                <span className="text-[#78716C]">({lb.matchedRef})</span>
                              </div>
                              <div className="text-xs font-medium text-[#181715] leading-snug">
                                {lb.title}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-[#57534E] tabular-nums">
                                <span>Author: {lb.primaryAuthor}</span>
                                {lb.fiscalStatus && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span
                                      className={
                                        gr != null && gr < 0
                                          ? 'text-[#991B1B] font-medium'
                                          : 'text-[#181715]'
                                      }
                                    >
                                      Bill LBB 2-Yr GR: {gr != null ? formatDollars(gr) : lb.fiscalStatus}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                            <ArrowUpRight className="w-4 h-4 text-[#78716C] shrink-0 mt-0.5" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Agency Fiscal Note & Government Growth Impact Statement */}
                <div className="border-t border-[#DFD9CE] pt-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] flex items-center gap-1.5">
                      <DollarSign className="w-3.5 h-3.5 text-[#9A3412]" />
                      Rule Preamble Fiscal Note &amp; Government Growth Impact
                    </h3>
                    {detail.fiscalImpactAmount !== null && (
                      <span
                        className={`text-xs font-mono font-semibold tabular-nums ${
                          detail.fiscalImpactAmount < 0
                            ? 'text-[#991B1B]'
                            : detail.fiscalImpactAmount > 0
                              ? 'text-[#14532D]'
                              : 'text-[#57534E]'
                        }`}
                      >
                        Parsed Est.: {formatDollars(detail.fiscalImpactAmount)}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-3.5 bg-[#FBF9F5] border border-[#DFD9CE] space-y-1.5">
                      <div className="text-[11px] font-mono uppercase text-[#78716C]">
                        Agency Fiscal Implication (Gov&apos;t Code §2001.024)
                      </div>
                      <p className="text-xs text-[#181715] leading-relaxed">
                        {detail.fiscalNoteText || 'No fiscal note paragraph extracted from this notice.'}
                      </p>
                    </div>
                    <div className="p-3.5 bg-[#FBF9F5] border border-[#DFD9CE] space-y-1.5">
                      <div className="text-[11px] font-mono uppercase text-[#78716C]">
                        Government Growth Impact (Gov&apos;t Code §2001.0221)
                      </div>
                      <p className="text-xs text-[#181715] leading-relaxed">
                        {detail.governmentGrowthNote || 'No government growth statement extracted from this notice.'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Statutory Authority */}
                <div className="border-t border-[#DFD9CE] pt-4 space-y-2">
                  <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E]">
                    Statutory Authority &amp; Cross-Referenced Codes
                  </h3>
                  {detail.statutoryAuthority && (
                    <p className="text-xs text-[#181715] leading-relaxed">{detail.statutoryAuthority}</p>
                  )}
                  <div className="text-xs font-mono text-[#57534E]">
                    {detail.statuteCodes.length > 0
                      ? detail.statuteCodes.join(' · ')
                      : 'No specific Texas Code sections parsed'}
                  </div>
                </div>

                {/* Full Register Notice Text */}
                <div className="border-t border-[#DFD9CE] pt-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E]">
                      Texas Register Notice Text
                    </h3>
                    <span className="text-[11px] font-mono text-[#78716C]">{detail.source}</span>
                  </div>
                  <pre className="p-4 bg-[#FBF9F5] border border-[#DFD9CE] text-xs font-mono text-[#181715] whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
                    {detail.fullText}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Manual SOS Texas Register Import Modal */}
      {showImportModal && (
        <div
          className="fixed inset-0 z-50 bg-[#181715]/50 flex items-center justify-center p-4"
          onClick={() => setShowImportModal(false)}
        >
          <div
            className="bg-[#FBF9F5] border border-[#C5BDB0] w-full max-w-2xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between">
              <div>
                <h2 className="font-display text-lg font-bold text-[#181715]">
                  Import Texas Register Notice (SOS Report)
                </h2>
                <p className="text-xs text-[#57534E]">
                  Paste a weekly rule notice or HTML directly from{' '}
                  <a
                    href="https://www.sos.state.tx.us/texreg/index.shtml"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#9A3412] underline"
                  >
                    sos.state.tx.us/texreg/index.shtml
                  </a>{' '}
                  to parse TAC citations, fiscal preambles, and automatic bill links.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="p-1.5 text-[#57534E] hover:text-[#181715] cursor-pointer"
                aria-label="Close import modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleImportSubmit} className="p-6 space-y-4 overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="text-xs text-[#57534E] space-y-1 block">
                  <span>Issue Date</span>
                  <input
                    type="date"
                    value={importDate}
                    onChange={(e) => setImportDate(e.target.value)}
                    required
                    className="w-full px-2.5 py-1.5 font-mono text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded text-[#181715]"
                  />
                </label>
                <label className="text-xs text-[#57534E] space-y-1 block">
                  <span>Action Type (auto if blank)</span>
                  <select
                    value={importAction}
                    onChange={(e) => setImportAction(e.target.value as '' | AgencyRuleActionType)}
                    className="w-full px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded text-[#181715]"
                  >
                    <option value="">Auto-detect</option>
                    <option value="Proposed">Proposed</option>
                    <option value="Adopted">Adopted</option>
                    <option value="Emergency">Emergency</option>
                    <option value="Withdrawn">Withdrawn</option>
                    <option value="Rule Review">Rule Review</option>
                  </select>
                </label>
                <label className="text-xs text-[#57534E] space-y-1 block">
                  <span>Agency Override (optional)</span>
                  <input
                    type="text"
                    value={importAgency}
                    onChange={(e) => setImportAgency(e.target.value)}
                    placeholder="e.g. Texas Education Agency"
                    className="w-full px-2.5 py-1.5 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded text-[#181715]"
                  />
                </label>
              </div>

              <label className="text-xs text-[#57534E] space-y-1 block">
                <span>Source URL (optional)</span>
                <input
                  type="url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  className="w-full px-2.5 py-1.5 font-mono text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded text-[#181715]"
                />
              </label>

              <label className="text-xs text-[#57534E] space-y-1 block">
                <span>Texas Register Rule Text or HTML</span>
                <textarea
                  rows={9}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  required
                  placeholder={`Paste a Texas Register weekly notice here (e.g. "19 TAC §61.1008 ... implements House Bill 2, 89th Legislature ... FISCAL NOTE: ...")`}
                  className="w-full p-3 font-mono text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded text-[#181715] focus:outline-none focus:border-[#9A3412]"
                />
              </label>

              {importError && <p className="text-xs text-[#991B1B]">{importError}</p>}
              {importResult && <p className="text-xs text-[#14532D] font-medium">{importResult}</p>}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#DFD9CE]">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-3.5 py-2 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={importing || importText.trim().length < 60}
                  className="px-4 py-2 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] disabled:opacity-50 cursor-pointer"
                >
                  {importing ? 'Parsing & Linking…' : 'Parse & Index Rule'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
