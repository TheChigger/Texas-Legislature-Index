import React, { useEffect, useState } from 'react';
import { Search, FileSpreadsheet } from 'lucide-react';
import type { BillAmendment } from '../types.ts';
import { RedlineDiffPane } from './RedlineDiffPane.tsx';
import { csvDateStamp, downloadCsv, stripHtmlTags } from '../utils/csv.ts';

interface AmendmentsViewProps {
  activeSession: string;
  onOpenBill: (billId: string) => void;
}

export const AmendmentsView: React.FC<AmendmentsViewProps> = ({
  activeSession,
  onOpenBill,
}) => {
  const [query, setQuery] = useState('');
  const [disposition, setDisposition] = useState('');
  const [amendments, setAmendments] = useState<BillAmendment[]>([]);
  const [selected, setSelected] = useState<BillAmendment | null>(null);
  const [billVersions, setBillVersions] = useState<BillAmendment[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (disposition) params.set('disposition', disposition);
      if (activeSession) params.set('session', activeSession);

      fetch(`/api/amendments?${params.toString()}`)
        .then((r) => r.json())
        .then((data) => {
          const list: BillAmendment[] = data.amendments ?? [];
          setAmendments(list);
          if (list.length > 0 && (!selected || !list.some((a) => a.id === selected.id))) {
            setSelected(list[0]);
          }
        })
        .catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [query, disposition, activeSession]);

  useEffect(() => {
    if (!selected?.billId) {
      setBillVersions([]);
      return;
    }
    fetch(`/api/bills/${encodeURIComponent(selected.billId)}`)
      .then((r) => r.json())
      .then((data) => setBillVersions(data.amendments ?? []))
      .catch(() => setBillVersions([]));
  }, [selected?.billId]);

  const handleExportAmendmentsCsv = () => {
    downloadCsv(
      `texas-amendments-${activeSession || 'all'}-${csvDateStamp()}.csv`,
      [
        'Session',
        'Bill Number',
        'Bill Title',
        'Version Code',
        'Version Label',
        'Amendment Number',
        'Sponsor',
        'Filed Date',
        'Disposition',
        'Yea Votes',
        'Nay Votes',
        'PNV Votes',
        'Summary',
      ],
      amendments.map((a) => [
        a.session,
        a.billNumber,
        a.billTitle,
        a.versionCode,
        a.versionLabel,
        a.amendmentNumber,
        a.sponsor,
        a.filedDate,
        a.disposition,
        a.yeaVotes,
        a.nayVotes,
        a.pnvVotes,
        a.snippet ? stripHtmlTags(a.snippet) : a.summary,
      ])
    );
  };

  useEffect(() => {
    const onExport = () => handleExportAmendmentsCsv();
    const onStep = (ev: Event) => {
      const delta = (ev as CustomEvent<{ delta?: number }>).detail?.delta ?? 1;
      if (amendments.length === 0) return;
      const curIdx = selected ? amendments.findIndex((a) => a.id === selected.id) : -1;
      const nextIdx =
        curIdx === -1
          ? 0
          : Math.max(0, Math.min(amendments.length - 1, curIdx + delta));
      if (amendments[nextIdx]) setSelected(amendments[nextIdx]);
    };
    window.addEventListener('capitol:export-csv', onExport);
    window.addEventListener('capitol:step-item', onStep);
    return () => {
      window.removeEventListener('capitol:export-csv', onExport);
      window.removeEventListener('capitol:step-item', onStep);
    };
  }, [amendments, selected, activeSession]);

  return (
    <div className="space-y-6">
      <div className="border border-[#DFD9CE] bg-[#F4F0E8] p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-4 h-4 text-[#57534E] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            data-global-search="true"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Full-text FTS5 search across archived committee substitutes, floor amendments & enrolled texts..."
            className="w-full pl-9 pr-10 py-2 bg-[#FFFFFF] border border-[#C5BDB0] text-sm rounded"
          />
          {!query && (
            <kbd className="hidden sm:inline-block absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] font-mono text-[#78716C] bg-[#FBF9F5] border border-[#DFD9CE] rounded pointer-events-none">
              /
            </kbd>
          )}
        </div>

        <select
          value={disposition}
          onChange={(e) => setDisposition(e.target.value)}
          className="px-3 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
        >
          <option value="">All Dispositions</option>
          <option value="Enacted">Enacted</option>
          <option value="Adopted">Adopted</option>
          <option value="Substituted">Substituted</option>
          <option value="Tabled">Tabled</option>
          <option value="Failed">Failed</option>
          <option value="Filed">Filed (Base)</option>
        </select>

        <button
          type="button"
          onClick={handleExportAmendmentsCsv}
          disabled={amendments.length === 0}
          className="px-3 py-2 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer"
          title="Export matching amendments to CSV (Shortcut: e)"
        >
          <FileSpreadsheet className="w-3.5 h-3.5 text-[#14532D]" />
          Export CSV
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5 border border-[#DFD9CE] bg-[#FFFFFF]">
          <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] text-xs font-mono text-[#57534E] tabular-nums">
            {amendments.length} Archived Versions & Amendments
          </div>
          <div className="divide-y divide-[#DFD9CE] max-h-[720px] overflow-y-auto">
            {amendments.map((am) => {
              const active = selected?.id === am.id;
              return (
                <button
                  key={am.id}
                  type="button"
                  onClick={() => setSelected(am)}
                  className={`w-full p-4 text-left block cursor-pointer ${
                    active ? 'bg-[#F4F0E8]' : 'hover:bg-[#FBF9F5]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-mono">
                    <span className="font-semibold text-[#9A3412]">
                      {am.session} {am.billNumber} · {am.amendmentNumber}
                    </span>
                    <span className="text-[#57534E] tabular-nums">{am.filedDate}</span>
                  </div>
                  <div className="text-sm font-medium text-[#181715] mt-1">
                    {am.versionLabel}
                  </div>
                  {am.snippet ? (
                    <p
                      className="text-xs text-[#57534E] mt-1 line-clamp-2"
                      dangerouslySetInnerHTML={{ __html: am.snippet }}
                    />
                  ) : (
                    <p className="text-xs text-[#57534E] mt-1 line-clamp-2">{am.summary}</p>
                  )}
                  <div className="mt-1.5 text-[11px] font-mono text-[#78716C] tabular-nums">
                    Sponsor: {am.sponsor} · {am.disposition}
                    {am.yeaVotes + am.nayVotes > 0 && ` (${am.yeaVotes}-${am.nayVotes})`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-7 border border-[#DFD9CE] bg-[#FFFFFF] p-6 space-y-5">
          {!selected ? (
            <div className="text-sm text-[#57534E]">
              Select an archived amendment to inspect its statutory text and redline diff.
            </div>
          ) : (
            <>
              <div className="border-b border-[#DFD9CE] pb-4">
                <div className="flex items-center justify-between gap-3 text-xs font-mono text-[#57534E]">
                  <button
                    type="button"
                    onClick={() => onOpenBill(selected.billId)}
                    className="font-semibold text-[#9A3412] hover:underline cursor-pointer"
                  >
                    Open Full Dossier: {selected.session} {selected.billNumber}
                  </button>
                  <span>
                    {selected.disposition} · Sponsor: {selected.sponsor}
                  </span>
                </div>
                <h2 className="font-display text-xl font-bold text-[#181715] mt-1.5">
                  {selected.versionLabel}
                </h2>
                <p className="text-xs text-[#57534E] mt-1">{selected.billTitle}</p>
              </div>

              <RedlineDiffPane
                billId={selected.billId}
                amendments={billVersions}
                initialToId={selected.id}
              />

              <div>
                <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] mb-2">
                  Archived Text ({selected.amendmentNumber})
                </h3>
                <pre className="p-4 bg-[#FBF9F5] border border-[#DFD9CE] text-xs font-mono whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                  {selected.fullText}
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
