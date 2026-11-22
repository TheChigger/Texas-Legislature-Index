import React, { useEffect, useState } from 'react';
import { GitCompare, Plus, Minus } from 'lucide-react';
import type { BillAmendment, DiffResult } from '../types.ts';

interface RedlineDiffPaneProps {
  billId: string;
  amendments: BillAmendment[];
  initialFromId?: string;
  initialToId?: string;
}

export const RedlineDiffPane: React.FC<RedlineDiffPaneProps> = ({
  billId,
  amendments,
  initialFromId,
  initialToId,
}) => {
  const [fromId, setFromId] = useState<string>(initialFromId || amendments[0]?.id || '');
  const [toId, setToId] = useState<string>(
    initialToId || amendments[amendments.length - 1]?.id || ''
  );
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (amendments.length === 0) return;
    setFromId(initialFromId || amendments[0].id);
    setToId(initialToId || amendments[amendments.length - 1].id);
  }, [billId, amendments, initialFromId, initialToId]);

  useEffect(() => {
    if (!billId || !fromId || !toId) return;
    let cancelled = false;
    setLoading(true);
    fetch(
      `/api/bills/${encodeURIComponent(billId)}/diff?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`
    )
      .then((r) => r.json())
      .then((data: DiffResult) => {
        if (!cancelled) setDiff(data);
      })
      .catch(() => {
        if (!cancelled) setDiff(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [billId, fromId, toId]);

  if (amendments.length < 2) {
    return (
      <div className="border border-[#DFD9CE] bg-[#F4F0E8]/60 p-4 text-sm text-[#57534E]">
        At least two bill versions or amendments are needed to render a line-by-line statutory redline.
      </div>
    );
  }

  return (
    <div className="border border-[#DFD9CE] bg-[#FFFFFF]">
      <div className="px-4 py-3 bg-[#F4F0E8] border-b border-[#DFD9CE] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-[#181715]">
          <GitCompare className="w-4 h-4 text-[#9A3412]" />
          <span>Statutory Redline Comparison</span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="text-[#57534E]">
            Base
            <select
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
              className="ml-1.5 px-2 py-1 border border-[#C5BDB0] bg-[#FFFFFF] text-[#181715] rounded text-xs"
            >
              {amendments.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.amendmentNumber} · {a.filedDate}
                </option>
              ))}
            </select>
          </label>
          <span className="text-[#78716C]">vs.</span>
          <label className="text-[#57534E]">
            Target
            <select
              value={toId}
              onChange={(e) => setToId(e.target.value)}
              className="ml-1.5 px-2 py-1 border border-[#C5BDB0] bg-[#FFFFFF] text-[#181715] rounded text-xs"
            >
              {amendments.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.amendmentNumber} · {a.filedDate}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {diff && (
        <div className="px-4 py-2 border-b border-[#DFD9CE] bg-[#FBF9F5] space-y-1.5 text-xs font-mono tabular-nums text-[#57534E]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {diff.fromVersion.label} → {diff.toVersion.label}
            </span>
            <div className="flex items-center gap-4">
              <span className="inline-flex items-center gap-1 text-[#14532D] font-medium">
                <Plus className="w-3 h-3" /> {diff.addedCount} added
              </span>
              <span className="inline-flex items-center gap-1 text-[#991B1B] font-medium">
                <Minus className="w-3 h-3" /> {diff.removedCount} removed
              </span>
            </div>
          </div>
          {diff.wordscoresShift && (
            <div className="pt-1.5 border-t border-[#EAE4D9] flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span>
                Wordscores Shift:{' '}
                <strong className="text-[#181715]">
                  {diff.wordscoresShift.fromScore > 0 ? '+' : ''}
                  {diff.wordscoresShift.fromScore.toFixed(2)} →{' '}
                  {diff.wordscoresShift.toScore > 0 ? '+' : ''}
                  {diff.wordscoresShift.toScore.toFixed(2)}
                </strong>{' '}
                (
                <span
                  className={
                    diff.wordscoresShift.delta < -0.04
                      ? 'text-[#1E3A5F] font-semibold'
                      : diff.wordscoresShift.delta > 0.04
                        ? 'text-[#991B1B] font-semibold'
                        : 'text-[#57534E]'
                  }
                >
                  Δ {diff.wordscoresShift.delta > 0 ? '+' : ''}
                  {diff.wordscoresShift.delta.toFixed(2)}
                </span>
                {' · '}
                {diff.wordscoresShift.confidenceTier} overlap)
              </span>
              {(diff.wordscoresShift.addedTermsDem.length > 0 ||
                diff.wordscoresShift.addedTermsRep.length > 0) && (
                <span className="text-[#78716C] truncate max-w-md">
                  Added terms:{' '}
                  {diff.wordscoresShift.addedTermsDem.length > 0 && (
                    <span className="text-[#1E3A5F]">
                      D[{diff.wordscoresShift.addedTermsDem.map((t) => t.term).join(', ')}]
                    </span>
                  )}
                  {diff.wordscoresShift.addedTermsDem.length > 0 &&
                    diff.wordscoresShift.addedTermsRep.length > 0 &&
                    ' · '}
                  {diff.wordscoresShift.addedTermsRep.length > 0 && (
                    <span className="text-[#991B1B]">
                      R[{diff.wordscoresShift.addedTermsRep.map((t) => t.term).join(', ')}]
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="max-h-80 overflow-y-auto font-mono text-xs leading-relaxed">
        {loading ? (
          <div className="p-4 text-[#78716C]">Computing statutory diff...</div>
        ) : diff ? (
          diff.lines.map((line, idx) => (
            <div
              key={idx}
              className={`px-4 py-1.5 flex items-start gap-3 border-b border-[#F4F0E8] last:border-b-0 ${
                line.type === 'added'
                  ? 'bg-[#DCFCE7]/65 text-[#14532D]'
                  : line.type === 'removed'
                    ? 'bg-[#FEE2E2]/65 text-[#991B1B]'
                    : 'text-[#181715]'
              }`}
            >
              <span className="w-8 shrink-0 text-right text-[#78716C] tabular-nums select-none">
                {line.oldLine ?? '·'}
              </span>
              <span className="w-8 shrink-0 text-right text-[#78716C] tabular-nums select-none">
                {line.newLine ?? '·'}
              </span>
              <span className="w-4 shrink-0 font-bold select-none">
                {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
              </span>
              <span className={line.type === 'removed' ? 'line-through' : ''}>
                {line.text || '\u00A0'}
              </span>
            </div>
          ))
        ) : (
          <div className="p-4 text-[#78716C]">Select two versions to inspect textual changes.</div>
        )}
      </div>
    </div>
  );
};
