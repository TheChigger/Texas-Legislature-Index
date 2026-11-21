import { Router } from 'express';
import {
  buildSafeFtsQuery,
  db,
  evaluateAlertRules,
  isProceduralCommittee,
  normalizeIsoDate,
  recomputeBillMetrics,
  refreshSessionCounts,
  syncAmendmentFts,
  syncBillFts,
} from './db.ts';
import { computeLineDiff } from './diff.ts';
import {
  cancelTloSyncJob,
  getLatestTloSyncJob,
  getTloSyncJob,
  listTloFtpSessions,
  startTloSyncJob,
  syncFromTloFtp,
  syncLegislatorsFromTloFtp,
  type TloBillType,
} from './tloFtp.ts';
import { fetchStatuteSnapshotByDate, syncTexasCodeFromTloFtp } from './statutes.ts';
import {
  deleteResearchHistoryItem,
  listResearchHistory,
  runResearchAgent,
} from './researchAgent.ts';
import { backfillAllBillFiscalImpacts } from './fiscalParser.ts';
import {
  getLatestTexRegSyncJob,
  parseTexasRegisterText,
  relinkAllRulesToBills,
  startTexRegSyncJob,
  upsertParsedAgencyRules,
} from './texasRegister.ts';
import type {
  AgencyRuleActionType,
  AgencyRuleDetail,
  AgencyRuleSummary,
  BillDocument,
  BillFiscalImpact,
  BillOutcome,
  BillRelatedRule,
  BillStage,
  BillSummary,
  Chamber,
  FiscalStatus,
  KeywordOverlapMatch,
  KeywordTrendSeries,
  NetworkEdge,
  NetworkGraph,
  NetworkNode,
  RuleLinkedBill,
  TimelineCohort,
  TimelineCohortBill,
  TimelineConsolidation,
  TimelineEventItem,
} from '../types.ts';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.json({ ok: true, status: 'healthy', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({
      ok: false,
      status: 'unhealthy',
      error: err instanceof Error ? err.message : 'Database check failed',
    });
  }
});

interface RawBillRow {
  id: string;
  session: string;
  bill_number: string;
  chamber: Chamber;
  title: string;
  summary: string;
  statute_codes: string;
  status: string;
  stage: BillSummary['stage'];
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
  influence_breakdown_json: string;
  momentum_label: string;
  bipartisan_index: number;
  amendment_count: number;
  action_count: number;
  source: string;
  full_text: string;
  fiscal_status?: string | null;
  biennial_gr_impact?: number | null;
  five_year_gr_impact?: number | null;
  five_year_all_funds_impact?: number | null;
  fte_change?: number | null;
  local_gov_impact?: string | null;
  fiscal_note_version?: string | null;
  fiscal_summary?: string | null;
  snippet?: string;
  rank?: number;
}

function safeStr(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return fallback;
  return v == null ? fallback : String(v);
}

function computeBillOutcome(
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
    return {
      outcome: 'Passed',
      outcomeDetail: passedDetail,
    };
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

function mapBillRow(row: RawBillRow): BillSummary {
  const linkCountRow = db
    .prepare(`SELECT COUNT(*) AS c FROM bill_links WHERE source_bill_id = ? OR target_bill_id = ?`)
    .get(row.id, row.id) as { c: number };

  const committees = JSON.parse(safeStr(row.committees_json, '[]')) as BillSummary['committees'];
  const session = safeStr(row.session);
  const status = safeStr(row.status);
  const lastAction = safeStr(row.last_action);
  const { outcome, outcomeDetail } = computeBillOutcome(
    session,
    row.stage,
    status,
    lastAction,
    committees.length
  );

  return {
    id: safeStr(row.id),
    session,
    billNumber: safeStr(row.bill_number),
    chamber: (safeStr(row.chamber, 'House') as Chamber),
    title: safeStr(row.title),
    summary: safeStr(row.summary),
    statuteCodes: JSON.parse(safeStr(row.statute_codes, '[]')),
    status,
    stage: row.stage,
    outcome,
    outcomeDetail,
    primaryAuthor: safeStr(row.primary_author),
    coauthors: JSON.parse(safeStr(row.coauthors_json, '[]')),
    sponsors: JSON.parse(safeStr(row.sponsors_json, '[]')),
    cosponsors: JSON.parse(safeStr(row.cosponsors_json, '[]')),
    committees,
    subjects: JSON.parse(safeStr(row.subjects_json, '[]')),
    lastAction,
    lastActionDate: safeStr(row.last_action_date),
    filedDate: safeStr(row.filed_date),
    influenceScore: Number(row.influence_score) || 0,
    influenceBreakdown: JSON.parse(safeStr(row.influence_breakdown_json, '{}')),
    momentumLabel: safeStr(row.momentum_label),
    bipartisanIndex: Number(row.bipartisan_index) || 0,
    amendmentCount: Number(row.amendment_count) || 0,
    actionCount: Number(row.action_count) || 0,
    linkCount: linkCountRow.c,
    source: safeStr(row.source),
    fiscalImpact: {
      status: safeStr(row.fiscal_status) as FiscalStatus,
      biennialGrImpact:
        row.biennial_gr_impact === null || row.biennial_gr_impact === undefined
          ? null
          : Number(row.biennial_gr_impact),
      fiveYearGrImpact:
        row.five_year_gr_impact === null || row.five_year_gr_impact === undefined
          ? null
          : Number(row.five_year_gr_impact),
      fiveYearAllFundsImpact:
        row.five_year_all_funds_impact === null || row.five_year_all_funds_impact === undefined
          ? null
          : Number(row.five_year_all_funds_impact),
      fteChange:
        row.fte_change === null || row.fte_change === undefined ? null : Number(row.fte_change),
      localGovImpact: safeStr(row.local_gov_impact),
      versionLabel: safeStr(row.fiscal_note_version),
      summary: safeStr(row.fiscal_summary),
    },
    snippet: row.snippet,
    rank: row.rank,
  };
}

const STOPWORDS = new Set([
  'relating', 'texas', 'state', 'section', 'chapter', 'code', 'amended', 'adding', 'public',
  'program', 'act', 'shall', 'under', 'from', 'with', 'that', 'this', 'bill', 'certain',
  'requiring', 'authorizing', 'establishing', 'providing', 'system', 'general', 'funds',
]);

function extractBillTokens(bill: { title: string; summary: string; subjects_json: string; statute_codes: string }): string[] {
  const subjects = (JSON.parse(bill.subjects_json || '[]') as string[]).join(' ');
  const statutes = (JSON.parse(bill.statute_codes || '[]') as string[]).join(' ');
  const combined = `${bill.title} ${bill.summary} ${subjects} ${statutes}`.toLowerCase();
  const words = combined.match(/[a-z]{4,}/g) ?? [];
  return Array.from(new Set(words.filter((w) => !STOPWORDS.has(w))));
}

function computeKeywordOverlaps(billId: string): KeywordOverlapMatch[] {
  const target = db
    .prepare(`SELECT id, title, summary, subjects_json, statute_codes FROM bills WHERE id = ?`)
    .get(billId) as
    | { id: string; title: string; summary: string; subjects_json: string; statute_codes: string }
    | undefined;
  if (!target) return [];

  const targetTokens = new Set(extractBillTokens(target));
  const others = db
    .prepare(
      `SELECT id, bill_number, session, title, summary, stage, subjects_json, statute_codes
       FROM bills
       WHERE id != ?
       ORDER BY influence_score DESC
       LIMIT 600`
    )
    .all(billId) as Array<{
    id: string;
    bill_number: string;
    session: string;
    title: string;
    summary: string;
    stage: string;
    subjects_json: string;
    statute_codes: string;
  }>;

  const overlaps: KeywordOverlapMatch[] = [];
  for (const o of others) {
    const tokens = extractBillTokens(o);
    const shared = tokens.filter((t) => targetTokens.has(t));
    if (shared.length >= 3) {
      overlaps.push({
        billId: o.id,
        billNumber: o.bill_number,
        session: o.session,
        title: o.title,
        stage: o.stage,
        sharedKeywords: shared.slice(0, 6),
        overlapScore: shared.length,
      });
    }
  }
  return overlaps.sort((a, b) => b.overlapScore - a.overlapScore).slice(0, 6);
}

// 1. Overview, Influential Legislation & Multi-Session Keyword Trends
apiRouter.get('/overview', (req, res) => {
  const sessionFilter = String(req.query.session ?? '').trim();

  const totals = {
    bills: (db.prepare(`SELECT COUNT(*) AS c FROM bills`).get() as { c: number }).c,
    amendments: (db.prepare(`SELECT COUNT(*) AS c FROM amendments`).get() as { c: number }).c,
    politicians: (db.prepare(`SELECT COUNT(*) AS c FROM politicians`).get() as { c: number }).c,
    contributionsTotal: (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM contributions`).get() as { s: number }).s,
    unreadAlerts: (db.prepare(`SELECT COUNT(*) AS c FROM alert_events WHERE is_read = 0`).get() as { c: number }).c,
    linksCount: (db.prepare(`SELECT COUNT(*) AS c FROM bill_links`).get() as { c: number }).c,
    rulesCount: (db.prepare(`SELECT COUNT(*) AS c FROM agency_rules`).get() as { c: number }).c,
    fiscalNotesParsed: (
      db.prepare(`SELECT COUNT(*) AS c FROM bills WHERE fiscal_status IS NOT NULL AND fiscal_status != ''`).get() as {
        c: number;
      }
    ).c,
  };

  const sessions = db
    .prepare(`SELECT code, label, years, bill_count AS billCount, synced_at AS syncedAt FROM sessions ORDER BY code DESC`)
    .all() as Array<{ code: string; label: string; years: string; billCount: number; syncedAt: string | null }>;

  const influentialRows = db
    .prepare(
      `SELECT * FROM bills
       ${sessionFilter ? 'WHERE session = ?' : ''}
       ORDER BY influence_score DESC, amendment_count DESC
       LIMIT 6`
    )
    .all(...(sessionFilter ? [sessionFilter] : [])) as RawBillRow[];

  const trendQueries = [
    { keyword: 'School Finance & Vouchers', query: '"basic allotment" OR "Education Freedom" OR voucher OR teacher' },
    { keyword: 'ERCOT Grid & Nuclear', query: 'ERCOT OR nuclear OR "Texas Energy Fund" OR dispatchable' },
    { keyword: 'Property Tax & Homestead', query: 'homestead OR appraisal OR compression' },
    { keyword: 'Water & Infrastructure', query: 'water OR desalination OR aquifer OR ambulance' },
    { keyword: 'AI Loads & Regulatory Reform', query: '"data center" OR regulatory OR "Administrative Code"' },
  ];

  const trackedSessions = ['87R', '88R', '89R', '891', '90R'];
  const keywordTrends: KeywordTrendSeries[] = trendQueries.map((tq) => {
    const fts = buildSafeFtsQuery(tq.query);
    let totalHits = 0;
    const bySession = trackedSessions.map((sess) => {
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS c
             FROM bills_fts
             JOIN bills b ON b.id = bills_fts.bill_id
             WHERE bills_fts MATCH ? AND b.session = ?`
          )
          .get(fts, sess) as { c: number };
        totalHits += row.c;
        return { session: sess, count: row.c };
      } catch {
        return { session: sess, count: 0 };
      }
    });
    const recentCount = bySession[bySession.length - 1].count + bySession[bySession.length - 3].count;
    return {
      keyword: tq.keyword,
      query: tq.query,
      totalHits,
      changeLabel: recentCount > 1 ? 'Rising into 90th' : 'Sustained Topic',
      bySession,
    };
  });

  // Committee throughput / bottlenecks
  const committeeMap = new Map<string, { name: string; chamber: Chamber; referred: number; reported: number }>();
  const allBills = db
    .prepare(`SELECT committees_json FROM bills ${sessionFilter ? 'WHERE session = ?' : ''}`)
    .all(...(sessionFilter ? [sessionFilter] : [])) as Array<{ committees_json: string }>;

  for (const row of allBills) {
    const comms = JSON.parse(row.committees_json || '[]') as Array<{
      name: string;
      chamber: Chamber;
      status: string;
    }>;
    for (const c of comms) {
      if (isProceduralCommittee(c.name)) continue;
      const key = `${c.chamber}-${c.name}`;
      const cur = committeeMap.get(key) ?? { name: c.name, chamber: c.chamber, referred: 0, reported: 0 };
      cur.referred++;
      if (c.status.toLowerCase().includes('out of committee')) cur.reported++;
      committeeMap.set(key, cur);
    }
  }

  const committeeBottlenecks = Array.from(committeeMap.values())
    .sort((a, b) => b.referred - a.referred)
    .slice(0, 6)
    .map((c) => ({
      name: c.name,
      chamber: c.chamber,
      referredCount: c.referred,
      reportedCount: c.reported,
      passageRate: c.referred > 0 ? Math.round((c.reported / c.referred) * 100) : 0,
    }));

  // Deterministic top keyword index across bills
  const tokenFreq = new Map<string, number>();
  const billTexts = db.prepare(`SELECT title, summary, subjects_json, statute_codes FROM bills`).all() as Array<{
    title: string;
    summary: string;
    subjects_json: string;
    statute_codes: string;
  }>;
  for (const b of billTexts) {
    for (const tok of extractBillTokens(b)) {
      tokenFreq.set(tok, (tokenFreq.get(tok) ?? 0) + 1);
    }
  }
  const topKeywords = Array.from(tokenFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([term, billCount]) => ({ term, billCount }));

  res.json({
    totals,
    sessions,
    influentialBills: influentialRows.map(mapBillRow),
    keywordTrends,
    committeeBottlenecks,
    topKeywords,
  });
});

