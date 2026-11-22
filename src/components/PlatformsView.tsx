import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  Download,
  ExternalLink,
  FilePlus2,
  FlaskConical,
  RefreshCw,
  Scale,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import type {
  PlatformParty,
  PlatformPlank,
  PlatformsOverviewResponse,
  WordfishResult,
  WordscoresEntityRow,
  WordscoresTextResult,
} from '../types.ts';

interface PlatformsViewProps {
  activeSession: string;
  onOpenBill: (billId: string) => void;
  onOpenRule: (ruleId: string) => void;
  refreshSignal: number;
  onDataMutated: () => void;
}

type ScalingTab = 'rile' | 'wordscores' | 'wordfish' | 'planks';

function safeExternalUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
    return null;
  } catch {
    return null;
  }
}

function formatSigned(n: number, digits = 2): string {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const csv = [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const PlatformsView: React.FC<PlatformsViewProps> = ({
  activeSession,
  onOpenBill,
  onOpenRule,
  refreshSignal,
  onDataMutated,
}) => {
  const [tab, setTab] = useState<ScalingTab>('rile');
  const [overview, setOverview] = useState<PlatformsOverviewResponse | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [bannerMsg, setBannerMsg] = useState<string>('');
  const [bannerError, setBannerError] = useState<string>('');

  // Wordscores state
  const [wsEntityType, setWsEntityType] = useState<'bill' | 'rule'>('bill');
  const [wsConfidence, setWsConfidence] = useState<string>('reliable');
  const [wsChamber, setWsChamber] = useState<string>('');
  const [wsSort, setWsSort] = useState<string>('score_asc');
  const [wsQuery, setWsQuery] = useState<string>('');
  const [wsRows, setWsRows] = useState<WordscoresEntityRow[]>([]);
  const [wsLoading, setWsLoading] = useState(false);
  const [wsSelectedId, setWsSelectedId] = useState<string>('');

  // Custom Text Wordscores Sandbox
  const [sandboxText, setSandboxText] = useState<string>('');
  const [sandboxLoading, setSandboxLoading] = useState(false);
  const [sandboxError, setSandboxError] = useState<string>('');
  const [sandboxResult, setSandboxResult] = useState<WordscoresTextResult | null>(null);

  // Wordfish state
  const [wfMode, setWfMode] = useState<'topic_corpus' | 'historical_platforms'>('topic_corpus');
  const [wfDomain, setWfDomain] = useState<string>('All Indexed Policy Domains');
  const [wfResult, setWfResult] = useState<WordfishResult | null>(null);
  const [wfLoading, setWfLoading] = useState(false);
  const [wfHoverWord, setWfHoverWord] = useState<{
    term: string;
    beta: number;
    psi: number;
    totalCount: number;
  } | null>(null);

  // Plank Explorer state
  const [plankQuery, setPlankQuery] = useState<string>('');
  const [plankParty, setPlankParty] = useState<string>('');
  const [plankDomain, setPlankDomain] = useState<string>('');
  const [plankRileCode, setPlankRileCode] = useState<string>('');
  const [planks, setPlanks] = useState<PlatformPlank[]>([]);
  const [planksTotal, setPlanksTotal] = useState<number>(0);
  const [planksLoading, setPlanksLoading] = useState(false);
  const [selectedPlankId, setSelectedPlankId] = useState<string>('');

  // Import Modal state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importParty, setImportParty] = useState<PlatformParty>('Democratic');
  const [importYear, setImportYear] = useState<string>('2024');
  const [importTitle, setImportTitle] = useState<string>('');
  const [importUrl, setImportUrl] = useState<string>('');
  const [importRawText, setImportRawText] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string>('');

  const loadOverview = useCallback(() => {
    setLoadingOverview(true);
    fetch('/api/platforms')
      .then((r) => r.json())
      .then((data: PlatformsOverviewResponse) => {
        setOverview(data);
        if (data.syncInProgress) {
          setSyncing(true);
        } else {
          setSyncing(false);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingOverview(false));
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview, refreshSignal]);

  // Poll briefly if background boot sync is currently running
  useEffect(() => {
    if (!overview?.syncInProgress) return;
    const id = window.setInterval(() => {
      loadOverview();
    }, 2500);
    return () => window.clearInterval(id);
  }, [overview?.syncInProgress, loadOverview]);

  // Fetch Wordscores list when on Wordscores tab
  useEffect(() => {
    if (tab !== 'wordscores') return;
    let cancelled = false;
    setWsLoading(true);
    const params = new URLSearchParams();
    params.set('entityType', wsEntityType);
    if (wsEntityType === 'bill' && activeSession) params.set('session', activeSession);
    if (wsEntityType === 'bill' && wsChamber) params.set('chamber', wsChamber);
    if (wsConfidence) params.set('confidence', wsConfidence);
    if (wsSort) params.set('sort', wsSort);
    if (wsQuery.trim()) params.set('q', wsQuery.trim());
    params.set('limit', '150');

    fetch(`/api/platforms/wordscores?${params.toString()}`)
      .then((r) => r.json())
      .then((data: { items: WordscoresEntityRow[] }) => {
        if (!cancelled) {
          setWsRows(data.items || []);
          if (data.items?.length && !wsSelectedId) {
            setWsSelectedId(data.items[0].entityId);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setWsRows([]);
      })
      .finally(() => {
        if (!cancelled) setWsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab, wsEntityType, activeSession, wsChamber, wsConfidence, wsSort, wsQuery, refreshSignal, overview?.vocabStats.totalTerms]);

  // Fetch Wordfish when on Wordfish tab
  useEffect(() => {
    if (tab !== 'wordfish') return;
    let cancelled = false;
    setWfLoading(true);
    const params = new URLSearchParams();
    params.set('mode', wfMode);
    params.set('domain', wfDomain);
    if (activeSession) params.set('session', activeSession);
    fetch(`/api/platforms/wordfish?${params.toString()}`)
      .then((r) => r.json())
      .then((data: WordfishResult) => {
        if (!cancelled) {
          setWfResult(data);
          setWfHoverWord(null);
        }
      })
      .catch(() => {
        if (!cancelled) setWfResult(null);
      })
      .finally(() => {
        if (!cancelled) setWfLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, wfMode, wfDomain, activeSession, refreshSignal, overview?.platforms.length]);

  // Fetch Planks when on Plank Explorer tab
  useEffect(() => {
    if (tab !== 'planks') return;
    let cancelled = false;
    setPlanksLoading(true);
    const params = new URLSearchParams();
    if (plankQuery.trim()) params.set('q', plankQuery.trim());
    if (plankParty) params.set('party', plankParty);
    if (plankDomain) params.set('domain', plankDomain);
    if (plankRileCode) params.set('rileCode', plankRileCode);
    params.set('limit', '120');

    fetch(`/api/platforms/planks?${params.toString()}`)
      .then((r) => r.json())
      .then((data: { totalMatches: number; planks: PlatformPlank[] }) => {
        if (!cancelled) {
          const list = data.planks || [];
          setPlanks(list);
          setPlanksTotal(data.totalMatches || 0);
          if (list.length > 0 && !list.some((p) => p.id === selectedPlankId)) {
            setSelectedPlankId(list[0].id);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setPlanks([]);
      })
      .finally(() => {
        if (!cancelled) setPlanksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, plankQuery, plankParty, plankDomain, plankRileCode, refreshSignal, overview?.platforms.length]);

  const handleSyncOfficial = async () => {
    setSyncing(true);
    setBannerError('');
    setBannerMsg('');
    try {
      const res = await fetch('/api/platforms/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      setBannerMsg(
        `Synced 2026 Texas party platforms (${data.synced?.map((s: { plankCount: number }) => `${s.plankCount} planks`).join(' + ')}) and rescored ${data.billsScored} bills & ${data.rulesScored} agency rules.`
      );
      loadOverview();
      onDataMutated();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Platform sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  const handleRecomputeScores = async () => {
    setRecomputing(true);
    setBannerError('');
    setBannerMsg('');
    try {
      const res = await fetch('/api/platforms/recompute', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Recompute failed');
      setBannerMsg(
        `Rebuilt Wordscores reference dictionary and updated ${data.billsScored} bills & ${data.rulesScored} agency rules.`
      );
      loadOverview();
      onDataMutated();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Recompute failed.');
    } finally {
      setRecomputing(false);
    }
  };

  const handleDeletePlatform = async (id: string) => {
    setBannerError('');
    try {
      const res = await fetch(`/api/platforms/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setBannerMsg('Platform removed and scaling indices refreshed.');
      loadOverview();
      onDataMutated();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to delete platform.');
    }
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setImporting(true);
    setImportError('');
    try {
      const res = await fetch('/api/platforms/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          party: importParty,
          year: Number(importYear),
          title: importTitle.trim(),
          sourceUrl: importUrl.trim(),
          rawText: importRawText.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setShowImportModal(false);
      setImportTitle('');
      setImportUrl('');
      setImportRawText('');
      setBannerMsg(
        `Imported "${importTitle.trim()}" (${data.platform?.plankCount ?? 0} planks, MARPOR RILE ${data.platform?.rileScore ?? 0}) and refreshed Wordscores.`
      );
      loadOverview();
      onDataMutated();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import platform.');
    } finally {
      setImporting(false);
    }
  };

  const handleScoreSandbox = async () => {
    setSandboxLoading(true);
    setSandboxError('');
    try {
      const res = await fetch('/api/platforms/wordscores/score-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sandboxText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scoring failed');
      setSandboxResult(data);
    } catch (err) {
      setSandboxError(err instanceof Error ? err.message : 'Failed to score text.');
      setSandboxResult(null);
    } finally {
      setSandboxLoading(false);
    }
  };

  const latestDem = useMemo(
    () => overview?.platforms.find((p) => p.party === 'Democratic') ?? null,
    [overview]
  );
  const latestRep = useMemo(
    () => overview?.platforms.find((p) => p.party === 'Republican') ?? null,
    [overview]
  );

  // Unified Texas domain comparison rows
  const domainComparison = useMemo(() => {
    if (!overview) return [];
    const demMap = new Map((latestDem?.domainSalience || []).map((d) => [d.domain, d]));
    const repMap = new Map((latestRep?.domainSalience || []).map((d) => [d.domain, d]));
    return overview.availableDomains.map((domain) => ({
      domain,
      demCount: demMap.get(domain)?.count ?? 0,
      demPct: demMap.get(domain)?.sharePct ?? 0,
      repCount: repMap.get(domain)?.count ?? 0,
      repPct: repMap.get(domain)?.sharePct ?? 0,
    }));
  }, [overview, latestDem, latestRep]);

  // Unified MARPOR RILE category comparison rows
  const rileComparison = useMemo(() => {
    if (!overview) return [];
    const demMap = new Map((latestDem?.rileBreakdown || []).map((c) => [c.code, c]));
    const repMap = new Map((latestRep?.rileBreakdown || []).map((c) => [c.code, c]));
    return overview.rileCategories
      .map((cat) => ({
        code: cat.code,
        label: cat.label,
        direction: cat.direction,
        demCount: demMap.get(cat.code)?.count ?? 0,
        demPct: demMap.get(cat.code)?.sharePct ?? 0,
        repCount: repMap.get(cat.code)?.count ?? 0,
        repPct: repMap.get(cat.code)?.sharePct ?? 0,
      }))
      .filter((r) => r.demCount > 0 || r.repCount > 0)
      .sort((a, b) => b.demCount + b.repCount - (a.demCount + a.repCount));
  }, [overview, latestDem, latestRep]);

  const selectedPlank = useMemo(
    () => planks.find((p) => p.id === selectedPlankId) ?? planks[0] ?? null,
    [planks, selectedPlankId]
  );

  const selectedWsRow = useMemo(
    () => wsRows.find((r) => r.entityId === wsSelectedId) ?? wsRows[0] ?? null,
    [wsRows, wsSelectedId]
  );

  const jumpToPlanksWithFilter = (opts: { domain?: string; rileCode?: string; party?: string }) => {
    setPlankDomain(opts.domain ?? '');
    setPlankRileCode(opts.rileCode ?? '');
    setPlankParty(opts.party ?? '');
    setPlankQuery('');
    setTab('planks');
  };

  const handleExportCurrentCsv = useCallback(() => {
    if (tab === 'wordscores' && wsRows.length > 0) {
      downloadCsv(
        `texas-wordscores-${wsEntityType}s.csv`,
        [
          'Entity',
          'Session/Date',
          'Chamber/Agency',
          'Title',
          'Author/Citation',
          'Stage/Action',
          'Transformed Wordscore',
          'Raw Wordscore',
          'Standard Error',
          'Matched Tokens',
          'Total Tokens',
          'Overlap %',
          'Confidence',
        ],
        wsRows.map((r) => [
          r.label,
          r.sessionOrDate,
          r.chamberOrAgency,
          r.title,
          r.authorOrCitation,
          r.stageOrAction,
          r.transformedWordscore,
          r.rawWordscore,
          r.standardError,
          r.matchedTokens,
          r.totalTokens,
          r.overlapPct,
          r.confidenceTier,
        ])
      );
    } else if (tab === 'planks' && planks.length > 0) {
      downloadCsv(
        'texas-platform-planks.csv',
        ['Party', 'Year', 'Chapter', 'Plank Number', 'Heading', 'Texas Domain', 'MARPOR Code', 'RILE Direction', 'Word Count', 'Body'],
        planks.map((p) => [
          p.party,
          p.year,
          p.chapter,
          p.plankNumber,
          p.heading,
          p.texasDomain,
          p.rileCode,
          p.rileDirection,
          p.wordCount,
          p.body,
        ])
      );
    } else if (tab === 'wordfish' && wfResult?.available) {
      downloadCsv(
        `texas-wordfish-${wfResult.mode}.csv`,
        ['Document', 'Kind', 'Subtitle', 'Omega (Latent Position)', 'Omega SE', 'Alpha (Length FE)', 'Clean Word Count'],
        wfResult.documents.map((d) => [
          d.label,
          d.kind,
          d.subtitle,
          d.omega,
          d.omegaSe,
          d.alpha,
          d.wordCount,
        ])
      );
    } else if (tab === 'rile' && rileComparison.length > 0) {
      downloadCsv(
        'texas-platforms-marpor-rile.csv',
        ['MARPOR Code', 'Category', 'RILE Pole', 'Democratic Planks', 'Democratic %', 'Republican Planks', 'Republican %'],
        rileComparison.map((r) => [
          r.code,
          r.label,
          r.direction,
          r.demCount,
          r.demPct,
          r.repCount,
          r.repPct,
        ])
      );
    }
  }, [tab, wsRows, wsEntityType, planks, wfResult, rileComparison]);

  useEffect(() => {
    const onExport = () => handleExportCurrentCsv();
    window.addEventListener('capitol:export-csv', onExport);
    return () => window.removeEventListener('capitol:export-csv', onExport);
  }, [handleExportCurrentCsv]);

  // Eiffel Tower plot bounds for Wordfish
  const eiffelBounds = useMemo(() => {
    if (!wfResult || wfResult.words.length === 0) {
      return { minBeta: -2, maxBeta: 2, minPsi: -4, maxPsi: 2 };
    }
    let minBeta = -1;
    let maxBeta = 1;
    let minPsi = 0;
    let maxPsi = 0;
    for (const w of wfResult.words) {
      if (w.beta < minBeta) minBeta = w.beta;
      if (w.beta > maxBeta) maxBeta = w.beta;
      if (w.psi < minPsi) minPsi = w.psi;
      if (w.psi > maxPsi) maxPsi = w.psi;
    }
    const maxAbsB = Math.max(Math.abs(minBeta), Math.abs(maxBeta), 1) * 1.12;
    return {
      minBeta: -maxAbsB,
      maxBeta: maxAbsB,
      minPsi: minPsi - 0.35,
      maxPsi: maxPsi + 0.45,
    };
  }, [wfResult]);

  return (
    <div className="space-y-6">
      {/* Masthead */}
      <section className="border border-[#DFD9CE] bg-[#FFFFFF] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <h1 className="font-display text-2xl font-bold text-[#181715] tracking-tight">
              Party Platforms &amp; Political Text Scaling
            </h1>
            <p className="text-sm text-[#57534E] mt-1.5 leading-relaxed">
              Computational scaling of the official 2026 Texas Democratic and Republican party platforms
              using Manifesto Project RILE coding (Budge et al.), supervised Wordscores (Laver, Benoit &amp;
              Garry 2003), and unsupervised Wordfish Poisson scaling (Slapin &amp; Proksch 2008). All scores
              measure lexical and thematic overlap with transparent term-level provenance.
            </p>
            {overview && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-mono text-[#57534E] tabular-nums">
                <span>{overview.platforms.length} Platforms Indexed</span>
                <span aria-hidden="true">·</span>
                <span>
                  {overview.platforms.reduce((s, p) => s + p.plankCount, 0).toLocaleString()} Planks
                </span>
                <span aria-hidden="true">·</span>
                <span>{overview.vocabStats.totalTerms.toLocaleString()} Wordscores Terms</span>
                <span aria-hidden="true">·</span>
                <span>
                  {overview.vocabStats.scoredBillsCount.toLocaleString()} Bills &amp;{' '}
                  {overview.vocabStats.scoredRulesCount.toLocaleString()} Rules Scored
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleSyncOfficial}
              disabled={syncing}
              className="px-3.5 py-2 text-xs font-medium bg-[#181715] text-[#FBF9F5] rounded hover:bg-[#9A3412] disabled:opacity-60 inline-flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing 2026 PDFs…' : 'Sync 2026 Platforms'}
            </button>
            <button
              type="button"
              onClick={() => setShowImportModal(true)}
              className="px-3.5 py-2 text-xs font-medium border border-[#C5BDB0] bg-[#FFFFFF] text-[#181715] rounded hover:border-[#181715] inline-flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap"
            >
              <FilePlus2 className="w-3.5 h-3.5 text-[#9A3412]" />
              Import Platform
            </button>
            <button
              type="button"
              onClick={handleRecomputeScores}
              disabled={recomputing || syncing}
              className="px-3 py-2 text-xs font-medium border border-[#C5BDB0] bg-[#FBF9F5] text-[#57534E] rounded hover:text-[#181715] hover:border-[#181715] disabled:opacity-60 inline-flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              {recomputing ? 'Recomputing…' : 'Rescore Bills'}
            </button>
            <button
              type="button"
              onClick={handleExportCurrentCsv}
              className="px-3 py-2 text-xs font-medium border border-[#C5BDB0] bg-[#FBF9F5] text-[#14532D] rounded hover:border-[#14532D] inline-flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
          </div>
        </div>

        {(bannerMsg || bannerError) && (
          <div
            className={`mt-4 px-3.5 py-2.5 text-xs border flex items-center justify-between gap-3 ${
              bannerError
                ? 'border-[#991B1B]/40 bg-[#FEE2E2]/40 text-[#991B1B]'
                : 'border-[#14532D]/30 bg-[#DCFCE7]/40 text-[#14532D]'
            }`}
          >
            <span>{bannerError || bannerMsg}</span>
            <button
              type="button"
              onClick={() => {
                setBannerMsg('');
                setBannerError('');
              }}
              className="text-current hover:opacity-70 cursor-pointer"
              aria-label="Dismiss notice"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Sub-Navigation Tabs */}
        <div className="mt-5 pt-3 border-t border-[#DFD9CE] flex items-center gap-6 overflow-x-auto">
          {[
            { id: 'rile', label: 'Manifesto RILE & Salience', icon: BookOpen },
            { id: 'wordscores', label: 'Wordscores (Laver–Benoit–Garry)', icon: Scale },
            { id: 'wordfish', label: 'Wordfish (Slapin–Proksch)', icon: FlaskConical },
            { id: 'planks', label: 'Plank Explorer (FTS5)', icon: Search },
          ].map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id as ScalingTab)}
                className={`pb-2 text-xs font-medium inline-flex items-center gap-1.5 border-b-2 whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  active
                    ? 'border-[#9A3412] text-[#9A3412]'
                    : 'border-transparent text-[#57534E] hover:text-[#181715]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>
      </section>

      {loadingOverview && !overview ? (
        <div className="border border-[#DFD9CE] bg-[#FFFFFF] p-8 text-sm text-[#57534E]">
          Loading Texas party platforms and scaling matrices…
        </div>
      ) : overview && overview.platforms.length === 0 ? (
        <div className="border border-[#DFD9CE] bg-[#FFFFFF] p-8 text-center space-y-3">
          <p className="text-sm text-[#181715] font-medium">
            {overview.syncInProgress
              ? 'Downloading and parsing the official 2026 Texas Democratic and Republican platform PDFs…'
              : 'No party platforms are indexed yet.'}
          </p>
          <p className="text-xs text-[#57534E] max-w-xl mx-auto">
            Click Sync 2026 Platforms to fetch both official PDFs, extract all planks, compute MARPOR RILE
            and Texas policy salience, and score indexed Texas bills with Wordscores.
          </p>
          {!overview.syncInProgress && (
            <button
              type="button"
              onClick={handleSyncOfficial}
              className="px-4 py-2 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] cursor-pointer"
            >
              Sync Official 2026 Platforms
            </button>
          )}
        </div>
      ) : (
        <>
          {/* ================================================================ */}
          {/* TAB 1: MANIFESTO PROJECT RILE & TEXAS POLICY DOMAIN SALIENCE     */}
          {/* ================================================================ */}
          {tab === 'rile' && overview && (
            <div className="space-y-6">
              {/* Platform Summary Comparison Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
                {overview.platforms.map((plat) => {
                  const isDem = plat.party === 'Democratic';
                  const isRep = plat.party === 'Republican';
                  const accentClass = isDem
                    ? 'text-[#1E3A5F]'
                    : isRep
                      ? 'text-[#991B1B]'
                      : 'text-[#57534E]';
                  const safeUrl = safeExternalUrl(plat.sourceUrl);
                  const totalCoded = Math.max(1, plat.plankCount);
                  const leftPct = Math.round((plat.rileLeftCount / totalCoded) * 100);
                  const rightPct = Math.round((plat.rileRightCount / totalCoded) * 100);
                  const neutPct = Math.max(0, 100 - leftPct - rightPct);
                  const isOfficial =
                    plat.id === 'platform-dem-2026' || plat.id === 'platform-rep-2026';

                  return (
                    <div
                      key={plat.id}
                      className="border border-[#DFD9CE] bg-[#FFFFFF] p-5 flex flex-col justify-between space-y-4"
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2 text-xs font-mono text-[#57534E]">
                              <span className={`font-semibold ${accentClass}`}>
                                {plat.party} Party · {plat.year}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">{plat.pageCount} pages</span>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">
                                {plat.wordCount.toLocaleString()} words
                              </span>
                            </div>
                            <h2 className="font-display text-lg font-bold text-[#181715] mt-1">
                              {plat.title}
                            </h2>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {safeUrl && (
                              <a
                                href={safeUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-[#57534E] hover:text-[#9A3412] inline-flex items-center gap-1 whitespace-nowrap"
                              >
                                PDF <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                            {!isOfficial && (
                              <button
                                type="button"
                                onClick={() => handleDeletePlatform(plat.id)}
                                className="p-1 text-[#78716C] hover:text-[#991B1B] cursor-pointer"
                                title="Remove imported platform"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* RILE Metrics Strip */}
                        <div className="grid grid-cols-3 gap-3 pt-2 font-mono tabular-nums">
                          <div className="p-2.5 bg-[#FBF9F5] border border-[#DFD9CE]">
                            <div className="text-[11px] text-[#78716C]">MARPOR RILE</div>
                            <div className={`text-base font-bold mt-0.5 ${accentClass}`}>
                              {formatSigned(plat.rileScore, 1)}
                            </div>
                            <div className="text-[10px] text-[#78716C]">Scale −100 to +100</div>
                          </div>
                          <div className="p-2.5 bg-[#FBF9F5] border border-[#DFD9CE]">
                            <div className="text-[11px] text-[#78716C]">Lowe Logit RILE</div>
                            <div className="text-base font-bold text-[#181715] mt-0.5">
                              {formatSigned(plat.rileLogit, 2)}
                            </div>
                            <div className="text-[10px] text-[#78716C]">log((R+0.5)/(L+0.5))</div>
                          </div>
                          <div className="p-2.5 bg-[#FBF9F5] border border-[#DFD9CE]">
                            <div className="text-[11px] text-[#78716C]">Indexed Planks</div>
                            <div className="text-base font-bold text-[#181715] mt-0.5">
                              {plat.plankCount}
                            </div>
                            <div className="text-[10px] text-[#78716C]">
                              {plat.rileLeftCount}L · {plat.rileRightCount}R · {plat.rileNeutralCount}N
                            </div>
                          </div>
                        </div>

                        {/* Proportional RILE Composition Bar */}
                        <div className="pt-1 space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-mono text-[#57534E] tabular-nums">
                            <span>Left-coded {leftPct}%</span>
                            <span>State / Uncoded {neutPct}%</span>
                            <span>Right-coded {rightPct}%</span>
                          </div>
                          <div className="h-2 w-full bg-[#EAE4D9] flex overflow-hidden">
                            <div
                              style={{ width: `${leftPct}%` }}
                              className="bg-[#1E3A5F]"
                              title={`MARPOR Left categories: ${plat.rileLeftCount} planks (${leftPct}%)`}
                            />
                            <div
                              style={{ width: `${neutPct}%` }}
                              className="bg-[#D6CFC2]"
                              title={`State-specific / Neutral planks: ${plat.rileNeutralCount} (${neutPct}%)`}
                            />
                            <div
                              style={{ width: `${rightPct}%` }}
                              className="bg-[#991B1B]"
                              title={`MARPOR Right categories: ${plat.rileRightCount} planks (${rightPct}%)`}
                            />
                          </div>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-[#F4F0E8] flex items-center justify-between text-xs">
                        <span className="text-[#78716C] truncate">
                          Top salience:{' '}
                          <strong className="text-[#181715] font-medium">
                            {plat.domainSalience[0]?.domain || '—'}
                          </strong>{' '}
                          ({plat.domainSalience[0]?.sharePct ?? 0}%)
                        </span>
                        <button
                          type="button"
                          onClick={() => jumpToPlanksWithFilter({ party: plat.party })}
                          className="text-[#9A3412] hover:underline font-medium whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Browse planks
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Texas Policy Domain Salience Comparison */}
              <section className="border border-[#DFD9CE] bg-[#FFFFFF]">
                <div className="px-5 py-3.5 bg-[#F4F0E8] border-b border-[#DFD9CE] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-display text-base font-bold text-[#181715]">
                      Texas Policy Domain Salience Comparison (2026 Platforms)
                    </h2>
                    <p className="text-xs text-[#57534E]">
                      Share of each platform’s planks devoted to Texas state policy domains. Click any row
                      to inspect verbatim planks from both parties.
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-xs font-mono text-[#57534E]">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block w-3 h-2 bg-[#1E3A5F]" aria-hidden="true" />
                      Democratic ({latestDem?.year ?? 2026})
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block w-3 h-2 bg-[#991B1B]" aria-hidden="true" />
                      Republican ({latestRep?.year ?? 2026})
                    </span>
                  </div>
                </div>

                <div className="divide-y divide-[#DFD9CE]">
                  {domainComparison.map((row) => {
                    const maxPct = Math.max(
                      1,
                      ...domainComparison.map((d) => Math.max(d.demPct, d.repPct))
                    );
                    return (
                      <button
                        key={row.domain}
                        type="button"
                        onClick={() => jumpToPlanksWithFilter({ domain: row.domain })}
                        className="w-full px-5 py-3 text-left hover:bg-[#FBF9F5] transition-colors cursor-pointer grid grid-cols-1 md:grid-cols-12 gap-3 items-center"
                      >
                        <div className="md:col-span-4 text-xs font-medium text-[#181715]">
                          {row.domain}
                        </div>
                        <div className="md:col-span-6 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-[#F4F0E8] overflow-hidden">
                              <div
                                style={{ width: `${(row.demPct / maxPct) * 100}%` }}
                                className="h-full bg-[#1E3A5F]"
                              />
                            </div>
                            <span className="w-24 text-right text-[11px] font-mono tabular-nums text-[#1E3A5F]">
                              {row.demPct.toFixed(1)}% ({row.demCount})
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-[#F4F0E8] overflow-hidden">
                              <div
                                style={{ width: `${(row.repPct / maxPct) * 100}%` }}
                                className="h-full bg-[#991B1B]"
                              />
                            </div>
                            <span className="w-24 text-right text-[11px] font-mono tabular-nums text-[#991B1B]">
                              {row.repPct.toFixed(1)}% ({row.repCount})
                            </span>
                          </div>
                        </div>
                        <div className="md:col-span-2 text-right text-xs font-mono tabular-nums text-[#57534E]">
                          Δ {formatSigned(row.repPct - row.demPct, 1)} pp
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* MARPOR RILE Category Breakdown Table */}
              <section className="border border-[#DFD9CE] bg-[#FFFFFF]">
                <div className="px-5 py-3.5 bg-[#F4F0E8] border-b border-[#DFD9CE] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-display text-base font-bold text-[#181715]">
                      Manifesto Project (MARPOR) RILE Category Ledger
                    </h2>
                    <p className="text-xs text-[#57534E]">
                      Deterministic keyword-coded share across standard Budge et al. Right/Left categories.
                      Click any category to audit the exact coded planks.
                    </p>
                  </div>
                  <span className="text-[11px] font-mono text-[#78716C]">
                    Note: MARPOR originated for national manifestos; state platforms also weight sub-national issues
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-[#DFD9CE] bg-[#FBF9F5] text-[#57534E] font-mono text-[11px]">
                        <th className="py-2.5 px-4 text-left font-medium">Code</th>
                        <th className="py-2.5 px-4 text-left font-medium">MARPOR Category</th>
                        <th className="py-2.5 px-4 text-left font-medium">RILE Pole</th>
                        <th className="py-2.5 px-4 text-right font-medium">Dem Planks</th>
                        <th className="py-2.5 px-4 text-right font-medium">Dem Share</th>
                        <th className="py-2.5 px-4 text-right font-medium">Rep Planks</th>
                        <th className="py-2.5 px-4 text-right font-medium">Rep Share</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#DFD9CE] font-mono tabular-nums">
                      {rileComparison.map((cat) => (
                        <tr
                          key={cat.code}
                          onClick={() => jumpToPlanksWithFilter({ rileCode: cat.code })}
                          className="hover:bg-[#FBF9F5] cursor-pointer transition-colors"
                        >
                          <td className="py-2.5 px-4 font-semibold text-[#9A3412]">{cat.code}</td>
                          <td className="py-2.5 px-4 font-sans font-medium text-[#181715]">
                            {cat.label}
                          </td>
                          <td
                            className={`py-2.5 px-4 ${
                              cat.direction === 'Left' ? 'text-[#1E3A5F]' : 'text-[#991B1B]'
                            }`}
                          >
                            {cat.direction}
                          </td>
                          <td className="py-2.5 px-4 text-right text-[#181715]">{cat.demCount}</td>
                          <td className="py-2.5 px-4 text-right text-[#1E3A5F]">
                            {cat.demPct.toFixed(1)}%
                          </td>
                          <td className="py-2.5 px-4 text-right text-[#181715]">{cat.repCount}</td>
                          <td className="py-2.5 px-4 text-right text-[#991B1B]">
                            {cat.repPct.toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          {/* ================================================================ */}
          {/* TAB 2: WORDSCORES (LAVER, BENOIT & GARRY 2003)                   */}
          {/* ================================================================ */}
          {tab === 'wordscores' && overview && (
            <div className="space-y-6">
              {/* Visual 1D Vocabulary Spectrum */}
              <section className="border border-[#DFD9CE] bg-[#FFFFFF] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-display text-base font-bold text-[#181715]">
                      Wordscores Platform Vocabulary Spectrum ({wsEntityType === 'bill' ? 'Texas Bills' : 'Agency Rules'})
                    </h2>
                    <p className="text-xs text-[#57534E]">
                      Corpus-calibrated Wordscores centered on the Texas legislative baseline (0.0 = typical bill,
                      ±1.0 = ±2 SD) using an Empirical-Bayes smoothed, plural-normalized 2026 platform lexicon
                      with statutory boilerplate excluded.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <div className="flex items-center border border-[#C5BDB0] rounded overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setWsEntityType('bill')}
                        className={`px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap ${
                          wsEntityType === 'bill'
                            ? 'bg-[#181715] text-[#FBF9F5]'
                            : 'bg-[#FFFFFF] text-[#57534E] hover:text-[#181715]'
                        }`}
                      >
                        Texas Bills
                      </button>
                      <button
                        type="button"
                        onClick={() => setWsEntityType('rule')}
                        className={`px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap ${
                          wsEntityType === 'rule'
                            ? 'bg-[#181715] text-[#FBF9F5]'
                            : 'bg-[#FFFFFF] text-[#57534E] hover:text-[#181715]'
                        }`}
                      >
                        Agency Rules
                      </button>
                    </div>
                  </div>
                </div>

                {/* Spectrum Strip Plot */}
                <div className="border border-[#DFD9CE] bg-[#FBF9F5] p-4">
                  <div className="flex items-center justify-between text-[11px] font-mono text-[#57534E] mb-2">
                    <span className="text-[#1E3A5F] font-semibold">−1.0 · 2026 Dem Platform Anchor</span>
                    <span>0.0 · Balanced Vocabulary</span>
                    <span className="text-[#991B1B] font-semibold">+1.0 · 2026 Rep Platform Anchor</span>
                  </div>
                  <div className="relative h-20 border-y border-[#DFD9CE] bg-[#FFFFFF]">
                    {/* Vertical grid lines */}
                    {[-1, -0.5, 0, 0.5, 1].map((tick) => {
                      const pct = ((tick + 1.25) / 2.5) * 100;
                      return (
                        <div
                          key={tick}
                          style={{ left: `${pct}%` }}
                          className={`absolute top-0 bottom-0 w-px ${
                            tick === 0 ? 'bg-[#181715]/40' : 'bg-[#DFD9CE]'
                          }`}
                        />
                      );
                    })}

                    {/* Entity markers */}
                    {wsRows.slice(0, 80).map((row, idx) => {
                      const clamped = Math.max(-1.2, Math.min(1.2, row.transformedWordscore));
                      const leftPct = ((clamped + 1.25) / 2.5) * 100;
                      const topPct = 18 + ((idx * 23) % 64);
                      const isSel = selectedWsRow?.entityId === row.entityId;
                      const colorClass =
                        row.transformedWordscore < -0.15
                          ? 'bg-[#1E3A5F]'
                          : row.transformedWordscore > 0.15
                            ? 'bg-[#991B1B]'
                            : 'bg-[#57534E]';
                      return (
                        <button
                          key={row.entityId}
                          type="button"
                          onClick={() => setWsSelectedId(row.entityId)}
                          style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                          title={`${row.label}: ${formatSigned(row.transformedWordscore, 2)} (SE ${row.standardError.toFixed(3)}, ${row.overlapPct}% overlap)`}
                          className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full cursor-pointer transition-transform ${colorClass} ${
                            isSel
                              ? 'w-3.5 h-3.5 ring-2 ring-[#9A3412] z-10 scale-125'
                              : row.confidenceTier === 'Low'
                                ? 'w-2 h-2 opacity-40 hover:opacity-90'
                                : 'w-2.5 h-2.5 opacity-80 hover:opacity-100 hover:scale-125'
                          }`}
                          aria-label={`${row.label} score ${row.transformedWordscore}`}
                        />
                      );
                    })}
                  </div>

                  {selectedWsRow && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div className="space-y-0.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 font-mono text-[#57534E] tabular-nums">
                          <span className="font-semibold text-[#181715]">{selectedWsRow.label}</span>
                          <span aria-hidden="true">·</span>
                          <span
                            className={`font-semibold ${
                              selectedWsRow.transformedWordscore < -0.15
                                ? 'text-[#1E3A5F]'
                                : selectedWsRow.transformedWordscore > 0.15
                                  ? 'text-[#991B1B]'
                                  : 'text-[#57534E]'
                            }`}
                          >
                            Score {formatSigned(selectedWsRow.transformedWordscore, 2)} (raw{' '}
                            {formatSigned(selectedWsRow.rawWordscore, 3)} ± {selectedWsRow.standardError.toFixed(3)})
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {selectedWsRow.overlapPct}% vocab overlap ({selectedWsRow.matchedTokens}/
                            {selectedWsRow.totalTokens} tokens)
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>Confidence: {selectedWsRow.confidenceTier}</span>
                        </div>
                        <div className="text-[#181715] font-medium truncate">
                          {selectedWsRow.title}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          selectedWsRow.entityType === 'bill'
                            ? onOpenBill(selectedWsRow.entityId)
                            : onOpenRule(selectedWsRow.entityId)
                        }
                        className="px-3 py-1.5 text-xs font-medium bg-[#181715] text-[#FBF9F5] rounded hover:bg-[#9A3412] inline-flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        Open Dossier <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Filter Bar */}
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="w-3.5 h-3.5 text-[#78716C] absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={wsQuery}
                      onChange={(e) => setWsQuery(e.target.value)}
                      placeholder={`Filter ${wsEntityType === 'bill' ? 'bill number, title, or author' : 'TAC citation, agency, or title'}…`}
                      className="w-full pl-8 pr-3 py-1.5 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                    />
                  </div>
                  <select
                    value={wsConfidence}
                    onChange={(e) => setWsConfidence(e.target.value)}
                    className="px-2.5 py-1.5 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                  >
                    <option value="reliable">Reliable Overlap (High &amp; Moderate)</option>
                    <option value="High">High Confidence Only</option>
                    <option value="">All Scored (incl. Low Overlap)</option>
                  </select>
                  {wsEntityType === 'bill' && (
                    <select
                      value={wsChamber}
                      onChange={(e) => setWsChamber(e.target.value)}
                      className="px-2.5 py-1.5 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                    >
                      <option value="">All Chambers</option>
                      <option value="House">House</option>
                      <option value="Senate">Senate</option>
                    </select>
                  )}
                  <select
                    value={wsSort}
                    onChange={(e) => setWsSort(e.target.value)}
                    className="px-2.5 py-1.5 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                  >
                    <option value="score_asc">Sort: Dem Platform Axis (−1 → +1)</option>
                    <option value="score_desc">Sort: Rep Platform Axis (+1 → −1)</option>
                    <option value="center">Sort: Most Balanced / Centrist</option>
                    <option value="overlap_desc">Sort: Highest Vocabulary Overlap</option>
                  </select>
                </div>

                {/* Scored Ledger Table */}
                <div className="border border-[#DFD9CE] overflow-x-auto max-h-[420px] overflow-y-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead className="sticky top-0 bg-[#F4F0E8] border-b border-[#DFD9CE] font-mono text-[11px] text-[#57534E]">
                      <tr>
                        <th className="py-2.5 px-3 text-left font-medium">
                          {wsEntityType === 'bill' ? 'Bill' : 'TAC / Rule'}
                        </th>
                        <th className="py-2.5 px-3 text-left font-medium">Title &amp; Author</th>
                        <th className="py-2.5 px-3 text-right font-medium">Wordscore</th>
                        <th className="py-2.5 px-3 text-right font-medium">Raw ± SE</th>
                        <th className="py-2.5 px-3 text-right font-medium">Overlap</th>
                        <th className="py-2.5 px-3 text-left font-medium">Driving Platform Terms</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#DFD9CE]">
                      {wsLoading ? (
                        <tr>
                          <td colSpan={6} className="p-6 text-center text-[#78716C]">
                            Loading Wordscores ledger…
                          </td>
                        </tr>
                      ) : wsRows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-6 text-center text-[#78716C]">
                            No scored records matched the current confidence or search filter. Try
                            switching to “All Scored” to inspect sparse bills.
                          </td>
                        </tr>
                      ) : (
                        wsRows.map((row) => (
                          <tr
                            key={row.entityId}
                            onClick={() => setWsSelectedId(row.entityId)}
                            className={`cursor-pointer transition-colors ${
                              selectedWsRow?.entityId === row.entityId
                                ? 'bg-[#F4F0E8]'
                                : 'hover:bg-[#FBF9F5]'
                            }`}
                          >
                            <td className="py-2.5 px-3 font-mono whitespace-nowrap">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  row.entityType === 'bill'
                                    ? onOpenBill(row.entityId)
                                    : onOpenRule(row.entityId);
                                }}
                                className="font-semibold text-[#9A3412] hover:underline cursor-pointer"
                              >
                                {row.label}
                              </button>
                              <div className="text-[10px] text-[#78716C]">{row.stageOrAction}</div>
                            </td>
                            <td className="py-2.5 px-3 max-w-md">
                              <div className="font-medium text-[#181715] line-clamp-1">
                                {row.title}
                              </div>
                              <div className="text-[11px] text-[#78716C]">
                                {row.authorOrCitation} · {row.chamberOrAgency}
                              </div>
                            </td>
                            <td
                              className={`py-2.5 px-3 text-right font-mono font-bold tabular-nums whitespace-nowrap ${
                                row.transformedWordscore < -0.15
                                  ? 'text-[#1E3A5F]'
                                  : row.transformedWordscore > 0.15
                                    ? 'text-[#991B1B]'
                                    : 'text-[#57534E]'
                              }`}
                            >
                              {formatSigned(row.transformedWordscore, 2)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#57534E] whitespace-nowrap">
                              {formatSigned(row.rawWordscore, 2)} ± {row.standardError.toFixed(2)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                              <div className="text-[#181715]">{row.overlapPct}%</div>
                              <div className="text-[10px] text-[#78716C]">
                                {row.confidenceTier} ({row.matchedTokens}t)
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-[11px] font-mono">
                              {row.topDemTerms.length > 0 && (
                                <div className="text-[#1E3A5F] truncate max-w-[260px]">
                                  D: {row.topDemTerms.slice(0, 3).map((t) => t.term).join(', ')}
                                </div>
                              )}
                              {row.topRepTerms.length > 0 && (
                                <div className="text-[#991B1B] truncate max-w-[260px]">
                                  R: {row.topRepTerms.slice(0, 3).map((t) => t.term).join(', ')}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Two-column lower row: Reference Dictionary Auditor + Live Custom Text Sandbox */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
                {/* Left 7 cols: Reference Vocabulary Auditor */}
                <section className="lg:col-span-7 border border-[#DFD9CE] bg-[#FFFFFF] flex flex-col">
                  <div className="px-5 py-3.5 bg-[#F4F0E8] border-b border-[#DFD9CE]">
                    <h3 className="font-display text-sm font-bold text-[#181715]">
                      Reference Vocabulary Auditor (Top Discriminating Terms)
                    </h3>
                    <p className="text-xs text-[#57534E]">
                      Empirical-Bayes smoothed Laver–Benoit–Garry term weights S_w ∈ [−1, +1] (minimum 6
                      occurrences, singular/plural normalized) across both 2026 platform PDFs.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-[#DFD9CE] flex-1">
                    <div className="p-4">
                      <div className="text-xs font-condensed uppercase tracking-wider text-[#1E3A5F] mb-2">
                        Democratic Platform Pole (S_w → −1.0)
                      </div>
                      <div className="divide-y divide-[#F4F0E8] text-xs font-mono tabular-nums max-h-72 overflow-y-auto">
                        {overview.topDemTerms.map((t) => (
                          <div key={t.term} className="py-1.5 flex items-center justify-between gap-2">
                            <span className="text-[#181715] font-medium">{t.term}</span>
                            <span className="text-[#57534E] text-[11px]">
                              D:{t.demCount} / R:{t.repCount} ·{' '}
                              <strong className="text-[#1E3A5F]">{t.wordScore.toFixed(2)}</strong>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs font-condensed uppercase tracking-wider text-[#991B1B] mb-2">
                        Republican Platform Pole (S_w → +1.0)
                      </div>
                      <div className="divide-y divide-[#F4F0E8] text-xs font-mono tabular-nums max-h-72 overflow-y-auto">
                        {overview.topRepTerms.map((t) => (
                          <div key={t.term} className="py-1.5 flex items-center justify-between gap-2">
                            <span className="text-[#181715] font-medium">{t.term}</span>
                            <span className="text-[#57534E] text-[11px]">
                              D:{t.demCount} / R:{t.repCount} ·{' '}
                              <strong className="text-[#991B1B]">+{t.wordScore.toFixed(2)}</strong>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                {/* Right 5 cols: Live Custom Text Wordscores Sandbox */}
                <section className="lg:col-span-5 border border-[#DFD9CE] bg-[#FFFFFF] flex flex-col">
                  <div className="px-5 py-3.5 bg-[#F4F0E8] border-b border-[#DFD9CE]">
                    <h3 className="font-display text-sm font-bold text-[#181715]">
                      Score Any Virgin Policy Text (Wordscores Sandbox)
                    </h3>
                    <p className="text-xs text-[#57534E]">
                      Paste a bill draft, floor speech, witness testimony, or agency preamble to measure
                      its lexical alignment against the 2026 reference dictionary.
                    </p>
                  </div>
                  <div className="p-4 space-y-3 flex-1 flex flex-col">
                    <textarea
                      value={sandboxText}
                      onChange={(e) => setSandboxText(e.target.value)}
                      rows={5}
                      placeholder="Paste at least 30 characters of Texas bill text, committee analysis, floor testimony, or agency rule text…"
                      className="w-full p-3 border border-[#C5BDB0] bg-[#FBF9F5] rounded text-xs text-[#181715] font-mono leading-relaxed"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setSandboxText(
                            'An act relating to expanding Medicaid coverage for rural hospitals, increasing the public school basic allotment and teacher pay, regulating electric grid reliability, and protecting collective bargaining rights for public workers.'
                          )
                        }
                        className="text-[11px] text-[#57534E] hover:text-[#9A3412] underline cursor-pointer"
                      >
                        Load sample text
                      </button>
                      <button
                        type="button"
                        onClick={handleScoreSandbox}
                        disabled={sandboxLoading || sandboxText.trim().length < 30}
                        className="px-3.5 py-1.5 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] disabled:opacity-50 cursor-pointer"
                      >
                        {sandboxLoading ? 'Scoring…' : 'Compute Wordscore'}
                      </button>
                    </div>
                    {sandboxError && <p className="text-xs text-[#991B1B]">{sandboxError}</p>}
                    {sandboxResult && (
                      <div className="border border-[#DFD9CE] bg-[#FBF9F5] p-3.5 space-y-2 text-xs font-mono tabular-nums">
                        <div className="flex items-center justify-between">
                          <span className="text-[#57534E]">Transformed Wordscore</span>
                          <span
                            className={`text-sm font-bold ${
                              sandboxResult.transformedWordscore < -0.15
                                ? 'text-[#1E3A5F]'
                                : sandboxResult.transformedWordscore > 0.15
                                  ? 'text-[#991B1B]'
                                  : 'text-[#181715]'
                            }`}
                          >
                            {formatSigned(sandboxResult.transformedWordscore, 3)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-[#57534E]">
                          <span>
                            Raw {formatSigned(sandboxResult.rawWordscore, 3)} ±{' '}
                            {sandboxResult.standardError.toFixed(3)}
                          </span>
                          <span>
                            Overlap {sandboxResult.overlapPct}% ({sandboxResult.matchedTokens}/
                            {sandboxResult.totalTokens}) · {sandboxResult.confidenceTier}
                          </span>
                        </div>
                        {sandboxResult.topDemTerms.length > 0 && (
                          <div className="text-[11px] text-[#1E3A5F]">
                            Dem-weighted terms:{' '}
                            {sandboxResult.topDemTerms
                              .map((t) => `${t.term} (${t.wordScore.toFixed(2)})`)
                              .join(', ')}
                          </div>
                        )}
                        {sandboxResult.topRepTerms.length > 0 && (
                          <div className="text-[11px] text-[#991B1B]">
                            Rep-weighted terms:{' '}
                            {sandboxResult.topRepTerms
                              .map((t) => `${t.term} (+${t.wordScore.toFixed(2)})`)
                              .join(', ')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* TAB 3: WORDFISH UNSUPERVISED POISSON SCALING (SLAPIN & PROKSCH)  */}
          {/* ================================================================ */}
          {tab === 'wordfish' && overview && (
            <div className="space-y-6">
              <section className="border border-[#DFD9CE] bg-[#FFFFFF] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="font-display text-base font-bold text-[#181715]">
                      Wordfish Unsupervised Poisson IRT Scaling (Slapin &amp; Proksch 2008)
                    </h2>
                    <p className="text-xs text-[#57534E]">
                      Estimates latent positions ω_i and word discrimination β_j directly from word count
                      matrices without pre-labeled scores (log λ_ij = α_i + ψ_j + β_j · ω_i). Domain runs
                      scale bills &amp; rules directly against each other to avoid manifesto-vs-statute genre
                      splitting.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <div className="flex items-center border border-[#C5BDB0] rounded overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setWfMode('topic_corpus')}
                        className={`px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap ${
                          wfMode === 'topic_corpus'
                            ? 'bg-[#181715] text-[#FBF9F5]'
                            : 'bg-[#FFFFFF] text-[#57534E] hover:text-[#181715]'
                        }`}
                      >
                        Topic Corpus (Same-Genre)
                      </button>
                      <button
                        type="button"
                        onClick={() => setWfMode('historical_platforms')}
                        className={`px-3 py-1.5 text-xs font-medium cursor-pointer whitespace-nowrap ${
                          wfMode === 'historical_platforms'
                            ? 'bg-[#181715] text-[#FBF9F5]'
                            : 'bg-[#FFFFFF] text-[#57534E] hover:text-[#181715]'
                        }`}
                      >
                        Historical Platforms ({overview.platforms.length}/4+)
                      </button>
                    </div>
                    {wfMode === 'topic_corpus' && (
                      <select
                        value={wfDomain}
                        onChange={(e) => setWfDomain(e.target.value)}
                        className="px-2.5 py-1.5 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                      >
                        <option value="All Indexed Policy Domains">All Indexed Policy Domains</option>
                        {overview.availableDomains.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {wfLoading ? (
                  <div className="p-8 text-center text-xs text-[#57534E] border border-[#DFD9CE] bg-[#FBF9F5]">
                    Running alternating Newton–Raphson Poisson MLE…
                  </div>
                ) : !wfResult || !wfResult.available ? (
                  <div className="p-6 border border-[#DFD9CE] bg-[#FBF9F5] space-y-3">
                    <p className="text-sm font-medium text-[#181715]">
                      Wordfish Model Requires a Larger Document Corpus
                    </p>
                    <p className="text-xs text-[#57534E] leading-relaxed max-w-2xl">
                      {wfResult?.reason ||
                        'Wordfish requires at least 4 documents on a shared policy dimension to identify latent positions.'}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      {wfMode === 'historical_platforms' && (
                        <>
                          <button
                            type="button"
                            onClick={() => setShowImportModal(true)}
                            className="px-3.5 py-1.5 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] cursor-pointer"
                          >
                            Import Historical Platform PDF / Text
                          </button>
                          <button
                            type="button"
                            onClick={() => setWfMode('topic_corpus')}
                            className="px-3.5 py-1.5 text-xs font-medium border border-[#C5BDB0] bg-[#FFFFFF] text-[#181715] rounded hover:border-[#181715] cursor-pointer"
                          >
                            Switch to Topic Corpus Mode
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Model Convergence Metadata Strip */}
                    <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#57534E] tabular-nums">
                      <span>Domain: {wfResult.domain}</span>
                      <span aria-hidden="true">·</span>
                      <span>{wfResult.docCount} Documents</span>
                      <span aria-hidden="true">·</span>
                      <span>{wfResult.vocabSize} Shared Vocabulary Terms</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {wfResult.converged ? 'Converged' : 'Stabilized'} in {wfResult.iterations}{' '}
                        MLE iterations
                      </span>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
                      {/* Left 7 cols: Latent Position Scale (omega_i ± 1.96 SE) */}
                      <div className="lg:col-span-7 border border-[#DFD9CE] bg-[#FBF9F5] p-4 space-y-2.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-condensed uppercase tracking-wider text-[#57534E]">
                            Document Latent Positions (ω_i ± 1.96 SE)
                          </span>
                          <span className="font-mono text-[11px] text-[#78716C]">
                            Standardized: mean 0, SD 1
                          </span>
                        </div>

                        <div className="space-y-2 max-h-[440px] overflow-y-auto pr-1">
                          {(() => {
                            const maxAbs = Math.max(
                              1.8,
                              ...wfResult.documents.map((d) => Math.abs(d.omega) + d.omegaSe * 1.96)
                            );
                            const toPct = (v: number) => ((v + maxAbs) / (2 * maxAbs)) * 100;
                            return wfResult.documents.map((doc) => {
                              const lo = toPct(doc.omega - 1.96 * doc.omegaSe);
                              const hi = toPct(doc.omega + 1.96 * doc.omegaSe);
                              const mid = toPct(doc.omega);
                              const isDem = doc.kind === 'platform_dem';
                              const isRep = doc.kind === 'platform_rep';
                              const dotColor = isDem
                                ? 'bg-[#1E3A5F]'
                                : isRep
                                  ? 'bg-[#991B1B]'
                                  : 'bg-[#181715]';

                              return (
                                <div
                                  key={doc.id}
                                  className={`p-2 bg-[#FFFFFF] border border-[#DFD9CE] grid grid-cols-12 gap-2 items-center text-xs ${
                                    isDem || isRep ? 'bg-[#F4F0E8]/60' : ''
                                  }`}
                                >
                                  <div className="col-span-5 min-w-0">
                                    {doc.entityId ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          doc.kind === 'bill'
                                            ? onOpenBill(doc.entityId!)
                                            : onOpenRule(doc.entityId!)
                                        }
                                        className="font-mono font-semibold text-[#9A3412] hover:underline cursor-pointer truncate block text-left"
                                      >
                                        {doc.label}
                                      </button>
                                    ) : (
                                      <div
                                        className={`font-mono font-semibold truncate ${
                                          isDem
                                            ? 'text-[#1E3A5F]'
                                            : isRep
                                              ? 'text-[#991B1B]'
                                              : 'text-[#181715]'
                                        }`}
                                      >
                                        {doc.label}
                                      </div>
                                    )}
                                    <div className="text-[10px] text-[#78716C] truncate">
                                      {doc.subtitle}
                                    </div>
                                  </div>

                                  <div className="col-span-5 relative h-5 flex items-center">
                                    <div className="w-full h-px bg-[#DFD9CE]" />
                                    <div
                                      style={{ left: `${toPct(0)}%` }}
                                      className="absolute top-0 bottom-0 w-px bg-[#181715]/30"
                                    />
                                    {/* SE whisker */}
                                    <div
                                      style={{
                                        left: `${Math.max(0, lo)}%`,
                                        width: `${Math.max(1, Math.min(100, hi) - Math.max(0, lo))}%`,
                                      }}
                                      className="absolute h-0.5 bg-[#78716C]/70"
                                    />
                                    {/* Point estimate */}
                                    <div
                                      style={{ left: `${mid}%` }}
                                      className={`absolute w-2.5 h-2.5 rounded-full -translate-x-1/2 ${dotColor}`}
                                    />
                                  </div>

                                  <div className="col-span-2 text-right font-mono text-[11px] tabular-nums text-[#181715]">
                                    {formatSigned(doc.omega, 2)}
                                    <span className="text-[#78716C] block text-[10px]">
                                      ±{doc.omegaSe.toFixed(2)}
                                    </span>
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      </div>

                      {/* Right 5 cols: Classic Eiffel Tower Plot (psi_j vs beta_j) */}
                      <div className="lg:col-span-5 border border-[#DFD9CE] bg-[#FBF9F5] p-4 flex flex-col justify-between space-y-3">
                        <div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-condensed uppercase tracking-wider text-[#57534E]">
                              Word Discrimination “Eiffel Tower” Plot
                            </span>
                            <span className="font-mono text-[11px] text-[#78716C]">
                              β_j (x) vs. ψ_j (y)
                            </span>
                          </div>
                          <p className="text-[11px] text-[#78716C] mt-1">
                            High-frequency neutral words sit near the peak (β ≈ 0); pole-defining words
                            spread horizontally left (negative β) and right (positive β).
                          </p>
                        </div>

                        <div className="bg-[#FFFFFF] border border-[#DFD9CE] p-2">
                          <svg viewBox="0 0 360 260" className="w-full h-64">
                            {/* Zero β axis */}
                            <line
                              x1="180"
                              y1="14"
                              x2="180"
                              y2="236"
                              stroke="#DFD9CE"
                              strokeDasharray="3 3"
                            />
                            {/* Baseline */}
                            <line x1="20" y1="236" x2="340" y2="236" stroke="#C5BDB0" />

                            {wfResult.words.map((w) => {
                              const x =
                                24 +
                                ((w.beta - eiffelBounds.minBeta) /
                                  (eiffelBounds.maxBeta - eiffelBounds.minBeta)) *
                                  312;
                              const y =
                                230 -
                                ((w.psi - eiffelBounds.minPsi) /
                                  Math.max(0.1, eiffelBounds.maxPsi - eiffelBounds.minPsi)) *
                                  210;
                              const fill =
                                w.beta < -0.45
                                  ? '#1E3A5F'
                                  : w.beta > 0.45
                                    ? '#991B1B'
                                    : '#78716C';
                              const isHovered = wfHoverWord?.term === w.term;
                              return (
                                <g
                                  key={w.term}
                                  onMouseEnter={() => setWfHoverWord(w)}
                                  className="cursor-pointer"
                                >
                                  <circle
                                    cx={x}
                                    cy={y}
                                    r={isHovered ? 5 : 3}
                                    fill={fill}
                                    fillOpacity={isHovered ? 1 : 0.72}
                                  />
                                </g>
                              );
                            })}

                            {/* Label top 6 extreme pole words */}
                            {[
                              ...wfResult.words.slice().sort((a, b) => a.beta - b.beta).slice(0, 3),
                              ...wfResult.words.slice().sort((a, b) => b.beta - a.beta).slice(0, 3),
                            ].map((w) => {
                              const x =
                                24 +
                                ((w.beta - eiffelBounds.minBeta) /
                                  (eiffelBounds.maxBeta - eiffelBounds.minBeta)) *
                                  312;
                              const y =
                                230 -
                                ((w.psi - eiffelBounds.minPsi) /
                                  Math.max(0.1, eiffelBounds.maxPsi - eiffelBounds.minPsi)) *
                                  210;
                              return (
                                <text
                                  key={`lbl-${w.term}`}
                                  x={x}
                                  y={Math.max(14, y - 6)}
                                  textAnchor={w.beta < 0 ? 'start' : 'end'}
                                  fontSize="9"
                                  fontFamily="monospace"
                                  fill={w.beta < 0 ? '#1E3A5F' : '#991B1B'}
                                >
                                  {w.term}
                                </text>
                              );
                            })}

                            <text
                              x="24"
                              y="252"
                              fontSize="9"
                              fontFamily="monospace"
                              fill="#1E3A5F"
                            >
                              ← Negative β
                            </text>
                            <text
                              x="180"
                              y="252"
                              textAnchor="middle"
                              fontSize="9"
                              fontFamily="monospace"
                              fill="#78716C"
                            >
                              β = 0
                            </text>
                            <text
                              x="336"
                              y="252"
                              textAnchor="end"
                              fontSize="9"
                              fontFamily="monospace"
                              fill="#991B1B"
                            >
                              Positive β →
                            </text>
                          </svg>
                        </div>

                        <div className="p-2.5 bg-[#FFFFFF] border border-[#DFD9CE] text-xs font-mono tabular-nums min-h-[44px] flex items-center justify-between">
                          {wfHoverWord ? (
                            <>
                              <span className="font-semibold text-[#181715]">
                                “{wfHoverWord.term}”
                              </span>
                              <span className="text-[#57534E]">
                                β {formatSigned(wfHoverWord.beta, 2)} · ψ{' '}
                                {formatSigned(wfHoverWord.psi, 2)} · n={wfHoverWord.totalCount}
                              </span>
                            </>
                          ) : (
                            <span className="text-[#78716C] font-sans">
                              Hover any point in the Eiffel Tower plot to inspect word parameters.
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </section>
            </div>
          )}

          {/* ================================================================ */}
          {/* TAB 4: PLANK EXPLORER (FTS5)                                     */}
          {/* ================================================================ */}
          {tab === 'planks' && overview && (
            <div className="space-y-4">
              {/* Filter bar */}
              <div className="border border-[#DFD9CE] bg-[#FFFFFF] p-4 flex flex-wrap items-center gap-3 text-xs">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="w-3.5 h-3.5 text-[#78716C] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    data-global-search="true"
                    value={plankQuery}
                    onChange={(e) => setPlankQuery(e.target.value)}
                    placeholder="Full-text search planks (e.g. ERCOT, voucher, Medicaid, property tax, border)…"
                    className="w-full pl-8 pr-3 py-1.5 border border-[#C5BDB0] bg-[#FBF9F5] rounded text-xs text-[#181715]"
                  />
                </div>
                <select
                  value={plankParty}
                  onChange={(e) => setPlankParty(e.target.value)}
                  className="px-2.5 py-1.5 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                >
                  <option value="">All Parties</option>
                  <option value="Democratic">Democratic</option>
                  <option value="Republican">Republican</option>
                  <option value="Other">Other</option>
                </select>
                <select
                  value={plankDomain}
                  onChange={(e) => setPlankDomain(e.target.value)}
                  className="px-2.5 py-1.5 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                >
                  <option value="">All Texas Domains</option>
                  {overview.availableDomains.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <select
                  value={plankRileCode}
                  onChange={(e) => setPlankRileCode(e.target.value)}
                  className="px-2.5 py-1.5 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                >
                  <option value="">All MARPOR RILE Codes</option>
                  {overview.rileCategories.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} · {c.label} ({c.direction})
                    </option>
                  ))}
                </select>
                {(plankQuery || plankParty || plankDomain || plankRileCode) && (
                  <button
                    type="button"
                    onClick={() => {
                      setPlankQuery('');
                      setPlankParty('');
                      setPlankDomain('');
                      setPlankRileCode('');
                    }}
                    className="text-xs text-[#9A3412] hover:underline cursor-pointer whitespace-nowrap"
                  >
                    Reset
                  </button>
                )}
              </div>

              {/* Matched-height split ledger */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:items-stretch">
                <div className="lg:col-span-5 lg:relative">
                  <div className="border border-[#DFD9CE] bg-[#FFFFFF] flex flex-col lg:absolute lg:inset-0">
                    <div className="px-4 py-2.5 bg-[#F4F0E8] border-b border-[#DFD9CE] flex items-center justify-between text-xs font-mono text-[#57534E] tabular-nums">
                      <span>{planksTotal.toLocaleString()} Matching Planks</span>
                      <span>Showing {planks.length}</span>
                    </div>
                    <div className="divide-y divide-[#DFD9CE] flex-1 min-h-0 max-h-[540px] lg:max-h-none overflow-y-auto">
                      {planksLoading ? (
                        <div className="p-6 text-xs text-[#78716C]">Searching planks…</div>
                      ) : planks.length === 0 ? (
                        <div className="p-6 text-xs text-[#78716C]">
                          No platform planks matched the current filter.
                        </div>
                      ) : (
                        planks.map((pl) => {
                          const active = selectedPlank?.id === pl.id;
                          return (
                            <button
                              key={pl.id}
                              type="button"
                              onClick={() => setSelectedPlankId(pl.id)}
                              className={`w-full p-3.5 text-left transition-colors cursor-pointer block ${
                                active ? 'bg-[#F4F0E8]' : 'hover:bg-[#FBF9F5]'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-[#57534E]">
                                <span
                                  className={`font-semibold ${
                                    pl.party === 'Democratic'
                                      ? 'text-[#1E3A5F]'
                                      : pl.party === 'Republican'
                                        ? 'text-[#991B1B]'
                                        : 'text-[#181715]'
                                  }`}
                                >
                                  {pl.party} {pl.year} · {pl.plankNumber}
                                </span>
                                <span className="tabular-nums text-[#78716C]">
                                  {pl.rileCode ? `MARPOR ${pl.rileCode}` : 'State-Specific'}
                                </span>
                              </div>
                              <div className="font-display text-sm font-semibold text-[#181715] mt-0.5 line-clamp-1">
                                {pl.heading}
                              </div>
                              <p className="text-xs text-[#57534E] mt-1 line-clamp-2 leading-relaxed">
                                {pl.body}
                              </p>
                              <div className="mt-1.5 text-[10px] font-mono text-[#78716C]">
                                {pl.texasDomain} · {pl.wordCount} words
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>

                {/* Right 7 cols: Full Verbatim Plank Dossier */}
                <div className="lg:col-span-7 border border-[#DFD9CE] bg-[#FFFFFF] lg:min-h-[540px]">
                  {!selectedPlank ? (
                    <div className="p-8 text-sm text-[#57534E]">
                      Select a platform plank from the index to inspect its verbatim text and
                      MARPOR coding provenance.
                    </div>
                  ) : (
                    <div>
                      <div className="p-6 border-b border-[#DFD9CE] bg-[#FBF9F5] space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#57534E]">
                          <span
                            className={`font-semibold ${
                              selectedPlank.party === 'Democratic'
                                ? 'text-[#1E3A5F]'
                                : selectedPlank.party === 'Republican'
                                  ? 'text-[#991B1B]'
                                  : 'text-[#181715]'
                            }`}
                          >
                            {selectedPlank.party} Party Platform ({selectedPlank.year})
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{selectedPlank.plankNumber}</span>
                          <span aria-hidden="true">·</span>
                          <span>Chapter: {selectedPlank.chapter}</span>
                        </div>
                        <h2 className="font-display text-xl font-bold text-[#181715]">
                          {selectedPlank.heading}
                        </h2>
                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#57534E] tabular-nums">
                          <span>Domain: {selectedPlank.texasDomain}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            MARPOR:{' '}
                            {selectedPlank.rileCode
                              ? `${selectedPlank.rileCode} ${selectedPlank.rileLabel} (${selectedPlank.rileDirection})`
                              : 'Uncoded / State-Specific'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{selectedPlank.wordCount} words</span>
                        </div>
                      </div>

                      <div className="p-6 space-y-4">
                        <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E]">
                          Verbatim Platform Plank Text
                        </h3>
                        <p className="text-sm text-[#181715] leading-relaxed whitespace-pre-wrap">
                          {selectedPlank.body}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Import Historical / Custom Platform Modal */}
      {showImportModal && (
        <div
          className="fixed inset-0 z-50 bg-[#181715]/50 flex items-center justify-center p-4"
          onClick={() => setShowImportModal(false)}
        >
          <div
            className="bg-[#FBF9F5] border border-[#C5BDB0] w-full max-w-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between">
              <div>
                <h2 className="font-display text-lg font-bold text-[#181715]">
                  Import Historical or Supplemental Platform
                </h2>
                <p className="text-xs text-[#57534E]">
                  Add 2018–2024 Texas platforms to unlock Historical Platform Drift Wordfish (4+ docs).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="p-1 text-[#57534E] hover:text-[#181715] cursor-pointer"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleImportSubmit} className="p-6 space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="space-y-1 block">
                  <span className="font-medium text-[#57534E]">Party</span>
                  <select
                    value={importParty}
                    onChange={(e) => setImportParty(e.target.value as PlatformParty)}
                    className="w-full px-2.5 py-2 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                  >
                    <option value="Democratic">Democratic</option>
                    <option value="Republican">Republican</option>
                    <option value="Other">Other / Third Party</option>
                  </select>
                </label>
                <label className="space-y-1 block">
                  <span className="font-medium text-[#57534E]">Platform Year</span>
                  <input
                    type="number"
                    min={1950}
                    max={2050}
                    required
                    value={importYear}
                    onChange={(e) => setImportYear(e.target.value)}
                    className="w-full px-2.5 py-2 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs font-mono text-[#181715]"
                  />
                </label>
                <label className="space-y-1 block sm:col-span-3">
                  <span className="font-medium text-[#57534E]">Platform Document Title</span>
                  <input
                    type="text"
                    required
                    value={importTitle}
                    onChange={(e) => setImportTitle(e.target.value)}
                    placeholder="e.g., 2024 Republican Party of Texas Platform"
                    className="w-full px-2.5 py-2 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs text-[#181715]"
                  />
                </label>
              </div>

              <label className="space-y-1 block">
                <span className="font-medium text-[#57534E]">
                  Public HTTPS PDF URL (optional if pasting text below)
                </span>
                <input
                  type="url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://example.org/2024-platform.pdf"
                  className="w-full px-2.5 py-2 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs font-mono text-[#181715]"
                />
              </label>

              <label className="space-y-1 block">
                <span className="font-medium text-[#57534E]">
                  Or Paste Platform Text Directly (min. 200 characters)
                </span>
                <textarea
                  rows={5}
                  value={importRawText}
                  onChange={(e) => setImportRawText(e.target.value)}
                  placeholder="Paste platform chapters or planks here if you prefer offline text import…"
                  className="w-full p-2.5 border border-[#C5BDB0] bg-[#FFFFFF] rounded text-xs font-mono text-[#181715]"
                />
              </label>

              {importError && <p className="text-xs text-[#991B1B]">{importError}</p>}

              <div className="pt-2 flex items-center justify-end gap-2 border-t border-[#DFD9CE]">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-3.5 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-[#181715] rounded hover:border-[#181715] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={importing}
                  className="px-4 py-2 bg-[#9A3412] text-[#FBF9F5] font-medium rounded hover:bg-[#7C2D12] disabled:opacity-60 cursor-pointer"
                >
                  {importing ? 'Extracting & Coding…' : 'Import & Index Platform'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
