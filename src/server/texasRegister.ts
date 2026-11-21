import crypto from 'crypto';
import { extractText } from 'unpdf';
import { db, syncRuleFts } from './db.ts';
import type { AgencyRuleActionType, TexRegSyncJob } from '../types.ts';

const UNT_OAI_BASE = 'https://texashistory.unt.edu/oai/';
const UNT_ARK_BASE = 'https://texashistory.unt.edu';

interface UntRegisterIssue {
  arkId: string;
  title: string;
  volume: number;
  issueNumber: number;
  pageRange: string;
  issueDate: string;
  sourceUrl: string;
}

export interface ParsedAgencyRule {
  id: string;
  issueDate: string;
  volume: number;
  issueNumber: number;
  pageRange: string;
  actionType: AgencyRuleActionType;
  agencyName: string;
  tacTitle: string;
  tacCitation: string;
  title: string;
  summary: string;
  statutoryAuthority: string;
  fiscalNoteText: string;
  fiscalImpactAmount: number | null;
  governmentGrowthNote: string;
  citedBills: string[];
  statuteCodes: string[];
  sourceUrl: string;
  source: string;
  fullText: string;
}

const TEXAS_CODES_PATTERN =
  /\b(Education|Government|Health and Safety|Human Resources|Tax|Water|Utilities|Natural Resources|Insurance|Labor|Local Government|Occupations|Penal|Transportation|Business\s*(?:&|and)\s*Commerce|Finance|Family|Agriculture|Alcoholic Beverage|Election|Estates|Parks and Wildlife|Property|Special District Local Laws)\s+Code(?:\s*,?\s*(?:Chapter|Ch\.?|§§?|Section|Sec\.?)\s*[\dA-Za-z.-]+)?/gi;

function extractStatuteRefs(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(TEXAS_CODES_PATTERN)) {
    const clean = m[0].replace(/\s+/g, ' ').replace(/\s*,\s*/g, ' ').trim();
    if (clean.length >= 8) found.add(clean);
  }
  return Array.from(found).slice(0, 12);
}

function inferSessionFromYear(year: number): string {
  // Regular Texas Legislature meets in odd years: 2025 -> 89R, 2023 -> 88R, 2021 -> 87R, 2027 -> 90R
  if (year >= 2027) return '90R';
  if (year >= 2025) return '89R';
  if (year >= 2023) return '88R';
  if (year >= 2021) return '87R';
  if (year >= 2019) return '86R';
  return '89R';
}

function extractBillCitations(text: string, issueDate: string): string[] {
  const refs = new Set<string>();
  const issueYear = Number((issueDate || '').slice(0, 4)) || 2025;
  const defaultSession = inferSessionFromYear(issueYear);

  // Match "House Bill 2", "HB 2", "Senate Bill 14", "SB 14", optionally followed by legislature number
  const regex =
    /\b(House\s+Bill|Senate\s+Bill|H\.?\s*B\.?|S\.?\s*B\.?|HJR|SJR)\s*(?:No\.?\s*)?(\d{1,5})(?:[^.\n;]{0,65}?\b(\d{2})(?:st|nd|rd|th)\s+Legislature)?/gi;

  for (const m of text.matchAll(regex)) {
    const rawType = m[1].toUpperCase().replace(/[^A-Z]/g, '');
    const prefix =
      rawType === 'HOUSEBILL' || rawType === 'HB'
        ? 'HB'
        : rawType === 'SENATEBILL' || rawType === 'SB'
          ? 'SB'
          : rawType;
    const num = Number(m[2]);
    if (!Number.isFinite(num) || num <= 0 || num > 9999) continue;

    // Look ahead/behind for explicit legislature number like "89th Legislature" or "(89R)"
    let session = m[3] ? `${m[3]}R` : '';
    if (!session) {
      const idx = m.index ?? 0;
      const win = text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + 120));
      const sessM =
        win.match(/\b(\d{2})([R1-4])\b/) ||
        win.match(/\b(\d{2})(?:st|nd|rd|th)\s+Legislature\b/i);
      if (sessM) {
        session = sessM[2] ? `${sessM[1]}${sessM[2].toUpperCase()}` : `${sessM[1]}R`;
      } else {
        session = defaultSession;
      }
    }
    refs.add(`${session} ${prefix} ${num}`);
  }

  return Array.from(refs).slice(0, 12);
}