// 2. Full-Text Keyword Legislation Search & Filters
apiRouter.get('/bills', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const session = String(req.query.session ?? '').trim();
  const chamber = String(req.query.chamber ?? '').trim();
  const stage = String(req.query.stage ?? '').trim();
  const outcomeFilter = String(req.query.outcome ?? '').trim();
  const committee = String(req.query.committee ?? '').trim();
  const fiscalFilter = String(req.query.fiscal ?? '').trim();
  const sort = String(req.query.sort ?? 'influence').trim();
  const parsedLimit = Number(req.query.limit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.floor(parsedLimit), 10000)
    : 100;

  const where: string[] = ["b.id IS NOT NULL AND typeof(b.id) = 'text' AND typeof(b.session) = 'text'"];
  const params: Array<string | number> = [];

  if (session) {
    where.push('b.session = ?');
    params.push(session);
  }
  if (chamber) {
    where.push('b.chamber = ?');
    params.push(chamber);
  }
  if (stage) {
    where.push('b.stage = ?');
    params.push(stage);
  }
  if (committee) {
    where.push('b.committees_json LIKE ?');
    params.push(`%${committee}%`);
  }
  if (fiscalFilter === 'significant') {
    where.push("b.fiscal_status = 'Significant Impact'");
  } else if (fiscalFilter === 'none') {
    where.push("b.fiscal_status = 'No Significant Impact'");
  } else if (fiscalFilter === 'parsed') {
    where.push("b.fiscal_status IS NOT NULL AND b.fiscal_status != ''");
  }

  const orderClause =
    sort === 'cost_desc'
      ? 'CASE WHEN b.biennial_gr_impact IS NOT NULL OR b.five_year_gr_impact IS NOT NULL OR b.five_year_all_funds_impact IS NOT NULL THEN 0 ELSE 1 END ASC, ABS(COALESCE(b.biennial_gr_impact, b.five_year_gr_impact, b.five_year_all_funds_impact, 0)) DESC, b.influence_score DESC'
      : sort === 'cost_asc'
        ? 'CASE WHEN b.biennial_gr_impact IS NOT NULL OR b.five_year_gr_impact IS NOT NULL OR b.five_year_all_funds_impact IS NOT NULL THEN 0 ELSE 1 END ASC, COALESCE(b.biennial_gr_impact, b.five_year_gr_impact, b.five_year_all_funds_impact, 0) DESC, b.influence_score DESC'
        : sort === 'amendments'
          ? 'b.amendment_count DESC, b.influence_score DESC'
          : sort === 'recent'
            ? 'b.last_action_date DESC, b.influence_score DESC'
            : sort === 'relevance' && q
              ? 'bm25(bills_fts) ASC, b.influence_score DESC'
              : 'b.influence_score DESC, b.amendment_count DESC';

  const finalizeResponse = (allRows: RawBillRow[], queryUsed: string) => {
    let passed = 0;
    let failed = 0;
    let vetoed = 0;
    let active = 0;
    const filteredRows: RawBillRow[] = [];

    for (const r of allRows) {
      let commCount = 0;
      try {
        commCount = (JSON.parse(safeStr(r.committees_json, '[]')) as unknown[]).length;
      } catch {
        commCount = 0;
      }
      const { outcome } = computeBillOutcome(
        safeStr(r.session),
        r.stage,
        safeStr(r.status),
        safeStr(r.last_action),
        commCount
      );
      if (outcome === 'Passed') passed++;
      else if (outcome === 'Failed') failed++;
      else if (outcome === 'Vetoed') vetoed++;
      else active++;

      if (!outcomeFilter || outcome === outcomeFilter) {
        if (filteredRows.length < limit) {
          filteredRows.push(r);
        }
      }
    }

    const totalPrevious = passed + failed + vetoed;
    return res.json({
      bills: filteredRows.map(mapBillRow),
      queryUsed,
      outcomeSummary: {
        passed,
        failed,
        vetoed,
        active,
        totalPrevious,
      },
    });
  };

  if (q) {
    const safeFts = buildSafeFtsQuery(q);
    if (safeFts) {
      try {
        const sql = `
          SELECT b.*,
                 snippet(bills_fts, -1, '<mark class="fts-hit">', '</mark>', ' … ', 20) AS snippet,
                 bm25(bills_fts) AS rank
          FROM bills_fts
          JOIN bills b ON b.id = bills_fts.bill_id
          WHERE bills_fts MATCH ?
          ${where.length ? 'AND ' + where.join(' AND ') : ''}
          ORDER BY ${orderClause}
        `;
        const rows = db.prepare(sql).all(safeFts, ...params) as RawBillRow[];
        return finalizeResponse(rows, safeFts);
      } catch {
        // Fallback to LIKE if FTS syntax is unusual
      }
    }
    where.push('(b.title LIKE ? OR b.summary LIKE ? OR b.bill_number LIKE ? OR b.full_text LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const sql = `
    SELECT b.*
    FROM bills b
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderClause === 'bm25(bills_fts) ASC, b.influence_score DESC' ? 'b.influence_score DESC' : orderClause}
  `;
  const rows = db.prepare(sql).all(...params) as RawBillRow[];
  return finalizeResponse(rows, q);
});

// 3. Single Bill Dossier
apiRouter.get('/bills/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM bills WHERE id = ?`).get(req.params.id) as RawBillRow | undefined;
  if (!row) return res.status(404).json({ error: 'Bill not found' });

  const bill = mapBillRow(row);
  const amendments = db
    .prepare(
      `SELECT id, bill_id AS billId, version_code AS versionCode, version_label AS versionLabel,
              amendment_number AS amendmentNumber, sponsor, filed_date AS filedDate, disposition,
              yea_votes AS yeaVotes, nay_votes AS nayVotes, pnv_votes AS pnvVotes, summary,
              full_text AS fullText, sort_order AS sortOrder
       FROM amendments
       WHERE bill_id = ?
       ORDER BY sort_order ASC, filed_date ASC`
    )
    .all(row.id);

  const actions = db
    .prepare(
      `SELECT id, bill_id AS billId, action_date AS actionDate, action_number AS actionNumber, description
       FROM bill_actions
       WHERE bill_id = ?
       ORDER BY action_date ASC, id ASC`
    )
    .all(row.id);

  const linksRaw = db
    .prepare(
      `SELECT l.id, l.source_bill_id AS sourceBillId, l.target_bill_id AS targetBillId,
              l.link_type AS linkType, l.notes, l.created_at AS createdAt,
              b.id AS otherId, b.bill_number AS otherNum, b.session AS otherSession,
              b.title AS otherTitle, b.stage AS otherStage
       FROM bill_links l
       JOIN bills b ON b.id = CASE WHEN l.source_bill_id = ? THEN l.target_bill_id ELSE l.source_bill_id END
       WHERE l.source_bill_id = ? OR l.target_bill_id = ?
       ORDER BY l.created_at DESC`
    )
    .all(row.id, row.id, row.id) as Array<{
    id: string;
    sourceBillId: string;
    targetBillId: string;
    linkType: string;
    notes: string;
    createdAt: string;
    otherId: string;
    otherNum: string;
    otherSession: string;
    otherTitle: string;
    otherStage: string;
  }>;

  const links = linksRaw.map((l) => ({
    id: l.id,
    sourceBillId: l.sourceBillId,
    targetBillId: l.otherId,
    targetBillNumber: l.otherNum,
    targetSession: l.otherSession,
    targetTitle: l.otherTitle,
    targetStage: l.otherStage,
    linkType: l.linkType,
    notes: l.notes,
    createdAt: l.createdAt,
  }));

  const keywordOverlaps = computeKeywordOverlaps(row.id);

  const witnessesRaw = db
    .prepare(
      `SELECT id, bill_id AS billId, chamber, committee_name AS committeeName, hearing_date AS hearingDate,
              witness_name AS witnessName, affiliation, is_citizen_self AS isCitizenSelf, position, testified, source
       FROM witness_registrations
       WHERE bill_id = ?
       ORDER BY testified DESC, position ASC, witness_name ASC`
    )
    .all(row.id) as Array<{
    id: string;
    billId: string;
    chamber: Chamber;
    committeeName: string;
    hearingDate: string;
    witnessName: string;
    affiliation: string;
    isCitizenSelf: number;
    position: 'For' | 'Against' | 'On';
    testified: number;
    source: string;
  }>;

  const constituentLogs = db
    .prepare(
      `SELECT c.id, c.bill_id AS billId, c.politician_id AS politicianId, p.name AS politicianName,
              c.committee_name AS committeeName, c.channel, c.stance, c.volume_count AS volumeCount,
              c.summary, c.topic_keywords AS topicKeywords, c.logged_date AS loggedDate
       FROM constituent_communications c
       LEFT JOIN politicians p ON p.id = c.politician_id
       WHERE c.bill_id = ?
       ORDER BY c.logged_date DESC`
    )
    .all(row.id) as Array<{ stance: string; volumeCount: number } & Record<string, unknown>>;

  const publicSentiment = {
    forCount: witnessesRaw.filter((w) => w.position === 'For').length,
    againstCount: witnessesRaw.filter((w) => w.position === 'Against').length,
    onCount: witnessesRaw.filter((w) => w.position === 'On').length,
    citizenSelfCount: witnessesRaw.filter((w) => w.isCitizenSelf === 1).length,
    orgCount: witnessesRaw.filter((w) => w.isCitizenSelf === 0).length,
    constituentSupportVolume: constituentLogs
      .filter((c) => c.stance === 'Support')
      .reduce((s, c) => s + c.volumeCount, 0),
    constituentOpposeVolume: constituentLogs
      .filter((c) => c.stance === 'Oppose')
      .reduce((s, c) => s + c.volumeCount, 0),
    constituentAmendVolume: constituentLogs
      .filter((c) => c.stance === 'Amend / Concern')
      .reduce((s, c) => s + c.volumeCount, 0),
  };

  const documents = db
    .prepare(
      `SELECT id, bill_id AS billId, doc_type AS docType, version_code AS versionCode,
              version_label AS versionLabel, title, summary, full_text AS fullText, source
       FROM bill_documents
       WHERE bill_id = ?
       ORDER BY CASE doc_type WHEN 'analysis' THEN 1 ELSE 2 END, version_code ASC`
    )
    .all(row.id) as BillDocument[];

  const savedBrief = db
    .prepare(`SELECT brief, model, updated_at AS updatedAt FROM bill_ai_briefs WHERE bill_id = ?`)
    .get(row.id) as { brief: string; model: string; updatedAt: string } | undefined;

  const relatedRules = db
    .prepare(
      `SELECT r.id AS ruleId, r.issue_date AS issueDate, r.action_type AS actionType,
              r.agency_name AS agencyName, r.tac_citation AS tacCitation, r.title,
              r.fiscal_impact_amount AS fiscalImpactAmount,
              l.link_basis AS linkBasis, l.matched_ref AS matchedRef, l.confidence
       FROM rule_bill_links l
       JOIN agency_rules r ON r.id = l.rule_id
       WHERE l.bill_id = ?
       ORDER BY l.confidence DESC, r.issue_date DESC`
    )
    .all(row.id) as BillRelatedRule[];

  res.json({
    ...bill,
    fullText: row.full_text,
    amendments,
    actions,
    links,
    keywordOverlaps,
    witnesses: witnessesRaw.map((w) => ({
      ...w,
      isCitizenSelf: Boolean(w.isCitizenSelf),
      testified: Boolean(w.testified),
    })),
    constituentLogs,
    publicSentiment,
    documents,
    relatedRules,
    aiBrief: savedBrief?.brief || '',
    aiBriefModel: savedBrief?.model || '',
    aiBriefUpdatedAt: savedBrief?.updatedAt || '',
  });
});

// 4. Ingest / Add Bill Record into SQLite FTS5
apiRouter.post('/bills', (req, res) => {
  const {
    session = '90R',
    billNumber,
    chamber = 'House',
    title,
    summary,
    primaryAuthor = 'Unassigned',
    committee = 'State Affairs',
    stage = 'Filed',
    subjects = [],
    statuteCodes = [],
    fullText = '',
  } = req.body ?? {};

  if (!billNumber || !title) {
    return res.status(400).json({ error: 'billNumber and title are required' });
  }

  const cleanNum = String(billNumber).trim().toUpperCase();
  const billId = `${session}-${cleanNum.replace(/\s+/g, '')}`;
  const today = new Date().toISOString().slice(0, 10);

  db.prepare(
    `INSERT OR IGNORE INTO sessions (code, label, years, synced_at, bill_count) VALUES (?, ?, ?, ?, 0)`
  ).run(session, `${session} Legislative Session`, '2025–2027', new Date().toISOString());

  db.prepare(
    `INSERT OR REPLACE INTO bills (
      id, session, bill_number, chamber, title, summary, statute_codes, status, stage,
      primary_author, coauthors_json, sponsors_json, cosponsors_json, committees_json,
      subjects_json, last_action, last_action_date, filed_date, bipartisan_index, source, full_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?, ?, ?, ?, 0.5, 'Manual Keyword Index Entry', ?)`
  ).run(
    billId,
    session,
    cleanNum,
    chamber,
    title,
    summary || title,
    JSON.stringify(Array.isArray(statuteCodes) ? statuteCodes : []),
    `${stage} — Entered ${today}`,
    stage,
    primaryAuthor,
    JSON.stringify(committee ? [{ name: committee, chamber, status: 'Pending', ayeVotes: 0, nayVotes: 0 }] : []),
    JSON.stringify(Array.isArray(subjects) ? subjects : []),
    `${today} Filed / Indexed`,
    today,
    today,
    fullText || summary || title
  );

  db.prepare(
    `INSERT OR REPLACE INTO bill_actions (id, bill_id, action_date, action_number, description)
     VALUES (?, ?, ?, 'H001', 'Filed and indexed in Capitol Ledger FTS5')`
  ).run(`${billId}-act-1`, billId, today);

  db.prepare(
    `INSERT OR IGNORE INTO amendments (
      id, bill_id, version_code, version_label, amendment_number, sponsor, filed_date,
      disposition, yea_votes, nay_votes, pnv_votes, summary, full_text, sort_order
    ) VALUES (?, ?, 'I', 'Introduced (As Filed)', 'Filed Version', ?, ?, 'Filed', 0, 0, 0, ?, ?, 1)`
  ).run(`${billId}-v1`, billId, primaryAuthor, today, summary || title, fullText || summary || title);

  syncBillFts(billId);
  syncAmendmentFts(`${billId}-v1`);
  recomputeBillMetrics(billId);
  refreshSessionCounts();
  const alertsTriggered = evaluateAlertRules(billId);

  const created = db.prepare(`SELECT * FROM bills WHERE id = ?`).get(billId) as RawBillRow;
  res.status(201).json({ bill: mapBillRow(created), alertsTriggered });
});

// 5. Amendment Archive & Redline Diff
apiRouter.get('/bills/:id/diff', (req, res) => {
  const fromId = String(req.query.from ?? '');
  const toId = String(req.query.to ?? '');
  const versions = db
    .prepare(
      `SELECT id, version_label AS label, amendment_number AS amendmentNumber, filed_date AS filedDate, full_text AS fullText
       FROM amendments WHERE bill_id = ? ORDER BY sort_order ASC, filed_date ASC`
    )
    .all(req.params.id) as Array<{
    id: string;
    label: string;
    amendmentNumber: string;
    filedDate: string;
    fullText: string;
  }>;

  if (versions.length === 0) {
    return res.status(404).json({ error: 'No historical versions found for this bill' });
  }

  const fromVer = versions.find((v) => v.id === fromId) ?? versions[0];
  const toVer = versions.find((v) => v.id === toId) ?? versions[versions.length - 1];
  const diff = computeLineDiff(fromVer.fullText, toVer.fullText);

  res.json({
    fromVersion: {
      id: fromVer.id,
      label: fromVer.label,
      amendmentNumber: fromVer.amendmentNumber,
      filedDate: fromVer.filedDate,
    },
    toVersion: {
      id: toVer.id,
      label: toVer.label,
      amendmentNumber: toVer.amendmentNumber,
      filedDate: toVer.filedDate,
    },
    ...diff,
  });
});

