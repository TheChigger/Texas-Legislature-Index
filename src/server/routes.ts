import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import {
  buildSafeFtsQuery,
  db,
  evaluateAlertRules,
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
  type TloBillType,
} from './tloFtp.ts';
import { fetchStatuteSnapshotByDate, syncTexasCodeFromTloFtp } from './statutes.ts';
import type {
  BillSummary,
  Chamber,
  KeywordOverlapMatch,
  KeywordTrendSeries,
  NetworkEdge,
  NetworkGraph,
  NetworkNode,
} from '../types.ts';

export const apiRouter = Router();

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
  snippet?: string;
  rank?: number;
}

function safeStr(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return fallback;
  return v == null ? fallback : String(v);
}

function mapBillRow(row: RawBillRow): BillSummary {
  const linkCountRow = db
    .prepare(`SELECT COUNT(*) AS c FROM bill_links WHERE source_bill_id = ? OR target_bill_id = ?`)
    .get(row.id, row.id) as { c: number };

  return {
    id: safeStr(row.id),
    session: safeStr(row.session),
    billNumber: safeStr(row.bill_number),
    chamber: (safeStr(row.chamber, 'House') as Chamber),
    title: safeStr(row.title),
    summary: safeStr(row.summary),
    statuteCodes: JSON.parse(safeStr(row.statute_codes, '[]')),
    status: safeStr(row.status),
    stage: row.stage,
    primaryAuthor: safeStr(row.primary_author),
    coauthors: JSON.parse(safeStr(row.coauthors_json, '[]')),
    sponsors: JSON.parse(safeStr(row.sponsors_json, '[]')),
    cosponsors: JSON.parse(safeStr(row.cosponsors_json, '[]')),
    committees: JSON.parse(safeStr(row.committees_json, '[]')),
    subjects: JSON.parse(safeStr(row.subjects_json, '[]')),
    lastAction: safeStr(row.last_action),
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
  const committee = String(req.query.committee ?? '').trim();
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

  const orderClause =
    sort === 'amendments'
      ? 'b.amendment_count DESC, b.influence_score DESC'
      : sort === 'recent'
        ? 'b.last_action_date DESC, b.influence_score DESC'
        : sort === 'relevance' && q
          ? 'bm25(bills_fts) ASC, b.influence_score DESC'
          : 'b.influence_score DESC, b.amendment_count DESC';

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
          LIMIT ?
        `;
        const rows = db.prepare(sql).all(safeFts, ...params, limit) as RawBillRow[];
        return res.json({ bills: rows.map(mapBillRow), queryUsed: safeFts });
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
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit) as RawBillRow[];
  res.json({ bills: rows.map(mapBillRow), queryUsed: q });
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
    where.push('(LOWER(p.name) LIKE ? OR LOWER(p.district) LIKE ? OR LOWER(p.leadership_role) LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
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
       ORDER BY p.total_raised DESC`
    )
    .all(...params);
  res.json({ politicians: rows });
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
      `SELECT id, bill_number, session, title, stage, primary_author, coauthors_json, sponsors_json, cosponsors_json, influence_score
       FROM bills ORDER BY influence_score DESC`
    )
    .all() as Array<{
    id: string;
    bill_number: string;
    session: string;
    title: string;
    stage: string;
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
      sponsorships.push({
        billId: b.id,
        billNumber: b.bill_number,
        session: b.session,
        title: b.title,
        stage: b.stage,
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

// 11. Optional Secondary AI Brief (Explicitly Secondary to Deterministic Keyword Database)
apiRouter.post('/bills/:id/ai-brief', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      error: 'GEMINI_API_KEY is not configured in Secrets. Use the deterministic SQLite keyword dossier and statutory diff above.',
    });
  }

  const row = db.prepare(`SELECT * FROM bills WHERE id = ?`).get(req.params.id) as RawBillRow | undefined;
  if (!row) return res.status(404).json({ error: 'Bill not found' });

  const amendments = db
    .prepare(`SELECT version_label, disposition, summary FROM amendments WHERE bill_id = ? ORDER BY sort_order ASC`)
    .all(row.id) as Array<{ version_label: string; disposition: string; summary: string }>;

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const prompt = [
      `Summarize this Texas Legislature bill concisely in 3 bullet points (Policy Mechanism, Fiscal/Committee Posture, Amendment Evolution).`,
      `Bill: ${row.session} ${row.bill_number} — ${row.title}`,
      `Author: ${row.primary_author} | Stage: ${row.stage} | Status: ${row.status}`,
      `Summary: ${row.summary}`,
      `Excerpt: ${row.full_text.slice(0, 2800)}`,
      amendments.length
        ? `Amendments: ${amendments.map((a) => `${a.version_label} (${a.disposition}): ${a.summary}`).join(' | ')}`
        : '',
    ].join('\n');

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'You are a neutral Texas legislative clerk. Provide an objective, concise 3-bullet policy brief grounded strictly in the provided statutory text.',
      },
    });

    res.json({ brief: response.text ?? 'No brief returned.' });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'AI brief generation failed',
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

