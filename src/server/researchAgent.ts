import crypto from 'crypto';
import { db } from './db.ts';
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
    // Any HTTP response (even 401/404) confirms the server socket is reachable
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
    return { outcome: 'Active', outcomeDetail: stage || 'In Progress' };
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
    billTerms: ['autonomous', 'automated motor vehicle', 'automated vehicle', 'self-driving', 'driverless', 'waymo', 'robotaxi', 'automated driving'],
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
    triggers: ['budget', 'appropriations', 'spending', 'fiscal', 'revenue'],
    billTerms: ['appropriations', 'biennium', 'budget', 'comptroller', 'grant'],
    committeeTerms: ['appropriations', 'finance', 'ways & means'],
    donorSectors: ['business', 'health', 'energy', 'real estate'],
    fiscalRelevant: true,
  },
];

function findPolicyExpansion(topic: string): PolicyExpansion | null {
  const lower = topic.toLowerCase();
  for (const exp of POLICY_EXPANSIONS) {
    if (exp.triggers.some((t) => lower.includes(t))) {
      return exp;
    }
  }
  return null;
}

function buildFtsFromNaturalText(raw: string): string {
  const cleaned = raw
    .replace(/['"`*?()[\]{}:^~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !['the', 'and', 'for', 'with', 'about', 'from', 'into', 'over', 'have', 'been', 'that', 'this', 'bill', 'bills', 'policy', 'texas'].includes(t.toLowerCase()));
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return `"${tokens[0]}"*`;
  return tokens.map((t) => `"${t}"*`).join(' AND ');
}

function buildOrFtsFromTerms(terms: string[]): string {
  const parts = terms
    .map((t) => t.replace(/['"`*?()[\]{}:^~]/g, ' ').trim())
    .filter((t) => t.length >= 3)
    .map((t) => (t.includes(' ') || t.length < 5 ? `"${t}"` : `"${t}"*`));
  return Array.from(new Set(parts)).join(' OR ');
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

// ============================================================================
// DETERMINISTIC RESEARCH TOOLS
// ============================================================================

function toolGetArchiveOverview(
  args: { session?: string },
  _ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const sessionFilter = safeStr(args.session).trim().toUpperCase();
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
    { session: string; total: number; passed: number; failed: number; vetoed: number; active: number }
  >();
  for (const r of billRows) {
    const committees = safeJsonArray(r.committees_json);
    const { outcome } = classifyOutcome(r.session, r.stage, r.status, r.last_action, committees.length);
    const cur = bySession.get(r.session) || {
      session: r.session,
      total: 0,
      passed: 0,
      failed: 0,
      vetoed: 0,
      active: 0,
    };
    cur.total += 1;
    if (outcome === 'Passed') cur.passed += 1;
    else if (outcome === 'Failed') cur.failed += 1;
    else if (outcome === 'Vetoed') cur.vetoed += 1;
    else cur.active += 1;
    bySession.set(r.session, cur);
  }

  const sessions = Array.from(bySession.values()).sort((a, b) => b.session.localeCompare(a.session));
  const politiciansCount = (db.prepare(`SELECT COUNT(*) AS c FROM politicians`).get() as { c: number }).c;
  const committeesCount = (db.prepare(`SELECT COUNT(*) AS c FROM committees`).get() as { c: number }).c;
  const statutesCount = (db.prepare(`SELECT COUNT(*) AS c FROM statute_sections`).get() as { c: number }).c;

  return {
    payload: {
      totalBillsIndexed: billRows.length,
      politiciansIndexed: politiciansCount,
      committeesIndexed: committeesCount,
      statuteSectionsIndexed: statutesCount,
      sessions,
    },
    summary: `${billRows.length} bills indexed across ${sessions.length} session(s), ${politiciansCount} legislators, ${committeesCount} committees`,
    resultCount: billRows.length,
  };
}

function queryBillsMatchingText(
  query: string,
  filters: { session?: string; chamber?: string; stage?: string; author?: string }
): { rows: BillDbRow[]; matchMode: 'exact_fts' | 'expanded_fts' | 'all_filtered' } {
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

  const trimmed = query.trim();
  if (!trimmed) {
    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT b.* FROM bills b ${whereSql} ORDER BY b.influence_score DESC, b.last_action_date DESC`)
      .all(...params) as BillDbRow[];
    return { rows, matchMode: 'all_filtered' };
  }

  // 1. Try precise FTS5 query first
  const ftsStrict = buildFtsFromNaturalText(trimmed);
  if (ftsStrict) {
    try {
      const whereSql = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      const rows = db
        .prepare(
          `SELECT b.*
           FROM bills_fts
           JOIN bills b ON b.id = bills_fts.bill_id
           WHERE bills_fts MATCH ? ${whereSql}
           ORDER BY b.influence_score DESC, b.last_action_date DESC`
        )
        .all(ftsStrict, ...params) as BillDbRow[];
      if (rows.length > 0) {
        return { rows, matchMode: 'exact_fts' };
      }
    } catch {
      // Fall through to LIKE/synonym matching
    }
  }

  // 2. Fallback to substring LIKE on exact trimmed phrase
  {
    const likeCond = [
      ...conditions,
      `(LOWER(b.title) LIKE LOWER(?) OR LOWER(b.summary) LIKE LOWER(?) OR LOWER(b.subjects_json) LIKE LOWER(?) OR LOWER(b.full_text) LIKE LOWER(?))`,
    ];
    const pat = `%${trimmed}%`;
    const rows = db
      .prepare(
        `SELECT b.* FROM bills b WHERE ${likeCond.join(' AND ')} ORDER BY b.influence_score DESC, b.last_action_date DESC`
      )
      .all(...params, pat, pat, pat, pat) as BillDbRow[];
    if (rows.length > 0) {
      return { rows, matchMode: 'exact_fts' };
    }
  }

  // 3. Domain synonym expansion if the topic has known statutory aliases (e.g. autonomous driving -> automated motor vehicle)
  const exp = findPolicyExpansion(trimmed);
  if (exp) {
    const ftsExpanded = buildOrFtsFromTerms(exp.billTerms);
    if (ftsExpanded) {
      try {
        const whereSql = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
        const rows = db
          .prepare(
            `SELECT b.*
             FROM bills_fts
             JOIN bills b ON b.id = bills_fts.bill_id
             WHERE bills_fts MATCH ? ${whereSql}
             ORDER BY b.influence_score DESC, b.last_action_date DESC`
          )
          .all(ftsExpanded, ...params) as BillDbRow[];
        if (rows.length > 0) {
          return { rows, matchMode: 'expanded_fts' };
        }
      } catch {
        // ignore
      }
    }
  }

  return { rows: [], matchMode: 'exact_fts' };
}

function toolSearchAndCountBills(
  args: {
    query?: string;
    session?: string;
    chamber?: string;
    outcome?: string;
    stage?: string;
    author?: string;
    limit?: number;
  },
  ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const query = safeStr(args.query).trim();
  const session = safeStr(args.session).trim();
  const chamber = safeStr(args.chamber).trim();
  const outcomeFilter = safeStr(args.outcome).trim().toLowerCase();
  const stage = safeStr(args.stage).trim();
  const author = safeStr(args.author).trim();
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 12));

  const { rows: rawRows, matchMode } = queryBillsMatchingText(query, {
    session: session || undefined,
    chamber: chamber || undefined,
    stage: stage || undefined,
    author: author || undefined,
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

  const filtered = outcomeFilter
    ? enriched.filter((e) => e.outcome.toLowerCase() === outcomeFilter)
    : enriched;

  const bySessionMap = new Map<
    string,
    { session: string; total: number; passed: number; failed: number; vetoed: number; active: number }
  >();
  const byChamber = { House: 0, Senate: 0 };
  const byOutcome = { Passed: 0, Failed: 0, Vetoed: 0, Active: 0 };
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
      influenceScore: Number(row.influence_score.toFixed(1)),
      filedDate: row.filed_date,
      lastActionDate: row.last_action_date,
    };
  });

  const totalIndexedBills = (db.prepare(`SELECT COUNT(*) AS c FROM bills`).get() as { c: number }).c;

  const payload = {
    query: query || '(all bills)',
    matchMode,
    filters: { session: session || 'ALL', chamber: chamber || 'ALL', outcome: outcomeFilter || 'ALL' },
    totalMatches: filtered.length,
    totalIndexedBillsInArchive: totalIndexedBills,
    bySession: Array.from(bySessionMap.values()).sort((a, b) => b.session.localeCompare(a.session)),
    byChamber,
    byOutcome,
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

  return {
    payload,
    summary:
      filtered.length === 0
        ? `0 bills matched "${query || 'filter'}" (out of ${totalIndexedBills} indexed)`
        : `${filtered.length} matching bill${filtered.length === 1 ? '' : 's'} (${byOutcome.Passed} passed, ${byOutcome.Failed} failed, ${byOutcome.Active} active)`,
    resultCount: filtered.length,
  };
}

function toolRankPolicyInfluence(
  args: { topic: string; chamber?: string; session?: string; limit?: number },
  ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const topic = safeStr(args.topic).trim();
  const chamberFilter = safeStr(args.chamber).trim();
  const sessionFilter = safeStr(args.session).trim();
  const limit = Math.min(15, Math.max(3, Number(args.limit) || 8));

  const expansion = findPolicyExpansion(topic);
  const topicTokens = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !['policy', 'bills', 'texas', 'over', 'influence'].includes(t));

  // 1. Find topic-related bills
  const { rows: topicBills, matchMode } = queryBillsMatchingText(topic, {
    session: sessionFilter || undefined,
  });
  const topicBillIds = new Set(topicBills.map((b) => b.id));

  // Register top topic bills as citations
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

  // Score each politician transparently
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

      // Also inspect leadership_role text directly (helpful for TLO-synced rosters without full membership rows)
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

      // Small tie-breaker for institutional seniority / bills passed if already relevant
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
    sessionFilter: sessionFilter || 'ALL',
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
  const session = safeStr(args.session).trim().toUpperCase();
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

function toolSearchCommittees(
  args: { query?: string; chamber?: string },
  ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const q = safeStr(args.query).trim().toLowerCase();
  const chamber = safeStr(args.chamber).trim();
  const expansion = q ? findPolicyExpansion(q) : null;

  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.chamber, c.session, c.jurisdiction,
              p1.id AS chair_pol_id, p1.name AS chair_name, p1.party AS chair_party, p1.district AS chair_district,
              p2.name AS vice_chair_name
       FROM committees c
       LEFT JOIN politicians p1 ON p1.id = c.chair_id
       LEFT JOIN politicians p2 ON p2.id = c.vice_chair_id
       ${chamber ? 'WHERE LOWER(c.chamber) = LOWER(?)' : ''}
       ORDER BY c.chamber ASC, c.name ASC`
    )
    .all(...(chamber ? [chamber] : [])) as Array<{
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

  const filtered = q
    ? rows.filter((r) => {
        const hay = `${r.name} ${r.jurisdiction}`.toLowerCase();
        if (hay.includes(q)) return true;
        if (expansion && expansion.committeeTerms.some((t) => hay.includes(t))) return true;
        return q
          .split(/\s+/)
          .filter((w) => w.length >= 3)
          .some((w) => hay.includes(w));
      })
    : rows;

  const finalList = (filtered.length > 0 ? filtered : rows).slice(0, 15);
  for (const r of finalList) {
    if (r.chair_pol_id && r.chair_name) {
      registerPoliticianCitation(ctx, {
        id: r.chair_pol_id,
        name: r.chair_name,
        shortName: r.chair_name,
        chamber: r.chamber,
        party: r.chair_party || '—',
        district: r.chair_district || '',
        leadershipRole: `Chair, ${r.chamber} ${r.name}`,
        reason: `Committee Chair (${r.jurisdiction || r.name})`,
      });
    }
  }

  return {
    payload: {
      query: q || '(all committees)',
      matchedSpecifically: filtered.length > 0,
      committees: finalList.map((r) => ({
        name: `${r.chamber} ${r.name}`,
        session: r.session,
        chair: r.chair_name || 'Unassigned',
        viceChair: r.vice_chair_name || 'Unassigned',
        jurisdiction: r.jurisdiction,
      })),
    },
    summary: `${finalList.length} committee${finalList.length === 1 ? '' : 's'} returned`,
    resultCount: finalList.length,
  };
}

function toolSearchStatutes(
  args: { query: string; code?: string; limit?: number },
  _ctx: AgentExecutionContext
): { payload: Record<string, unknown>; summary: string; resultCount: number } {
  const q = safeStr(args.query).trim();
  const code = safeStr(args.code).trim().toUpperCase();
  const limit = Math.min(12, Math.max(1, Number(args.limit) || 6));
  const fts = buildFtsFromNaturalText(q);

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
        'Get counts of all indexed Texas bills by session (including Passed/Failed/Vetoed totals), plus total legislators, committees, and statute sections in the local database.',
      parameters: {
        type: 'object',
        properties: {
          session: {
            type: 'string',
            description: 'Optional session code such as 90R, 89R, 891, 88R, 87R.',
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
        'Search and count bills in the local Texas Capitol SQLite/FTS5 archive by policy topic, keywords, session, chamber, outcome (Passed/Failed/Vetoed/Active), or author. Returns exact totals by session/chamber/outcome plus top matching bills.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords or policy topic (e.g., "autonomous driving", "medicaid", "school finance", "ERCOT"). Leave empty to count all bills matching filters.',
          },
          session: { type: 'string', description: 'Optional session filter (e.g., 89R, 90R, 88R).' },
          chamber: { type: 'string', enum: ['House', 'Senate'], description: 'Optional chamber filter.' },
          outcome: {
            type: 'string',
            enum: ['Passed', 'Failed', 'Vetoed', 'Active'],
            description: 'Optional outcome filter for previous vs active sessions.',
          },
          author: { type: 'string', description: 'Optional author surname or name.' },
          limit: { type: 'number', description: 'Max bills to return in sample (default 12).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rank_policy_influence',
      description:
        'Rank Texas legislators by influence over a specific policy area (e.g., medicaid, education, ERCOT grid, property tax, autonomous driving) combining committee chair/gatekeeping power, authored & passed bills, leadership roles, roll-call votes, and related-sector PAC filings.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Policy area to evaluate (e.g., "medicaid", "public education", "autonomous driving", "ERCOT energy").',
          },
          chamber: {
            type: 'string',
            enum: ['House', 'Senate'],
            description: 'Use "House" when asked about representatives, "Senate" when asked about senators, or omit for both.',
          },
          session: { type: 'string', description: 'Optional session scope.' },
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
          session: { type: 'string', description: 'Optional session code like "89R".' },
        },
        required: ['billRef'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_committees',
      description: 'Search Texas House and Senate committees by policy topic, jurisdiction, or chamber, returning chairs and jurisdictions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Policy topic or committee name.' },
          chamber: { type: 'string', enum: ['House', 'Senate'] },
        },
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
    case 'rank_policy_influence':
      res = toolRankPolicyInfluence(args as Parameters<typeof toolRankPolicyInfluence>[0], ctx);
      break;
    case 'get_politician_profile':
      res = toolGetPoliticianProfile(args as { query: string }, ctx);
      break;
    case 'get_bill_details':
      res = toolGetBillDetails(args as { billRef: string; session?: string }, ctx);
      break;
    case 'search_committees':
      res = toolSearchCommittees(args as { query?: string; chamber?: string }, ctx);
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
// DETERMINISTIC QUERY PLANNER (used when LLM lacks tool-calling or is offline)
// ============================================================================

function extractTopicFromQuestion(question: string): string {
  const q = question.trim();
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
        .replace(/\b(in\s+\d{2}[r1-4]|across\s+[\w\s,-]+|in\s+texas|policy|legislation|bills?|session|previous sessions?|passed|failed|vs\.?)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (candidate.length >= 2) return candidate;
    }
  }
  return q
    .replace(
      /\b(how|many|which|who|what|are|is|have|has|been|were|was|the|greatest|most|top|bills?|introduced|filed|passed|failed|vs|representatives?|senators?|legislators?|lawmakers?|influence|over|on|about|policy|texas|session|sessions|across|in|and|\d{2}[r1-4])\b/gi,
      ' '
    )
    .replace(/[?!.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectChamberFromQuestion(question: string): 'House' | 'Senate' | undefined {
  const lower = question.toLowerCase();
  const wantsHouse = /\b(representative|representatives|rep\.|house)\b/.test(lower);
  const wantsSenate = /\b(senator|senators|sen\.|senate)\b/.test(lower);
  if (wantsHouse && !wantsSenate) return 'House';
  if (wantsSenate && !wantsHouse) return 'Senate';
  return undefined;
}

function detectSessionFromQuestion(question: string, sessionScope: string): string | undefined {
  const m = question.match(/\b(\d{2}[Rr]|\d{2}[1-4])\b/);
  if (m) return m[1].toUpperCase();
  if (sessionScope) return sessionScope.toUpperCase();
  return undefined;
}

function runDeterministicPlan(
  question: string,
  sessionScope: string,
  ctx: AgentExecutionContext
): { evidence: Record<string, unknown>; fallbackMarkdown: string } {
  const lower = question.toLowerCase();
  const chamber = detectChamberFromQuestion(question);
  const session = detectSessionFromQuestion(question, sessionScope);
  const topic = extractTopicFromQuestion(question);

  const evidence: Record<string, unknown> = {};
  const overview = executeTool('get_archive_overview', session ? { session } : {}, ctx);
  evidence.archiveOverview = overview;

  const isInfluenceQuery =
    /\b(influence|influential|control|powerful|key|top|which\s+(representative|representatives|senator|senators|legislator|legislators|member|members)|who\s+controls?|who\s+leads?)\b/i.test(
      lower
    );
  const isCommitteeQuery = /\bcommittee|committees|chair|chairs\b/i.test(lower);
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
        `- **Outcome / Stage:** ${b.outcomeDetail} (Stage: ${b.stage}) · **Primary Author:** ${b.primaryAuthor} · **Influence Score:** ${b.influenceScore}`
      );
      if (b.summary) lines.push(`- **Summary:** ${b.summary}`);
      if (b.lastAction) lines.push(`- **Last Action (${b.lastActionDate}):** ${b.lastAction}`);
    }
  }

  if (isInfluenceQuery) {
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
      `### Highest-Influence ${chamber === 'House' ? 'Texas House Representatives' : chamber === 'Senate' ? 'Texas Senators' : 'Texas Legislators'} on "${topic || question}"`
    );
    lines.push(
      `Evaluated **${topicBillCount}** matching bill${topicBillCount === 1 ? '' : 's'} and **${relComms.length}** relevant committee${relComms.length === 1 ? '' : 's'} across the indexed SQLite archive (${(overview.totalBillsIndexed as number) ?? 0} total bills, ${(overview.politiciansIndexed as number) ?? 0} legislators).`
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
      lines.push(
        `\n**Key Gatekeeping Committees:** ${relComms.map((c) => c.name).join(', ')}.`
      );
    }
    if (topicBillCount === 0) {
      lines.push(
        `\n*Archive note:* 0 bills specifically mentioning "${topic}" are synced locally yet. Use **Sync TLO FTP** to import full session archives (e.g., 89R or 88R) to deepen bill-level scoring.`
      );
    }
  }

  if (!isInfluenceQuery || /\bhow many|count|bills?\b/i.test(lower)) {
    const outcomeParam =
      /\bpassed|enacted|signed\b/i.test(lower) && !/\bfailed|vs\.?\s*failed\b/i.test(lower)
        ? 'Passed'
        : /\bfailed|died|stalled\b/i.test(lower) && !/\bpassed\b/i.test(lower)
          ? 'Failed'
          : /\bvetoed\b/i.test(lower)
            ? 'Vetoed'
            : undefined;

    const billSearch = executeTool(
      'search_and_count_bills',
      {
        query: topic,
        ...(session ? { session } : {}),
        ...(chamber ? { chamber } : {}),
        ...(outcomeParam ? { outcome: outcomeParam } : {}),
        limit: 12,
      },
      ctx
    );
    evidence.billSearch = billSearch;

    if (!isInfluenceQuery) {
      const total = Number(billSearch.totalMatches || 0);
      const totalArchive = Number(billSearch.totalIndexedBillsInArchive || 0);
      const bySession = (billSearch.bySession as Array<Record<string, unknown>>) || [];
      const byOutcome = (billSearch.byOutcome as Record<string, number>) || {};
      const bills = (billSearch.bills as Array<Record<string, unknown>>) || [];

      lines.push(`### Bill Count & Archive Findings: "${topic || 'All Bills'}"`);
      lines.push(
        `- **Total Matching Bills in Local Archive:** **${total}** (out of **${totalArchive}** indexed bills${session ? ` in ${session}` : ''}).`
      );

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
        for (const b of bills.slice(0, 8)) {
          lines.push(
            `- **${b.session} ${b.billNumber}** (${b.outcomeDetail}) — ${b.title} *(Author: ${b.primaryAuthor})*`
          );
        }
      } else {
        const syncedSessions = ((overview.sessions as Array<{ session: string; total: number }>) || [])
          .map((s) => `${s.session} (${s.total})`)
          .join(', ');
        lines.push(
          `- Currently indexed sessions: ${syncedSessions || 'None'}.`
        );
        lines.push(
          `- To search the full Texas Legislature history for **"${topic}"**, open **Sync TLO FTP** on the Legislation tab and sync the full 89R, 88R, or 87R session archives into SQLite.`
        );
      }
    }
  }

  if (isCommitteeQuery) {
    evidence.committees = executeTool(
      'search_committees',
      { query: topic, ...(chamber ? { chamber } : {}) },
      ctx
    );
  }

  if (isStatuteQuery) {
    evidence.statutes = executeTool('search_statutes', { query: topic }, ctx);
  }

  return {
    evidence,
    fallbackMarkdown: lines.join('\n'),
  };
}

// Parse fallback <tool_call> JSON if a local Qwen model emits text-formatted tool calls
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
You have read-only tools connected directly to the user's live SQLite + FTS5 Texas Legislature archive (bills, outcomes, committees, legislators, roll-call votes, TEC campaign finance donors, and Texas statutes).

CRITICAL RULES:
1. ALWAYS call the appropriate tools before answering. NEVER invent bill counts, bill numbers, committee seats, or legislator names.
2. For questions like "how many bills about X", call search_and_count_bills (and get_archive_overview if 0 matches so you can report what sessions are currently synced locally).
3. For questions like "which representatives/senators have the greatest influence over X policy", call rank_policy_influence (set chamber="House" for representatives, "Senate" for senators) AND search_and_count_bills if helpful.
4. Distinguish clearly between:
   - What is verified in the currently indexed local database (exact counts, exact bills, exact committees/chairs/funding), and
   - Whether additional sessions should be synced via TLO FTP if 0 or few bills match a niche topic.
5. Present crisp, structured answers using concise markdown headings and bullet points with exact figures, bill numbers (e.g., 89R HB 2), and legislator names.`;

export async function runResearchAgent(input: {
  question: string;
  sessionScope?: string;
  priorTurns?: Array<{ question: string; answer: string }>;
}): Promise<ResearchQueryRecord> {
  const question = input.question.trim();
  const sessionScope = (input.sessionScope || '').trim();
  const cfg = getLocalLlmConfig();
  const ctx: AgentExecutionContext = {
    citedBillsMap: new Map(),
    citedPoliticiansMap: new Map(),
    traces: [],
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  // Fast reachability check (3s) so offline/LAN-isolated servers immediately fall back to deterministic SQLite evidence
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
          : question,
      });

      let toolCallingUnsupported = false;

      for (let step = 0; step < 5; step++) {
        const llmRes = await fetch(cfg.endpoint, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(75000),
          body: JSON.stringify({
            model: cfg.model,
            temperature: 0.15,
            tools: OPENAI_TOOLS,
            tool_choice: step === 0 ? 'auto' : 'auto',
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
            const toolOutput = executeTool(fnName, parsedArgs, ctx);
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
            const toolOutput = executeTool(ic.name, ic.arguments, ctx);
            inlineOutputs.push(`Tool ${ic.name} result:\n${JSON.stringify(toolOutput)}`);
          }
          messages.push({
            role: 'user',
            content: `Here are the tool results from the local SQLite database. Now write your final grounded answer:\n\n${inlineOutputs.join('\n\n')}`,
          });
          continue;
        }

        // Model produced final text directly
        if (ctx.traces.length === 0 && step === 0) {
          // Enforce grounding: if the 7B model skipped calling tools on step 0, run our deterministic planner and have it synthesize!
          toolCallingUnsupported = true;
          break;
        }

        answer = (msg.content || '').trim();
        mode = 'llm_agent';
        break;
      }

      // Layer 2 fallback: deterministic SQLite retrieval + single-shot LLM synthesis
      if (toolCallingUnsupported || !answer) {
        const plan = runDeterministicPlan(question, sessionScope, ctx);
        const synthRes = await fetch(cfg.endpoint, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(75000),
          body: JSON.stringify({
            model: cfg.model,
            temperature: 0.15,
            messages: [
              {
                role: 'system',
                content:
                  'You are a Texas legislative research analyst. Answer the user question concisely using ONLY the structured SQLite database evidence provided below. Cite exact numbers, bill numbers, committees, and legislator names.',
              },
              {
                role: 'user',
                content: `Question: ${question}\n\nDatabase Evidence (JSON):\n${JSON.stringify(plan.evidence, null, 2)}`,
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
    // Layer 3: Local LLM is offline or outside current network — execute deterministic SQLite research plan directly
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