apiRouter.post('/bills/:id/amendments', (req, res) => {
  const bill = db.prepare(`SELECT id FROM bills WHERE id = ?`).get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  const {
    versionCode = 'FA',
    versionLabel,
    amendmentNumber,
    sponsor = 'Floor Sponsor',
    disposition = 'Adopted',
    yeaVotes = 0,
    nayVotes = 0,
    summary,
    fullText,
  } = req.body ?? {};

  if (!versionLabel || !fullText) {
    return res.status(400).json({ error: 'versionLabel and fullText are required' });
  }

  const maxSort = (
    db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM amendments WHERE bill_id = ?`).get(req.params.id) as {
      m: number;
    }
  ).m;
  const id = `${req.params.id}-am-${Date.now()}`;
  const filedDate = new Date().toISOString().slice(0, 10);

  db.prepare(
    `INSERT INTO amendments (
      id, bill_id, version_code, version_label, amendment_number, sponsor, filed_date,
      disposition, yea_votes, nay_votes, pnv_votes, summary, full_text, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    id,
    req.params.id,
    versionCode,
    versionLabel,
    amendmentNumber || `Amend. #${maxSort + 1}`,
    sponsor,
    filedDate,
    disposition,
    Number(yeaVotes) || 0,
    Number(nayVotes) || 0,
    summary || versionLabel,
    fullText,
    maxSort + 1
  );

  syncAmendmentFts(id);
  recomputeBillMetrics(req.params.id);
  const alertsTriggered = evaluateAlertRules(req.params.id);

  res.status(201).json({ id, alertsTriggered });
});

apiRouter.get('/amendments', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const disposition = String(req.query.disposition ?? '').trim();
  const session = String(req.query.session ?? '').trim();

  const where: string[] = [];
  const params: Array<string> = [];
  if (disposition) {
    where.push('a.disposition = ?');
    params.push(disposition);
  }
  if (session) {
    where.push('b.session = ?');
    params.push(session);
  }

  if (q) {
    const safeFts = buildSafeFtsQuery(q);
    if (safeFts) {
      try {
        const rows = db
          .prepare(
            `SELECT a.id, a.bill_id AS billId, b.bill_number AS billNumber, b.session, b.title AS billTitle,
                    a.version_code AS versionCode, a.version_label AS versionLabel,
                    a.amendment_number AS amendmentNumber, a.sponsor, a.filed_date AS filedDate,
                    a.disposition, a.yea_votes AS yeaVotes, a.nay_votes AS nayVotes, a.pnv_votes AS pnvVotes,
                    a.summary, a.full_text AS fullText, a.sort_order AS sortOrder,
                    snippet(amendments_fts, -1, '<mark class="fts-hit">', '</mark>', ' … ', 18) AS snippet
             FROM amendments_fts
             JOIN amendments a ON a.id = amendments_fts.amendment_id
             JOIN bills b ON b.id = a.bill_id
             WHERE amendments_fts MATCH ?
             ${where.length ? 'AND ' + where.join(' AND ') : ''}
             ORDER BY a.filed_date DESC
             LIMIT 80`
          )
          .all(safeFts, ...params);
        return res.json({ amendments: rows });
      } catch {
        // Fallback below
      }
    }
    where.push('(a.summary LIKE ? OR a.full_text LIKE ? OR a.sponsor LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = db
    .prepare(
      `SELECT a.id, a.bill_id AS billId, b.bill_number AS billNumber, b.session, b.title AS billTitle,
              a.version_code AS versionCode, a.version_label AS versionLabel,
              a.amendment_number AS amendmentNumber, a.sponsor, a.filed_date AS filedDate,
              a.disposition, a.yea_votes AS yeaVotes, a.nay_votes AS nayVotes, a.pnv_votes AS pnvVotes,
              a.summary, a.full_text AS fullText, a.sort_order AS sortOrder
       FROM amendments a
       JOIN bills b ON b.id = a.bill_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.filed_date DESC, a.sort_order DESC
       LIMIT 80`
    )
    .all(...params);
  res.json({ amendments: rows });
});

// 6. Cross-Bill Relationship Links
apiRouter.post('/links', (req, res) => {
  const { sourceBillId, targetBillId, linkType = 'Related Policy', notes = '' } = req.body ?? {};
  if (!sourceBillId || !targetBillId || sourceBillId === targetBillId) {
    return res.status(400).json({ error: 'Valid distinct sourceBillId and targetBillId are required' });
  }
  const id = `lnk-${Date.now()}`;
  db.prepare(
    `INSERT INTO bill_links (id, source_bill_id, target_bill_id, link_type, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, sourceBillId, targetBillId, linkType, notes, new Date().toISOString());

  recomputeBillMetrics(sourceBillId);
  recomputeBillMetrics(targetBillId);
  res.status(201).json({ id });
});

apiRouter.delete('/links/:id', (req, res) => {
  const existing = db
    .prepare(`SELECT source_bill_id, target_bill_id FROM bill_links WHERE id = ?`)
    .get(req.params.id) as { source_bill_id: string; target_bill_id: string } | undefined;
  db.prepare(`DELETE FROM bill_links WHERE id = ?`).run(req.params.id);
  if (existing) {
    recomputeBillMetrics(existing.source_bill_id);
    recomputeBillMetrics(existing.target_bill_id);
  }
  res.json({ ok: true });
});

// 7. Politician Profiles (Votes, Sponsorships, Committees, Donors)
apiRouter.get('/politicians', (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const chamber = String(req.query.chamber ?? '').trim();
  const party = String(req.query.party ?? '').trim();

  const where: string[] = [];
  const params: string[] = [];
  if (chamber) {
    where.push('p.chamber = ?');
    params.push(chamber);
  }
  if (party) {
    where.push('p.party = ?');
    params.push(party);
  }
  if (q) {
    where.push(
      '(LOWER(p.name) LIKE ? OR LOWER(p.short_name) LIKE ? OR LOWER(p.district) LIKE ? OR LOWER(p.leadership_role) LIKE ?)'
    );
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.short_name AS shortName, p.chamber, p.district, p.party,
              p.tenure_years AS tenureYears, p.leadership_role AS leadershipRole, p.bio,
              p.total_raised AS totalRaised, p.bills_authored AS billsAuthored, p.bills_passed AS billsPassed,
              (SELECT COUNT(*) FROM committee_memberships cm WHERE cm.politician_id = p.id) AS committeesCount,
              (SELECT COUNT(*) FROM votes v WHERE v.politician_id = p.id) AS votesCount
       FROM politicians p
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.total_raised DESC, p.bills_authored DESC, p.name ASC`
    )
    .all(...params);
  res.json({ politicians: rows });
});

apiRouter.post('/politicians/sync-tlo', async (req, res) => {
  try {
    const body = req.body as {
      session?: string;
      fetchProfiles?: boolean;
      concurrency?: number;
    };
    const session = (body.session || '89R').trim();
    const fetchProfiles = body.fetchProfiles !== false;
    const concurrency = Math.min(Math.max(Number(body.concurrency) || 4, 1), 6);

    const result = await syncLegislatorsFromTloFtp(session, { fetchProfiles, concurrency });
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Failed to sync legislator roster from TLO FTP',
    });
  }
});

apiRouter.get('/politicians/:id', (req, res) => {
  const pol = db
    .prepare(
      `SELECT id, name, short_name AS shortName, chamber, district, party,
              tenure_years AS tenureYears, leadership_role AS leadershipRole, bio,
              total_raised AS totalRaised, bills_authored AS billsAuthored, bills_passed AS billsPassed,
              (SELECT COUNT(*) FROM committee_memberships cm WHERE cm.politician_id = politicians.id) AS committeesCount,
              (SELECT COUNT(*) FROM votes v WHERE v.politician_id = politicians.id) AS votesCount
       FROM politicians WHERE id = ?`
    )
    .get(req.params.id) as { id: string; shortName: string } | undefined;

  if (!pol) return res.status(404).json({ error: 'Politician not found' });

  const committeesRaw = db
    .prepare(
      `SELECT c.id AS committeeId, c.name, c.chamber, cm.role, cm.session, c.jurisdiction
       FROM committee_memberships cm
       JOIN committees c ON c.id = cm.committee_id
       WHERE cm.politician_id = ?
       ORDER BY CASE cm.role WHEN 'Chair' THEN 1 WHEN 'Vice-Chair' THEN 2 ELSE 3 END`
    )
    .all(pol.id) as Array<{
    committeeId: string;
    name: string;
    chamber: Chamber;
    role: 'Chair' | 'Vice-Chair' | 'Member';
    session: string;
    jurisdiction: string;
  }>;

  const committees = committeesRaw.map((c) => {
    const referredCount = (
      db
        .prepare(`SELECT COUNT(*) AS cnt FROM bills WHERE committees_json LIKE ?`)
        .get(`%"name":"${c.name}"%`) as { cnt: number }
    ).cnt;
    return { ...c, referredBillsCount: referredCount };
  });

  const allBills = db
    .prepare(
      `SELECT id, bill_number, session, title, stage, status, last_action, committees_json, primary_author, coauthors_json, sponsors_json, cosponsors_json, influence_score
       FROM bills ORDER BY influence_score DESC`
    )
    .all() as Array<{
    id: string;
    bill_number: string;
    session: string;
    title: string;
    stage: string;
    status: string;
    last_action: string;
    committees_json: string;
    primary_author: string;
    coauthors_json: string;
    sponsors_json: string;
    cosponsors_json: string;
    influence_score: number;
  }>;

  const sponsorships: Array<{
    billId: string;
    billNumber: string;
    session: string;
    title: string;
    stage: string;
    outcome: BillOutcome;
    outcomeDetail: string;
    role: string;
    influenceScore: number;
  }> = [];

  for (const b of allBills) {
    let role = '';
    if (b.primary_author === pol.shortName) role = 'Primary Author';
    else if ((JSON.parse(b.sponsors_json) as string[]).includes(pol.shortName)) role = 'Sponsor';
    else if ((JSON.parse(b.coauthors_json) as string[]).includes(pol.shortName)) role = 'Co-Author';
    else if ((JSON.parse(b.cosponsors_json) as string[]).includes(pol.shortName)) role = 'Co-Sponsor';
    if (role) {
      let commCount = 0;
      try {
        commCount = (JSON.parse(b.committees_json || '[]') as unknown[]).length;
      } catch {
        commCount = 0;
      }
      const { outcome, outcomeDetail } = computeBillOutcome(
        b.session,
        b.stage,
        b.status || '',
        b.last_action || '',
        commCount
      );
      sponsorships.push({
        billId: b.id,
        billNumber: b.bill_number,
        session: b.session,
        title: b.title,
        stage: b.stage,
        outcome,
        outcomeDetail,
        role,
        influenceScore: b.influence_score,
      });
    }
  }

  const votes = db
    .prepare(
      `SELECT v.id, v.bill_id AS billId, b.bill_number AS billNumber, b.session, b.title AS billTitle,
              v.amendment_id AS amendmentId, v.motion, v.vote_cast AS voteCast, v.vote_date AS voteDate,
              v.party_line AS partyLine
       FROM votes v
       JOIN bills b ON b.id = v.bill_id
       WHERE v.politician_id = ?
       ORDER BY v.vote_date DESC`
    )
    .all(pol.id) as Array<{ partyLine: number } & Record<string, unknown>>;

  const contributions = db
    .prepare(
      `SELECT c.id, c.donor_id AS donorId, d.name AS donorName, d.sector, d.pac_id AS pacId, d.city,
              c.cycle, c.amount, c.filing_date AS filingDate
       FROM contributions c
       JOIN donors d ON d.id = c.donor_id
       WHERE c.politician_id = ?
       ORDER BY c.amount DESC`
    )
    .all(pol.id) as Array<{ sector: string; amount: number } & Record<string, unknown>>;

  const sectorMap = new Map<string, { sector: string; total: number; count: number }>();
  for (const c of contributions) {
    const cur = sectorMap.get(c.sector) ?? { sector: c.sector, total: 0, count: 0 };
    cur.total += c.amount;
    cur.count += 1;
    sectorMap.set(c.sector, cur);
  }
  const sectorTotals = Array.from(sectorMap.values()).sort((a, b) => b.total - a.total);

  const constituentLogs = db
    .prepare(
      `SELECT c.id, c.bill_id AS billId, b.bill_number AS billNumber, b.session,
              c.politician_id AS politicianId, c.committee_name AS committeeName,
              c.channel, c.stance, c.volume_count AS volumeCount,
              c.summary, c.topic_keywords AS topicKeywords, c.logged_date AS loggedDate
       FROM constituent_communications c
       JOIN bills b ON b.id = c.bill_id
       WHERE c.politician_id = ?
       ORDER BY c.logged_date DESC`
    )
    .all(pol.id);

  res.json({
    ...pol,
    committees,
    sponsorships,
    votes: votes.map((v) => ({ ...v, partyLine: Boolean(v.partyLine) })),
    contributions,
    sectorTotals,
    constituentLogs,
  });
});

// 8. Automated Keyword Alerts
apiRouter.get('/alerts', (_req, res) => {
  const rules = db
    .prepare(
      `SELECT r.id, r.name, r.query, r.session, r.chamber, r.committee, r.politician,
              r.is_active AS isActive, r.created_at AS createdAt,
              (SELECT COUNT(*) FROM alert_events e WHERE e.rule_id = r.id) AS matchCount
       FROM alert_rules r
       ORDER BY r.created_at DESC`
    )
    .all() as Array<{ isActive: number } & Record<string, unknown>>;

  const events = db
    .prepare(
      `SELECT e.id, e.rule_id AS ruleId, r.name AS ruleName, e.bill_id AS billId,
              b.bill_number AS billNumber, b.session, b.title AS billTitle,
              e.amendment_id AS amendmentId, e.match_type AS matchType,
              e.snippet, e.triggered_at AS triggeredAt, e.is_read AS isRead
       FROM alert_events e
       JOIN alert_rules r ON r.id = e.rule_id
       JOIN bills b ON b.id = e.bill_id
       ORDER BY e.is_read ASC, e.triggered_at DESC
       LIMIT 100`
    )
    .all() as Array<{ isRead: number } & Record<string, unknown>>;

  res.json({
    rules: rules.map((r) => ({ ...r, isActive: Boolean(r.isActive) })),
    events: events.map((e) => ({ ...e, isRead: Boolean(e.isRead) })),
  });
});