function extractRuleFiscalAmount(fiscalText: string): number | null {
  if (!fiscalText) return null;
  if (/no\s+(?:significant\s+)?fiscal\s+implication|will\s+not\s+result\s+in\s+(?:any\s+)?(?:additional\s+)?cost/i.test(fiscalText)) {
    return 0;
  }
  const m = fiscalText.match(
    /(\(?-?\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?|\(?-?\$\s*\d+(?:\.\d+)?)\s*(billion|million|thousand)?\)?/i
  );
  if (!m) return null;
  const base = Number(m[1].replace(/[()$,\s-]/g, ''));
  if (!Number.isFinite(base)) return null;
  const unit = (m[2] || '').toLowerCase();
  const mult =
    unit === 'billion' ? 1_000_000_000 : unit === 'million' ? 1_000_000 : unit === 'thousand' ? 1_000 : 1;
  const amt = Math.round(base * mult);
  const isGain = /\b(revenue\s+gain|savings|increase\s+in\s+revenue|positive\s+fiscal)\b/i.test(fiscalText);
  return isGain ? amt : -amt;
}

function extractLabeledParagraph(block: string, labelPattern: RegExp, maxLen = 420): string {
  const m = block.match(labelPattern);
  if (!m || m.index === undefined) return '';
  const start = m.index;
  const slice = block.slice(start, start + 900).replace(/\s+/g, ' ').trim();
  // Trim cleanly at sentence boundary near maxLen
  if (slice.length <= maxLen) return slice;
  const cut = slice.slice(0, maxLen);
  const lastPeriod = cut.lastIndexOf('.');
  return lastPeriod > 120 ? cut.slice(0, lastPeriod + 1) : `${cut.trim()}…`;
}

function normalizeAgencyName(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/^PART\s+\d+\.?\s*/i, '')
    .replace(/^CHAPTER\s+\d+\.?\s*/i, '')
    .trim();
  if (!cleaned) return 'Texas State Agency';
  if (cleaned === cleaned.toUpperCase()) {
    // Convert ALL CAPS agency headings to clean Title Case preserving common acronyms
    const acronyms = new Set(['TEXAS', 'HHSC', 'TEA', 'TCEQ', 'TDI', 'PUC', 'RRC', 'TDLR', 'DPS', 'TXDOT', 'THECB', 'ERS', 'TRS', 'TWDB', 'GLO', 'OAG']);
    const lowerWords = new Set(['of', 'and', 'for', 'the', 'on', 'in', 'to', 'at']);
    return cleaned
      .split(/\s+/)
      .map((w, i) => {
        const up = w.toUpperCase();
        if (acronyms.has(up) && up !== 'TEXAS') return up;
        const lw = w.toLowerCase();
        if (i > 0 && lowerWords.has(lw)) return lw;
        return lw.charAt(0).toUpperCase() + lw.slice(1);
      })
      .join(' ');
  }
  return cleaned;
}

/**
 * Parses extracted plain text (from a Texas Register PDF or pasted SOS HTML/text report)
 * into structured agency rule notices with citations, statutory authority, and fiscal notes.
 */
