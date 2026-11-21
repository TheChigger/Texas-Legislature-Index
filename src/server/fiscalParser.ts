import { db } from './db.ts';
import type { BillFiscalImpact, FiscalStatus } from '../types.ts';

// Authoritative order: Enrolled (F) > Conference/Amended (A) > Engrossed (E) > Senate/House Committee (S/H) > Introduced (I)
const VERSION_PRIORITY: Record<string, number> = {
  F: 6,
  A: 5,
  E: 4,
  S: 3,
  H: 3,
  I: 1,
};

function parseSignedDollarToken(raw: string): number | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const isParenNeg = cleaned.startsWith('(') && cleaned.endsWith(')');
  const isMinus = cleaned.startsWith('-');
  const numStr = cleaned.replace(/[()$,+\s-]/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(numStr)) return null;
  const val = Number(numStr);
  if (!Number.isFinite(val)) return null;
  return isParenNeg || isMinus ? -val : val;
}

function parseProseDollarAmount(text: string): number | null {
  // e.g. "$8.5 billion", "$50.0 million", "($12,400,000)", "cost of $28.4 million"
  const m = text.match(/(\(?-?\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?|\(?-?\$\s*\d+(?:\.\d+)?)\s*(billion|million|thousand)?\)?/i);
  if (!m) return null;
  const rawNum = m[1];
  const unit = (m[2] || '').toLowerCase();
  if (!rawNum.includes('$') && !unit) return null;
  const isNeg = rawNum.includes('(') || rawNum.includes('-');
  const base = Number(rawNum.replace(/[()$,\s-]/g, ''));
  if (!Number.isFinite(base)) return null;
  const mult =
    unit === 'billion' ? 1_000_000_000 : unit === 'million' ? 1_000_000 : unit === 'thousand' ? 1_000 : 1;
  const magnitude = Math.round(base * mult);
  // Check prose sign cues if not already parenthetical/negative
  if (isNeg) return -magnitude;
  if (/\b(cost|negative impact|net cost|expenditure|outlay|appropriation|loss|reduction in general revenue)\b/i.test(text)) {
    return -magnitude;
  }
  return magnitude;
}

/**
 * Deterministically extracts structured 2-year & 5-year General Revenue / All Funds
 * fiscal impact, FTE change, and local government impact from an official Texas LBB Fiscal Note.
 */
export function parseLbbFiscalNoteText(
  plainText: string,
  versionLabel = ''
): BillFiscalImpact {
  const raw = (plainText || '').replace(/\r/g, '');
  const normalized = raw.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return {
      status: '',
      biennialGrImpact: null,
      fiveYearGrImpact: null,
      fiveYearAllFundsImpact: null,
      fteChange: null,
      localGovImpact: '',
      versionLabel,
      summary: '',
    };
  }

  // 1. Detect explicit "No significant fiscal implication" LBB standard phrase
  const noSigMatch = normalized.match(
    /No significant fiscal implication to the State is anticipated[^.]{0,180}\./i
  );
  const indeterminateMatch = normalized.match(
    /(?:fiscal (?:implication|impact)[^.]{0,120}(?:cannot be determined|indeterminate)|cannot be determined at this time)[^.]{0,140}\./i
  );

  // 2. Extract Local Government Impact section
  let localGovImpact = '';
  const localMatch = raw.match(
    /Local Government Impact[\s:]*\n+([^\n]{15,320})/i
  ) || normalized.match(/Local Government Impact[\s:]+([^.]{15,240}\.)/i);
  if (localMatch) {
    localGovImpact = localMatch[1].replace(/\s+/g, ' ').trim().slice(0, 260);
  }

  // 3. Parse standard LBB 5-year fiscal table rows:
  // Example lines:
  //   2026    ($4,250,000,000)    ($4,250,000,000)    42.0
  //   2027    ($4,250,000,000)    ($4,250,000,000)    42.0
  // Or:
  //   2026    ($12,500,000)    0.0
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  interface YearRow {
    year: number;
    dollars: number[];
    fte: number | null;
  }
  const yearRows: YearRow[] = [];

  for (const line of lines) {
    const yrMatch = line.match(/^(20[1-3]\d)\b(.*)$/);
    if (!yrMatch) continue;
    const year = Number(yrMatch[1]);
    const rest = yrMatch[2];
    const dollarTokens = rest.match(/\(?-?\$?\d{1,3}(?:,\d{3})+(?:\.\d{2})?\)?|\$0\b/g) || [];
    const parsedDollars = dollarTokens
      .map(parseSignedDollarToken)
      .filter((v): v is number => v !== null);

    // Check trailing FTE decimal token (e.g., "42.0" or "-5.5" or "12.5") not containing commas or $
    const withoutDollars = rest.replace(/\(?-?\$?\d{1,3}(?:,\d{3})+(?:\.\d{2})?\)?|\$0\b/g, ' ');
    const fteMatch = withoutDollars.match(/(?:^|\s)(\(?-?\d{1,4}\.\d\)?)(?:\s|$)/);
    let fte: number | null = null;
    if (fteMatch) {
      const f = parseSignedDollarToken(fteMatch[1]);
      if (f !== null && Math.abs(f) <= 25000) fte = f;
    }

    if (parsedDollars.length > 0 || fte !== null) {
      // Avoid duplicate years from secondary tables by keeping the first 5-year primary LBB summary table
      if (!yearRows.some((r) => r.year === year) && yearRows.length < 5) {
        yearRows.push({ year, dollars: parsedDollars, fte });
      }
    }
  }

  let biennialGrImpact: number | null = null;
  let fiveYearGrImpact: number | null = null;
  let fiveYearAllFundsImpact: number | null = null;
  let fteChange: number | null = null;

  if (yearRows.length >= 2) {
    yearRows.sort((a, b) => a.year - b.year);
    const hasGrCol = yearRows.every((r) => r.dollars.length >= 1);
    if (hasGrCol) {
      biennialGrImpact = yearRows.slice(0, 2).reduce((sum, r) => sum + (r.dollars[0] ?? 0), 0);
      fiveYearGrImpact = yearRows.reduce((sum, r) => sum + (r.dollars[0] ?? 0), 0);

      // If multiple dollar columns exist (e.g. GR + Other Funds or All Funds), compute all-funds sum
      const hasSecondCol = yearRows.some((r) => r.dollars.length >= 2);
      if (hasSecondCol) {
        const col1Sum = fiveYearGrImpact;
        const col2Sum = yearRows.reduce((sum, r) => sum + (r.dollars[1] ?? 0), 0);
        // If column 2 is explicitly labeled "All Funds" in header, use col2Sum; otherwise sum GR + Other
        const hasAllFundsHeader = /All Funds/i.test(normalized);
        fiveYearAllFundsImpact = hasAllFundsHeader && Math.abs(col2Sum) >= Math.abs(col1Sum)
          ? col2Sum
          : col1Sum + col2Sum;
      } else {
        fiveYearAllFundsImpact = fiveYearGrImpact;
      }
    }

    const ftes = yearRows.map((r) => r.fte).filter((v): v is number => v !== null);
    if (ftes.length > 0) {
      // Peak/steady-state FTE change (typically final year or max absolute change)
      fteChange = ftes.reduce((best, cur) => (Math.abs(cur) >= Math.abs(best) ? cur : best), 0);
    }
  }

  // 4. Fallback prose extraction (LBB summary sentences like "negative impact of ($8,500,000,000) through the biennium ending August 31, 2027")
  if (biennialGrImpact === null) {
    const bienMatch =
      normalized.match(
        /(?:negative|positive|net)?\s*(?:fiscal\s+)?impact\s+of\s+([^.;]{4,60}?)\s+through\s+the\s+biennium/i
      ) ||
      normalized.match(
        /(?:Probable\s+)?(?:Net\s+)?General\s+Revenue(?:-Related)?\s*(?:Impact|Cost|Appropriation|Funds)?\s*[:]\s*(\(?-?\$\s*\d[\d,.]*(?:\s*(?:billion|million|thousand))?\)?)/i
      ) ||
      normalized.match(
        /(?:biennial|two-year|2-year)\s+(?:General Revenue|GR|fiscal|all funds)?\s*(?:cost|impact|savings|gain|appropriation)[^$.(]{0,30}(\(?-?\$?\s*\d[\d,.]*(?:\s*(?:billion|million|thousand))?\)?)/i
      ) ||
      normalized.match(
        /(\(?-?\$\s*\d[\d,.]*(?:\s*(?:billion|million|thousand))?\)?)\s+General\s+Revenue(?:\s+and\s+[\w\s]+)?\s+(?:biennial\s+)?(?:cost|impact|appropriation)/i
      );
    if (bienMatch) {
      let parsed = parseProseDollarAmount(bienMatch[0]);
      if (parsed !== null) {
        // General Revenue appropriations/budget allocations represent state outlays (negative impact to GR)
        if (parsed > 0 && /\b(General Revenue|Biennial Cost|budget|appropriation)\b/i.test(bienMatch[0]) && !/\b(gain|savings|positive|revenue increase)\b/i.test(bienMatch[0])) {
          parsed = -parsed;
        }
        biennialGrImpact = parsed;
      }
    }
  }

  if (fiveYearGrImpact === null) {
    const fiveMatch = normalized.match(
      /(?:five-year|5-year)\s+(?:General Revenue|GR|net)?\s*(?:cost|impact|savings|gain)[^$.(]{0,30}(\(?-?\$?\s*\d[\d,.]*(?:\s*(?:billion|million|thousand))?\)?)/i
    );
    if (fiveMatch) {
      fiveYearGrImpact = parseProseDollarAmount(fiveMatch[0]);
    }
  }

  if (fiveYearAllFundsImpact === null) {
    const allFundsMatch = normalized.match(
      /All Funds[^$.(]{0,40}(\(?-?\$\s*\d[\d,.]*(?:\s*(?:billion|million|thousand))?\)?)/i
    );
    if (allFundsMatch && allFundsMatch[1]) {
      let parsed = parseProseDollarAmount(allFundsMatch[1]);
      if (parsed !== null && parsed > 0 && !/\b(gain|savings|positive|revenue increase)\b/i.test(normalized.slice(0, 260))) {
        parsed = -parsed;
      }
      fiveYearAllFundsImpact = parsed;
    } else if (fiveYearGrImpact !== null) {
      fiveYearAllFundsImpact = fiveYearGrImpact;
    }
  }

  if (fteChange === null) {
    const fteProse = normalized.match(/(\+|-)?(\d+(?:\.\d)?)\s+FTEs?\b/i);
    if (fteProse) {
      const n = Number(fteProse[2]);
      if (Number.isFinite(n)) {
        fteChange = fteProse[1] === '-' ? -n : n;
      }
    }
  }

  // 5. Determine canonical FiscalStatus & clean headline summary
  let status: FiscalStatus = '';
  const hasQuantifiedDollars =
    (biennialGrImpact !== null && biennialGrImpact !== 0) ||
    (fiveYearGrImpact !== null && fiveYearGrImpact !== 0) ||
    (fiveYearAllFundsImpact !== null && fiveYearAllFundsImpact !== 0);

  if (hasQuantifiedDollars) {
    status = 'Significant Impact';
  } else if (noSigMatch) {
    status = 'No Significant Impact';
  } else if (indeterminateMatch) {
    status = 'Indeterminate';
  } else if (biennialGrImpact === 0 && fiveYearGrImpact === 0) {
    status = 'No Significant Impact';
  } else if (/fiscal\s+implication/i.test(normalized)) {
    status = 'Indeterminate';
  }

  let summary = '';
  if (noSigMatch && !hasQuantifiedDollars) {
    summary = noSigMatch[0].trim();
  } else if (indeterminateMatch && !hasQuantifiedDollars) {
    summary = indeterminateMatch[0].trim();
  } else {
    const impactLine = lines.find((l) =>
      /negative impact|positive impact|fiscal implication|biennium ending|appropriation|All Funds/i.test(l)
    );
    summary = (impactLine || normalized).slice(0, 280);
  }

  return {
    status,
    biennialGrImpact,
    fiveYearGrImpact,
    fiveYearAllFundsImpact,
    fteChange,
    localGovImpact,
    versionLabel,
    summary,
  };
}

export function formatFiscalDollars(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  const sign = amount < 0 ? '-' : amount > 0 ? '+' : '';
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000).toLocaleString()}K`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

export function recomputeBillFiscalImpact(billId: string): BillFiscalImpact | null {
  const docs = db
    .prepare(
      `SELECT version_code, version_label, summary, full_text
       FROM bill_documents
       WHERE bill_id = ? AND doc_type = 'fiscal_note'`
    )
    .all(billId) as Array<{
    version_code: string;
    version_label: string;
    summary: string;
    full_text: string;
  }>;

  if (docs.length === 0) return null;

  docs.sort((a, b) => (VERSION_PRIORITY[b.version_code] ?? 0) - (VERSION_PRIORITY[a.version_code] ?? 0));
  const best = docs[0];
  const parsed = parseLbbFiscalNoteText(`${best.summary}\n${best.full_text}`, best.version_label);

  db.prepare(
    `UPDATE bills
     SET fiscal_status = ?,
         biennial_gr_impact = ?,
         five_year_gr_impact = ?,
         five_year_all_funds_impact = ?,
         fte_change = ?,
         local_gov_impact = ?,
         fiscal_note_version = ?,
         fiscal_summary = ?
     WHERE id = ?`
  ).run(
    parsed.status,
    parsed.biennialGrImpact,
    parsed.fiveYearGrImpact,
    parsed.fiveYearAllFundsImpact,
    parsed.fteChange,
    parsed.localGovImpact,
    parsed.versionLabel,
    parsed.summary,
    billId
  );

  return parsed;
}

export function backfillAllBillFiscalImpacts(forceAll = false): number {
  const rows = db
    .prepare(
      forceAll
        ? `SELECT DISTINCT d.bill_id
           FROM bill_documents d
           WHERE d.doc_type = 'fiscal_note'`
        : `SELECT DISTINCT d.bill_id
           FROM bill_documents d
           JOIN bills b ON b.id = d.bill_id
           WHERE d.doc_type = 'fiscal_note'
             AND (b.fiscal_status = '' OR b.fiscal_status IS NULL)`
    )
    .all() as Array<{ bill_id: string }>;

  if (rows.length === 0) return 0;

  let updated = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const res = recomputeBillFiscalImpact(r.bill_id);
      if (res && res.status) updated += 1;
    }
  });
  tx();
  return updated;
}