apiRouter.post('/alerts/rules', (req, res) => {
  const { name, query, session = '', chamber = '', committee = '', politician = '' } = req.body ?? {};
  if (!name || !query) {
    return res.status(400).json({ error: 'name and query are required' });
  }
  const id = `rule-${Date.now()}`;
  db.prepare(
    `INSERT INTO alert_rules (id, name, query, session, chamber, committee, politician, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, name, query, session, chamber, committee, politician, new Date().toISOString());

  const alertsTriggered = evaluateAlertRules();
  res.status(201).json({ id, alertsTriggered });
});

apiRouter.patch('/alerts/rules/:id', (req, res) => {
  const { isActive } = req.body ?? {};
  db.prepare(`UPDATE alert_rules SET is_active = ? WHERE id = ?`).run(isActive ? 1 : 0, req.params.id);
  const alertsTriggered = isActive ? evaluateAlertRules() : 0;
  res.json({ ok: true, alertsTriggered });
});

apiRouter.delete('/alerts/rules/:id', (req, res) => {
  db.prepare(`DELETE FROM alert_rules WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

apiRouter.post('/alerts/scan', (_req, res) => {
  const triggered = evaluateAlertRules();
  res.json({ triggered });
});

apiRouter.patch('/alerts/events/:id/read', (req, res) => {
  const { isRead = true } = req.body ?? {};
  db.prepare(`UPDATE alert_events SET is_read = ? WHERE id = ?`).run(isRead ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// 9. 4-Layer Influence & Keyword Network Graph
apiRouter.get('/network', (req, res) => {
  const sessionFilter = String(req.query.session ?? '').trim();
  const minContribution = Number(req.query.minContribution ?? 0);
  const minKeywordOverlap = Number(req.query.minOverlap ?? 3);

  const nodeMap = new Map<string, NetworkNode>();
  const edges: NetworkEdge[] = [];

  // Politician nodes
  const pols = db
    .prepare(`SELECT id, name, short_name, chamber, district, party, total_raised FROM politicians`)
    .all() as Array<{
    id: string;
    name: string;
    short_name: string;
    chamber: Chamber;
    district: string;
    party: 'R' | 'D';
    total_raised: number;
  }>;

  const polByShort = new Map<string, string>();
  for (const p of pols) {
    polByShort.set(p.short_name, p.id);
    nodeMap.set(p.id, {
      id: p.id,
      kind: 'politician',
      label: p.name,
      subtitle: `${p.party} · ${p.district}`,
      party: p.party,
      chamber: p.chamber,
      weight: Math.max(12, Math.round(p.total_raised / 150000)),
      entityId: p.id,
    });
  }

  // Layer 1: Donor & PAC Money Flows
  const contribs = db
    .prepare(
      `SELECT c.id, c.donor_id, c.politician_id, c.amount, d.name AS donor_name, d.sector, d.pac_id
       FROM contributions c
       JOIN donors d ON d.id = c.donor_id
       WHERE c.amount >= ?`
    )
    .all(minContribution) as Array<{
    id: string;
    donor_id: string;
    politician_id: string;
    amount: number;
    donor_name: string;
    sector: string;
    pac_id: string;
  }>;

  let moneyEdges = 0;
  for (const ctr of contribs) {
    if (!nodeMap.has(ctr.donor_id)) {
      nodeMap.set(ctr.donor_id, {
        id: ctr.donor_id,
        kind: 'donor',
        label: ctr.donor_name.replace(/\s+PAC.*$/i, ''),
        subtitle: `${ctr.sector} · ${ctr.pac_id}`,
        sector: ctr.sector,
        weight: 14,
        entityId: ctr.donor_id,
      });
    }
    edges.push({
      id: `edge-${ctr.id}`,
      source: ctr.donor_id,
      target: ctr.politician_id,
      layer: 'money',
      label: `$${(ctr.amount / 1000).toFixed(0)}k`,
      weight: Math.max(1, Math.min(6, ctr.amount / 45000)),
      meta: `${ctr.sector} contribution: $${ctr.amount.toLocaleString()}`,
    });
    moneyEdges++;
  }

  // Layer 2 & 3 & 4: Bills, Sponsorships/Lineage, Committees, and Keyword Overlap
  const bills = db
    .prepare(
      `SELECT id, session, bill_number, chamber, title, stage, primary_author, coauthors_json, sponsors_json,
              committees_json, subjects_json, statute_codes, summary, influence_score
       FROM bills
       ${sessionFilter ? 'WHERE session = ?' : ''}
       ORDER BY influence_score DESC
       LIMIT 28`
    )
    .all(...(sessionFilter ? [sessionFilter] : [])) as Array<{
    id: string;
    session: string;
    bill_number: string;
    chamber: Chamber;
    title: string;
    stage: string;
    primary_author: string;
    coauthors_json: string;
    sponsors_json: string;
    committees_json: string;
    subjects_json: string;
    statute_codes: string;
    summary: string;
    influence_score: number;
  }>;

  const billIds = new Set(bills.map((b) => b.id));

  for (const b of bills) {
    nodeMap.set(b.id, {
      id: b.id,
      kind: 'bill',
      label: `${b.session} ${b.bill_number}`,
      subtitle: `${b.stage} · ${b.title.slice(0, 64)}`,
      chamber: b.chamber,
      session: b.session,
      weight: Math.max(10, Math.round(b.influence_score / 4)),
      entityId: b.id,
    });
  }

  let lineageEdges = 0;
  for (const b of bills) {
    const authorId = polByShort.get(b.primary_author);
    if (authorId) {
      edges.push({
        id: `edge-auth-${b.id}-${authorId}`,
        source: authorId,
        target: b.id,
        layer: 'lineage',
        label: 'Author',
        weight: 3,
        meta: `Primary author of ${b.session} ${b.bill_number}`,
      });
      lineageEdges++;
    }
    const sponsors = JSON.parse(b.sponsors_json || '[]') as string[];
    for (const sp of sponsors) {
      const spId = polByShort.get(sp);
      if (spId) {
        edges.push({
          id: `edge-spon-${b.id}-${spId}`,
          source: spId,
          target: b.id,
          layer: 'lineage',
          label: 'Sponsor',
          weight: 2.4,
        });
        lineageEdges++;
      }
    }
    const coauthors = (JSON.parse(b.coauthors_json || '[]') as string[]).slice(0, 5);
    for (const ca of coauthors) {
      const caId = polByShort.get(ca);
      if (caId) {
        edges.push({
          id: `edge-co-${b.id}-${caId}`,
          source: caId,
          target: b.id,
          layer: 'lineage',
          label: 'Co-Author',
          weight: 1.4,
        });
        lineageEdges++;
      }
    }
  }

  // Cross-bill explicit links (part of lineage layer)
  const billLinks = db.prepare(`SELECT id, source_bill_id, target_bill_id, link_type FROM bill_links`).all() as Array<{
    id: string;
    source_bill_id: string;
    target_bill_id: string;
    link_type: string;
  }>;
  for (const l of billLinks) {
    if (billIds.has(l.source_bill_id) && billIds.has(l.target_bill_id)) {
      edges.push({
        id: `edge-${l.id}`,
        source: l.source_bill_id,
        target: l.target_bill_id,
        layer: 'lineage',
        label: l.link_type,
        weight: 2.8,
        meta: `Linked bill relationship: ${l.link_type}`,
      });
      lineageEdges++;
    }
  }

  // Layer 3: Committee Membership & Chair Clusters
  let committeeEdges = 0;
  const comRows = db
    .prepare(`SELECT id, name, chamber, jurisdiction FROM committees`)
    .all() as Array<{ id: string; name: string; chamber: Chamber; jurisdiction: string }>;

  const comByName = new Map<string, string>();
  for (const c of comRows) {
    comByName.set(`${c.chamber}-${c.name}`, c.id);
    nodeMap.set(c.id, {
      id: c.id,
      kind: 'committee',
      label: `${c.chamber} ${c.name}`,
      subtitle: c.jurisdiction.slice(0, 64),
      chamber: c.chamber,
      weight: 15,
      entityId: c.id,
    });
  }

  const memberships = db
    .prepare(`SELECT id, committee_id, politician_id, role FROM committee_memberships`)
    .all() as Array<{ id: string; committee_id: string; politician_id: string; role: string }>;

  for (const m of memberships) {
    if (nodeMap.has(m.committee_id) && nodeMap.has(m.politician_id)) {
      edges.push({
        id: `edge-${m.id}`,
        source: m.politician_id,
        target: m.committee_id,
        layer: 'committee',
        label: m.role,
        weight: m.role === 'Chair' ? 3.5 : m.role === 'Vice-Chair' ? 2.5 : 1.3,
        meta: `${m.role} assignment`,
      });
      committeeEdges++;
    }
  }

  for (const b of bills) {
    const comms = JSON.parse(b.committees_json || '[]') as Array<{ name: string; chamber: Chamber; status: string }>;
    for (const c of comms) {
      const cid = comByName.get(`${c.chamber}-${c.name}`);
      if (cid) {
        edges.push({
          id: `edge-ref-${b.id}-${cid}`,
          source: cid,
          target: b.id,
          layer: 'committee',
          label: 'Referred',
          weight: 2,
          meta: `${c.status}`,
        });
        committeeEdges++;
      }
    }
  }

  // Layer 4: Cross-Bill Keyword Overlap Clusters
  let keywordEdges = 0;
  const tokenCache = bills.map((b) => ({ id: b.id, tokens: new Set(extractBillTokens(b)) }));
  for (let i = 0; i < tokenCache.length; i++) {
    for (let j = i + 1; j < tokenCache.length; j++) {
      const a = tokenCache[i];
      const b = tokenCache[j];
      const shared: string[] = [];
      for (const tok of a.tokens) {
        if (b.tokens.has(tok)) shared.push(tok);
      }
      if (shared.length >= minKeywordOverlap) {
        edges.push({
          id: `edge-kw-${a.id}-${b.id}`,
          source: a.id,
          target: b.id,
          layer: 'keyword',
          label: `${shared.length} shared terms`,
          weight: Math.min(4.5, 1 + shared.length * 0.4),
          meta: `Shared indexed keywords: ${shared.slice(0, 6).join(', ')}`,
        });
        keywordEdges++;
      }
    }
  }

  // Layer 5: Public Testimony & Constituent Sentiment Blocs
  let publicEdges = 0;
  const witSummaryRows = db
    .prepare(
      `SELECT bill_id, position, SUM(is_citizen_self) AS citizen_cnt, COUNT(*) AS total_cnt
       FROM witness_registrations
       GROUP BY bill_id, position`
    )
    .all() as Array<{
    bill_id: string;
    position: 'For' | 'Against' | 'On';
    citizen_cnt: number;
    total_cnt: number;
  }>;

  for (const ws of witSummaryRows) {
    if (!billIds.has(ws.bill_id)) continue;
    const blocId = `pub-${ws.bill_id}-${ws.position}`;
    nodeMap.set(blocId, {
      id: blocId,
      kind: 'public_bloc',
      label: `Witnesses ${ws.position} (${ws.total_cnt})`,
      subtitle: `${ws.citizen_cnt} private citizens · ${ws.total_cnt - ws.citizen_cnt} orgs`,
      weight: Math.min(18, 9 + ws.total_cnt),
      entityId: ws.bill_id,
    });
    edges.push({
      id: `edge-pub-${ws.bill_id}-${ws.position}`,
      source: blocId,
      target: ws.bill_id,
      layer: 'public',
      label: `${ws.position} (${ws.total_cnt})`,
      weight: Math.min(4.5, 1.2 + ws.total_cnt * 0.4),
      meta: `TLO Witness List: ${ws.total_cnt} ${ws.position} (${ws.citizen_cnt} Self)`,
    });
    publicEdges++;
  }

  const commRows = db
    .prepare(
      `SELECT id, bill_id, politician_id, channel, stance, volume_count
       FROM constituent_communications`
    )
    .all() as Array<{
    id: string;
    bill_id: string;
    politician_id: string | null;
    channel: string;
    stance: string;
    volume_count: number;
  }>;

  for (const cr of commRows) {
    if (!billIds.has(cr.bill_id)) continue;
    const blocId = `comm-node-${cr.id}`;
    nodeMap.set(blocId, {
      id: blocId,
      kind: 'public_bloc',
      label: `${cr.channel} (${cr.volume_count})`,
      subtitle: `Constituent stance: ${cr.stance}`,
      weight: Math.min(18, 9 + Math.round(cr.volume_count / 250)),
      entityId: cr.bill_id,
    });
    edges.push({
      id: `edge-comm-bill-${cr.id}`,
      source: blocId,
      target: cr.bill_id,
      layer: 'public',
      label: `${cr.stance} · ${cr.volume_count}`,
      weight: Math.min(4.5, 1.5 + cr.volume_count / 500),
      meta: `${cr.channel}: ${cr.volume_count} constituent contacts`,
    });
    publicEdges++;
    if (cr.politician_id && nodeMap.has(cr.politician_id)) {
      edges.push({
        id: `edge-comm-pol-${cr.id}`,
        source: blocId,
        target: cr.politician_id,
        layer: 'public',
        label: `${cr.volume_count} contacts`,
        weight: Math.min(4, 1.2 + cr.volume_count / 600),
        meta: `District outreach (${cr.stance})`,
      });
      publicEdges++;
    }
  }

  const graph: NetworkGraph = {
    nodes: Array.from(nodeMap.values()),
    edges,
    stats: {
      moneyEdges,
      lineageEdges,
      committeeEdges,
      keywordEdges,
      publicEdges,
    },
  };
  res.json(graph);
});

// 9b. Public Sentiment & Legislative Receptivity Engine
apiRouter.get('/receptivity', (_req, res) => {
  const witTotals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(is_citizen_self), 0) AS citizens
       FROM witness_registrations`
    )
    .get() as { total: number; citizens: number };

  const commTotal = (
    db
      .prepare(`SELECT COALESCE(SUM(volume_count), 0) AS v FROM constituent_communications`)
      .get() as { v: number }
  ).v;

  // 1. Committee Receptivity Rankings
  const committees = db
    .prepare(
      `SELECT c.id, c.name, c.chamber, p.name AS chairName
       FROM committees c
       LEFT JOIN politicians p ON p.id = c.chair_id`
    )
    .all() as Array<{ id: string; name: string; chamber: Chamber; chairName: string | null }>;

  const allBills = db
    .prepare(
      `SELECT id, stage, amendment_count, committees_json, title, summary, subjects_json, statute_codes
       FROM bills`
    )
    .all() as Array<{
    id: string;
    stage: string;
    amendment_count: number;
    committees_json: string;
    title: string;
    summary: string;
    subjects_json: string;
    statute_codes: string;
  }>;

  const committeeRows = committees.map((c) => {
    const referred = allBills.filter((b) =>
      b.committees_json.toLowerCase().includes(`"name":"${c.name.toLowerCase()}"`)
    );
    const revisedAfterHearing = referred.filter((b) => b.amendment_count >= 2).length;

    const witRows = db
      .prepare(
        `SELECT bill_id, is_citizen_self, position
         FROM witness_registrations
         WHERE LOWER(committee_name) = LOWER(?)`
      )
      .all(c.name) as Array<{ bill_id: string; is_citizen_self: number; position: string }>;

    const citizenSelfWitnesses = witRows.filter((w) => w.is_citizen_self === 1).length;
    const orgWitnesses = witRows.length - citizenSelfWitnesses;

    const opposedBillIds = new Set(
      witRows.filter((w) => w.position === 'Against').map((w) => w.bill_id)
    );
    const stalledWithOpposition = referred.filter(
      (b) => opposedBillIds.has(b.id) && (b.stage === 'Stalled' || b.amendment_count >= 2)
    ).length;

    const constituentVolume = (
      db
        .prepare(
          `SELECT COALESCE(SUM(volume_count), 0) AS v FROM constituent_communications WHERE LOWER(committee_name) = LOWER(?)`
        )
        .get(c.name) as { v: number }
    ).v;

    const revRatio = referred.length > 0 ? (revisedAfterHearing / referred.length) * 45 : 0;
    const citizenRatio =
      witRows.length > 0 ? (citizenSelfWitnesses / witRows.length) * 30 : 0;
    const outreachFactor = Math.min(25, Math.round(constituentVolume / 120));
    const receptivityScore = Number(Math.min(100, revRatio + citizenRatio + outreachFactor).toFixed(1));

    let postureLabel = 'Procedural Gatekeeper';
    if (receptivityScore >= 65) postureLabel = 'High Post-Hearing Revision';
    else if (receptivityScore >= 40) postureLabel = 'Moderately Responsive';

    return {
      committeeId: c.id,
      name: c.name,
      chamber: c.chamber,
      chairName: c.chairName || 'Chair Unassigned',
      referredBills: referred.length,
      revisedAfterHearing,
      stalledWithOpposition,
      citizenSelfWitnesses,
      orgWitnesses,
      constituentVolume,
      receptivityScore,
      postureLabel,
    };
  }).sort((a, b) => b.receptivityScore - a.receptivityScore);

  // 2. Representative Responsiveness Index
  const pols = db
    .prepare(
      `SELECT id, name, short_name, chamber, party, district, leadership_role, total_raised
       FROM politicians`
    )
    .all() as Array<{
    id: string;
    name: string;
    short_name: string;
    chamber: Chamber;
    party: 'R' | 'D';
    district: string;
    leadership_role: string;
    total_raised: number;
  }>;

  const repRows = pols.map((p) => {
    const votes = db
      .prepare(`SELECT party_line FROM votes WHERE politician_id = ?`)
      .all(p.id) as Array<{ party_line: number }>;
    const totalVotes = votes.length;
    const crossAisleVotes = votes.filter((v) => v.party_line === 0).length;
    const crossAislePct = totalVotes > 0 ? Math.round((crossAisleVotes / totalVotes) * 100) : 0;

    const authoredBills = allBills.filter((b) =>
      b.id ? db.prepare(`SELECT 1 FROM bills WHERE id = ? AND primary_author = ?`).get(b.id, p.short_name) : false
    );
    let citizenWitnessExposure = 0;
    for (const ab of authoredBills) {
      const cnt = (
        db
          .prepare(`SELECT COALESCE(SUM(is_citizen_self), 0) AS c FROM witness_registrations WHERE bill_id = ?`)
          .get(ab.id) as { c: number }
      ).c;
      citizenWitnessExposure += cnt;
    }

    const constituentContacts = (
      db
        .prepare(`SELECT COALESCE(SUM(volume_count), 0) AS v FROM constituent_communications WHERE politician_id = ?`)
        .get(p.id) as { v: number }
    ).v;

    const sectorRow = db
      .prepare(
        `SELECT d.sector, SUM(c.amount) AS total
         FROM contributions c
         JOIN donors d ON d.id = c.donor_id
         WHERE c.politician_id = ?
         GROUP BY d.sector
         ORDER BY total DESC
         LIMIT 1`
      )
      .get(p.id) as { sector: string; total: number } | undefined;

    const totalItemized = (
      db
        .prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM contributions WHERE politician_id = ?`)
        .get(p.id) as { t: number }
    ).t;

    const topDonorSector = sectorRow?.sector ?? 'Unitemized';
    const topSectorSharePct =
      totalItemized > 0 && sectorRow ? Math.round((sectorRow.total / totalItemized) * 100) : 0;

    const score = Number(
      Math.min(
        100,
        crossAislePct * 0.45 +
          Math.min(30, constituentContacts / 50) +
          Math.min(25, citizenWitnessExposure * 4) +
          (100 - topSectorSharePct) * 0.15
      ).toFixed(1)
    );

    let responsivenessSignal = 'Party-Aligned Posture';
    if (score >= 50) responsivenessSignal = 'High Constituent & Cross-Aisle Signal';
    else if (score >= 30) responsivenessSignal = 'Balanced Hearing Exposure';

    return {
      politicianId: p.id,
      name: p.name,
      chamber: p.chamber,
      party: p.party,
      district: p.district,
      leadershipRole: p.leadership_role,
      crossAisleVotes,
      totalVotes,
      crossAislePct,
      citizenWitnessExposure,
      constituentContacts,
      topDonorSector,
      topSectorSharePct,
      responsivenessScore: score,
      responsivenessSignal,
    };
  }).sort((a, b) => b.responsivenessScore - a.responsivenessScore);

  // 3. Policy-Domain Malleability
  const domains = [
    { domain: 'Public School Finance & Teachers', query: '"basic allotment" OR "Teacher Retention"' },
    { domain: 'School Vouchers & Accountability', query: '"Education Freedom Accounts" OR STAAR' },
    { domain: 'ERCOT Grid, Nuclear & AI Loads', query: 'ERCOT OR nuclear OR "data center"' },
    { domain: 'Property Tax & Homestead Relief', query: 'homestead OR appraisal OR compression' },
    { domain: 'Water Infrastructure & Rural EMS', query: 'water OR desalination OR ambulance' },
    { domain: 'Regulatory Efficiency', query: 'regulatory OR "Administrative Code"' },
  ];

  const policies = domains.map((d) => {
    const fts = buildSafeFtsQuery(d.query);
    let matchedBills: Array<{ id: string; amendment_count: number }> = [];
    try {
      matchedBills = db
        .prepare(
          `SELECT b.id, b.amendment_count
           FROM bills_fts
           JOIN bills b ON b.id = bills_fts.bill_id
           WHERE bills_fts MATCH ?`
        )
        .all(fts) as Array<{ id: string; amendment_count: number }>;
    } catch {
      matchedBills = [];
    }

    const billCount = matchedBills.length;
    const amendedCount = matchedBills.filter((b) => b.amendment_count >= 2).length;
    const amendedRatePct = billCount > 0 ? Math.round((amendedCount / billCount) * 100) : 0;

    let forWit = 0;
    let againstWit = 0;
    let totalWit = 0;
    let constituentVolume = 0;

    for (const mb of matchedBills) {
      const ws = db
        .prepare(`SELECT position FROM witness_registrations WHERE bill_id = ?`)
        .all(mb.id) as Array<{ position: string }>;
      forWit += ws.filter((w) => w.position === 'For').length;
      againstWit += ws.filter((w) => w.position === 'Against').length;
      totalWit += ws.length;

      const cv = (
        db
          .prepare(`SELECT COALESCE(SUM(volume_count), 0) AS v FROM constituent_communications WHERE bill_id = ?`)
          .get(mb.id) as { v: number }
      ).v;
      constituentVolume += cv;
    }

    const citizenForPct = totalWit > 0 ? Math.round((forWit / totalWit) * 100) : 0;
    const citizenAgainstPct = totalWit > 0 ? Math.round((againstWit / totalWit) * 100) : 0;

    let malleabilityLabel = 'Stable / Party Consensus';
    if (amendedRatePct >= 60 && againstWit > 0) malleabilityLabel = 'High Amendment Contestation';
    else if (amendedRatePct >= 50) malleabilityLabel = 'Iterative Committee Rewrites';

    return {
      domain: d.domain,
      query: d.query,
      billCount,
      amendedRatePct,
      citizenForPct,
      citizenAgainstPct,
      constituentVolume,
      malleabilityLabel,
    };
  });

  const recentCommunications = db
    .prepare(
      `SELECT c.id, c.bill_id AS billId, b.bill_number AS billNumber, b.session,
              c.politician_id AS politicianId, p.name AS politicianName,
              c.committee_name AS committeeName, c.channel, c.stance,
              c.volume_count AS volumeCount, c.summary, c.topic_keywords AS topicKeywords,
              c.logged_date AS loggedDate
       FROM constituent_communications c
       JOIN bills b ON b.id = c.bill_id
       LEFT JOIN politicians p ON p.id = c.politician_id
       ORDER BY c.logged_date DESC
       LIMIT 30`
    )
    .all();

  res.json({
    totals: {
      witnessRegistrations: witTotals.total,
      citizenSelfCount: witTotals.citizens,
      orgWitnessCount: witTotals.total - witTotals.citizens,
      constituentContacts: commTotal,
    },
    committees: committeeRows,
    representatives: repRows,
    policies,
    recentCommunications,
  });
});

apiRouter.post('/constituent-feedback', (req, res) => {
  const {
    billId,
    politicianId = null,
    committeeName = '',
    channel = 'District Call Log',
    stance = 'Amend / Concern',
    volumeCount = 1,
    summary,
    topicKeywords = '',
  } = req.body ?? {};

  if (!billId || !summary) {
    return res.status(400).json({ error: 'billId and summary are required' });
  }

  const id = `comm-${Date.now()}`;
  const loggedDate = new Date().toISOString().slice(0, 10);

  db.prepare(
    `INSERT INTO constituent_communications
     (id, bill_id, politician_id, committee_name, channel, stance, volume_count, summary, topic_keywords, logged_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    billId,
    politicianId || null,
    committeeName,
    channel,
    stance,
    Math.max(1, Number(volumeCount) || 1),
    summary,
    topicKeywords,
    loggedDate
  );

  res.status(201).json({ id });
});

// 10. TLO FTP Directory & Live Sync (ftp://ftp.legis.state.tx.us/)
apiRouter.get('/tlo/sessions', async (_req, res) => {
  try {
    const sessions = await listTloFtpSessions();
    res.json({ sessions, host: 'ftp://ftp.legis.state.tx.us' });
  } catch (err) {
    const localSessions = db
      .prepare(`SELECT code, label, years FROM sessions ORDER BY code DESC`)
      .all();
    res.status(200).json({
      sessions: localSessions,
      host: 'ftp://ftp.legis.state.tx.us (cached fallback)',
      warning: err instanceof Error ? err.message : 'Unable to reach TLO FTP server',
    });
  }
});

apiRouter.post('/tlo/sync', async (req, res) => {
  const {
    session,
    billTypes,
    limit,
    startNumber,
    includeBillText,
    includeWitnesses,
    includeDocuments,
    skipUnchanged,
    concurrency,
  } = req.body ?? {};
  if (!session) {
    return res.status(400).json({ error: 'session code (e.g., 90R, 89R, 88R) is required' });
  }
  try {
    const result = await syncFromTloFtp({
      session: String(session),
      billTypes: Array.isArray(billTypes) ? (billTypes as TloBillType[]) : undefined,
      limit: limit ? Number(limit) : 16,
      startNumber: startNumber ? Number(startNumber) : 1,
      includeBillText: includeBillText !== false,
      includeWitnesses: includeWitnesses !== undefined ? Boolean(includeWitnesses) : undefined,
      includeDocuments: includeDocuments !== undefined ? Boolean(includeDocuments) : undefined,
      skipUnchanged: Boolean(skipUnchanged),
      concurrency: concurrency ? Number(concurrency) : 4,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'TLO FTP synchronization failed',
    });
  }
});

apiRouter.post('/tlo/sync-session', (req, res) => {
  const {
    session,
    mode = 'full',
    billTypes,
    limit,
    startNumber,
    includeBillText,
    includeWitnesses,
    includeDocuments,
    skipUnchanged,
    concurrency,
  } = req.body ?? {};
  if (!session) {
    return res.status(400).json({ error: 'session code (e.g., 90R, 89R, 88R) is required' });
  }

  const job = startTloSyncJob({
    session: String(session),
    mode: mode === 'batch' ? 'batch' : 'full',
    billTypes: Array.isArray(billTypes) ? (billTypes as TloBillType[]) : undefined,
    limit: limit ? Number(limit) : undefined,
    startNumber: startNumber ? Number(startNumber) : 1,
    includeBillText: includeBillText !== false,
    includeWitnesses: includeWitnesses !== undefined ? Boolean(includeWitnesses) : undefined,
    includeDocuments: includeDocuments !== undefined ? Boolean(includeDocuments) : undefined,
    skipUnchanged: skipUnchanged !== false,
    concurrency: concurrency ? Number(concurrency) : 4,
  });

  res.status(202).json({ job });
});

apiRouter.get('/tlo/sync-status', (_req, res) => {
  res.json({ job: getLatestTloSyncJob() ?? null });
});

apiRouter.get('/tlo/sync-status/:jobId', (req, res) => {
  const job = getTloSyncJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Sync job not found' });
  }
  res.json({ job });
});

apiRouter.post('/tlo/sync-cancel/:jobId', (req, res) => {
  const job = cancelTloSyncJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Sync job not found' });
  }
  res.json({ job });
});

// 11. Optional Secondary AI Brief via Local OpenAI-Compatible LLM (Ollama / llama.cpp / vLLM)
apiRouter.post('/bills/:id/ai-brief', async (req, res) => {
  const rawBaseUrl = (process.env.LOCAL_LLM_URL || 'http://192.168.4.20:11434/v1/').trim();
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const model = (process.env.LOCAL_LLM_MODEL || 'qwen2.5:7b').trim();
  const apiKey = (process.env.LOCAL_LLM_API_KEY || '').trim();

  if (!baseUrl) {
    return res.status(400).json({
      error: 'LOCAL_LLM_URL is not configured. Set LOCAL_LLM_URL and LOCAL_LLM_MODEL in your environment.',
    });
  }

  const row = db.prepare(`SELECT * FROM bills WHERE id = ?`).get(req.params.id) as RawBillRow | undefined;
  if (!row) return res.status(404).json({ error: 'Bill not found' });

  const amendments = db
    .prepare(`SELECT version_label, disposition, summary FROM amendments WHERE bill_id = ? ORDER BY sort_order ASC`)
    .all(row.id) as Array<{ version_label: string; disposition: string; summary: string }>;

  try {
    const prompt = [
      `Summarize this Texas Legislature bill concisely in 3 bullet points (Policy Mechanism, Fiscal/Committee Posture, Amendment Evolution).`,
      `Bill: ${row.session} ${row.bill_number} — ${row.title}`,
      `Author: ${row.primary_author} | Stage: ${row.stage} | Status: ${row.status}`,
      `Summary: ${row.summary}`,
      `Excerpt: ${row.full_text.slice(0, 2800)}`,
      amendments.length
        ? `Amendments: ${amendments.map((a) => `${a.version_label} (${a.disposition}): ${a.summary}`).join(' | ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const endpoint = baseUrl.endsWith('/chat/completions')
      ? baseUrl
      : `${baseUrl}/chat/completions`;

    const llmRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You are a neutral Texas legislative clerk. Provide an objective, concise 3-bullet policy brief grounded strictly in the provided statutory text.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!llmRes.ok) {
      const errBody = await llmRes.text().catch(() => '');
      return res.status(502).json({
        error: `Local LLM (${model} at ${endpoint}) returned HTTP ${llmRes.status}${errBody ? `: ${errBody.slice(0, 240)}` : ''}`,
      });
    }

    const data = (await llmRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const brief = data.choices?.[0]?.message?.content?.trim() || '';
    if (!brief) {
      return res.status(502).json({
        error: `Local LLM (${model}) returned an empty brief.`,
      });
    }

    const updatedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO bill_ai_briefs (bill_id, brief, model, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bill_id) DO UPDATE SET
         brief = excluded.brief,
         model = excluded.model,
         updated_at = excluded.updated_at`
    ).run(row.id, brief, model, updatedAt);

    res.json({ brief, model, updatedAt });
  } catch (err) {
    res.status(502).json({
      error:
        err instanceof Error
          ? `Could not reach local LLM at ${baseUrl} (${model}): ${err.message}`
          : 'Local LLM brief generation failed',
    });
  }
});

// 12. Texas Legal Code & Historical Statutes (TLO /pub/statutes + StatutesByDate since 2004)
apiRouter.get('/statutes/codes', (_req, res) => {
  const codes = db
    .prepare(
      `SELECT c.code, c.zip_code AS zipCode, c.code_id AS codeId, c.name,
              c.chapter_count AS chapterCount,
              (SELECT COUNT(*) FROM statute_sections s WHERE s.code = c.code) AS sectionCount,
              c.synced_at AS syncedAt
       FROM statutes_codes c
       ORDER BY sectionCount DESC, c.name ASC`
    )
    .all();
  res.json({ codes });
});

apiRouter.post('/statutes/sync', async (req, res) => {
  const { code, chapterLimit } = req.body ?? {};
  if (!code) {
    return res.status(400).json({ error: 'Texas statute code (e.g., PE, ED, TX, CN) is required' });
  }
  try {
    const result = await syncTexasCodeFromTloFtp(
      String(code),
      chapterLimit ? Number(chapterLimit) : undefined
    );
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Texas statutes FTP sync failed',
    });
  }
});

apiRouter.get('/statutes', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const code = String(req.query.code ?? '').trim().toUpperCase();
  const session = String(req.query.session ?? '').trim().toLowerCase();
  const ftsQuery = buildSafeFtsQuery(q);

  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (code) {
    conditions.push('s.code = ?');
    params.push(code);
  }
  if (session) {
    conditions.push('LOWER(s.sessions_amended_json) LIKE ?');
    params.push(`%${session}%`);
  }

  let rows: Array<{
    id: string;
    code: string;
    codeName: string;
    chapter: string;
    chapterTitle: string;
    sectionNumber: string;
    sectionTitle: string;
    actsHistory: string;
    sessionsAmendedJson: string;
    lastAmendedSession: string;
    source: string;
    snippet?: string;
  }> = [];

  if (ftsQuery) {
    const whereClause = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
    try {
      rows = db
        .prepare(
          `SELECT s.id, s.code, s.code_name AS codeName, s.chapter, s.chapter_title AS chapterTitle,
                  s.section_number AS sectionNumber, s.section_title AS sectionTitle,
                  s.acts_history AS actsHistory, s.sessions_amended_json AS sessionsAmendedJson,
                  s.last_amended_session AS lastAmendedSession, s.source,
                  snippet(statutes_fts, -1, '<mark class="fts-hit">', '</mark>', ' … ', 18) AS snippet
           FROM statutes_fts
           JOIN statute_sections s ON s.rowid = statutes_fts.rowid
           WHERE statutes_fts MATCH ?
           ${whereClause}
           ORDER BY rank
           LIMIT 100`
        )
        .all(ftsQuery, ...params) as typeof rows;
    } catch {
      rows = [];
    }
  } else {
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    rows = db
      .prepare(
        `SELECT s.id, s.code, s.code_name AS codeName, s.chapter, s.chapter_title AS chapterTitle,
                s.section_number AS sectionNumber, s.section_title AS sectionTitle,
                s.acts_history AS actsHistory, s.sessions_amended_json AS sessionsAmendedJson,
                s.last_amended_session AS lastAmendedSession, s.source
         FROM statute_sections s
         ${whereClause}
         ORDER BY s.code ASC, CAST(s.chapter AS INTEGER) ASC, s.section_number ASC
         LIMIT 120`
      )
      .all(...params) as typeof rows;
  }

  res.json({
    sections: rows.map((r) => ({
      id: r.id,
      code: r.code,
      codeName: r.codeName,
      chapter: r.chapter,
      chapterTitle: r.chapterTitle,
      sectionNumber: r.sectionNumber,
      sectionTitle: r.sectionTitle,
      actsHistory: r.actsHistory,
      sessionsAmended: JSON.parse(r.sessionsAmendedJson || '[]'),
      lastAmendedSession: r.lastAmendedSession,
      source: r.source,
      snippet: r.snippet,
    })),
  });
});

apiRouter.get('/statutes/:id', (req, res) => {
  const row = db
    .prepare(
      `SELECT id, code, code_name AS codeName, chapter, chapter_title AS chapterTitle,
              section_number AS sectionNumber, section_title AS sectionTitle,
              full_text AS fullText, acts_history AS actsHistory,
              sessions_amended_json AS sessionsAmendedJson,
              last_amended_session AS lastAmendedSession, source
       FROM statute_sections WHERE id = ?`
    )
    .get(req.params.id) as
    | {
        id: string;
        code: string;
        codeName: string;
        chapter: string;
        chapterTitle: string;
        sectionNumber: string;
        sectionTitle: string;
        fullText: string;
        actsHistory: string;
        sessionsAmendedJson: string;
        lastAmendedSession: string;
        source: string;
      }
    | undefined;

  if (!row) return res.status(404).json({ error: 'Statute section not found' });

  const snapshots = db
    .prepare(
      `SELECT id, section_id AS sectionId, code, section_number AS sectionNumber,
              snapshot_date AS snapshotDate, header_text AS headerText,
              full_text AS fullText, acts_history AS actsHistory,
              source, fetched_at AS fetchedAt
       FROM statute_snapshots
       WHERE section_id = ?
       ORDER BY snapshot_date ASC`
    )
    .all(row.id);

  // Find indexed bills touching this code/chapter/section
  const relatedBills = db
    .prepare(
      `SELECT id, session, bill_number AS billNumber, title, stage
       FROM bills
       WHERE full_text LIKE ? OR statute_codes LIKE ? OR full_text LIKE ?
       ORDER BY influence_score DESC
       LIMIT 12`
    )
    .all(
      `%${row.sectionNumber}%`,
      `%${row.codeName}%`,
      `%Chapter ${row.chapter}, ${row.codeName}%`
    );

  res.json({
    id: row.id,
    code: row.code,
    codeName: row.codeName,
    chapter: row.chapter,
    chapterTitle: row.chapterTitle,
    sectionNumber: row.sectionNumber,
    sectionTitle: row.sectionTitle,
    fullText: row.fullText,
    actsHistory: row.actsHistory,
    sessionsAmended: JSON.parse(row.sessionsAmendedJson || '[]'),
    lastAmendedSession: row.lastAmendedSession,
    source: row.source,
    snapshots,
    relatedBills,
  });
});

apiRouter.post('/statutes/:id/snapshot', async (req, res) => {
  const sec = db
    .prepare(`SELECT id, code, section_number AS sectionNumber FROM statute_sections WHERE id = ?`)
    .get(req.params.id) as { id: string; code: string; sectionNumber: string } | undefined;

  if (!sec) return res.status(404).json({ error: 'Statute section not found' });

  const snapshotDate = String(req.body?.snapshotDate ?? '').trim();
  if (!snapshotDate) {
    return res.status(400).json({ error: 'snapshotDate (YYYY-MM-DD, >= 2004-01-01) is required' });
  }

  try {
    const snap = await fetchStatuteSnapshotByDate(sec.code, sec.sectionNumber, snapshotDate);
    res.status(201).json({ snapshot: snap });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Could not fetch historical snapshot',
    });
  }
});

apiRouter.get('/statutes/:id/diff', (req, res) => {
  const fromId = String(req.query.from ?? '').trim();
  const toId = String(req.query.to ?? '').trim();

  const sec = db
    .prepare(`SELECT id, section_number AS sectionNumber, full_text AS fullText FROM statute_sections WHERE id = ?`)
    .get(req.params.id) as { id: string; sectionNumber: string; fullText: string } | undefined;

  if (!sec) return res.status(404).json({ error: 'Statute section not found' });

  const resolveText = (snapId: string): { label: string; text: string } | null => {
    if (snapId === 'current') {
      return { label: 'Current Codified Text', text: sec.fullText };
    }
    const snap = db
      .prepare(`SELECT snapshot_date, full_text FROM statute_snapshots WHERE id = ? AND section_id = ?`)
      .get(snapId, sec.id) as { snapshot_date: string; full_text: string } | undefined;
    if (!snap) return null;
    return { label: `As of ${snap.snapshot_date}`, text: snap.full_text };
  };

  const fromVer = resolveText(fromId);
  const toVer = resolveText(toId);
  if (!fromVer || !toVer) {
    return res.status(404).json({ error: 'Historical snapshot not found' });
  }

  const diff = computeLineDiff(fromVer.text, toVer.text);
  res.json({
    fromLabel: fromVer.label,
    toLabel: toVer.label,
    ...diff,
  });
});

// 13. Multi-Track Session Timeline, Policy Cohorts & Consolidation Tracker
const MONTH_LOOKUP: Record<string, string> = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
};

function parseFlexibleIsoDate(raw: string): string {
  const direct = normalizeIsoDate(raw);
  if (direct) return direct;
  const named = (raw || '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (named) {
    const mm = MONTH_LOOKUP[named[1].toLowerCase()];
    if (mm) return `${named[3]}-${mm}-${named[2].padStart(2, '0')}`;
  }
  return '';
}

function isoDateToEpochMs(iso: string): number {
  const t = Date.parse(`${iso}T12:00:00Z`);
  return Number.isNaN(t) ? 0 : t;
}

function normalizeStatuteKey(codeStr: string): string {
  return codeStr
    .replace(/\bSubch\.\s*[A-Z0-9]+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

apiRouter.get('/timeline', (req, res) => {
  const sessionParam = String(req.query.session ?? '').trim();
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const committeeFilter = String(req.query.committee ?? '').trim();
  const requestedFocus = String(req.query.focusBillId ?? '').trim();

  const billRows = db
    .prepare(
      `SELECT id, session, bill_number, chamber, title, summary, statute_codes, status, stage,
              primary_author, committees_json, subjects_json, filed_date, last_action, last_action_date,
              amendment_count, influence_score
       FROM bills
       ${sessionParam ? 'WHERE session = ?' : ''}
       ORDER BY influence_score DESC, last_action_date DESC
       LIMIT 350`
    )
    .all(...(sessionParam ? [sessionParam] : [])) as Array<{
    id: string;
    session: string;
    bill_number: string;
    chamber: Chamber;
    title: string;
    summary: string;
    statute_codes: string;
    status: string;
    stage: BillStage;
    primary_author: string;
    committees_json: string;
    subjects_json: string;
    filed_date: string;
    last_action: string;
    last_action_date: string;
    amendment_count: number;
    influence_score: number;
  }>;

  const parsedBills = billRows.map((r) => {
    const committees = JSON.parse(safeStr(r.committees_json, '[]')) as Array<{
      name: string;
      chamber: Chamber;
      status: string;
    }>;
    const subjects = JSON.parse(safeStr(r.subjects_json, '[]')) as string[];
    const statuteCodes = JSON.parse(safeStr(r.statute_codes, '[]')) as string[];
    const tokens = extractBillTokens({
      title: r.title,
      summary: r.summary,
      subjects_json: r.subjects_json,
      statute_codes: r.statute_codes,
    });
    const isBudgetBill = /^(SB|HB)\s*1$/i.test(r.bill_number.trim());

    return {
      ...r,
      committees,
      subjects,
      statuteCodes,
      statuteKeys: statuteCodes
        .map(normalizeStatuteKey)
        .filter((sk) => Boolean(sk) && /\d/.test(sk)),
      tokens,
      tokenSet: new Set(tokens),
      isBudgetBill,
      isoFiledDate: parseFlexibleIsoDate(r.filed_date) || '2025-01-15',
      isoLastDate: parseFlexibleIsoDate(r.last_action_date) || parseFlexibleIsoDate(r.filed_date) || '2025-01-15',
    };
  });

  // Collect committees across evaluated session bills
  const committeeSet = new Set<string>();
  for (const b of parsedBills) {
    for (const c of b.committees) {
      if (c.name) committeeSet.add(c.name);
    }
  }

  // Apply keyword + committee filters for focused subset while keeping full cohort graph intact
  const filteredBills = parsedBills.filter((b) => {
    if (committeeFilter && !b.committees.some((c) => c.name === committeeFilter)) {
      return false;
    }
    if (q) {
      const hay = `${b.bill_number} ${b.session} ${b.title} ${b.summary} ${b.primary_author} ${b.subjects.join(' ')} ${b.statuteCodes.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const billById = new Map(parsedBills.map((b) => [b.id, b]));
  const filteredIds = new Set(filteredBills.map((b) => b.id));

  const focusBillId =
    requestedFocus && billById.has(requestedFocus)
      ? requestedFocus
      : filteredBills[0]?.id ?? parsedBills[0]?.id ?? '';

  // Load explicit bill_links touching evaluated bills
  const allLinks = db
    .prepare(`SELECT id, source_bill_id, target_bill_id, link_type, notes FROM bill_links`)
    .all() as Array<{
    id: string;
    source_bill_id: string;
    target_bill_id: string;
    link_type: string;
    notes: string;
  }>;

  const explicitEdges: Array<{ a: string; b: string; linkType: string; notes: string }> = [];
  for (const l of allLinks) {
    if (billById.has(l.source_bill_id) && billById.has(l.target_bill_id)) {
      explicitEdges.push({
        a: l.source_bill_id,
        b: l.target_bill_id,
        linkType: l.link_type,
        notes: l.notes,
      });
    }
  }

  // Union-Find to cluster Policy Cohorts (companions, shared statute chapters, >=3 domain tokens)
  const parent = new Map<string, string>();
  for (const b of parsedBills) parent.set(b.id, b.id);
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      cur = parent.get(cur) ?? cur;
    }
    return cur;
  };
  const union = (x: string, y: string) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(ry, rx);
  };

  for (const edge of explicitEdges) {
    // Do not merge unrelated policy clusters purely through mega-budget rider links
    const ba = billById.get(edge.a);
    const bb = billById.get(edge.b);
    if (ba && bb && !ba.isBudgetBill && !bb.isBudgetBill) {
      union(edge.a, edge.b);
    }
  }

  for (let i = 0; i < parsedBills.length; i++) {
    const a = parsedBills[i];
    if (a.isBudgetBill) continue;
    for (let j = i + 1; j < parsedBills.length; j++) {
      const b = parsedBills[j];
      if (b.isBudgetBill) continue;
      if (a.session !== b.session) continue;

      const sharedStatutes = a.statuteKeys.filter((sk) => b.statuteKeys.includes(sk));
      const sharedTokens = a.tokens.filter((t) => b.tokenSet.has(t));
      if (sharedStatutes.length > 0 || sharedTokens.length >= 3) {
        union(a.id, b.id);
      }
    }
  }

  // Build cohort groups from components with >= 2 bills
  const groups = new Map<string, typeof parsedBills>();
  for (const b of parsedBills) {
    const root = find(b.id);
    const list = groups.get(root);
    if (list) list.push(b);
    else groups.set(root, [b]);
  }

  const cohorts: TimelineCohort[] = [];
  const billToCohortIds = new Map<string, Set<string>>();

  for (const [rootId, members] of groups.entries()) {
    if (members.length < 2) continue;
    // If filters are active, include cohorts touching at least one filtered bill
    if ((q || committeeFilter) && !members.some((m) => filteredIds.has(m.id))) continue;

    const subjectFreq = new Map<string, number>();
    const statuteFreq = new Map<string, number>();
    const tokenFreq = new Map<string, number>();

    for (const m of members) {
      for (const s of m.subjects) subjectFreq.set(s, (subjectFreq.get(s) ?? 0) + 1);
      for (const st of m.statuteCodes) statuteFreq.set(st, (statuteFreq.get(st) ?? 0) + 1);
      for (const t of m.tokens) tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
    }

    const topSharedSubjects = Array.from(subjectFreq.entries())
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([s]) => s);
    const topSharedStatutes = Array.from(statuteFreq.entries())
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([s]) => s);
    const topSharedTokens = Array.from(tokenFreq.entries())
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);

    const cohortLinks = explicitEdges.filter(
      (e) => members.some((m) => m.id === e.a) && members.some((m) => m.id === e.b)
    );

    const topicLabel =
      topSharedSubjects[0] ||
      topSharedStatutes[0] ||
      (topSharedTokens.length
        ? topSharedTokens.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' & ')
        : `${members[0].session} ${members[0].bill_number} Cluster`);

    const basisParts: string[] = [];
    if (cohortLinks.length > 0) {
      basisParts.push(`Explicit ${cohortLinks[0].linkType} Link`);
    }
    if (topSharedStatutes.length > 0) {
      basisParts.push(`Shared Statute: ${topSharedStatutes.slice(0, 2).join(', ')}`);
    } else if (topSharedTokens.length > 0) {
      basisParts.push(`Keywords: ${topSharedTokens.join(', ')}`);
    }

    const memberIds = new Set(members.map((m) => m.id));
    for (const m of members) {
      billToCohortIds.set(m.id, memberIds);
    }

    const mappedMembers: TimelineCohortBill[] = members
      .slice()
      .sort((a, b) => a.isoFiledDate.localeCompare(b.isoFiledDate) || b.influence_score - a.influence_score)
      .map((m) => {
        let roleInCohort: TimelineCohortBill['roleInCohort'] = 'Advancing';
        if (m.stage === 'Signed' || m.stage === 'Enrolled') roleInCohort = 'Vehicle / Enacted';
        else if (m.stage === 'Stalled') roleInCohort = 'Stalled / Pending';
        else if (m.stage === 'Pre-Filed') roleInCohort = 'Pre-Filed';

        const { outcome, outcomeDetail } = computeBillOutcome(
          m.session,
          m.stage,
          m.status || '',
          m.last_action || '',
          m.committees.length
        );

        return {
          id: m.id,
          billNumber: m.bill_number,
          session: m.session,
          chamber: m.chamber,
          title: m.title,
          stage: m.stage,
          outcome,
          outcomeDetail,
          filedDate: m.isoFiledDate,
          lastActionDate: m.isoLastDate,
          primaryAuthor: m.primary_author,
          amendmentCount: m.amendment_count,
          roleInCohort,
        };
      });

    const earliestFiled = mappedMembers.reduce(
      (min, m) => (m.filedDate < min ? m.filedDate : min),
      mappedMembers[0].filedDate
    );
    const latestAction = mappedMembers.reduce(
      (max, m) => (m.lastActionDate > max ? m.lastActionDate : max),
      mappedMembers[0].lastActionDate
    );

    cohorts.push({
      id: `coh-${rootId}`,
      topicLabel,
      sharedBasis: basisParts.join(' · ') || 'Multi-bill subject alignment',
      earliestFiled,
      latestAction,
      bills: mappedMembers,
    });
  }
  cohorts.sort((a, b) => b.bills.length - a.bills.length || a.earliestFiled.localeCompare(b.earliestFiled));

  // Preload amendments & bill_documents for evaluated bills (efficient batch queries)
  const amendmentsByBill = new Map<
    string,
    Array<{
      id: string;
      versionCode: string;
      versionLabel: string;
      amendmentNumber: string;
      sponsor: string;
      filedDate: string;
      disposition: string;
      summary: string;
      fullText: string;
      sortOrder: number;
    }>
  >();

  const allAmends = db
    .prepare(
      `SELECT id, bill_id AS billId, version_code AS versionCode, version_label AS versionLabel,
              amendment_number AS amendmentNumber, sponsor, filed_date AS filedDate,
              disposition, summary, full_text AS fullText, sort_order AS sortOrder
       FROM amendments
       ORDER BY sort_order ASC, filed_date ASC`
    )
    .all() as Array<{
    id: string;
    billId: string;
    versionCode: string;
    versionLabel: string;
    amendmentNumber: string;
    sponsor: string;
    filedDate: string;
    disposition: string;
    summary: string;
    fullText: string;
    sortOrder: number;
  }>;

  for (const am of allAmends) {
    if (!billById.has(am.billId)) continue;
    const list = amendmentsByBill.get(am.billId);
    if (list) list.push(am);
    else amendmentsByBill.set(am.billId, [am]);
  }

  const docsByBill = new Map<string, BillDocument[]>();
  const allDocs = db
    .prepare(
      `SELECT id, bill_id AS billId, doc_type AS docType, version_code AS versionCode,
              version_label AS versionLabel, title, summary, full_text AS fullText, source
       FROM bill_documents`
    )
    .all() as BillDocument[];

  for (const d of allDocs) {
    if (!billById.has(d.billId)) continue;
    const list = docsByBill.get(d.billId);
    if (list) list.push(d);
    else docsByBill.set(d.billId, [d]);
  }

  // Detect Consolidation & Absorption Signals (stalled/early bills vs. advancing committee-substitute vehicles)
  const consolidations: TimelineConsolidation[] = [];
  const stalledCandidates = parsedBills.filter(
    (b) => b.stage === 'Stalled' || b.stage === 'Filed' || b.stage === 'Committee Hearing'
  );
  const vehicleCandidates = parsedBills.filter(
    (b) =>
      (b.stage === 'Committee Reported' || b.stage === 'Engrossed' || b.stage === 'Enrolled' || b.stage === 'Signed') &&
      (amendmentsByBill.get(b.id)?.length ?? 0) >= 2
  );

  const seenPairs = new Set<string>();
  for (const st of stalledCandidates) {
    for (const veh of vehicleCandidates) {
      if (st.id === veh.id) continue;
      if ((q || committeeFilter) && !filteredIds.has(st.id) && !filteredIds.has(veh.id)) continue;

      const pairKey = `${st.id}::${veh.id}`;
      if (seenPairs.has(pairKey)) continue;

      const explicitLink = explicitEdges.find(
        (e) => (e.a === st.id && e.b === veh.id) || (e.a === veh.id && e.b === st.id)
      );
      const sharedComm = st.committees.find((sc) => veh.committees.some((vc) => vc.name === sc.name));
      const sharedStatutes = st.statuteCodes.filter((sCode) =>
        veh.statuteKeys.includes(normalizeStatuteKey(sCode))
      );
      const sharedTokens = st.tokens.filter((t) => veh.tokenSet.has(t));

      const qualifiesExplicit = Boolean(explicitLink);
      const qualifiesIntraSession =
        st.session === veh.session &&
        !st.isBudgetBill &&
        !veh.isBudgetBill &&
        Boolean(sharedComm) &&
        (sharedStatutes.length > 0 || sharedTokens.length >= 2);

      if (!qualifiesExplicit && !qualifiesIntraSession) continue;
      seenPairs.add(pairKey);

      const vehVersions = amendmentsByBill.get(veh.id) ?? [];
      const firstVer = vehVersions[0];
      const latestVer = vehVersions[vehVersions.length - 1];
      const diff =
        firstVer && latestVer && firstVer.id !== latestVer.id
          ? computeLineDiff(firstVer.fullText, latestVer.fullText)
          : { lines: [], addedCount: 0, removedCount: 0, unchangedCount: 0 };
      const addedLinePreviews = diff.lines
        .filter((l) => l.type === 'added')
        .map((l) => l.text)
        .slice(0, 4);

      const vehDocs = docsByBill.get(veh.id) ?? [];
      const analysisDoc = vehDocs.find((d) => d.docType === 'analysis') ?? vehDocs[0];

      const basisParts: string[] = [];
      if (explicitLink) basisParts.push(`${explicitLink.linkType} link`);
      if (sharedComm) basisParts.push(`Same committee (${sharedComm.name})`);
      if (sharedStatutes.length > 0) basisParts.push(`Shared statute (${sharedStatutes[0]})`);
      else if (sharedTokens.length > 0) basisParts.push(`Shared terms: ${sharedTokens.slice(0, 3).join(', ')}`);

      consolidations.push({
        id: `cons-${st.id}-${veh.id}`,
        stalledBillId: st.id,
        stalledBillNumber: `${st.session} ${st.bill_number}`,
        stalledTitle: st.title,
        stalledDate: st.isoLastDate,
        stalledStage: st.stage,
        vehicleBillId: veh.id,
        vehicleBillNumber: `${veh.session} ${veh.bill_number}`,
        vehicleTitle: veh.title,
        vehicleDate: latestVer ? parseFlexibleIsoDate(latestVer.filedDate) || veh.isoLastDate : veh.isoLastDate,
        vehicleStage: veh.stage,
        committee: sharedComm?.name ?? veh.committees[0]?.name ?? 'Committee Vehicle',
        basis: basisParts.join(' · '),
        sharedStatutes: sharedStatutes.length ? sharedStatutes : sharedTokens.slice(0, 3),
        addedLinePreviews,
        addedCount: diff.addedCount,
        removedCount: diff.removedCount,
        analysisNote: analysisDoc?.summary || latestVer?.summary || '',
      });
    }
  }
  consolidations.sort((a, b) => b.addedCount - a.addedCount || b.vehicleDate.localeCompare(a.vehicleDate));

  // Build Synchronized Multi-Track Chronological Events
  const focusCohortSet = new Set<string>(billToCohortIds.get(focusBillId) ?? []);
  for (const e of explicitEdges) {
    if (e.a === focusBillId) focusCohortSet.add(e.b);
    if (e.b === focusBillId) focusCohortSet.add(e.a);
  }

  const events: TimelineEventItem[] = [];

  for (const b of filteredBills) {
    const track: TimelineEventItem['track'] =
      b.id === focusBillId ? 'focus' : focusCohortSet.has(b.id) ? 'cohort' : 'session';
    const primaryCommittee = b.committees[0]?.name ?? 'General Calendar';

    // 1. Filing / Pre-filing event
    events.push({
      id: `evt-file-${b.id}`,
      date: b.isoFiledDate,
      billId: b.id,
      billNumber: b.bill_number,
      session: b.session,
      billTitle: b.title,
      stage: b.stage,
      committee: primaryCommittee,
      kind: 'filing',
      track,
      title: `${b.session} ${b.bill_number} ${b.stage === 'Pre-Filed' ? 'Pre-Filed' : 'Filed'} (${b.primary_author})`,
      detail: b.title,
      concurrentEventsCount: 0,
    });

    // 2. Witness hearing events grouped by committee + hearing date
    const witRows = db
      .prepare(
        `SELECT committee_name AS committeeName, hearing_date AS hearingDate,
                position, is_citizen_self AS isCitizenSelf
         FROM witness_registrations WHERE bill_id = ?`
      )
      .all(b.id) as Array<{
      committeeName: string;
      hearingDate: string;
      position: string;
      isCitizenSelf: number;
    }>;

    const hearingMap = new Map<
      string,
      { committeeName: string; isoDate: string; total: number; forC: number; againstC: number; selfC: number }
    >();
    for (const w of witRows) {
      const iso = parseFlexibleIsoDate(w.hearingDate);
      if (!iso) continue;
      const key = `${w.committeeName}::${iso}`;
      const cur = hearingMap.get(key) ?? {
        committeeName: w.committeeName,
        isoDate: iso,
        total: 0,
        forC: 0,
        againstC: 0,
        selfC: 0,
      };
      cur.total++;
      if (w.position === 'For') cur.forC++;
      if (w.position === 'Against') cur.againstC++;
      if (w.isCitizenSelf === 1) cur.selfC++;
      hearingMap.set(key, cur);
    }

    for (const h of hearingMap.values()) {
      events.push({
        id: `evt-wit-${b.id}-${h.isoDate}-${h.committeeName}`,
        date: h.isoDate,
        billId: b.id,
        billNumber: b.bill_number,
        session: b.session,
        billTitle: b.title,
        stage: b.stage,
        committee: h.committeeName,
        kind: 'hearing',
        track,
        title: `${b.session} ${b.bill_number} Public Hearing — ${h.committeeName}`,
        detail: `${h.total} witness registrations (${h.forC} For, ${h.againstC} Against, ${h.selfC} Citizen Self)`,
        witnessCount: h.total,
        citizenSelfCount: h.selfC,
        concurrentEventsCount: 0,
      });
    }

    // Load bill_actions once per bill for both version-date fallback and timeline actions
    const actions = db
      .prepare(
        `SELECT id, action_date AS actionDate, action_number AS actionNumber, description
         FROM bill_actions WHERE bill_id = ? ORDER BY action_date ASC`
      )
      .all(b.id) as Array<{ id: string; actionDate: string; actionNumber: string; description: string }>;

    // 3. Substitutes / Floor Amendments with line-by-line diffs & attached TLO documents
    const billAmends = amendmentsByBill.get(b.id) ?? [];
    const billDocs = docsByBill.get(b.id) ?? [];
    for (let idx = 0; idx < billAmends.length; idx++) {
      const am = billAmends[idx];
      if (idx === 0 && am.versionCode === 'I') continue;
      const prevAm = idx > 0 ? billAmends[idx - 1] : null;
      let amDate = parseFlexibleIsoDate(am.filedDate) || b.isoLastDate;
      if (amDate === b.isoFiledDate && actions.length > 0) {
        const matchedAct =
          am.versionCode === 'H'
            ? actions.find((a) => /committee substitute|reported favorably/i.test(a.description))
            : am.versionCode === 'E'
              ? actions.find((a) => /engrossed|passed/i.test(a.description))
              : am.versionCode === 'S'
                ? actions.find((a) => a.actionNumber.startsWith('S') && /reported favorably/i.test(a.description))
                : am.versionCode === 'F'
                  ? actions.find((a) => /enrolled|signed by the governor/i.test(a.description))
                  : undefined;
        if (matchedAct) {
          amDate = parseFlexibleIsoDate(matchedAct.actionDate) || amDate;
        }
      }
      const diff = prevAm ? computeLineDiff(prevAm.fullText, am.fullText) : null;

      const matchingDoc =
        billDocs.find((d) => d.versionCode === am.versionCode) ??
        billDocs.find((d) => d.docType === 'analysis') ??
        billDocs[0];

      events.push({
        id: `evt-am-${am.id}`,
        date: amDate,
        billId: b.id,
        billNumber: b.bill_number,
        session: b.session,
        billTitle: b.title,
        stage: b.stage,
        committee: primaryCommittee,
        kind: 'substitute',
        track,
        title: `${b.session} ${b.bill_number} ${am.versionLabel} (${am.disposition})`,
        detail: am.summary,
        diffMeta:
          diff && prevAm
            ? {
                fromLabel: prevAm.versionLabel,
                toLabel: am.versionLabel,
                addedCount: diff.addedCount,
                removedCount: diff.removedCount,
                addedLines: diff.lines.filter((l) => l.type === 'added').map((l) => l.text).slice(0, 6),
                removedLines: diff.lines.filter((l) => l.type === 'removed').map((l) => l.text).slice(0, 4),
              }
            : undefined,
        documentNote: matchingDoc
          ? {
              docType: matchingDoc.docType,
              versionLabel: matchingDoc.versionLabel,
              summary: matchingDoc.summary,
            }
          : undefined,
        concurrentEventsCount: 0,
      });
    }

    // 4. Key procedural actions (stalls, referrals, committee reports, enactments)

    for (const act of actions) {
      const iso = parseFlexibleIsoDate(act.actionDate) || b.isoLastDate;
      const descLower = act.description.toLowerCase();
      // Skip redundant initial filing if same date as filed event
      if (iso === b.isoFiledDate && (descLower.startsWith('filed') || descLower.startsWith('pre-filed'))) {
        continue;
      }
      let kind: TimelineEventItem['kind'] = 'action';
      if (
        descLower.includes('stalled') ||
        descLower.includes('left pending') ||
        descLower.includes('vetoed') ||
        descLower.includes('failed') ||
        descLower.includes('tabled')
      ) {
        kind = 'stalled';
      } else if (
        descLower.includes('signed by the governor') ||
        descLower.includes('enrolled') ||
        descLower.includes('conference committee report adopted')
      ) {
        kind = 'enacted';
      }

      events.push({
        id: `evt-act-${act.id}`,
        date: iso,
        billId: b.id,
        billNumber: b.bill_number,
        session: b.session,
        billTitle: b.title,
        stage: b.stage,
        committee: primaryCommittee,
        kind,
        track,
        title: `${b.session} ${b.bill_number} · ${act.description}`,
        detail: `Action ${act.actionNumber || 'TLO'} · Stage: ${b.stage}`,
        concurrentEventsCount: 0,
      });
    }
  }

  const kindOrder: Record<TimelineEventItem['kind'], number> = {
    filing: 1,
    hearing: 2,
    substitute: 3,
    action: 4,
    stalled: 5,
    enacted: 6,
  };

  events.sort((a, b) => {
    const dCmp = a.date.localeCompare(b.date);
    if (dCmp !== 0) return dCmp;
    const tRank = (t: TimelineEventItem['track']) => (t === 'focus' ? 0 : t === 'cohort' ? 1 : 2);
    const trCmp = tRank(a.track) - tRank(b.track);
    if (trCmp !== 0) return trCmp;
    return kindOrder[a.kind] - kindOrder[b.kind];
  });

  // Compute +/- 3-day concurrent activity window counts across other bills
  const epochs = events.map((ev) => isoDateToEpochMs(ev.date));
  const THREE_DAYS_MS = 3 * 86400 * 1000;
  let concurrentWindows = 0;

  for (let i = 0; i < events.length; i++) {
    const ei = epochs[i];
    if (!ei) continue;
    const seenOtherBills = new Set<string>();
    for (let j = 0; j < events.length; j++) {
      if (events[j].billId === events[i].billId) continue;
      const ej = epochs[j];
      if (!ej) continue;
      if (Math.abs(ei - ej) <= THREE_DAYS_MS) {
        seenOtherBills.add(events[j].billId);
      }
    }
    events[i].concurrentEventsCount = seenOtherBills.size;
    if (seenOtherBills.size > 0) concurrentWindows++;
  }

  res.json({
    session: sessionParam || 'ALL',
    focusBillId,
    totals: {
      billsEvaluated: filteredBills.length,
      cohortsDetected: cohorts.length,
      consolidationsDetected: consolidations.length,
      timelineEvents: events.length,
      concurrentWindows,
    },
    cohorts,
    consolidations,
    events: events.slice(0, 260),
    availableBills: parsedBills.slice(0, 120).map((b) => ({
      id: b.id,
      billNumber: b.bill_number,
      session: b.session,
      title: b.title,
    })),
    availableCommittees: Array.from(committeeSet).sort((a, b) => a.localeCompare(b)),
  });
});