export function parseTexasRegisterText(
  rawText: string,
  meta: {
    issueDate: string;
    volume?: number;
    issueNumber?: number;
    pageRange?: string;
    sourceUrl?: string;
    source?: string;
    defaultActionType?: AgencyRuleActionType;
    defaultAgency?: string;
  }
): ParsedAgencyRule[] {
  // Strip HTML tags if user pasted HTML straight from sos.state.tx.us/texreg
  const stripped = rawText
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:p|div|br|tr|li|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&sect;/gi, '§')
    .replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/\r/g, '');

  const volume = meta.volume ?? Number(stripped.match(/\b(\d{2})\s+TexReg\b/i)?.[1] || 0);
  const issueNumber = meta.issueNumber ?? Number(stripped.match(/\bNumber\s+(\d{1,2})\b/i)?.[1] || 0);
  const issueDate = meta.issueDate || new Date().toISOString().slice(0, 10);

  // Track active section (Proposed / Adopted / Withdrawn / Emergency / Rule Review) & TAC Title/Agency
  // Split into candidate rule chunks around TAC citation lines like "19 TAC §101.3011" or "1 TAC §§355.101 - 355.105"
  const tacHeadingRegex = /(?:^|\n)\s*(\d{1,2}\s+TAC\s+§§?\s*[\dA-Za-z.,\s–-]{3,65})(?=\n|$)/g;
  const matches = Array.from(stripped.matchAll(tacHeadingRegex));

  const results: ParsedAgencyRule[] = [];
  const seenKeys = new Set<string>();

  const detectSectionBefore = (idx: number): AgencyRuleActionType => {
    const before = stripped.slice(Math.max(0, idx - 60000), idx);
    const sectionMarkers: Array<{ type: AgencyRuleActionType; pos: number }> = [
      { type: 'Proposed', pos: before.search(/PROPOSED\s+RULES(?![\s\S]*PROPOSED\s+RULES)/i) },
      { type: 'Adopted', pos: before.search(/ADOPTED\s+RULES(?![\s\S]*ADOPTED\s+RULES)/i) },
      { type: 'Withdrawn', pos: before.search(/WITHDRAWN\s+RULES(?![\s\S]*WITHDRAWN\s+RULES)/i) },
      { type: 'Emergency', pos: before.search(/EMERGENCY\s+RULES(?![\s\S]*EMERGENCY\s+RULES)/i) },
      { type: 'Rule Review', pos: before.search(/REVIEW\s+OF\s+AGENCY\s+RULES(?![\s\S]*REVIEW\s+OF\s+AGENCY\s+RULES)/i) },
    ];
    sectionMarkers.sort((a, b) => b.pos - a.pos);
    if (sectionMarkers[0] && sectionMarkers[0].pos >= 0) return sectionMarkers[0].type;
    return meta.defaultActionType || 'Proposed';
  };

  const detectAgencyBefore = (idx: number, blockText: string): { agencyName: string; tacTitle: string } => {
    const context = stripped.slice(Math.max(0, idx - 1200), idx);
    const titleMatches = Array.from(context.matchAll(/TITLE\s+(\d{1,2})\.\s*([A-Z][A-Z\s,&-]{3,60})/g));
    const lastTitle = titleMatches[titleMatches.length - 1];
    const tacTitle = lastTitle ? `${lastTitle[1]} TAC (${normalizeAgencyName(lastTitle[2])})` : '';

    // Look for PART N. AGENCY NAME right above the TAC citation
    const partMatches = Array.from(context.matchAll(/PART\s+\d+\.\s*([A-Z][A-Za-z\s,&'-]{4,80})/g));
    const lastPart = partMatches[partMatches.length - 1];
    if (lastPart) {
      return { agencyName: normalizeAgencyName(lastPart[1]), tacTitle };
    }

    // Fallback: look for "The Texas ... (Commission|Agency|Department|Board|Office) proposes/adopts"
    const introAgency = blockText.match(
      /The\s+((?:Texas\s+)?[A-Z][A-Za-z\s,&-]{3,70}?(?:Agency|Commission|Department|Board|Office|Comptroller|System|Authority|Council))\s*(?:\([^)]+\))?\s+(?:proposes|adopts|withdraws|files|reviews)/
    );
    if (introAgency) {
      return { agencyName: normalizeAgencyName(introAgency[1]), tacTitle };
    }

    return {
      agencyName: meta.defaultAgency || (lastTitle ? normalizeAgencyName(lastTitle[2]) : 'Texas State Agency'),
      tacTitle,
    };
  };

  if (matches.length > 0) {
    for (let i = 0; i < matches.length && results.length < 120; i++) {
      const m = matches[i];
      const startIdx = m.index ?? 0;
      const nextIdx = i + 1 < matches.length ? (matches[i + 1].index ?? startIdx + 5000) : Math.min(stripped.length, startIdx + 6000);
      const block = stripped.slice(startIdx, Math.min(nextIdx, startIdx + 6500)).trim();
      if (block.length < 180) continue; // Skip Table of Contents lines

      // Require rulemaking narrative cues so TOC entries are never ingested as rules
      if (!/\b(proposes|adopts|adopted|withdraws|emergency|statutory authority|fiscal note|amendment|new\s+§|repeal)\b/i.test(block)) {
        continue;
      }

      const tacCitation = m[1].replace(/\s+/g, ' ').trim();
      const actionType = /\badopts\b|\badopted\b/i.test(block.slice(0, 450))
        ? 'Adopted'
        : /\bwithdraws\b|\bwithdrawn\b/i.test(block.slice(0, 450))
          ? 'Withdrawn'
          : /\bemergency\b/i.test(block.slice(0, 350))
            ? 'Emergency'
            : detectSectionBefore(startIdx);

      const { agencyName, tacTitle } = detectAgencyBefore(startIdx, block);
      const dedupeKey = `${issueDate}::${actionType}::${tacCitation.toLowerCase()}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      // Extract clean heading / title from chapter line or opening sentence
      const blockLines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      const contextBefore = stripped.slice(Math.max(0, startIdx - 350), startIdx);
      const chapterM = Array.from(contextBefore.matchAll(/CHAPTER\s+\d+\.\s*([^\n]{4,100})/gi)).pop();
      const chapterTitle = chapterM ? normalizeAgencyName(chapterM[1]) : '';
      const firstNarrative =
        blockLines.find((l) => l.length > 50 && !/^\d+\s+TAC\s+§/i.test(l)) ||
        block.replace(/\s+/g, ' ').slice(0, 220);

      const title = chapterTitle
        ? `${chapterTitle} (${tacCitation})`
        : `${agencyName}: ${tacCitation}`;
      const summary = firstNarrative.replace(/\s+/g, ' ').trim().slice(0, 340);

      const statutoryAuthority = extractLabeledParagraph(
        block,
        /(?:STATUTORY\s+AUTHORITY|Statutory\s+Authority|is\s+(?:proposed|adopted)\s+under)/i,
        360
      );
      const fiscalNoteText = extractLabeledParagraph(
        block,
        /(?:FISCAL\s+NOTE|FISCAL\s+IMPLICATIONS?|PUBLIC\s+BENEFIT\s+AND\s+COST|Fiscal\s+Impact|fiscal\s+implications?\s+for\s+state)/i,
        420
      );
      const governmentGrowthNote = extractLabeledParagraph(
        block,
        /(?:GOVERNMENT\s+GROWTH\s+IMPACT|Government\s+Growth\s+Impact)/i,
        320
      );

      const citedBills = extractBillCitations(block, issueDate);
      const statuteCodes = extractStatuteRefs(block);
      const fiscalImpactAmount = extractRuleFiscalAmount(fiscalNoteText);
      const hash = crypto.createHash('sha1').update(dedupeKey).digest('hex').slice(0, 10);

      results.push({
        id: `tr-${issueDate.replace(/-/g, '')}-${hash}`,
        issueDate,
        volume,
        issueNumber,
        pageRange: meta.pageRange || '',
        actionType,
        agencyName,
        tacTitle: tacTitle || tacCitation.match(/^(\d{1,2}\s+TAC)/i)?.[1] || '',
        tacCitation,
        title,
        summary,
        statutoryAuthority,
        fiscalNoteText,
        fiscalImpactAmount,
        governmentGrowthNote,
        citedBills,
        statuteCodes,
        sourceUrl: meta.sourceUrl || 'https://www.sos.state.tx.us/texreg/index.shtml',
        source: meta.source || 'Texas Register (UNT / Texas SOS Archive)',
        fullText: block.slice(0, 5500),
      });
    }
  } else if (stripped.trim().length >= 80) {
    // Fallback for a single pasted rule notice that may not have a standalone TAC heading line
    const block = stripped.trim();
    const tacMatch = block.match(/(\d{1,2}\s+TAC\s+§§?\s*[\dA-Za-z.,\s–-]{3,50})/i);
    const tacCitation = tacMatch ? tacMatch[1].replace(/\s+/g, ' ').trim() : 'TAC Rule Notice';
    const agencyName =
      meta.defaultAgency ||
      detectAgencyBefore(0, block).agencyName ||
      'Texas State Agency';
    const actionType =
      meta.defaultActionType ||
      (/\badopts?\b/i.test(block.slice(0, 400))
        ? 'Adopted'
        : /\bwithdraw/i.test(block.slice(0, 400))
          ? 'Withdrawn'
          : /\bemergency\b/i.test(block.slice(0, 400))
            ? 'Emergency'
            : 'Proposed');
    const firstLine = block.split('\n').map((l) => l.trim()).find((l) => l.length > 15) || `${agencyName} Rulemaking`;
    const fiscalNoteText = extractLabeledParagraph(
      block,
      /(?:FISCAL\s+NOTE|FISCAL\s+IMPLICATIONS?|PUBLIC\s+BENEFIT\s+AND\s+COST|Fiscal\s+Impact)/i,
      420
    );
    const governmentGrowthNote = extractLabeledParagraph(
      block,
      /(?:GOVERNMENT\s+GROWTH\s+IMPACT|Government\s+Growth\s+Impact)/i,
      320
    );
    const statutoryAuthority = extractLabeledParagraph(
      block,
      /(?:STATUTORY\s+AUTHORITY|Statutory\s+Authority|is\s+(?:proposed|adopted)\s+under)/i,
      360
    );
    const hash = crypto.createHash('sha1').update(`${issueDate}:${tacCitation}:${firstLine}`).digest('hex').slice(0, 10);

    results.push({
      id: `tr-${issueDate.replace(/-/g, '')}-${hash}`,
      issueDate,
      volume,
      issueNumber,
      pageRange: meta.pageRange || '',
      actionType,
      agencyName,
      tacTitle: tacCitation.match(/^(\d{1,2}\s+TAC)/i)?.[1] || '',
      tacCitation,
      title: firstLine.slice(0, 160),
      summary: block.replace(/\s+/g, ' ').slice(0, 340),
      statutoryAuthority,
      fiscalNoteText,
      fiscalImpactAmount: extractRuleFiscalAmount(fiscalNoteText),
      governmentGrowthNote,
      citedBills: extractBillCitations(block, issueDate),
      statuteCodes: extractStatuteRefs(block),
      sourceUrl: meta.sourceUrl || 'https://www.sos.state.tx.us/texreg/index.shtml',
      source: meta.source || 'Texas Register (Manual SOS Import)',
      fullText: block.slice(0, 5500),
    });
  }

  return results;
}

function normalizeStatuteKey(raw: string): string {
  // "Education Code § 29.001" or "Education Code Ch. 39" -> "education code 29.001" / "education code 39"
  const lower = raw
    .toLowerCase()
    .replace(/texas\s+/g, '')
    .replace(/\b(?:sections?|sec|chapters?|ch)\.?\s+/g, ' ')
    .replace(/[§,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return lower;
}

/**
 * Links all indexed agency rules to bills in our SQLite archive via:
 * 1) Explicit Bill Citation (confidence = 1.0): e.g. "89R HB 2"
 * 2) Shared Statutory Authority (confidence = 0.72): matching normalized Code + Section/Chapter
 */
export function relinkAllRulesToBills(): number {
  const bills = db
    .prepare(`SELECT id, session, bill_number, statute_codes FROM bills`)
    .all() as Array<{
    id: string;
    session: string;
    bill_number: string;
    statute_codes: string;
  }>;

  const billBySessionAndNum = new Map<string, string>();
  const billsByNumOnly = new Map<string, Array<{ id: string; session: string }>>();
  const billsByStatute = new Map<string, Array<{ id: string; raw: string }>>();

  for (const b of bills) {
    const cleanNum = b.bill_number.toUpperCase().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    billBySessionAndNum.set(`${b.session.toUpperCase()} ${cleanNum}`, b.id);
    const list = billsByNumOnly.get(cleanNum) || [];
    list.push({ id: b.id, session: b.session });
    billsByNumOnly.set(cleanNum, list);

    let codes: string[] = [];
    try {
      codes = JSON.parse(b.statute_codes || '[]');
    } catch {
      codes = [];
    }
    for (const c of codes) {
      const key = normalizeStatuteKey(c);
      if (key.length < 8) continue;
      const sList = billsByStatute.get(key) || [];
      sList.push({ id: b.id, raw: c });
      billsByStatute.set(key, sList);
    }
  }

  const rules = db
    .prepare(`SELECT id, issue_date, cited_bills_json, statute_codes_json FROM agency_rules`)
    .all() as Array<{
    id: string;
    issue_date: string;
    cited_bills_json: string;
    statute_codes_json: string;
  }>;

  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO rule_bill_links (id, rule_id, bill_id, link_basis, matched_ref, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let linksCreated = 0;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const r of rules) {
      let citedBills: string[] = [];
      let statuteCodes: string[] = [];
      try {
        citedBills = JSON.parse(r.cited_bills_json || '[]');
      } catch {
        citedBills = [];
      }
      try {
        statuteCodes = JSON.parse(r.statute_codes_json || '[]');
      } catch {
        statuteCodes = [];
      }

      const linkedBillIds = new Set<string>();

      // 1. Direct explicit bill citations (highest precision)
      for (const ref of citedBills) {
        const cleanRef = ref.toUpperCase().replace(/\s+/g, ' ').trim();
        let billId = billBySessionAndNum.get(cleanRef);
        if (!billId) {
          // Try matching by bill number alone if exact session isn't synced yet, picking closest prior session
          const m = cleanRef.match(/\b(HB|SB|HJR|SJR)\s+(\d+)\b/);
          if (m) {
            const cands = billsByNumOnly.get(`${m[1]} ${m[2]}`) || [];
            if (cands.length === 1) billId = cands[0].id;
          }
        }
        if (billId && !linkedBillIds.has(billId)) {
          linkedBillIds.add(billId);
          const linkId = `rbl-${crypto.createHash('sha1').update(`${r.id}:${billId}`).digest('hex').slice(0, 12)}`;
          const res = insertLink.run(linkId, r.id, billId, 'Explicit Bill Citation', ref, 1.0, now);
          if (res.changes > 0) linksCreated += 1;
        }
      }

      // 2. Shared Statutory Authority (only when section or chapter matches specifically, capped at 4 per rule)
      let statuteLinkCount = 0;
      for (const sc of statuteCodes) {
        if (statuteLinkCount >= 4) break;
        const key = normalizeStatuteKey(sc);
        // Require a numeric chapter or section in the key so generic "Government Code" never links hundreds of bills
        if (!/\d/.test(key)) continue;
        const matches = billsByStatute.get(key) || [];
        for (const m of matches.slice(0, 3)) {
          if (linkedBillIds.has(m.id)) continue;
          linkedBillIds.add(m.id);
          const linkId = `rbl-${crypto.createHash('sha1').update(`${r.id}:${m.id}`).digest('hex').slice(0, 12)}`;
          const res = insertLink.run(linkId, r.id, m.id, 'Shared Statutory Authority', sc, 0.72, now);
          if (res.changes > 0) {
            linksCreated += 1;
            statuteLinkCount += 1;
          }
        }
      }
    }
  });

  tx();
  return linksCreated;
}

export function upsertParsedAgencyRules(rules: ParsedAgencyRule[]): { rulesUpserted: number; billLinksCreated: number } {
  if (rules.length === 0) return { rulesUpserted: 0, billLinksCreated: 0 };

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO agency_rules (
      id, issue_date, volume, issue_number, page_range, action_type, agency_name,
      tac_title, tac_citation, title, summary, statutory_authority,
      fiscal_note_text, fiscal_impact_amount, government_growth_note,
      cited_bills_json, statute_codes_json, source_url, source, full_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const r of rules) {
      stmt.run(
        r.id,
        r.issueDate,
        r.volume,
        r.issueNumber,
        r.pageRange,
        r.actionType,
        r.agencyName,
        r.tacTitle,
        r.tacCitation,
        r.title,
        r.summary,
        r.statutoryAuthority,
        r.fiscalNoteText,
        r.fiscalImpactAmount,
        r.governmentGrowthNote,
        JSON.stringify(r.citedBills),
        JSON.stringify(r.statuteCodes),
        r.sourceUrl,
        r.source,
        r.fullText,
        now
      );
      syncRuleFts(r.id);
    }
  });
  tx();

  const billLinksCreated = relinkAllRulesToBills();
  return { rulesUpserted: rules.length, billLinksCreated };
}

/**
 * Discovers weekly Texas Register issues from the official UNT Portal to Texas History
 * OAI-PMH archive (Texas Secretary of State depository) starting from `fromDate`.
 */
async function discoverUntRegisterIssues(fromDate: string, maxIssues: number): Promise<UntRegisterIssue[]> {
  const url = `${UNT_OAI_BASE}?verb=ListRecords&metadataPrefix=untl&set=collection:TR&from=${encodeURIComponent(fromDate)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TexasCapitolLedger/1.0 (Legislative Research Archive)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`UNT Texas Register OAI feed returned HTTP ${res.status}`);
  }
  const xml = await res.text();
  const issues: UntRegisterIssue[] = [];

  for (const recMatch of xml.matchAll(/<record>([\s\S]*?)<\/record>/g)) {
    const rec = recMatch[1];
    const idM = rec.match(/<identifier>info:(ark\/[^<]+)<\/identifier>/);
    const titleM = rec.match(/<untl:title\s+qualifier="officialtitle">([^<]+)<\/untl:title>/);
    const dateM = rec.match(/<untl:date\s+qualifier="creation">(\d{4}-\d{2}-\d{2})<\/untl:date>/);
    if (!idM || !titleM) continue;

    const arkId = idM[1].replace(/^ark\//, 'ark:/');
    const title = titleM[1].trim();
    const issueDate = dateM ? dateM[1] : '';
    if (fromDate && issueDate && issueDate < fromDate) continue;

    const volM = title.match(/Volume\s+(\d+)/i);
    const numM = title.match(/Number\s+(\d+)/i);
    const pageM = title.match(/Pages?\s+([\d-]+)/i);

    issues.push({
      arkId,
      title,
      volume: volM ? Number(volM[1]) : 0,
      issueNumber: numM ? Number(numM[1]) : 0,
      pageRange: pageM ? pageM[1] : '',
      issueDate: issueDate || fromDate,
      sourceUrl: `${UNT_ARK_BASE}/${arkId}/`,
    });
  }

  // Most recent issues first
  issues.sort((a, b) => b.issueDate.localeCompare(a.issueDate));
  return issues.slice(0, maxIssues);
}

async function fetchIssuePdfUrl(arkUrl: string): Promise<string | null> {
  const res = await fetch(arkUrl, {
    headers: { 'User-Agent': 'TexasCapitolLedger/1.0 (Legislative Research Archive)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const pdfM = html.match(/https?:\/\/texashistory\.unt\.edu\/ark:\/[^"'\s]+\.pdf/i);
  return pdfM ? pdfM[0] : null;
}

function mapSyncJobRow(row: Record<string, unknown>): TexRegSyncJob {
  return {
    id: String(row.id),
    status: row.status as TexRegSyncJob['status'],
    fromDate: String(row.from_date || ''),
    maxIssues: Number(row.max_issues || 0),
    issuesDiscovered: Number(row.issues_discovered || 0),
    issuesProcessed: Number(row.issues_processed || 0),
    rulesUpserted: Number(row.rules_upserted || 0),
    billLinksCreated: Number(row.bill_links_created || 0),
    currentIssue: String(row.current_issue || ''),
    message: String(row.message || ''),
    startedAt: String(row.started_at || ''),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

export function getLatestTexRegSyncJob(): TexRegSyncJob | null {
  const row = db
    .prepare(`SELECT * FROM texreg_sync_jobs ORDER BY started_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return row ? mapSyncJobRow(row) : null;
}

export function startTexRegSyncJob(options: { fromDate?: string; maxIssues?: number }): TexRegSyncJob {
  const running = db
    .prepare(`SELECT * FROM texreg_sync_jobs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  if (running) return mapSyncJobRow(running);

  const fromDate = options.fromDate || '2025-01-01';
  const maxIssues = Math.min(20, Math.max(1, Number(options.maxIssues) || 4));
  const id = `trsync-${crypto.randomUUID().slice(0, 10)}`;
  const startedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO texreg_sync_jobs
     (id, status, from_date, max_issues, issues_discovered, issues_processed, rules_upserted, bill_links_created, current_issue, message, started_at)
     VALUES (?, 'running', ?, ?, 0, 0, 0, 0, '', 'Querying official Texas Register archive (UNT / Texas SOS)…', ?)`
  ).run(id, fromDate, maxIssues, startedAt);

  const updateJob = (patch: Partial<{
    status: string;
    issuesDiscovered: number;
    issuesProcessed: number;
    rulesUpserted: number;
    billLinksCreated: number;
    currentIssue: string;
    message: string;
    completedAt: string | null;
  }>) => {
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (patch.issuesDiscovered !== undefined) { sets.push('issues_discovered = ?'); vals.push(patch.issuesDiscovered); }
    if (patch.issuesProcessed !== undefined) { sets.push('issues_processed = ?'); vals.push(patch.issuesProcessed); }
    if (patch.rulesUpserted !== undefined) { sets.push('rules_upserted = ?'); vals.push(patch.rulesUpserted); }
    if (patch.billLinksCreated !== undefined) { sets.push('bill_links_created = ?'); vals.push(patch.billLinksCreated); }
    if (patch.currentIssue !== undefined) { sets.push('current_issue = ?'); vals.push(patch.currentIssue); }
    if (patch.message !== undefined) { sets.push('message = ?'); vals.push(patch.message); }
    if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); vals.push(patch.completedAt); }
    if (sets.length > 0) {
      db.prepare(`UPDATE texreg_sync_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    }
  };

  void (async () => {
    try {
      const issues = await discoverUntRegisterIssues(fromDate, maxIssues);
      updateJob({
        issuesDiscovered: issues.length,
        message: `Discovered ${issues.length} weekly Texas Register issue(s) since ${fromDate}.`,
      });

      let issuesProcessed = 0;
      let totalRules = 0;
      let totalLinks = 0;

      for (const issue of issues) {
        updateJob({
          currentIssue: `${issue.issueDate} (Vol. ${issue.volume}, No. ${issue.issueNumber})`,
          message: `Fetching Texas Register Vol. ${issue.volume}, No. ${issue.issueNumber} (${issue.issueDate})…`,
        });

        try {
          const pdfUrl = await fetchIssuePdfUrl(issue.sourceUrl);
          if (pdfUrl) {
            const pdfRes = await fetch(pdfUrl, {
              headers: { 'User-Agent': 'TexasCapitolLedger/1.0 (Legislative Research Archive)' },
              signal: AbortSignal.timeout(45000),
            });
            if (pdfRes.ok) {
              const buf = new Uint8Array(await pdfRes.arrayBuffer());
              const extracted = await extractText(buf, { mergePages: true });
              const rawText = Array.isArray(extracted.text)
                ? extracted.text.join('\n')
                : String(extracted.text || '');
              const parsed = parseTexasRegisterText(rawText, {
                issueDate: issue.issueDate,
                volume: issue.volume,
                issueNumber: issue.issueNumber,
                pageRange: issue.pageRange,
                sourceUrl: issue.sourceUrl,
                source: `Texas Register Vol. ${issue.volume}, No. ${issue.issueNumber} (UNT / Texas SOS)`,
              });
              const { rulesUpserted, billLinksCreated } = upsertParsedAgencyRules(parsed);
              totalRules += rulesUpserted;
              totalLinks += billLinksCreated;
            }
          }
        } catch {
          // Continue to next weekly issue if a single PDF times out
        }

        issuesProcessed += 1;
        updateJob({
          issuesProcessed,
          rulesUpserted: totalRules,
          billLinksCreated: totalLinks,
        });
      }

      updateJob({
        status: 'completed',
        currentIssue: '',
        message: `Synced ${issuesProcessed} weekly Texas Register issue(s): ${totalRules} rule notice(s) indexed, ${totalLinks} bill link(s) created.`,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      updateJob({
        status: 'failed',
        message: err instanceof Error ? err.message : 'Texas Register sync failed',
        completedAt: new Date().toISOString(),
      });
    }
  })();

  const created = db.prepare(`SELECT * FROM texreg_sync_jobs WHERE id = ?`).get(id) as Record<string, unknown>;
  return mapSyncJobRow(created);
}
