import crypto from 'crypto';
import { db, isProceduralCommittee } from './db.ts';
import type {
  BillOutcome,
  Chamber,
  ResearchCitedBill,
  ResearchCitedPolitician,
  ResearchQueryRecord,
  ResearchToolTrace,
} from '../types.ts';

interface LlmConfig {
  baseUrl: string;
  endpoint: string;
  modelsUrl: string;
  model: string;
  apiKey: string;
}

export function getLocalLlmConfig(): LlmConfig {
  const rawBaseUrl = (process.env.LOCAL_LLM_URL || 'http://192.168.4.20:11434/v1/').trim();
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const modelsUrl = baseUrl.endsWith('/chat/completions')
    ? baseUrl.replace(/\/chat\/completions$/, '/models')
    : `${baseUrl}/models`;
  const model = (process.env.LOCAL_LLM_MODEL || 'qwen2.5:7b').trim();
  const apiKey = (process.env.LOCAL_LLM_API_KEY || '').trim();
  return { baseUrl, endpoint, modelsUrl, model, apiKey };
}

export async function checkLocalLlmReachable(timeoutMs = 2800): Promise<{
  reachable: boolean;
  baseUrl: string;
  model: string;
  error?: string;
}> {
  const cfg = getLocalLlmConfig();
  if (!cfg.baseUrl) {
    return { reachable: false, baseUrl: '', model: cfg.model, error: 'LOCAL_LLM_URL not configured' };
  }
  try {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    await fetch(cfg.modelsUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { reachable: true, baseUrl: cfg.baseUrl, model: cfg.model };
  } catch (err) {
    return {
      reachable: false,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      error: err instanceof Error ? err.message : 'Connection failed',
    };
  }
}

function safeStr(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return fallback;
  return v == null ? fallback : String(v);
}

function safeJsonArray<T = string>(raw: unknown): T[] {
  try {
    const parsed = JSON.parse(safeStr(raw, '[]'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function classifyOutcome(
  session: string,
  stage: string,
  status: string,
  lastAction: string,
  committeesCount: number
): { outcome: BillOutcome; outcomeDetail: string } {
  const legNum = parseInt(session, 10);
  const isPreviousSession = !Number.isNaN(legNum) && legNum < 90;
  const combined = `${stage} ${status} ${lastAction}`.toLowerCase();

  if (
    stage === 'Vetoed' ||
    (/\bvetoed\b/.test(combined) &&
      !combined.includes('signed by the governor') &&
      !combined.includes('line-item veto'))
  ) {
    return { outcome: 'Vetoed', outcomeDetail: 'Vetoed by Governor' };
  }

  if (
    stage === 'Signed' ||
    stage === 'Enrolled' ||
    combined.includes('signed by the governor') ||
    combined.includes('filed without the governor') ||
    combined.includes('filed with the secretary of state') ||
    combined.includes('effective on') ||
    combined.includes('effective immediately') ||
    combined.includes('became law') ||
    combined.includes('enacted')
  ) {
    let passedDetail = 'Passed · Enacted';
    if (combined.includes('filed without the governor')) {
      passedDetail = 'Passed · Filed Without Signature';
    } else if (combined.includes('filed with the secretary of state')) {
      passedDetail = 'Passed · Filed with Sec. of State';
    } else if (combined.includes('line-item veto')) {
      passedDetail = 'Passed · Signed (Line-Item Veto)';
    } else if (stage === 'Signed' || combined.includes('signed by the governor')) {
      passedDetail = 'Passed · Signed';
    } else if (stage === 'Enrolled') {
      passedDetail = 'Passed · Enrolled';
    }
    return { outcome: 'Passed', outcomeDetail: passedDetail };
  }

  if (!isPreviousSession) {
    return { outcome: 'Active', outcomeDetail: `Active · ${stage || 'In Progress'}` };
  }

  if (combined.includes('conference') || combined.includes('impasse')) {
    return { outcome: 'Failed', outcomeDetail: 'Failed · Conference Impasse' };
  }
  if (stage === 'Engrossed') {
    return { outcome: 'Failed', outcomeDetail: 'Failed · Died in Opposite Chamber' };
  }
  if (stage === 'Committee Reported') {
    return { outcome: 'Failed', outcomeDetail: 'Failed · Died on Calendar / Floor' };
  }
  if (
    stage === 'Committee Hearing' ||
    committeesCount > 0 ||
    combined.includes('committee') ||
    combined.includes('referred to')
  ) {
    return { outcome: 'Failed', outcomeDetail: 'Failed · Died in Committee' };
  }
  if (stage === 'Stalled') {
    return { outcome: 'Failed', outcomeDetail: 'Failed · Stalled at Sine Die' };
  }
  return { outcome: 'Failed', outcomeDetail: 'Failed · Died in Filing' };
}

// Domain synonym & jurisdiction expansion for policy intelligence
interface PolicyExpansion {
  triggers: string[];
  billTerms: string[];
  committeeTerms: string[];
  donorSectors: string[];
  fiscalRelevant: boolean;
}

const POLICY_EXPANSIONS: PolicyExpansion[] = [
  {
    triggers: ['medicaid', 'hhsc', 'chip', 'health care', 'healthcare', 'public health', 'hospital', 'medical'],
    billTerms: [
      'medicaid',
      'hhsc',
      'health and human services',
      'healthcare',
      'health care',
      'hospital',
      'medical assistance',
      'ambulance',
      'paramedic',
    ],
    committeeTerms: ['human services', 'public health', 'health', 'appropriations', 'finance'],
    donorSectors: ['health', 'medical', 'hospital', 'pharma', 'insurance'],
    fiscalRelevant: true,
  },
  {
    triggers: ['autonomous', 'self-driving', 'self driving', 'driverless', 'automated vehicle', 'automated motor'],
    // Keep strictly vehicle-specific phrases so bare "autonomous" never matches unrelated education/governance bills
    billTerms: [
      'autonomous vehicle',
      'autonomous vehicles',
      'autonomous driving',
      'autonomous motor vehicle',
      'automated motor vehicle',
      'automated vehicle',
      'automated driving system',
      'self-driving',
      'driverless',
      'robotaxi',
    ],
    committeeTerms: ['transportation', 'business', 'state affairs', 'licensing'],
    donorSectors: ['transportation', 'auto', 'tech', 'mobility', 'insurance'],
    fiscalRelevant: false,
  },
  {
    triggers: ['education', 'school', 'voucher', 'staar', 'teacher', 'allotment', 'isd', 'esa'],
    billTerms: ['education', 'school', 'allotment', 'teacher', 'voucher', 'freedom accounts', 'staar', 'assessment', 'prekindergarten'],
    committeeTerms: ['public education', 'education', 'appropriations', 'finance'],
    donorSectors: ['education', 'teacher', 'school', 'charter', 'civic'],
    fiscalRelevant: true,
  },
  {
    triggers: ['ercot', 'grid', 'energy', 'electric', 'power', 'nuclear', 'utility', 'data center'],
    billTerms: ['ercot', 'grid', 'electric', 'nuclear', 'reactor', 'power plant', 'weatherization', 'energy fund', 'data center'],
    committeeTerms: ['state affairs', 'business', 'energy', 'natural resources'],
    donorSectors: ['energy', 'oil', 'gas', 'utility', 'electric', 'power'],
    fiscalRelevant: true,
  },
  {
    triggers: ['water', 'aquifer', 'desalination', 'flood', 'twdb', 'drought'],
    billTerms: ['water', 'desalination', 'aquifer', 'flood', 'twdb', 'water development'],
    committeeTerms: ['natural resources', 'water', 'agriculture', 'appropriations', 'finance'],
    donorSectors: ['water', 'agriculture', 'infrastructure', 'real estate', 'energy'],
    fiscalRelevant: true,
  },
  {
    triggers: ['property tax', 'homestead', 'appraisal', 'tax relief', 'tax'],
    billTerms: ['property tax', 'homestead', 'appraisal', 'tax rate', 'compression', 'motor fuels tax'],
    committeeTerms: ['ways & means', 'ways and means', 'local government', 'finance', 'appropriations'],
    donorSectors: ['real estate', 'realtor', 'business', 'banking', 'tax'],
    fiscalRelevant: true,
  },
  {
    triggers: [
      'artificial intelligence',
      'generative ai',
      'machine learning',
      'ai regulation',
      'ai governance',
      'ai safety',
      'ai act',
      'ai policy',
      'ai bill',
      'ai bills',
      'deepfake',
      'algorithmic',
      'automated decision',
      'ai',
    ],
    billTerms: [
      'artificial intelligence',
      'generative artificial intelligence',
      'generative ai',
      'machine learning',
      'automated decision system',
      'automated decision-making',
      'algorithmic',
      'deepfake',
      'large language model',
      'neural network',
      'ai system',
      'ai systems',
      'ai model',
      'ai models',
      'ai',
    ],
    committeeTerms: [
      'state affairs',
      'business',
      'technology',
      'innovation',
      'delivery of government efficiency',
      'trade',
    ],
    donorSectors: ['tech', 'technology', 'software', 'telecom', 'data'],
    fiscalRelevant: false,
  },
  {
    triggers: ['budget', 'appropriations', 'spending', 'fiscal', 'revenue'],
    billTerms: ['appropriations', 'biennium', 'budget', 'comptroller', 'grant'],
    committeeTerms: ['appropriations', 'finance', 'ways & means'],
    donorSectors: ['business', 'health', 'energy', 'real estate'],
    fiscalRelevant: true,
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary matcher so short tokens like "ai" NEVER match inside "affairs",
 * "certain", "maintain", "paid", "training", etc.
 */
function matchesTermWithBoundary(haystack: string, term: string): boolean {
  const clean = term.trim().toLowerCase();
  if (!clean) return false;
  // Multi-word phrases and short tokens (<= 4 chars) require exact start + end word boundaries.
  // Longer single words allow prefix stem matching (e.g. "regul" -> "regulation"/"regulating") at word start.
  const pattern =
    clean.includes(' ') || clean.length <= 4
      ? `\\b${escapeRegExp(clean)}\\b`
      : `\\b${escapeRegExp(clean)}`;
  return new RegExp(pattern, 'i').test(haystack);
}

function findPolicyExpansion(topic: string): PolicyExpansion | null {
  const lower = topic.toLowerCase();
  for (const exp of POLICY_EXPANSIONS) {
    if (exp.triggers.some((t) => matchesTermWithBoundary(lower, t))) {
      return exp;
    }
  }
  return null;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'about',
  'from',
  'into',
  'over',
  'have',
  'been',
  'that',
  'this',
  'bill',
  'bills',
  'policy',
  'texas',
  'legislature',
  'session',
  'sessions',
]);

// Generic legislative intent modifiers stripped if strict AND returns 0 hits
const GENERIC_INTENT_MODIFIERS = new Set([
  'regulation',
  'regulations',
  'regulatory',
  'regulate',
  'regulating',
  'law',
  'laws',
  'legislation',
  'rule',
  'rules',
  'governance',
  'oversight',
  'reform',
  'reforms',
]);

function extractQueryTokens(raw: string): string[] {
  const cleaned = raw
    .replace(/['"`*?()[\]{}:^~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()));
}

function buildFtsFromNaturalText(raw: string, metadataColumnsOnly = true): string {
  const tokens = extractQueryTokens(raw);
  if (tokens.length === 0) return '';
  const expr =
    tokens.length === 1
      ? tokens[0].length < 5
        ? `"${tokens[0]}"`
        : `"${tokens[0]}"*`
      : tokens.map((t) => (t.length < 5 ? `"${t}"` : `"${t}"*`)).join(' AND ');
  // Restrict bills_fts matches to metadata columns (title, summary, subjects, statute_codes)
  // so incidental words buried inside long full_text excerpts do not cause cross-topic leakage.
  return metadataColumnsOnly ? `{title summary subjects statute_codes} : (${expr})` : expr;
}

function buildOrFtsFromTerms(terms: string[], metadataColumnsOnly = true): string {
  const parts = terms
    .map((t) => t.replace(/['"`*?()[\]{}:^~]/g, ' ').trim())
    .filter((t) => t.length >= 2)
    .map((t) => (t.includes(' ') || t.length < 5 ? `"${t}"` : `"${t}"*`));
  const unique = Array.from(new Set(parts));
  if (unique.length === 0) return '';
  const expr = unique.join(' OR ');
  return metadataColumnsOnly ? `{title summary subjects statute_codes} : (${expr})` : expr;
}

interface BillDbRow {
  id: string;
  session: string;
  bill_number: string;
  chamber: Chamber;
  title: string;
  summary: string;
  statute_codes: string;
  status: string;
  stage: string;
  primary_author: string;
  coauthors_json: string;
  sponsors_json: string;
  cosponsors_json: string;
  committees_json: string;
  subjects_json: string;
  last_action: string;
  last_action_date: string;
  filed_date: string;
  influence_score: number;
  bipartisan_index: number;
  amendment_count: number;
  action_count: number;
  full_text: string;
}

interface AgentExecutionContext {
  citedBillsMap: Map<string, ResearchCitedBill>;
  citedPoliticiansMap: Map<string, ResearchCitedPolitician>;
  traces: ResearchToolTrace[];
}

function registerBillCitation(ctx: AgentExecutionContext, row: BillDbRow): ResearchCitedBill {
  const committees = safeJsonArray<{ name: string }>(row.committees_json);
  const { outcome, outcomeDetail } = classifyOutcome(
    row.session,
    row.stage,
    row.status,
    row.last_action,
    committees.length
  );
  const cited: ResearchCitedBill = {
    id: row.id,
    session: row.session,
    billNumber: row.bill_number,
    title: row.title,
    chamber: row.chamber,
    stage: row.stage,
    outcome,
    outcomeDetail,
    primaryAuthor: row.primary_author,
    influenceScore: Number(row.influence_score || 0),
  };
  if (!ctx.citedBillsMap.has(row.id)) {
    ctx.citedBillsMap.set(row.id, cited);
  }
  return cited;
}

function registerPoliticianCitation(
  ctx: AgentExecutionContext,
  pol: {
    id: string;
    name: string;
    shortName: string;
    chamber: Chamber;
    party: string;
    district: string;
    leadershipRole: string;
    score?: number;
    reason?: string;
  }
): ResearchCitedPolitician {
  const partyNorm: 'R' | 'D' | '—' =
    pol.party === 'R' || pol.party === 'D' ? pol.party : '—';
  const entry: ResearchCitedPolitician = {
    id: pol.id,
    name: pol.name,
    shortName: pol.shortName,
    chamber: pol.chamber,
    party: partyNorm,
    district: pol.district || '',
    leadershipRole: pol.leadershipRole || '',
    score: pol.score,
    reason: pol.reason,
  };
  const existing = ctx.citedPoliticiansMap.get(pol.id);
  if (!existing || (entry.score ?? 0) > (existing.score ?? 0)) {
    ctx.citedPoliticiansMap.set(pol.id, entry);
  }
  return entry;
}

function normalizeSessionCode(raw: string): string {
  const s = safeStr(raw).trim().toUpperCase();
  if (!s) return '';
  if (s === 'ALL' || s === 'ALL SESSIONS') return '';
  // Normalize "89-1" -> "891", "89TH" -> "89R"
  const called = s.match(/^(\d{2})[-_](\d)$/);
  if (called) return `${called[1]}${called[2]}`;
  const ord = s.match(/^(\d{2})(?:ST|ND|RD|TH)$/);
  if (ord) return `${ord[1]}R`;
  return s;
}

// ============================================================================
// DETERMINISTIC RESEARCH TOOLS
// ============================================================================

function toolGetArchiveOverview(
  args: { session?: string },
  _ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const sessionFilter = normalizeSessionCode(args.session || '');
  const billRows = db
    .prepare(
      `SELECT id, session, stage, status, last_action, committees_json
       FROM bills ${sessionFilter ? 'WHERE UPPER(session) = ?' : ''}`
    )
    .all(...(sessionFilter ? [sessionFilter] : [])) as Array<{
    id: string;
    session: string;
    stage: string;
    status: string;
    last_action: string;
    committees_json: string;
  }>;

  const bySession = new Map<
    string,
    {
      session: string;
      total: number;
      passed: number;
      failed: number;
      vetoed: number;
      active: number;
      diedInCommittee: number;
    }
  >();
  for (const r of billRows) {
    const committees = safeJsonArray(r.committees_json);
    const { outcome, outcomeDetail } = classifyOutcome(
      r.session,
      r.stage,
      r.status,
      r.last_action,
      committees.length
    );
    const cur = bySession.get(r.session) || {
      session: r.session,
      total: 0,
      passed: 0,
      failed: 0,
      vetoed: 0,
      active: 0,
      diedInCommittee: 0,
    };
    cur.total += 1;
    if (outcome === 'Passed') cur.passed += 1;
    else if (outcome === 'Failed') {
      cur.failed += 1;
      if (outcomeDetail.toLowerCase().includes('died in committee')) cur.diedInCommittee += 1;
    } else if (outcome === 'Vetoed') cur.vetoed += 1;
    else cur.active += 1;
    bySession.set(r.session, cur);
  }

  const sessions = Array.from(bySession.values()).sort((a, b) => b.session.localeCompare(a.session));
  const totalBillsAllSessions = (db.prepare(`SELECT COUNT(*) AS c FROM bills`).get() as { c: number }).c;
  const politiciansCount = (db.prepare(`SELECT COUNT(*) AS c FROM politicians`).get() as { c: number }).c;
  const committeesCount = (db.prepare(`SELECT COUNT(*) AS c FROM committees`).get() as { c: number }).c;
  const statutesCount = (db.prepare(`SELECT COUNT(*) AS c FROM statute_sections`).get() as { c: number }).c;

  return {
    payload: {
      scope: sessionFilter || 'ALL SESSIONS',
      totalBillsInScope: billRows.length,
      totalBillsAllSessions,
      politiciansIndexed: politiciansCount,
      committeesIndexed: committeesCount,
      statuteSectionsIndexed: statutesCount,
      sessions,
    },
    summary: sessionFilter
      ? `${billRows.length} bills indexed in ${sessionFilter} (${totalBillsAllSessions} total across all sessions)`
      : `${billRows.length} bills indexed across ${sessions.length} session(s), ${politiciansCount} legislators, ${committeesCount} committees`,
    resultCount: billRows.length,
  };
}

function billMetadataContainsTokens(row: BillDbRow, tokens: string[]): boolean {
  const hay = `${row.title} ${row.summary} ${row.subjects_json} ${row.statute_codes}`;
  return tokens.every((t) => matchesTermWithBoundary(hay, t));
}

function billMetadataContainsAnyPhrase(row: BillDbRow, phrases: string[]): boolean {
  const hay = `${row.title} ${row.summary} ${row.subjects_json} ${row.statute_codes}`;
  return phrases.some((p) => matchesTermWithBoundary(hay, p));
}

function queryBillsMatchingText(
  query: string,
  filters: {
    session?: string;
    chamber?: string;
    stage?: string;
    author?: string;
    minInfluenceScore?: number;
    minBipartisanIndex?: number;
    includeFullText?: boolean;
  }
): { rows: BillDbRow[]; matchMode: 'exact_metadata_fts' | 'expanded_metadata_fts' | 'all_filtered' } {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filters.session) {
    conditions.push('UPPER(b.session) = UPPER(?)');
    params.push(filters.session);
  }
  if (filters.chamber) {
    conditions.push('LOWER(b.chamber) = LOWER(?)');
    params.push(filters.chamber);
  }
  if (filters.stage) {
    conditions.push('LOWER(b.stage) = LOWER(?)');
    params.push(filters.stage);
  }
  if (filters.author) {
    conditions.push(
      '(LOWER(b.primary_author) LIKE LOWER(?) OR LOWER(b.coauthors_json) LIKE LOWER(?) OR LOWER(b.sponsors_json) LIKE LOWER(?))'
    );
    const pat = `%${filters.author}%`;
    params.push(pat, pat, pat);
  }
  if (filters.minInfluenceScore !== undefined && Number.isFinite(filters.minInfluenceScore)) {
    conditions.push('b.influence_score >= ?');
    params.push(filters.minInfluenceScore);
  }
  if (filters.minBipartisanIndex !== undefined && Number.isFinite(filters.minBipartisanIndex)) {
    conditions.push('b.bipartisan_index >= ?');
    params.push(filters.minBipartisanIndex);
  }

  const metadataOnly = !filters.includeFullText;
  const trimmed = query.trim();

  if (!trimmed) {
    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT b.* FROM bills b ${whereSql} ORDER BY b.influence_score DESC, b.last_action_date DESC`)
      .all(...params) as BillDbRow[];
    return { rows, matchMode: 'all_filtered' };
  }

  const tokens = extractQueryTokens(trimmed);
  const coreTokens = tokens.filter((t) => !GENERIC_INTENT_MODIFIERS.has(t.toLowerCase()));
  const exp = findPolicyExpansion(trimmed) || (coreTokens.length > 0 ? findPolicyExpansion(coreTokens.join(' ')) : null);

  // 1. If a curated domain expansion matches (e.g. "AI regulation" -> artificial intelligence + word-bounded AI,
  // or "autonomous driving" -> autonomous/automated vehicle phrases), run column-restricted FTS5 across
  // the expansion terms AND verify with word-boundary regex against metadata columns ONLY.
  if (exp) {
    const combinedTerms = Array.from(new Set([...exp.billTerms]));
    const ftsExpanded = buildOrFtsFromTerms(combinedTerms, metadataOnly);
    if (ftsExpanded) {
      try {
        const whereSql = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
        const rawRows = db
          .prepare(
            `SELECT b.*
             FROM bills_fts
             JOIN bills b ON b.id = bills_fts.bill_id
             WHERE bills_fts MATCH ? ${whereSql}
             ORDER BY b.influence_score DESC, b.last_action_date DESC`
          )
          .all(ftsExpanded, ...params) as BillDbRow[];
        const verified = metadataOnly
          ? rawRows.filter((r) => billMetadataContainsAnyPhrase(r, combinedTerms))
          : rawRows;
        return { rows: verified, matchMode: 'expanded_metadata_fts' };
      } catch {
        // Fall through to exact FTS below
      }
    }
  }

  const runFtsForTokens = (toks: string[]): BillDbRow[] => {
    if (toks.length === 0) return [];
    const ftsExpr = buildFtsFromNaturalText(toks.join(' '), metadataOnly);
    if (!ftsExpr) return [];
    try {
      const whereSql = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      const rawRows = db
        .prepare(
          `SELECT b.*
           FROM bills_fts
           JOIN bills b ON b.id = bills_fts.bill_id
           WHERE bills_fts MATCH ? ${whereSql}
           ORDER BY b.influence_score DESC, b.last_action_date DESC`
        )
        .all(ftsExpr, ...params) as BillDbRow[];
      return metadataOnly ? rawRows.filter((r) => billMetadataContainsTokens(r, toks)) : rawRows;
    } catch {
      return [];
    }
  };

  // 2. Column-restricted FTS5 on all query tokens (strictly metadata columns + word-boundary verified)
  const exactRows = runFtsForTokens(tokens);
  if (exactRows.length > 0) {
    return { rows: exactRows, matchMode: 'exact_metadata_fts' };
  }

  // 3. If generic intent modifiers (e.g. "regulation", "laws", "rules") caused 0 hits on strict AND,
  // retry with just the substantive subject tokens (still strictly metadata + word-boundary verified)
  if (coreTokens.length > 0 && coreTokens.length < tokens.length) {
    const coreRows = runFtsForTokens(coreTokens);
    if (coreRows.length > 0) {
      return { rows: coreRows, matchMode: 'exact_metadata_fts' };
    }
  }

  // 4. Safe metadata-only LIKE fallback ONLY for phrases >= 4 chars (never short tokens like "AI"),
  // strictly verified with word-boundary matching so substrings like "Affairs" never leak
  if (trimmed.length >= 4 && tokens.every((t) => t.length >= 4)) {
    const likeExpr = metadataOnly
      ? `(LOWER(b.title) LIKE LOWER(?) OR LOWER(b.summary) LIKE LOWER(?) OR LOWER(b.subjects_json) LIKE LOWER(?) OR LOWER(b.statute_codes) LIKE LOWER(?))`
      : `(LOWER(b.title) LIKE LOWER(?) OR LOWER(b.summary) LIKE LOWER(?) OR LOWER(b.subjects_json) LIKE LOWER(?) OR LOWER(b.full_text) LIKE LOWER(?))`;
    const likeCond = [...conditions, likeExpr];
    const pat = `%${trimmed}%`;
    const rows = db
      .prepare(
        `SELECT b.* FROM bills b WHERE ${likeCond.join(' AND ')} ORDER BY b.influence_score DESC, b.last_action_date DESC`
      )
      .all(...params, pat, pat, pat, pat) as BillDbRow[];
    const verified = metadataOnly ? rows.filter((r) => billMetadataContainsTokens(r, tokens)) : rows;
    if (verified.length > 0) {
      return { rows: verified, matchMode: 'exact_metadata_fts' };
    }
  }

  return { rows: [], matchMode: 'exact_metadata_fts' };
}

function toolSearchAndCountBills(
  args: {
    query?: string;
    session?: string;
    chamber?: string;
    outcome?: string;
    disposition?: string;
    stage?: string;
    author?: string;
    minInfluenceScore?: number;
    minBipartisanIndex?: number;
    sortBy?: 'influence' | 'bipartisan' | 'influence_and_bipartisan' | 'amendments' | 'recent';
    limit?: number;
  },
  ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const query = safeStr(args.query).trim();
  const session = normalizeSessionCode(args.session || '');
  const chamber = safeStr(args.chamber).trim();
  const outcomeFilter = safeStr(args.outcome).trim().toLowerCase();
  const dispositionFilter = safeStr(args.disposition).trim().toLowerCase().replace(/_/g, ' ');
  const stage = safeStr(args.stage).trim();
  const author = safeStr(args.author).trim();
  const minInfluenceScore =
    args.minInfluenceScore !== undefined && args.minInfluenceScore !== null && args.minInfluenceScore !== ('' as unknown)
      ? Number(args.minInfluenceScore)
      : undefined;
  const minBipartisanIndex =
    args.minBipartisanIndex !== undefined && args.minBipartisanIndex !== null && args.minBipartisanIndex !== ('' as unknown)
      ? Number(args.minBipartisanIndex)
      : undefined;
  const sortBy = args.sortBy || 'influence';
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 12));

  const { rows: rawRows, matchMode } = queryBillsMatchingText(query, {
    session: session || undefined,
    chamber: chamber || undefined,
    stage: stage || undefined,
    author: author || undefined,
    minInfluenceScore: Number.isFinite(minInfluenceScore) ? minInfluenceScore : undefined,
    minBipartisanIndex: Number.isFinite(minBipartisanIndex) ? minBipartisanIndex : undefined,
    includeFullText: false,
  });

  const enriched = rawRows.map((row) => {
    const committees = safeJsonArray<{ name: string; chamber: string }>(row.committees_json);
    const { outcome, outcomeDetail } = classifyOutcome(
      row.session,
      row.stage,
      row.status,
      row.last_action,
      committees.length
    );
    return { row, committees, outcome, outcomeDetail };
  });

  let filtered = enriched;
  if (outcomeFilter) {
    filtered = filtered.filter((e) => e.outcome.toLowerCase() === outcomeFilter);
  }
  if (dispositionFilter) {
    filtered = filtered.filter((e) => e.outcomeDetail.toLowerCase().includes(dispositionFilter));
  }

  // Apply explicit sorting requested by the user/LLM
  if (sortBy === 'bipartisan') {
    filtered.sort(
      (a, b) =>
        (b.row.bipartisan_index || 0) - (a.row.bipartisan_index || 0) ||
        (b.row.influence_score || 0) - (a.row.influence_score || 0)
    );
  } else if (sortBy === 'influence_and_bipartisan') {
    filtered.sort((a, b) => {
      const scoreA = (a.row.influence_score || 0) * 0.6 + (a.row.bipartisan_index || 0) * 40;
      const scoreB = (b.row.influence_score || 0) * 0.6 + (b.row.bipartisan_index || 0) * 40;
      return scoreB - scoreA;
    });
  } else if (sortBy === 'amendments') {
    filtered.sort(
      (a, b) =>
        (b.row.amendment_count || 0) - (a.row.amendment_count || 0) ||
        (b.row.influence_score || 0) - (a.row.influence_score || 0)
    );
  } else if (sortBy === 'recent') {
    filtered.sort((a, b) => (b.row.last_action_date || '').localeCompare(a.row.last_action_date || ''));
  }

  const bySessionMap = new Map<
    string,
    { session: string; total: number; passed: number; failed: number; vetoed: number; active: number }
  >();
  const byChamber = { House: 0, Senate: 0 };
  const byOutcome = { Passed: 0, Failed: 0, Vetoed: 0, Active: 0 };
  const byDisposition = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  const committeeCounts = new Map<string, number>();

  for (const item of filtered) {
    const s = item.row.session;
    const cur = bySessionMap.get(s) || {
      session: s,
      total: 0,
      passed: 0,
      failed: 0,
      vetoed: 0,
      active: 0,
    };
    cur.total += 1;
    if (item.outcome === 'Passed') cur.passed += 1;
    else if (item.outcome === 'Failed') cur.failed += 1;
    else if (item.outcome === 'Vetoed') cur.vetoed += 1;
    else cur.active += 1;
    bySessionMap.set(s, cur);

    if (item.row.chamber === 'House') byChamber.House += 1;
    else if (item.row.chamber === 'Senate') byChamber.Senate += 1;

    byOutcome[item.outcome] += 1;
    byDisposition.set(item.outcomeDetail, (byDisposition.get(item.outcomeDetail) ?? 0) + 1);

    if (item.row.primary_author) {
      authorCounts.set(item.row.primary_author, (authorCounts.get(item.row.primary_author) ?? 0) + 1);
    }
    for (const c of item.committees) {
      if (c.name) {
        const key = `${c.chamber || item.row.chamber} ${c.name}`.trim();
        committeeCounts.set(key, (committeeCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const topBills = filtered.slice(0, limit).map(({ row, outcome, outcomeDetail }) => {
    registerBillCitation(ctx, row);
    return {
      id: row.id,
      session: row.session,
      billNumber: row.bill_number,
      chamber: row.chamber,
      title: row.title,
      stage: row.stage,
      outcome,
      outcomeDetail,
      primaryAuthor: row.primary_author,
      influenceScore: Number((row.influence_score || 0).toFixed(1)),
      bipartisanIndex: Number((row.bipartisan_index || 0).toFixed(2)),
      amendmentCount: row.amendment_count || 0,
      filedDate: row.filed_date,
      lastActionDate: row.last_action_date,
    };
  });

  // Compute BOTH the session-scoped total (when session is specified) AND the overall archive total
  const totalBillsInScope = session
    ? (db.prepare(`SELECT COUNT(*) AS c FROM bills WHERE UPPER(session) = UPPER(?)`).get(session) as { c: number }).c
    : (db.prepare(`SELECT COUNT(*) AS c FROM bills`).get() as { c: number }).c;
  const totalBillsAllSessions = (db.prepare(`SELECT COUNT(*) AS c FROM bills`).get() as { c: number }).c;

  const isUpcomingSession = session ? parseInt(session, 10) >= 90 : false;

  const payload = {
    query: query || '(all bills matching filters)',
    searchColumns: 'title, summary, subjects, statute_codes (excludes full_text)',
    matchMode,
    filters: {
      session: session || 'ALL SESSIONS',
      chamber: chamber || 'ALL',
      outcome: outcomeFilter || 'ALL',
      disposition: dispositionFilter || 'ALL',
      stage: stage || 'ALL',
      minInfluenceScore: Number.isFinite(minInfluenceScore) ? minInfluenceScore : null,
      minBipartisanIndex: Number.isFinite(minBipartisanIndex) ? minBipartisanIndex : null,
      sortBy,
    },
    totalMatches: filtered.length,
    totalBillsInScope,
    totalBillsAllSessions,
    ...(isUpcomingSession
      ? {
          sessionNote: `${session} is the upcoming/active 90th Legislature (pre-filing/in-progress). Bills in ${session} have outcome "Active" and have not died at sine die.`,
        }
      : {}),
    bySession: Array.from(bySessionMap.values()).sort((a, b) => b.session.localeCompare(a.session)),
    byChamber,
    byOutcome,
    byDisposition: Object.fromEntries(
      Array.from(byDisposition.entries()).sort((a, b) => b[1] - a[1])
    ),
    topAuthors: Array.from(authorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
    topCommittees: Array.from(committeeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => ({ name, count })),
    bills: topBills,
  };

  const scopeLabel = session ? `in ${session} (${totalBillsInScope} bills in ${session})` : `across all sessions (${totalBillsInScope} total)`;

  return {
    payload,
    summary:
      filtered.length === 0
        ? `0 bills matched ${query ? `"${query}"` : 'criteria'} ${scopeLabel}`
        : `${filtered.length} matching bill${filtered.length === 1 ? '' : 's'} ${scopeLabel} (${byOutcome.Passed} passed, ${byOutcome.Failed} failed, ${byOutcome.Active} active)`,
    resultCount: filtered.length,
  };
}

function toolGetCommitteeStats(
  args: {
    query?: string;
    chamber?: string;
    session?: string;
    sortBy?: 'bottleneck' | 'most_referred' | 'highest_passage';
    includeProcedural?: boolean;
    limit?: number;
  },
  ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const q = safeStr(args.query).trim().toLowerCase();
  const chamberFilter = safeStr(args.chamber).trim();
  const sessionFilter = normalizeSessionCode(args.session || '');
  const sortBy = args.sortBy || 'bottleneck';
  const queryAsksProcedural = /\b(calendar|calendars|procedural|administration|rules\s*(?:&|and)\s*resolutions)\b/i.test(q);
  const includeProcedural = Boolean(args.includeProcedural) || queryAsksProcedural;
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 12));
  const expansion = q ? findPolicyExpansion(q) : null;

  const billRows = db
    .prepare(
      `SELECT id, session, chamber, stage, status, last_action, committees_json
       FROM bills
       ${sessionFilter ? 'WHERE UPPER(session) = UPPER(?)' : ''}`
    )
    .all(...(sessionFilter ? [sessionFilter] : [])) as Array<{
    id: string;
    session: string;
    chamber: Chamber;
    stage: string;
    status: string;
    last_action: string;
    committees_json: string;
  }>;

  // Lookup chair/jurisdiction metadata from committees table
  const commMetaRows = db
    .prepare(
      `SELECT c.id, c.name, c.chamber, c.session, c.jurisdiction,
              p1.id AS chair_pol_id, p1.name AS chair_name, p1.party AS chair_party, p1.district AS chair_district,
              p2.name AS vice_chair_name
       FROM committees c
       LEFT JOIN politicians p1 ON p1.id = c.chair_id
       LEFT JOIN politicians p2 ON p2.id = c.vice_chair_id`
    )
    .all() as Array<{
    id: string;
    name: string;
    chamber: Chamber;
    session: string;
    jurisdiction: string;
    chair_pol_id: string | null;
    chair_name: string | null;
    chair_party: string | null;
    chair_district: string | null;
    vice_chair_name: string | null;
  }>;

  const metaByKey = new Map<string, (typeof commMetaRows)[number]>();
  for (const m of commMetaRows) {
    metaByKey.set(`${m.chamber.toLowerCase()}::${m.name.toLowerCase()}`, m);
  }

  interface CommAgg {
    key: string;
    chamber: Chamber;
    name: string;
    referredCount: number;
    reportedCount: number;
    passedCount: number;
    failedCount: number;
    diedInCommitteeCount: number;
    activeCount: number;
  }

  const aggMap = new Map<string, CommAgg>();

  for (const b of billRows) {
    const committees = safeJsonArray<{ name?: string; chamber?: Chamber; status?: string }>(b.committees_json);
    if (committees.length === 0) continue;
    const { outcome, outcomeDetail } = classifyOutcome(
      b.session,
      b.stage,
      b.status,
      b.last_action,
      committees.length
    );

    const seenInBill = new Set<string>();
    for (const c of committees) {
      const cName = safeStr(c.name).trim();
      if (!cName) continue;
      const cChamber: Chamber = c.chamber === 'Senate' || c.chamber === 'House' ? c.chamber : b.chamber;
      if (chamberFilter && cChamber.toLowerCase() !== chamberFilter.toLowerCase()) continue;

      const key = `${cChamber.toLowerCase()}::${cName.toLowerCase()}`;
      if (seenInBill.has(key)) continue;
      seenInBill.add(key);

      const cur = aggMap.get(key) || {
        key,
        chamber: cChamber,
        name: cName,
        referredCount: 0,
        reportedCount: 0,
        passedCount: 0,
        failedCount: 0,
        diedInCommitteeCount: 0,
        activeCount: 0,
      };
      cur.referredCount += 1;

      const cStatus = safeStr(c.status).toLowerCase();
      const wasReported =
        ['Committee Reported', 'Engrossed', 'Enrolled', 'Signed', 'Vetoed'].includes(b.stage) ||
        cStatus.includes('reported') ||
        cStatus.includes('passed');
      if (wasReported) cur.reportedCount += 1;

      if (outcome === 'Passed') cur.passedCount += 1;
      else if (outcome === 'Failed') {
        cur.failedCount += 1;
        if (outcomeDetail.toLowerCase().includes('died in committee')) {
          cur.diedInCommitteeCount += 1;
        }
      } else if (outcome === 'Active') {
        cur.activeCount += 1;
      }

      aggMap.set(key, cur);
    }
  }

  let rows = Array.from(aggMap.values()).map((a) => {
    const meta = metaByKey.get(a.key);
    const completedCount = a.passedCount + a.failedCount;
    const reportRatePct = a.referredCount > 0 ? Math.round((a.reportedCount / a.referredCount) * 1000) / 10 : 0;
    const passageRatePct =
      completedCount > 0
        ? Math.round((a.passedCount / completedCount) * 1000) / 10
        : a.referredCount > 0
          ? Math.round((a.passedCount / a.referredCount) * 1000) / 10
          : 0;

    return {
      ...a,
      isProcedural: isProceduralCommittee(a.name),
      reportRatePct,
      passageRatePct,
      chair: meta?.chair_name || 'Unassigned',
      chairPolId: meta?.chair_pol_id || null,
      chairParty: meta?.chair_party || '—',
      chairDistrict: meta?.chair_district || '',
      viceChair: meta?.vice_chair_name || 'Unassigned',
      jurisdiction: meta?.jurisdiction || '',
    };
  });

  const excludedProceduralCommittees = includeProcedural
    ? []
    : rows.filter((r) => r.isProcedural).map((r) => `${r.chamber} ${r.name}`);

  if (!includeProcedural) {
    const substantive = rows.filter((r) => !r.isProcedural);
    if (substantive.length > 0) {
      rows = substantive;
    }
  }

  if (q) {
    const matched = rows.filter((r) => {
      const hay = `${r.chamber} ${r.name} ${r.jurisdiction}`.toLowerCase();
      if (hay.includes(q)) return true;
      if (expansion && expansion.committeeTerms.some((t) => hay.includes(t))) return true;
      return q
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .some((w) => hay.includes(w));
    });
    if (matched.length > 0) rows = matched;
  }

  if (sortBy === 'bottleneck') {
    // Lowest passage/report rate first among committees with referrals (preferring substantive volume when tied)
    rows.sort(
      (a, b) =>
        a.passageRatePct - b.passageRatePct ||
        a.reportRatePct - b.reportRatePct ||
        b.referredCount - a.referredCount
    );
  } else if (sortBy === 'highest_passage') {
    rows.sort((a, b) => b.passageRatePct - a.passageRatePct || b.referredCount - a.referredCount);
  } else {
    rows.sort((a, b) => b.referredCount - a.referredCount || b.passedCount - a.passedCount);
  }

  const top = rows.slice(0, limit);
  for (const r of top) {
    if (r.chairPolId && r.chair && r.chair !== 'Unassigned') {
      registerPoliticianCitation(ctx, {
        id: r.chairPolId,
        name: r.chair,
        shortName: r.chair,
        chamber: r.chamber,
        party: r.chairParty,
        district: r.chairDistrict,
        leadershipRole: `Chair, ${r.chamber} ${r.name}`,
        reason: `${r.referredCount} referred · ${r.passageRatePct}% passage rate`,
      });
    }
  }

  const payload = {
    scope: sessionFilter || 'ALL SESSIONS',
    chamberFilter: chamberFilter || 'ALL',
    query: q || '(all substantive committees)',
    sortBy,
    proceduralExcluded: !includeProcedural,
    ...(excludedProceduralCommittees.length > 0 ? { excludedProceduralCommittees } : {}),
    totalBillsEvaluatedInScope: billRows.length,
    totalCommitteesWithReferrals: rows.length,
    committees: top.map((r) => ({
      committee: `${r.chamber} ${r.name}`,
      chamber: r.chamber,
      isProcedural: r.isProcedural,
      chair: r.chair,
      viceChair: r.viceChair,
      jurisdiction: r.jurisdiction,
      referredCount: r.referredCount,
      reportedCount: r.reportedCount,
      passedCount: r.passedCount,
      failedCount: r.failedCount,
      diedInCommitteeCount: r.diedInCommitteeCount,
      activeCount: r.activeCount,
      reportRatePct: r.reportRatePct,
      passageRatePct: r.passageRatePct,
    })),
  };

  return {
    payload,
    summary: `Computed real referral/passage stats for ${rows.length} ${includeProcedural ? '' : 'substantive '}committee${rows.length === 1 ? '' : 's'} from ${billRows.length} bills${sessionFilter ? ` in ${sessionFilter}` : ''}`,
    resultCount: top.length,
  };
}

function toolRankPolicyInfluence(
  args: { topic: string; chamber?: string; session?: string; limit?: number },
  ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const topic = safeStr(args.topic).trim();
  const chamberFilter = safeStr(args.chamber).trim();
  const sessionFilter = normalizeSessionCode(args.session || '');
  const limit = Math.min(15, Math.max(3, Number(args.limit) || 8));

  const expansion = findPolicyExpansion(topic);
  const topicTokens = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !['policy', 'bills', 'texas', 'over', 'influence'].includes(t));

  // 1. Find topic-related bills (strictly metadata columns, no full_text leakage)
  const { rows: topicBills, matchMode } = queryBillsMatchingText(topic, {
    session: sessionFilter || undefined,
    includeFullText: false,
  });
  const topicBillIds = new Set(topicBills.map((b) => b.id));

  for (const b of topicBills.slice(0, 8)) {
    registerBillCitation(ctx, b);
  }

  // 2. Find committees with jurisdiction over this topic or receiving topic bills
  const allCommittees = db
    .prepare(`SELECT id, name, chamber, session, chair_id, vice_chair_id, jurisdiction FROM committees`)
    .all() as Array<{
    id: string;
    name: string;
    chamber: Chamber;
    session: string;
    chair_id: string | null;
    vice_chair_id: string | null;
    jurisdiction: string;
  }>;

  const billCommitteeNames = new Set<string>();
  for (const b of topicBills) {
    for (const c of safeJsonArray<{ name: string }>(b.committees_json)) {
      if (c.name) billCommitteeNames.add(c.name.toLowerCase());
    }
  }

  const relevantCommittees = allCommittees.filter((c) => {
    const hay = `${c.name} ${c.jurisdiction}`.toLowerCase();
    if (billCommitteeNames.has(c.name.toLowerCase())) return true;
    if (topicTokens.some((tok) => hay.includes(tok))) return true;
    if (expansion && expansion.committeeTerms.some((term) => hay.includes(term))) return true;
    return false;
  });
  const relevantCommitteeIds = new Set(relevantCommittees.map((c) => c.id));

  // 3. Load politicians (optionally filtered by chamber)
  const polRows = db
    .prepare(
      `SELECT id, name, short_name, chamber, district, party, tenure_years,
              leadership_role, bio, total_raised, bills_authored, bills_passed
       FROM politicians
       ${chamberFilter ? 'WHERE LOWER(chamber) = LOWER(?)' : ''}`
    )
    .all(...(chamberFilter ? [chamberFilter] : [])) as Array<{
    id: string;
    name: string;
    short_name: string;
    chamber: Chamber;
    district: string;
    party: string;
    tenure_years: number;
    leadership_role: string;
    bio: string;
    total_raised: number;
    bills_authored: number;
    bills_passed: number;
  }>;

  const memberships = db
    .prepare(
      `SELECT cm.politician_id, cm.role, cm.committee_id, c.name AS committee_name, c.chamber, c.jurisdiction
       FROM committee_memberships cm
       JOIN committees c ON c.id = cm.committee_id`
    )
    .all() as Array<{
    politician_id: string;
    role: string;
    committee_id: string;
    committee_name: string;
    chamber: Chamber;
    jurisdiction: string;
  }>;
  const membershipsByPol = new Map<string, typeof memberships>();
  for (const m of memberships) {
    const arr = membershipsByPol.get(m.politician_id) || [];
    arr.push(m);
    membershipsByPol.set(m.politician_id, arr);
  }

  // Votes on topic bills
  const voteCountsByPol = new Map<string, number>();
  if (topicBillIds.size > 0) {
    const placeholders = Array.from(topicBillIds).map(() => '?').join(',');
    const voteRows = db
      .prepare(`SELECT politician_id, COUNT(*) AS c FROM votes WHERE bill_id IN (${placeholders}) GROUP BY politician_id`)
      .all(...Array.from(topicBillIds)) as Array<{ politician_id: string; c: number }>;
    for (const vr of voteRows) {
      voteCountsByPol.set(vr.politician_id, vr.c);
    }
  }

  // Sector-aligned PAC contributions
  const sectorDonorTotals = new Map<string, number>();
  const sectorTerms = expansion?.donorSectors || topicTokens;
  if (sectorTerms.length > 0) {
    const contribRows = db
      .prepare(
        `SELECT c.politician_id, d.sector, SUM(c.amount) AS total
         FROM contributions c
         JOIN donors d ON d.id = c.donor_id
         GROUP BY c.politician_id, d.sector`
      )
      .all() as Array<{ politician_id: string; sector: string; total: number }>;
    for (const cr of contribRows) {
      const secLower = cr.sector.toLowerCase();
      if (sectorTerms.some((t) => secLower.includes(t))) {
        sectorDonorTotals.set(
          cr.politician_id,
          (sectorDonorTotals.get(cr.politician_id) ?? 0) + Number(cr.total || 0)
        );
      }
    }
  }

  const scored = polRows
    .map((p) => {
      const shortLower = p.short_name.toLowerCase();
      const lastToken = shortLower.split(',')[0].trim();
      const nameLower = p.name.toLowerCase();
      const bioLeadLower = `${p.leadership_role} ${p.bio}`.toLowerCase();

      let score = 0;
      const reasons: string[] = [];

      // A. Committee Gatekeeping
      const polComms = membershipsByPol.get(p.id) || [];
      const matchingComms = polComms.filter((m) => relevantCommitteeIds.has(m.committee_id));
      for (const mc of matchingComms) {
        const isPrimaryPolicy =
          !['appropriations', 'finance'].includes(mc.committee_name.toLowerCase()) ||
          topic.toLowerCase().includes('budget') ||
          topic.toLowerCase().includes('appropriations') ||
          Boolean(expansion?.fiscalRelevant);

        const roleLower = mc.role.toLowerCase();
        if (roleLower === 'chair') {
          score += isPrimaryPolicy ? 36 : 24;
          reasons.push(`Chair, ${mc.chamber} ${mc.committee_name}`);
        } else if (roleLower.includes('vice')) {
          score += isPrimaryPolicy ? 22 : 14;
          reasons.push(`Vice-Chair, ${mc.chamber} ${mc.committee_name}`);
        } else {
          score += isPrimaryPolicy ? 11 : 7;
          reasons.push(`Member, ${mc.chamber} ${mc.committee_name}`);
        }
      }

      if (matchingComms.length === 0 && p.leadership_role) {
        const matchedKeyword =
          topicTokens.some((t) => bioLeadLower.includes(t)) ||
          (expansion && expansion.committeeTerms.some((t) => bioLeadLower.includes(t)));
        if (matchedKeyword) {
          score += bioLeadLower.includes('chair') ? 26 : 14;
          reasons.push(p.leadership_role);
        }
      }

      // B. Authorship & Sponsorship on topic bills
      let authoredCount = 0;
      let passedCount = 0;
      let cosponsoredCount = 0;
      for (const b of topicBills) {
        const pa = b.primary_author.toLowerCase();
        const co = safeJsonArray<string>(b.coauthors_json).map((x) => x.toLowerCase());
        const sp = safeJsonArray<string>(b.sponsors_json).map((x) => x.toLowerCase());
        const committees = safeJsonArray(b.committees_json);
        const { outcome } = classifyOutcome(b.session, b.stage, b.status, b.last_action, committees.length);

        const matchesName = (s: string) =>
          s === shortLower ||
          s === nameLower ||
          (lastToken.length >= 4 && s.includes(lastToken));

        if (matchesName(pa)) {
          authoredCount += 1;
          score += 18 + Math.min(10, b.influence_score * 0.1);
          if (outcome === 'Passed') {
            passedCount += 1;
            score += 10;
          }
        } else if (co.some(matchesName) || sp.some(matchesName)) {
          cosponsoredCount += 1;
          score += 7;
        }
      }
      if (authoredCount > 0) {
        reasons.push(
          `Authored ${authoredCount} topic bill${authoredCount === 1 ? '' : 's'}${passedCount > 0 ? ` (${passedCount} passed)` : ''}`
        );
      } else if (cosponsoredCount > 0) {
        reasons.push(`Co-authored/sponsored ${cosponsoredCount} topic bill${cosponsoredCount === 1 ? '' : 's'}`);
      }

      // C. Chamber Leadership / Budget Gatekeeping
      if (bioLeadLower.includes('speaker') || bioLeadLower.includes('lieutenant governor')) {
        score += 18;
        reasons.push(p.leadership_role || 'Chamber Leadership');
      } else if (
        expansion?.fiscalRelevant &&
        (bioLeadLower.includes('appropriations') || bioLeadLower.includes('finance')) &&
        !reasons.some((r) => r.toLowerCase().includes('appropriations') || r.toLowerCase().includes('finance'))
      ) {
        score += 14;
        reasons.push(p.leadership_role || 'Budget / Appropriations Authority');
      }

      // D. Roll-Call Votes on topic bills
      const topicVotes = voteCountsByPol.get(p.id) ?? 0;
      if (topicVotes > 0) {
        score += Math.min(10, topicVotes * 3);
      }

      // E. Related PAC Sector Funding
      const sectorFunding = sectorDonorTotals.get(p.id) ?? 0;
      if (sectorFunding > 0) {
        score += Math.min(12, Math.log10(Math.max(10, sectorFunding)) * 2.2);
        reasons.push(`$${sectorFunding.toLocaleString()} in related-sector PAC filings`);
      }

      if (score > 0) {
        score += Math.min(5, p.tenure_years * 0.25) + Math.min(4, p.bills_passed * 0.15);
      }

      return {
        politician: p,
        score: Math.round(score * 10) / 10,
        relevantCommittees: matchingComms.map((m) => `${m.chamber} ${m.committee_name} (${m.role})`),
        authoredTopicBills: authoredCount,
        passedTopicBills: passedCount,
        cosponsoredTopicBills: cosponsoredCount,
        topicVotes,
        relatedSectorFunding: sectorFunding,
        rationale: reasons.slice(0, 3).join(' · ') || p.leadership_role || 'Indexed legislator',
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.politician.bills_passed - a.politician.bills_passed)
    .slice(0, limit);

  for (const item of scored) {
    registerPoliticianCitation(ctx, {
      id: item.politician.id,
      name: item.politician.name,
      shortName: item.politician.short_name,
      chamber: item.politician.chamber,
      party: item.politician.party,
      district: item.politician.district,
      leadershipRole: item.politician.leadership_role,
      score: item.score,
      reason: item.rationale,
    });
  }

  const payload = {
    topic,
    chamberFilter: chamberFilter || 'Both Chambers',
    sessionFilter: sessionFilter || 'ALL SESSIONS',
    matchingTopicBillsCount: topicBills.length,
    billMatchMode: matchMode,
    relevantCommittees: relevantCommittees.map((c) => ({
      name: `${c.chamber} ${c.name}`,
      session: c.session,
      jurisdiction: c.jurisdiction,
    })),
    rankedLegislators: scored.map((s, idx) => ({
      rank: idx + 1,
      id: s.politician.id,
      name: s.politician.name,
      party: s.politician.party,
      chamber: s.politician.chamber,
      district: s.politician.district,
      leadershipRole: s.politician.leadership_role,
      policyInfluenceScore: s.score,
      relevantCommittees: s.relevantCommittees,
      authoredTopicBills: s.authoredTopicBills,
      passedTopicBills: s.passedTopicBills,
      relatedSectorFunding: s.relatedSectorFunding,
      rationale: s.rationale,
    })),
  };

  return {
    payload,
    summary: `Ranked ${scored.length} ${chamberFilter || 'Texas'} legislator${scored.length === 1 ? '' : 's'} (${topicBills.length} topic bills, ${relevantCommittees.length} relevant committees)`,
    resultCount: scored.length,
  };
}

function toolGetPoliticianProfile(
  args: { query: string },
  ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const q = safeStr(args.query).trim();
  if (!q) {
    return { payload: { error: 'query is required' }, summary: 'No legislator query provided', resultCount: 0 };
  }
  const pat = `%${q}%`;
  const pol = db
    .prepare(
      `SELECT id, name, short_name, chamber, district, party, tenure_years,
              leadership_role, bio, total_raised, bills_authored, bills_passed
       FROM politicians
       WHERE LOWER(name) LIKE LOWER(?) OR LOWER(short_name) LIKE LOWER(?) OR LOWER(district) LIKE LOWER(?)
       ORDER BY total_raised DESC, bills_authored DESC
       LIMIT 1`
    )
    .get(pat, pat, pat) as
    | {
        id: string;
        name: string;
        short_name: string;
        chamber: Chamber;
        district: string;
        party: string;
        tenure_years: number;
        leadership_role: string;
        bio: string;
        total_raised: number;
        bills_authored: number;
        bills_passed: number;
      }
    | undefined;

  if (!pol) {
    return {
      payload: { found: false, query: q },
      summary: `No legislator matched "${q}"`,
      resultCount: 0,
    };
  }

  registerPoliticianCitation(ctx, {
    id: pol.id,
    name: pol.name,
    shortName: pol.short_name,
    chamber: pol.chamber,
    party: pol.party,
    district: pol.district,
    leadershipRole: pol.leadership_role,
    reason: pol.leadership_role || `${pol.chamber} ${pol.district}`,
  });

  const committees = db
    .prepare(
      `SELECT c.name, c.chamber, cm.role, cm.session, c.jurisdiction
       FROM committee_memberships cm
       JOIN committees c ON c.id = cm.committee_id
       WHERE cm.politician_id = ?`
    )
    .all(pol.id);

  const shortPat = `%${pol.short_name.split(',')[0].trim()}%`;
  const bills = db
    .prepare(
      `SELECT * FROM bills
       WHERE LOWER(primary_author) LIKE LOWER(?) OR LOWER(sponsors_json) LIKE LOWER(?)
       ORDER BY influence_score DESC
       LIMIT 12`
    )
    .all(shortPat, shortPat) as BillDbRow[];

  const mappedBills = bills.map((b) => {
    const cited = registerBillCitation(ctx, b);
    return {
      id: cited.id,
      session: cited.session,
      billNumber: cited.billNumber,
      title: cited.title,
      outcome: cited.outcome,
      outcomeDetail: cited.outcomeDetail,
      influenceScore: cited.influenceScore,
      bipartisanIndex: Number((b.bipartisan_index || 0).toFixed(2)),
    };
  });

  const topSectors = db
    .prepare(
      `SELECT d.sector, SUM(c.amount) AS total, COUNT(*) AS filings
       FROM contributions c
       JOIN donors d ON d.id = c.donor_id
       WHERE c.politician_id = ?
       GROUP BY d.sector
       ORDER BY total DESC
       LIMIT 6`
    )
    .all(pol.id);

  return {
    payload: {
      found: true,
      politician: {
        id: pol.id,
        name: pol.name,
        party: pol.party,
        chamber: pol.chamber,
        district: pol.district,
        tenureYears: pol.tenure_years,
        leadershipRole: pol.leadership_role,
        bio: pol.bio,
        totalRaised: pol.total_raised,
        billsAuthored: pol.bills_authored,
        billsPassed: pol.bills_passed,
      },
      committees,
      topBills: mappedBills,
      topDonorSectors: topSectors,
    },
    summary: `Loaded ${pol.name} (${pol.party}-${pol.chamber}, ${mappedBills.length} linked bills)`,
    resultCount: 1,
  };
}

function toolGetBillDetails(
  args: { billRef: string; session?: string },
  ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const ref = safeStr(args.billRef).trim();
  const session = normalizeSessionCode(args.session || '');
  if (!ref) {
    return { payload: { found: false }, summary: 'No bill reference provided', resultCount: 0 };
  }

  const normalized = ref.replace(/\s+/g, '').toUpperCase();
  let row = db
    .prepare(`SELECT * FROM bills WHERE UPPER(id) = ? LIMIT 1`)
    .get(normalized) as BillDbRow | undefined;

  if (!row) {
    const m = ref.match(/\b(HB|SB|HJR|SJR|HCR|SCR)\s*(\d+)\b/i);
    if (m) {
      const billNum = `${m[1].toUpperCase()} ${m[2]}`;
      row = (
        session
          ? db
              .prepare(`SELECT * FROM bills WHERE UPPER(bill_number) = ? AND UPPER(session) = ? LIMIT 1`)
              .get(billNum, session)
          : db
              .prepare(`SELECT * FROM bills WHERE UPPER(bill_number) = ? ORDER BY session DESC LIMIT 1`)
              .get(billNum)
      ) as BillDbRow | undefined;
    }
  }

  if (!row) {
    return { payload: { found: false, billRef: ref }, summary: `Bill "${ref}" not found`, resultCount: 0 };
  }

  const cited = registerBillCitation(ctx, row);
  const amendments = db
    .prepare(`SELECT version_label, amendment_number, sponsor, disposition, summary FROM amendments WHERE bill_id = ? ORDER BY sort_order ASC`)
    .all(row.id);
  const witnessSummary = db
    .prepare(`SELECT position, COUNT(*) AS count FROM witness_registrations WHERE bill_id = ? GROUP BY position`)
    .all(row.id);

  return {
    payload: {
      found: true,
      bill: {
        ...cited,
        bipartisanIndex: Number((row.bipartisan_index || 0).toFixed(2)),
        status: row.status,
        lastAction: row.last_action,
        lastActionDate: row.last_action_date,
        filedDate: row.filed_date,
        summary: row.summary,
        committees: safeJsonArray(row.committees_json),
        subjects: safeJsonArray(row.subjects_json),
        statuteCodes: safeJsonArray(row.statute_codes),
        coauthors: safeJsonArray(row.coauthors_json),
        sponsors: safeJsonArray(row.sponsors_json),
      },
      amendments,
      witnessSummary,
    },
    summary: `Loaded ${row.session} ${row.bill_number} (${cited.outcomeDetail})`,
    resultCount: 1,
  };
}

function toolSearchStatutes(
  args: { query: string; code?: string; limit?: number },
  _ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const q = safeStr(args.query).trim();
  const code = safeStr(args.code).trim().toUpperCase();
  const limit = Math.min(12, Math.max(1, Number(args.limit) || 6));
  const fts = buildFtsFromNaturalText(q, false);

  let rows: Array<{
    id: string;
    code: string;
    code_name: string;
    chapter: string;
    section_number: string;
    section_title: string;
    last_amended_session: string;
  }> = [];

  if (fts) {
    try {
      rows = db
        .prepare(
          `SELECT s.id, s.code, s.code_name, s.chapter, s.section_number, s.section_title, s.last_amended_session
           FROM statutes_fts
           JOIN statute_sections s ON s.rowid = statutes_fts.rowid
           WHERE statutes_fts MATCH ? ${code ? 'AND UPPER(s.code) = ?' : ''}
           LIMIT ?`
        )
        .all(...(code ? [fts, code, limit] : [fts, limit])) as typeof rows;
    } catch {
      rows = [];
    }
  }

  return {
    payload: { query: q, code: code || 'ALL', totalFound: rows.length, sections: rows },
    summary: `${rows.length} Texas statute section${rows.length === 1 ? '' : 's'} matched`,
    resultCount: rows.length,
  };
}

const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_archive_overview',
      description:
        'Get exact counts of indexed Texas bills broken down by session (including Passed, Failed, Died in Committee, Vetoed, and Active totals), plus legislator, committee, and statute totals.',
      parameters: {
        type: 'object',
        properties: {
          session: {
            type: 'string',
            description:
              'ONLY set this if the user explicitly specified a session code (e.g. 90R, 89R, 88R) or an Active Session Filter header is present. OMIT to cover all sessions.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_and_count_bills',
      description:
        'Search, filter, sort, and count bills in the local Texas Capitol SQLite/FTS5 archive (searching title, summary, subjects, and statute_codes — NOT full_text). Supports filtering by topic, session, chamber, outcome, disposition (e.g. "died in committee"), stage, author, minInfluenceScore, minBipartisanIndex, and sorting by influence, bipartisan, or influence_and_bipartisan. Returns exact counts in-scope plus bipartisanIndex and influenceScore on every bill.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Topic keywords (e.g., "autonomous driving", "medicaid", "school finance"). Leave empty when filtering strictly by metrics/outcomes like bipartisan index, influence score, or died in committee.',
          },
          session: {
            type: 'string',
            description:
              'ONLY set if the user explicitly named a session (e.g. 90R, 89R, 88R). NEVER guess or default to 89R; omit to search all sessions.',
          },
          chamber: { type: 'string', enum: ['House', 'Senate'] },
          outcome: { type: 'string', enum: ['Passed', 'Failed', 'Vetoed', 'Active'] },
          disposition: {
            type: 'string',
            description:
              'Optional failure/passage disposition substring (e.g., "died in committee", "conference impasse", "died on calendar", "died in opposite chamber", "line-item veto").',
          },
          stage: {
            type: 'string',
            description: 'Optional legislative stage (Pre-Filed, Filed, Committee Hearing, Committee Reported, Engrossed, Enrolled, Signed, Vetoed, Stalled).',
          },
          author: { type: 'string', description: 'Optional author surname or name.' },
          minInfluenceScore: {
            type: 'number',
            description: 'Optional minimum influence score (0-100) when the user asks for high-influence bills.',
          },
          minBipartisanIndex: {
            type: 'number',
            description:
              'Optional minimum bipartisan index (0.0-1.0). In Texas legislative data, 0.35-0.60 is already strongly bipartisan. When the user asks for "high bipartisan" without giving a number, do NOT set this above 0.40 (prefer 0.35 with sortBy="influence_and_bipartisan" or "bipartisan").',
          },
          sortBy: {
            type: 'string',
            enum: ['influence', 'bipartisan', 'influence_and_bipartisan', 'amendments', 'recent'],
            description: 'Sort order. Use "influence_and_bipartisan" when the user asks for BOTH high influence and high bipartisan index.',
          },
          limit: { type: 'number', description: 'Max bills to return in sample (default 12, max 25).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_committee_stats',
      description:
        'Compute real committee bottleneck, referral, reporting, and passage rate statistics directly from the bills table (committees_json) and committee chairs. Excludes procedural scheduling committees (House Calendars, Local & Consent Calendars, Administration) by default unless includeProcedural=true.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional committee name or policy area filter.' },
          chamber: { type: 'string', enum: ['House', 'Senate'] },
          session: {
            type: 'string',
            description: 'ONLY set if the user explicitly named a session. Omit to compute across all sessions.',
          },
          sortBy: {
            type: 'string',
            enum: ['bottleneck', 'most_referred', 'highest_passage'],
            description: 'Use "bottleneck" for lowest passage/report rates, "most_referred" for highest volume, "highest_passage" for highest passage rates.',
          },
          includeProcedural: {
            type: 'boolean',
            description:
              'Default false (substantive policy committees only). Set true ONLY when the user explicitly asks about Calendars, Administration, or procedural committees.',
          },
          limit: { type: 'number', description: 'Max committees to return (default 12).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rank_policy_influence',
      description:
        'Rank Texas legislators by influence over a specific policy area combining committee chair/gatekeeping power, authored & passed bills, leadership roles, roll-call votes, and related-sector PAC filings.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Policy area to evaluate (e.g., "medicaid", "public education", "ERCOT energy").' },
          chamber: {
            type: 'string',
            enum: ['House', 'Senate'],
            description: 'Use "House" when asked about representatives, "Senate" when asked about senators, or omit for both.',
          },
          session: {
            type: 'string',
            description: 'ONLY set if the user explicitly named a session. Omit to evaluate across all sessions.',
          },
          limit: { type: 'number', description: 'Max ranked legislators to return (default 8).' },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_politician_profile',
      description: 'Look up a specific Texas legislator profile, committees, authored bills with outcomes, and top PAC donor sectors.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Legislator name, last name, or district.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bill_details',
      description: 'Fetch detailed dossier information for a specific Texas bill (e.g., "HB 2", "SB 1", "89R-HB4").',
      parameters: {
        type: 'object',
        properties: {
          billRef: { type: 'string', description: 'Bill number or ID like "HB 2" or "89R-HB4".' },
          session: { type: 'string', description: 'Optional session code ONLY if explicitly requested.' },
        },
        required: ['billRef'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_statutes',
      description: 'Search indexed Texas Statutes sections by keyword or code.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Statute keyword query.' },
          code: { type: 'string', description: 'Optional Texas code abbreviation (e.g., ED, TX, PE, TN, HS).' },
        },
        required: ['query'],
      },
    },
  },
];

function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentExecutionContext
): Record<string, unknown> {
  const start = Date.now();
  let res: { payload: Record<string, unknown>; summary: string; resultCount: number };

  switch (name) {
    case 'get_archive_overview':
      res = toolGetArchiveOverview(args as { session?: string }, ctx);
      break;
    case 'search_and_count_bills':
      res = toolSearchAndCountBills(args as Parameters<typeof toolSearchAndCountBills>[0], ctx);
      break;
    case 'get_committee_stats':
    case 'search_committees':
      res = toolGetCommitteeStats(args as Parameters<typeof toolGetCommitteeStats>[0], ctx);
      break;
    case 'rank_policy_influence':
      res = toolRankPolicyInfluence(args as Parameters<typeof toolRankPolicyInfluence>[0], ctx);
      break;
    case 'get_politician_profile':
      res = toolGetPoliticianProfile(args as { query: string }, ctx);
      break;
    case 'get_bill_details':
      res = toolGetBillDetails(args as { billRef: string; session?: string }, ctx);
      break;
    case 'search_statutes':
      res = toolSearchStatutes(args as { query: string; code?: string; limit?: number }, ctx);
      break;
    default:
      res = {
        payload: { error: `Unknown tool: ${name}` },
        summary: `Unknown tool ${name}`,
        resultCount: 0,
      };
  }

  ctx.traces.push({
    id: `tc-${ctx.traces.length + 1}`,
    name,
    args,
    summary: res.summary,
    durationMs: Date.now() - start,
    resultCount: res.resultCount,
  });

  return res.payload;
}

// ============================================================================
// DETERMINISTIC QUERY PLANNER & GUARDRAILS
// ============================================================================

function detectSessionFromQuestion(question: string, sessionScope: string): string | undefined {
  // Match explicit session codes like 89R, 90R, 891, 89-1, 88-2
  const codeMatch = question.match(/\b(\d{2}(?:[Rr]|[-_]?[1-4]))\b/);
  if (codeMatch) return normalizeSessionCode(codeMatch[1]);
  // Match ordinal legislature mentions like "89th legislature", "90th session"
  const ordMatch = question.match(/\b(\d{2})(?:st|nd|rd|th)\s+(?:texas\s+)?(?:legislature|session)\b/i);
  if (ordMatch) return `${ordMatch[1]}R`;
  if (sessionScope) return normalizeSessionCode(sessionScope);
  return undefined;
}

function detectChamberFromQuestion(question: string): 'House' | 'Senate' | undefined {
  const lower = question.toLowerCase();
  const wantsHouse = /\b(representative|representatives|rep\.|house)\b/.test(lower);
  const wantsSenate = /\b(senator|senators|sen\.|senate)\b/.test(lower);
  if (wantsHouse && !wantsSenate) return 'House';
  if (wantsSenate && !wantsHouse) return 'Senate';
  return undefined;
}

function detectDispositionFromQuestion(question: string): string | undefined {
  const lower = question.toLowerCase();
  if (/\bdied in committee\b|\bstuck in committee\b|\bleft pending in committee\b/.test(lower)) {
    return 'died in committee';
  }
  if (/\bconference\b.*\bimpasse\b|\bconference committee\b.*\bfailed\b/.test(lower)) {
    return 'conference impasse';
  }
  if (/\bdied on (?:the )?(?:calendar|floor)\b/.test(lower)) {
    return 'died on calendar';
  }
  if (/\bdied in (?:the )?opposite chamber\b/.test(lower)) {
    return 'died in opposite chamber';
  }
  if (/\bdied in filing\b/.test(lower)) {
    return 'died in filing';
  }
  return undefined;
}

function extractTopicFromQuestion(question: string): string {
  const q = question.trim();
  // Pure metric / disposition / committee-stats questions should NOT turn metric words into a keyword query
  const lower = q.toLowerCase();
  if (
    /\bbipartisan\b/.test(lower) &&
    !/\b(about|regarding|on|for)\s+(?!bipartisan|influence|high)/i.test(lower)
  ) {
    return '';
  }

  const patterns = [
    /\bhow many\s+([a-z0-9\s-]+?)\s+bills?\b/i,
    /\binfluence\s+(?:over|on)\s+([^?.!]+)/i,
    /\bbills?\s+(?:introduced|filed|passed|failed)\s+(?:about|on|for|regarding|involving)\s+([^?.!]+)/i,
    /\b(?:about|regarding|over|related to|involving)\s+([^?.!]+)/i,
    /\bwhat\s+([a-z0-9\s-]+?)\s+bills?\b/i,
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (m && m[1]) {
      const candidate = m[1]
        .replace(
          /\b(have\s+been\s+(?:introduced|filed|passed|enacted)|were\s+(?:introduced|filed|passed|enacted)|in\s+\d{2}(?:[r1-4]|-\d)|across\s+[\w\s,-]+|in\s+texas|policy|legislation|bills?|session|sessions|previous sessions?|introduced|filed|passed|failed|died|committee|committees|bottleneck|bottlenecks|passage\s+rates?|vs\.?|high|both|influence|score|scores|bipartisan|index)\b/gi,
          ' '
        )
        .replace(/\s+/g, ' ')
        .trim();
      if (candidate.length >= 2) return candidate;
    }
  }
  const stripped = q
    .replace(
      /\b(how|many|which|who|what|are|is|have|has|been|were|was|the|greatest|most|lowest|highest|biggest|top|both|high|low|bills?|introduced|filed|passed|failed|died|stalled|vetoed|vs|representatives?|senators?|legislators?|lawmakers?|committee|committees|bottleneck|bottlenecks|passage|rate|rates|influence|score|scores|bipartisan|index|over|on|about|policy|texas|session|sessions|across|in|and|with|by|\d{2}(?:[r1-4]|-\d)|\d{2}(?:st|nd|rd|th))\b/gi,
      ' '
    )
    .replace(/[?!.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 2 ? stripped : '';
}

function runDeterministicPlan(
  question: string,
  sessionScope: string,
  ctx: AgentExecutionContext
): { evidence: Record<string, unknown>; fallbackMarkdown: string } {
  const lower = question.toLowerCase();
  const chamber = detectChamberFromQuestion(question);
  const session = detectSessionFromQuestion(question, sessionScope);
  const disposition = detectDispositionFromQuestion(question);
  const topic = extractTopicFromQuestion(question);

  const evidence: Record<string, unknown> = {};
  const overview = executeTool('get_archive_overview', session ? { session } : {}, ctx);
  evidence.archiveOverview = overview;

  const isBipartisanQuery = /\bbipartisan\b/i.test(lower);
  const isHighInfluenceBillQuery =
    /\bbills?\b/i.test(lower) && /\binfluence\b/i.test(lower) && !/\b(representative|senator|legislator|who)\b/i.test(lower);
  const isInfluencePersonQuery =
    !isHighInfluenceBillQuery &&
    /\b(influence|influential|control|powerful|which\s+(representative|representatives|senator|senators|legislator|legislators|member|members)|who\s+controls?|who\s+leads?)\b/i.test(
      lower
    );
  const isCommitteeStatsQuery =
    !disposition &&
    /\b(committee|committees|calendars?)\b/i.test(lower) &&
    /\b(bottleneck|bottlenecks|passage\s+rate|pass\s+rate|report\s+rate|referral|referred|lowest|highest|most|chair|chairs|stats|statistics)\b/i.test(
      lower
    );
  const isStatuteQuery = /\bstatute|statutes|code section|penal code|education code|tax code\b/i.test(lower);
  const specificBillMatch = question.match(/\b(HB|SB|HJR|SJR|HCR|SCR)\s*(\d+)\b/i);

  const lines: string[] = [];

  if (specificBillMatch) {
    const billRes = executeTool(
      'get_bill_details',
      { billRef: `${specificBillMatch[1].toUpperCase()} ${specificBillMatch[2]}`, ...(session ? { session } : {}) },
      ctx
    );
    evidence.billDetails = billRes;
    if (billRes.found && billRes.bill) {
      const b = billRes.bill as Record<string, unknown>;
      lines.push(`### ${b.session} ${b.billNumber} — ${b.title}`);
      lines.push(
        `- **Outcome / Stage:** ${b.outcomeDetail} · **Primary Author:** ${b.primaryAuthor} · **Influence:** ${b.influenceScore} · **Bipartisan Index:** ${b.bipartisanIndex}`
      );
      if (b.summary) lines.push(`- **Summary:** ${b.summary}`);
      if (b.lastAction) lines.push(`- **Last Action (${b.lastActionDate}):** ${b.lastAction}`);
    }
  }

  if (isCommitteeStatsQuery) {
    const sortBy = /\b(highest|best|top)\b/i.test(lower)
      ? 'highest_passage'
      : /\b(most\s+referred|busiest|volume)\b/i.test(lower)
        ? 'most_referred'
        : 'bottleneck';

    const includeProcedural = /\b(calendar|calendars|procedural|administration|rules\s*(?:&|and)\s*resolutions)\b/i.test(
      lower
    );

    const commRes = executeTool(
      'get_committee_stats',
      {
        ...(topic ? { query: topic } : {}),
        ...(chamber ? { chamber } : {}),
        ...(session ? { session } : {}),
        sortBy,
        includeProcedural,
        limit: 12,
      },
      ctx
    );
    evidence.committeeStats = commRes;

    const comms = (commRes.committees as Array<Record<string, unknown>>) || [];
    lines.push(
      `### Committee Referral & Passage Statistics (${session || 'All Sessions'})`
    );
    lines.push(
      `Computed directly from **${commRes.totalBillsEvaluatedInScope}** indexed bills${session ? ` in ${session}` : ' across all sessions'}.`
    );
    for (const c of comms.slice(0, 10)) {
      const activeSuffix =
        Number(c.activeCount || 0) > 0 ? ` · ${c.activeCount} active` : '';
      const passRateLabel =
        c.passageRatePct !== null && c.passageRatePct !== undefined
          ? `${c.passageRatePct}%${Number(c.activeCount || 0) > 0 ? ' of concluded' : ''}`
          : 'N/A';
      lines.push(
        `- **${c.committee}** (Chair: ${c.chair}) — **${c.referredCount}** referred · **${c.reportedCount}** reported (${c.reportRatePct}%) · **${c.passedCount}** passed (${passRateLabel}) · ${c.diedInCommitteeCount} died in committee${activeSuffix}`
      );
    }
  }

  if (isInfluencePersonQuery) {
    const rankRes = executeTool(
      'rank_policy_influence',
      {
        topic: topic || question,
        ...(chamber ? { chamber } : {}),
        ...(session ? { session } : {}),
        limit: 8,
      },
      ctx
    );
    evidence.policyInfluence = rankRes;

    const ranked = (rankRes.rankedLegislators as Array<Record<string, unknown>>) || [];
    const relComms = (rankRes.relevantCommittees as Array<Record<string, unknown>>) || [];
    const topicBillCount = Number(rankRes.matchingTopicBillsCount || 0);

    lines.push(
      `### Highest-Influence ${chamber === 'House' ? 'Texas House Representatives' : chamber === 'Senate' ? 'Texas Senators' : 'Texas Legislators'} on "${topic || question}" (${session || 'All Sessions'})`
    );
    lines.push(
      `Evaluated **${topicBillCount}** matching bill${topicBillCount === 1 ? '' : 's'} and **${relComms.length}** relevant committee${relComms.length === 1 ? '' : 's'} (${(overview.totalBillsInScope as number) ?? 0} bills in scope, ${(overview.politiciansIndexed as number) ?? 0} legislators).`
    );

    if (ranked.length > 0) {
      for (const r of ranked.slice(0, 6)) {
        lines.push(
          `- **#${r.rank} ${r.name}** (${r.party}-${r.chamber}${r.district ? `, ${r.district}` : ''}) — Policy Influence Score **${r.policyInfluenceScore}** · ${r.rationale}`
        );
      }
    } else {
      lines.push(
        `- No ${chamber || 'Texas'} legislators in the currently synced archive had direct committee seats, authored bills, or sector PAC filings tied to "${topic}".`
      );
    }

    if (relComms.length > 0) {
      lines.push(`\n**Key Gatekeeping Committees:** ${relComms.map((c) => c.name).join(', ')}.`);
    }
  }

  if (
    (!isInfluencePersonQuery && !isCommitteeStatsQuery) ||
    isBipartisanQuery ||
    isHighInfluenceBillQuery ||
    Boolean(disposition) ||
    /\bhow many|count\b/i.test(lower)
  ) {
    const outcomeParam = disposition
      ? 'Failed'
      : /\bpassed|enacted|signed\b/i.test(lower) && !/\bfailed|vs\.?\s*failed\b/i.test(lower)
        ? 'Passed'
        : /\bfailed|died|stalled\b/i.test(lower) && !/\bpassed\b/i.test(lower)
          ? 'Failed'
          : /\bvetoed\b/i.test(lower)
            ? 'Vetoed'
            : undefined;

    const sortBy: 'influence' | 'bipartisan' | 'influence_and_bipartisan' =
      isBipartisanQuery && /\binfluence\b/i.test(lower)
        ? 'influence_and_bipartisan'
        : isBipartisanQuery
          ? 'bipartisan'
          : 'influence';

    const billSearch = executeTool(
      'search_and_count_bills',
      {
        query: topic,
        ...(session ? { session } : {}),
        ...(chamber ? { chamber } : {}),
        ...(outcomeParam ? { outcome: outcomeParam } : {}),
        ...(disposition ? { disposition } : {}),
        ...(isBipartisanQuery ? { minBipartisanIndex: 0.35 } : {}),
        ...(isBipartisanQuery && /\binfluence\b/i.test(lower) ? { minInfluenceScore: 40 } : {}),
        sortBy,
        limit: 12,
      },
      ctx
    );
    evidence.billSearch = billSearch;

    if (!isInfluencePersonQuery && !isCommitteeStatsQuery) {
      const total = Number(billSearch.totalMatches || 0);
      const totalInScope = Number(billSearch.totalBillsInScope || 0);
      const bySession = (billSearch.bySession as Array<Record<string, unknown>>) || [];
      const byOutcome = (billSearch.byOutcome as Record<string, number>) || {};
      const bills = (billSearch.bills as Array<Record<string, unknown>>) || [];

      const headingSubject =
        disposition
          ? `Disposition: "${disposition}"`
          : isBipartisanQuery
            ? 'High Influence & High Bipartisan Index Bills'
            : topic
              ? `"${topic}"`
              : 'Matching Legislation';

      lines.push(`### ${headingSubject} (${session || 'All Sessions'})`);
      lines.push(
        `- **Matching Bills:** **${total}** out of **${totalInScope}** indexed bills ${session ? `in ${session}` : 'across all sessions'}.`
      );
      if (billSearch.sessionNote) {
        lines.push(`- *Note:* ${billSearch.sessionNote}`);
      }

      if (total > 0) {
        lines.push(
          `- **Outcomes Breakdown:** ${byOutcome.Passed ?? 0} Passed · ${byOutcome.Failed ?? 0} Failed · ${byOutcome.Vetoed ?? 0} Vetoed · ${byOutcome.Active ?? 0} Active (90th).`
        );
        if (bySession.length > 0) {
          lines.push(
            `- **By Session:** ${bySession.map((s) => `${s.session}: ${s.total} (${s.passed} passed, ${s.failed} failed)`).join(' · ')}`
          );
        }
        lines.push('\n**Matching Bills:**');
        for (const b of bills.slice(0, 10)) {
          lines.push(
            `- **${b.session} ${b.billNumber}** (${b.outcomeDetail} · Influence **${b.influenceScore}** · Bipartisan **${b.bipartisanIndex}**) — ${b.title} *(Author: ${b.primaryAuthor})*`
          );
        }
      } else {
        const syncedSessions = ((overview.sessions as Array<{ session: string; total: number }>) || [])
          .map((s) => `${s.session} (${s.total})`)
          .join(', ');
        lines.push(`- Indexed sessions in scope: ${syncedSessions || 'None'}.`);
      }
    }
  }

  if (isStatuteQuery) {
    evidence.statutes = executeTool('search_statutes', { query: topic || question }, ctx);
  }

  return {
    evidence,
    fallbackMarkdown: lines.join('\n'),
  };
}

function parseInlineToolCalls(content: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed.name) {
        results.push({ name: parsed.name, arguments: parsed.arguments || {} });
      }
    } catch {
      // ignore malformed inline call
    }
  }
  return results;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string | Record<string, unknown> };
  }>;
}

const SYSTEM_PROMPT = `You are the Texas Capitol Ledger Research Agent — an objective, data-driven Texas legislative analyst.
You have read-only tools connected directly to the user's live SQLite + FTS5 Texas Legislature archive.

STRICT ACCURACY & GROUNDING RULES:
1. ALWAYS call the appropriate tools before answering. NEVER invent counts, percentages, bill numbers, committee stats, or legislator names.
2. NEVER default to a specific session (like 89R) unless the user explicitly named a session OR an [Active Session Filter] header is present. When no session is specified, OMIT the session parameter so you search ALL indexed sessions, and report counts across all sessions (or broken down by session).
3. RESPECT EVERY CRITERION in the user's question. If the user asks for multiple criteria (e.g., BOTH high influence score AND high bipartisan index), pass minInfluenceScore / minBipartisanIndex / sortBy="influence_and_bipartisan" and verify in the returned JSON that EVERY bill you cite actually meets ALL requested criteria. Do NOT silently drop a criterion or substitute passed/enacted status for bipartisan index. For "high bipartisan" without an explicit number, use minBipartisanIndex around 0.35 (not 0.7+) since 0.40-0.60 is already strongly bipartisan in Texas.
4. For committee passage rates, bottlenecks, or referrals, ALWAYS call get_committee_stats — never estimate or fabricate committee rates from keyword trends. Leave includeProcedural=false unless the user specifically asks about Calendars or procedural committees.
5. For session-specific counts, ALWAYS cite totalBillsInScope for that session (NEVER confuse totalBillsAllSessions with a single session's count!).
6. Note that 90R is the upcoming/active 90th Legislature; bills in 90R are "Active" and have not died at sine die.
7. Present crisp, structured answers using concise markdown headings and bullet points with exact numbers, bill numbers, influence/bipartisan metrics when relevant, and legislator names.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are a Texas legislative research analyst. You are given verified JSON evidence from direct SQLite database queries.

STRICT RULES:
1. Answer ONLY using the provided JSON evidence. Do NOT fabricate numbers, passage rates, bill numbers, or legislator names.
2. Verify ALL criteria requested by the user (for example, if the user asked for bills with BOTH high influence score AND high bipartisan index, explicitly cite both influenceScore and bipartisanIndex for each bill and ONLY include bills that meet BOTH criteria — never substitute one criterion for another).
3. Respect the exact session scope in the JSON: if scope is "ALL SESSIONS", state findings across all sessions (broken down by session when available) and NEVER claim the results are only from 89R. If a specific session was queried, cite totalBillsInScope for that session (NOT totalBillsAllSessions).
4. Present concise, factual markdown with exact figures, bill numbers, and legislator names.`;

export async function runResearchAgent(input: {
  question: string;
  sessionScope?: string;
  priorTurns?: Array<{ question: string; answer: string }>;
}): Promise<ResearchQueryRecord> {
  const question = input.question.trim();
  const sessionScope = normalizeSessionCode(input.sessionScope || '');
  const explicitUserSession = detectSessionFromQuestion(question, sessionScope);
  const userSpecifiedBipartisanCutoff =
    /\b0?\.\d+\b/.test(question) || /\b\d{1,2}\s*%/.test(question);
  const userAskedProceduralCommittee =
    /\b(calendar|calendars|procedural|administration|rules\s*(?:&|and)\s*resolutions)\b/i.test(question);
  const cfg = getLocalLlmConfig();
  const ctx: AgentExecutionContext = {
    citedBillsMap: new Map(),
    citedPoliticiansMap: new Map(),
    traces: [],
  };

  // Code-level guardrails:
  // 1) Prevent 7B models from hallucinating session="89R" when neither the user nor UI filter requested a session
  // 2) Clamp overly strict unrequested bipartisan thresholds (e.g. LLM guessing 0.7) down to 0.35 so 0.4-0.6 bills qualify
  // 3) Exclude procedural committees (House Calendars) by default unless the user explicitly asked about them
  const sanitizeToolArgs = (name: string, rawArgs: Record<string, unknown>): Record<string, unknown> => {
    const args = { ...rawArgs };
    if (
      ['get_archive_overview', 'search_and_count_bills', 'get_committee_stats', 'rank_policy_influence'].includes(name)
    ) {
      if (!explicitUserSession && args.session) {
        delete args.session;
      } else if (explicitUserSession && !args.session) {
        args.session = explicitUserSession;
      }
    }
    if (name === 'search_and_count_bills') {
      if (
        !userSpecifiedBipartisanCutoff &&
        args.minBipartisanIndex !== undefined &&
        Number(args.minBipartisanIndex) > 0.45
      ) {
        args.minBipartisanIndex = 0.35;
      }
    }
    if (name === 'get_committee_stats') {
      if (userAskedProceduralCommittee && args.includeProcedural === undefined) {
        args.includeProcedural = true;
      } else if (!userAskedProceduralCommittee && args.includeProcedural === true) {
        args.includeProcedural = false;
      }
    }
    return args;
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const probe = await checkLocalLlmReachable(3000);

  let answer = '';
  let mode: ResearchQueryRecord['mode'] = 'llm_agent';
  let warning: string | undefined;

  if (probe.reachable) {
    try {
      const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
      for (const turn of (input.priorTurns || []).slice(-3)) {
        messages.push({ role: 'user', content: turn.question });
        messages.push({ role: 'assistant', content: turn.answer.slice(0, 1500) });
      }
      messages.push({
        role: 'user',
        content: sessionScope
          ? `[Active Session Filter: ${sessionScope}]\n${question}`
          : `[Scope: All Indexed Sessions — do NOT filter to a single session unless the user explicitly names one]\n${question}`,
      });

      let toolCallingUnsupported = false;

      for (let step = 0; step < 5; step++) {
        const llmRes = await fetch(cfg.endpoint, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(75000),
          body: JSON.stringify({
            model: cfg.model,
            temperature: 0.1,
            tools: OPENAI_TOOLS,
            tool_choice: 'auto',
            messages,
          }),
        });

        if (!llmRes.ok) {
          const errText = await llmRes.text().catch(() => '');
          if (llmRes.status === 400 || llmRes.status === 422) {
            toolCallingUnsupported = true;
            break;
          }
          throw new Error(`HTTP ${llmRes.status}${errText ? `: ${errText.slice(0, 180)}` : ''}`);
        }

        const data = (await llmRes.json()) as {
          choices?: Array<{
            message?: {
              role?: string;
              content?: string | null;
              tool_calls?: Array<{
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string | Record<string, unknown> };
              }>;
            };
          }>;
        };

        const msg = data.choices?.[0]?.message;
        if (!msg) throw new Error('Empty response from local LLM');

        const nativeCalls = msg.tool_calls ?? [];
        const inlineCalls =
          nativeCalls.length === 0 && msg.content ? parseInlineToolCalls(msg.content) : [];

        if (nativeCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: nativeCalls.map((tc, i) => ({
              id: tc.id || `call_${step}_${i}`,
              type: 'function',
              function: {
                name: tc.function?.name || '',
                arguments:
                  typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function?.arguments || {}),
              },
            })),
          });

          for (let i = 0; i < nativeCalls.length; i++) {
            const tc = nativeCalls[i];
            const fnName = tc.function?.name || '';
            let parsedArgs: Record<string, unknown> = {};
            if (typeof tc.function?.arguments === 'string') {
              try {
                parsedArgs = JSON.parse(tc.function.arguments);
              } catch {
                parsedArgs = {};
              }
            } else if (tc.function?.arguments && typeof tc.function.arguments === 'object') {
              parsedArgs = tc.function.arguments;
            }
            const safeArgs = sanitizeToolArgs(fnName, parsedArgs);
            const toolOutput = executeTool(fnName, safeArgs, ctx);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id || `call_${step}_${i}`,
              name: fnName,
              content: JSON.stringify(toolOutput),
            });
          }
          continue;
        }

        if (inlineCalls.length > 0) {
          messages.push({ role: 'assistant', content: msg.content || '' });
          const inlineOutputs: string[] = [];
          for (const ic of inlineCalls) {
            const safeArgs = sanitizeToolArgs(ic.name, ic.arguments);
            const toolOutput = executeTool(ic.name, safeArgs, ctx);
            inlineOutputs.push(`Tool ${ic.name} result:\n${JSON.stringify(toolOutput)}`);
          }
          messages.push({
            role: 'user',
            content: `Here are the verified tool results from SQLite. Write your final grounded answer verifying ALL user criteria:\n\n${inlineOutputs.join('\n\n')}`,
          });
          continue;
        }

        if (ctx.traces.length === 0 && step === 0) {
          toolCallingUnsupported = true;
          break;
        }

        answer = (msg.content || '').trim();
        mode = 'llm_agent';
        break;
      }

      if (toolCallingUnsupported || !answer) {
        const plan = runDeterministicPlan(question, sessionScope, ctx);
        const synthRes = await fetch(cfg.endpoint, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(75000),
          body: JSON.stringify({
            model: cfg.model,
            temperature: 0.1,
            messages: [
              { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
              {
                role: 'user',
                content: `Question: ${question}\nSession Scope: ${explicitUserSession || 'ALL SESSIONS'}\n\nDatabase Evidence (JSON):\n${JSON.stringify(plan.evidence, null, 2)}`,
              },
            ],
          }),
        });

        if (synthRes.ok) {
          const synthData = (await synthRes.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const synthText = synthData.choices?.[0]?.message?.content?.trim() || '';
          if (synthText) {
            answer = synthText;
            mode = 'llm_grounded';
          }
        }
        if (!answer) {
          answer = plan.fallbackMarkdown;
          mode = 'deterministic_fallback';
        }
      }
    } catch (err) {
      const plan = runDeterministicPlan(question, sessionScope, ctx);
      answer = plan.fallbackMarkdown;
      mode = 'deterministic_fallback';
      warning = `Local LLM (${cfg.model} at ${cfg.baseUrl}) encountered an error (${err instanceof Error ? err.message : 'unreachable'}); displaying direct SQLite/FTS5 evidence.`;
    }
  } else {
    const plan = runDeterministicPlan(question, sessionScope, ctx);
    answer = plan.fallbackMarkdown;
    mode = 'deterministic_fallback';
    warning = `Local LLM (${cfg.model} at ${cfg.baseUrl}) is currently unreachable from this host — displaying direct SQLite/FTS5 research evidence.`;
  }

  const record: ResearchQueryRecord = {
    id: `res-${crypto.randomUUID().slice(0, 10)}`,
    question,
    sessionScope,
    answer,
    model: cfg.model,
    mode,
    warning,
    toolCalls: ctx.traces,
    citedBills: Array.from(ctx.citedBillsMap.values()).slice(0, 14),
    citedPoliticians: Array.from(ctx.citedPoliticiansMap.values()).slice(0, 10),
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO research_history (
      id, question, session_scope, answer, model, mode, warning,
      tool_calls_json, cited_bills_json, cited_politicians_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.question,
    record.sessionScope,
    record.answer,
    record.model,
    record.mode,
    record.warning || '',
    JSON.stringify(record.toolCalls),
    JSON.stringify(record.citedBills),
    JSON.stringify(record.citedPoliticians),
    record.createdAt
  );

  return record;
}

export function listResearchHistory(limit = 30): ResearchQueryRecord[] {
  const rows = db
    .prepare(
      `SELECT id, question, session_scope, answer, model, mode, warning,
              tool_calls_json, cited_bills_json, cited_politicians_json, created_at
       FROM research_history
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    question: string;
    session_scope: string;
    answer: string;
    model: string;
    mode: string;
    warning: string;
    tool_calls_json: string;
    cited_bills_json: string;
    cited_politicians_json: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    sessionScope: r.session_scope,
    answer: r.answer,
    model: r.model,
    mode: (r.mode as ResearchQueryRecord['mode']) || 'llm_agent',
    warning: r.warning || undefined,
    toolCalls: safeJsonArray<ResearchToolTrace>(r.tool_calls_json),
    citedBills: safeJsonArray<ResearchCitedBill>(r.cited_bills_json),
    citedPoliticians: safeJsonArray<ResearchCitedPolitician>(r.cited_politicians_json),
    createdAt: r.created_at,
  }));
}

export function deleteResearchHistoryItem(id: string): boolean {
  const res = db.prepare(`DELETE FROM research_history WHERE id = ?`).run(id);
  return res.changes > 0;
}