// 14. AI Legislative Research Agent (Tool-Calling Local LLM + Deterministic SQLite/FTS5 Tools)
apiRouter.get('/research/history', (_req, res) => {
  res.json({ items: listResearchHistory(40) });
});

apiRouter.post('/research/ask', async (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  const sessionScope = String(req.body?.sessionScope ?? '').trim();
  const priorTurns = Array.isArray(req.body?.priorTurns)
    ? (req.body.priorTurns as Array<{ question: string; answer: string }>)
        .filter((t) => t && typeof t.question === 'string' && typeof t.answer === 'string')
        .slice(-3)
    : [];

  if (!question) {
    return res.status(400).json({ error: 'A legislative research question is required.' });
  }

  try {
    const record = await runResearchAgent({
      question,
      sessionScope,
      priorTurns,
    });
    res.json({ record });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Research agent execution failed.',
    });
  }
});

apiRouter.delete('/research/history/:id', (req, res) => {
  const deleted = deleteResearchHistoryItem(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Research record not found' });
  res.json({ deleted: true });
});

// 15. Texas Register Weekly Agency Rulemaking & LBB Fiscal Impact Backfill
interface RawAgencyRuleRow {
  id: string;
  issue_date: string;
  volume: number;
  issue_number: number;
  page_range: string;
  action_type: AgencyRuleActionType;
  agency_name: string;
  tac_title: string;
  tac_citation: string;
  title: string;
  summary: string;
  statutory_authority: string;
  fiscal_note_text: string;
  fiscal_impact_amount: number | null;
  government_growth_note: string;
  cited_bills_json: string;
  statute_codes_json: string;
  source_url: string;
  source: string;
  full_text: string;
  created_at?: string;
  linked_bill_count?: number;
}

function mapAgencyRuleRow(r: RawAgencyRuleRow): AgencyRuleSummary {
  let citedBills: string[] = [];
  let statuteCodes: string[] = [];
  try {
    citedBills = JSON.parse(safeStr(r.cited_bills_json, '[]'));
  } catch {
    citedBills = [];
  }
  try {
    statuteCodes = JSON.parse(safeStr(r.statute_codes_json, '[]'));
  } catch {
    statuteCodes = [];
  }
  const previewRows = db
    .prepare(
      `SELECT l.bill_id AS billId, b.session, b.bill_number AS billNumber, l.link_basis AS linkBasis
       FROM rule_bill_links l
       JOIN bills b ON b.id = l.bill_id
       WHERE l.rule_id = ?
       ORDER BY l.confidence DESC, b.influence_score DESC
       LIMIT 4`
    )
    .all(r.id) as AgencyRuleSummary['linkedBillsPreview'];

  const linkedBillsCount =
    r.linked_bill_count !== undefined
      ? Number(r.linked_bill_count)
      : (
          db.prepare(`SELECT COUNT(*) AS c FROM rule_bill_links WHERE rule_id = ?`).get(r.id) as { c: number }
        ).c;

  return {
    id: r.id,
    issueDate: safeStr(r.issue_date),
    volume: Number(r.volume) || 0,
    issueNumber: Number(r.issue_number) || 0,
    pageRange: safeStr(r.page_range),
    actionType: r.action_type,
    agencyName: safeStr(r.agency_name),
    tacTitle: safeStr(r.tac_title),
    tacCitation: safeStr(r.tac_citation),
    title: safeStr(r.title),
    summary: safeStr(r.summary),
    statutoryAuthority: safeStr(r.statutory_authority),
    fiscalNoteText: safeStr(r.fiscal_note_text),
    fiscalImpactAmount:
      r.fiscal_impact_amount === null || r.fiscal_impact_amount === undefined
        ? null
        : Number(r.fiscal_impact_amount),
    governmentGrowthNote: safeStr(r.government_growth_note),
    citedBills,
    statuteCodes,
    sourceUrl: safeStr(r.source_url),
    source: safeStr(r.source),
    linkedBillsCount,
    linkedBillsPreview: previewRows,
  };
}

apiRouter.get('/rules', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const agency = String(req.query.agency ?? '').trim();
  const actionType = String(req.query.actionType ?? '').trim();
  const linkedOnly = String(req.query.linkedOnly ?? '').trim() === 'true';
  const billId = String(req.query.billId ?? '').trim();
  const parsedLimit = Number(req.query.limit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), 250) : 100;

  const where: string[] = [];
  const params: Array<string | number> = [];

  if (agency) {
    where.push('r.agency_name = ?');
    params.push(agency);
  }
  if (actionType) {
    where.push('r.action_type = ?');
    params.push(actionType);
  }
  if (linkedOnly) {
    where.push('EXISTS (SELECT 1 FROM rule_bill_links l WHERE l.rule_id = r.id)');
  }
  if (billId) {
    where.push('EXISTS (SELECT 1 FROM rule_bill_links l WHERE l.rule_id = r.id AND l.bill_id = ?)');
    params.push(billId);
  }

  let rows: RawAgencyRuleRow[] = [];
  if (q) {
    const safeFts = buildSafeFtsQuery(q);
    let usedFts = false;
    if (safeFts) {
      try {
        rows = db
          .prepare(
            `SELECT r.*, (SELECT COUNT(*) FROM rule_bill_links l WHERE l.rule_id = r.id) AS linked_bill_count
             FROM rules_fts
             JOIN agency_rules r ON r.id = rules_fts.rule_id
             WHERE rules_fts MATCH ?
             ${where.length ? 'AND ' + where.join(' AND ') : ''}
             ORDER BY r.issue_date DESC, linked_bill_count DESC
             LIMIT ?`
          )
          .all(safeFts, ...params, limit) as RawAgencyRuleRow[];
        usedFts = true;
      } catch {
        usedFts = false;
      }
    }
    if (!usedFts) {
      where.push(
        '(r.title LIKE ? OR r.agency_name LIKE ? OR r.tac_citation LIKE ? OR r.summary LIKE ? OR r.cited_bills_json LIKE ?)'
      );
      const pat = `%${q}%`;
      params.push(pat, pat, pat, pat, pat);
      rows = db
        .prepare(
          `SELECT r.*, (SELECT COUNT(*) FROM rule_bill_links l WHERE l.rule_id = r.id) AS linked_bill_count
           FROM agency_rules r
           WHERE ${where.join(' AND ')}
           ORDER BY r.issue_date DESC, linked_bill_count DESC
           LIMIT ?`
        )
        .all(...params, limit) as RawAgencyRuleRow[];
    }
  } else {
    rows = db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM rule_bill_links l WHERE l.rule_id = r.id) AS linked_bill_count
         FROM agency_rules r
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY r.issue_date DESC, linked_bill_count DESC
         LIMIT ?`
      )
      .all(...params, limit) as RawAgencyRuleRow[];
  }

  const agencies = (
    db
      .prepare(`SELECT DISTINCT agency_name FROM agency_rules WHERE agency_name != '' ORDER BY agency_name ASC`)
      .all() as Array<{ agency_name: string }>
  ).map((a) => a.agency_name);

  const stats = {
    totalRules: (db.prepare(`SELECT COUNT(*) AS c FROM agency_rules`).get() as { c: number }).c,
    linkedRules: (db.prepare(`SELECT COUNT(DISTINCT rule_id) AS c FROM rule_bill_links`).get() as { c: number }).c,
    totalBillLinks: (db.prepare(`SELECT COUNT(*) AS c FROM rule_bill_links`).get() as { c: number }).c,
    agenciesCount: agencies.length,
    issuesCount: (
      db.prepare(`SELECT COUNT(DISTINCT issue_date) AS c FROM agency_rules WHERE issue_date != ''`).get() as {
        c: number;
      }
    ).c,
  };

  res.json({
    rules: rows.map(mapAgencyRuleRow),
    agencies,
    stats,
  });
});

apiRouter.get('/rules/sync/status', (_req, res) => {
  res.json({ job: getLatestTexRegSyncJob() });
});

apiRouter.post('/rules/sync', (req, res) => {
  const fromDate = String(req.body?.fromDate ?? '2025-01-01').trim();
  const maxIssues = Math.min(20, Math.max(1, Number(req.body?.maxIssues) || 4));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return res.status(400).json({ error: 'fromDate must be YYYY-MM-DD' });
  }
  const job = startTexRegSyncJob({ fromDate, maxIssues });
  res.status(202).json({ job });
});

apiRouter.post('/rules/import', (req, res) => {
  const rawText = String(req.body?.rawText ?? '').trim();
  const issueDate = String(req.body?.issueDate ?? new Date().toISOString().slice(0, 10)).trim();
  const agencyName = String(req.body?.agencyName ?? '').trim();
  const actionType = String(req.body?.actionType ?? '').trim() as AgencyRuleActionType | '';
  const sourceUrlRaw = String(req.body?.sourceUrl ?? '').trim();

  if (rawText.length < 60) {
    return res.status(400).json({ error: 'Paste at least 60 characters of Texas Register notice text or HTML.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    return res.status(400).json({ error: 'issueDate must be YYYY-MM-DD.' });
  }

  let safeSourceUrl = 'https://www.sos.state.tx.us/texreg/index.shtml';
  if (sourceUrlRaw) {
    try {
      const u = new URL(sourceUrlRaw);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        safeSourceUrl = u.toString();
      }
    } catch {
      return res.status(400).json({ error: 'sourceUrl must be a valid http(s) URL.' });
    }
  }

  const allowedTypes: AgencyRuleActionType[] = ['Proposed', 'Adopted', 'Withdrawn', 'Emergency', 'Rule Review'];
  const parsed = parseTexasRegisterText(rawText, {
    issueDate,
    defaultAgency: agencyName || undefined,
    defaultActionType: allowedTypes.includes(actionType as AgencyRuleActionType)
      ? (actionType as AgencyRuleActionType)
      : undefined,
    sourceUrl: safeSourceUrl,
    source: 'Texas Register (Manual SOS Import)',
  });

  if (parsed.length === 0) {
    return res.status(400).json({
      error: 'Could not extract a Texas Register rulemaking notice from the pasted text. Include the TAC citation (e.g. "19 TAC §61.1008") or rule preamble.',
    });
  }

  const { rulesUpserted, billLinksCreated } = upsertParsedAgencyRules(parsed);
  res.status(201).json({
    rulesUpserted,
    billLinksCreated,
    ruleIds: parsed.map((p) => p.id),
  });
});

apiRouter.post('/rules/relink', (_req, res) => {
  const billLinksCreated = relinkAllRulesToBills();
  res.json({ ok: true, billLinksCreated });
});

apiRouter.get('/rules/:id', (req, res) => {
  const row = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM rule_bill_links l WHERE l.rule_id = r.id) AS linked_bill_count
       FROM agency_rules r WHERE r.id = ?`
    )
    .get(req.params.id) as RawAgencyRuleRow | undefined;

  if (!row) return res.status(404).json({ error: 'Agency rule not found' });

  const summary = mapAgencyRuleRow(row);
  const linkedRows = db
    .prepare(
      `SELECT l.link_basis AS linkBasis, l.matched_ref AS matchedRef, l.confidence,
              b.*
       FROM rule_bill_links l
       JOIN bills b ON b.id = l.bill_id
       WHERE l.rule_id = ?
       ORDER BY l.confidence DESC, b.influence_score DESC`
    )
    .all(row.id) as Array<RawBillRow & { linkBasis: string; matchedRef: string; confidence: number }>;

  const linkedBills: RuleLinkedBill[] = linkedRows.map((lr) => {
    const mapped = mapBillRow(lr);
    return {
      billId: mapped.id,
      session: mapped.session,
      billNumber: mapped.billNumber,
      title: mapped.title,
      stage: mapped.stage,
      outcome: mapped.outcome,
      outcomeDetail: mapped.outcomeDetail,
      primaryAuthor: mapped.primaryAuthor,
      biennialGrImpact: mapped.fiscalImpact.biennialGrImpact,
      fiscalStatus: mapped.fiscalImpact.status,
      linkBasis: lr.linkBasis as RuleLinkedBill['linkBasis'],
      matchedRef: lr.matchedRef,
      confidence: Number(lr.confidence),
    };
  });

  const detail: AgencyRuleDetail = {
    ...summary,
    fullText: safeStr(row.full_text),
    createdAt: safeStr(row.created_at),
    linkedBills,
  };
  res.json(detail);
});

apiRouter.delete('/rules/:id', (req, res) => {
  const existing = db.prepare(`SELECT id FROM agency_rules WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agency rule not found' });
  db.prepare(`DELETE FROM rules_fts WHERE rule_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM rule_bill_links WHERE rule_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM agency_rules WHERE id = ?`).run(req.params.id);
  res.json({ deleted: true });
});

apiRouter.post('/fiscal/recompute', (_req, res) => {
  const updated = backfillAllBillFiscalImpacts(true);
  res.json({ ok: true, billsUpdated: updated });
});
