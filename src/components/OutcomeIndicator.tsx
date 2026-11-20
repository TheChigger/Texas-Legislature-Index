import React from 'react';
import type { BillOutcome } from '../types.ts';

interface OutcomeIndicatorProps {
  outcome?: BillOutcome;
  detail?: string;
  showDetail?: boolean;
  className?: string;
}

const OUTCOME_STYLES: Record<Exclude<BillOutcome, 'Active'>, { label: string; classes: string; dot: string }> = {
  Passed: {
    label: 'PASSED',
    classes: 'bg-[#F0FDF4] text-[#14532D] border-[#BBF7D0]',
    dot: 'bg-[#14532D]',
  },
  Failed: {
    label: 'FAILED',
    classes: 'bg-[#FEF2F2] text-[#991B1B] border-[#FECACA]',
    dot: 'bg-[#991B1B]',
  },
  Vetoed: {
    label: 'VETOED',
    classes: 'bg-[#FFF7ED] text-[#9A3412] border-[#FED7AA]',
    dot: 'bg-[#9A3412]',
  },
};

export const OutcomeIndicator: React.FC<OutcomeIndicatorProps> = ({
  outcome,
  detail,
  showDetail = false,
  className = '',
}) => {
  if (!outcome || outcome === 'Active') return null;

  const cfg = OUTCOME_STYLES[outcome];
  if (!cfg) return null;

  const cleanSubDetail =
    showDetail && detail
      ? detail.replace(/^(Passed|Failed|Vetoed)\s*[·:\-–]\s*/i, '').trim()
      : '';

  return (
    <span
      title={detail || outcome}
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 border rounded-[2px] font-mono text-[10px] font-semibold tracking-wide leading-none whitespace-nowrap ${cfg.classes} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-[1px] shrink-0 ${cfg.dot}`} aria-hidden="true" />
      <span>{cfg.label}</span>
      {cleanSubDetail && (
        <span className="font-normal tracking-normal opacity-90">· {cleanSubDetail}</span>
      )}
    </span>
  );
};
