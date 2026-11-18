import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { InfluenceBreakdown } from '../types.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'capitol_ledger.db');
export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('wal_autocheckpoint = 100');
db.pragma('cache_size = -65536');
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456');
db.pragma('foreign_keys = ON');

export function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      code TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      years TEXT NOT NULL,
      synced_at TEXT,
      bill_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      bill_number TEXT NOT NULL,
      chamber TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      statute_codes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      primary_author TEXT NOT NULL,
      coauthors_json TEXT NOT NULL DEFAULT '[]',
      sponsors_json TEXT NOT NULL DEFAULT '[]',
      cosponsors_json TEXT NOT NULL DEFAULT '[]',
      committees_json TEXT NOT NULL DEFAULT '[]',
      subjects_json TEXT NOT NULL DEFAULT '[]',
      last_action TEXT NOT NULL DEFAULT '',
      last_action_date TEXT NOT NULL DEFAULT '',
      filed_date TEXT NOT NULL DEFAULT '',
      influence_score REAL NOT NULL DEFAULT 0,
      influence_breakdown_json TEXT NOT NULL DEFAULT '{}',
      momentum_label TEXT NOT NULL DEFAULT 'Active',
      bipartisan_index REAL NOT NULL DEFAULT 0,
      amendment_count INTEGER NOT NULL DEFAULT 0,
      action_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'Seeded TLO Record',
      full_text TEXT NOT NULL DEFAULT ''
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS bills_fts USING fts5(
      bill_id UNINDEXED,
      session,
      bill_number,
      title,
      summary,
      subjects,
      statute_codes,
      primary_author,
      full_text,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS amendments (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      version_code TEXT NOT NULL,
      version_label TEXT NOT NULL,
      amendment_number TEXT NOT NULL,
      sponsor TEXT NOT NULL,
      filed_date TEXT NOT NULL,
      disposition TEXT NOT NULL,
      yea_votes INTEGER NOT NULL DEFAULT 0,
      nay_votes INTEGER NOT NULL DEFAULT 0,
      pnv_votes INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,
      full_text TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 1
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS amendments_fts USING fts5(
      amendment_id UNINDEXED,
      bill_id UNINDEXED,
      version_label,
      sponsor,
      summary,
      full_text,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS bill_actions (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      action_date TEXT NOT NULL,
      action_number TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bill_links (
      id TEXT PRIMARY KEY,
      source_bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      target_bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS politicians (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_name TEXT NOT NULL,
      chamber TEXT NOT NULL,
      district TEXT NOT NULL,
      party TEXT NOT NULL,
      tenure_years INTEGER NOT NULL DEFAULT 2,
      leadership_role TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      total_raised INTEGER NOT NULL DEFAULT 0,
      bills_authored INTEGER NOT NULL DEFAULT 0,
      bills_passed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS committees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      chamber TEXT NOT NULL,
      session TEXT NOT NULL,
      chair_id TEXT,
      vice_chair_id TEXT,
      jurisdiction TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS committee_memberships (
      id TEXT PRIMARY KEY,
      committee_id TEXT NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
      politician_id TEXT NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      session TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      amendment_id TEXT,
      politician_id TEXT NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
      vote_cast TEXT NOT NULL,
      vote_date TEXT NOT NULL,
      motion TEXT NOT NULL,
      party_line INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS donors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sector TEXT NOT NULL,
      pac_id TEXT NOT NULL,
      city TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contributions (
      id TEXT PRIMARY KEY,
      donor_id TEXT NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
      politician_id TEXT NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
      cycle TEXT NOT NULL,
      amount INTEGER NOT NULL,
      filing_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      session TEXT NOT NULL DEFAULT '',
      chamber TEXT NOT NULL DEFAULT '',
      committee TEXT NOT NULL DEFAULT '',
      politician TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_events (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      amendment_id TEXT,
      match_type TEXT NOT NULL,
      snippet TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_unique
      ON alert_events(rule_id, bill_id, COALESCE(amendment_id, ''));

    CREATE TABLE IF NOT EXISTS witness_registrations (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      chamber TEXT NOT NULL,
      committee_name TEXT NOT NULL,
      hearing_date TEXT NOT NULL DEFAULT '',
      witness_name TEXT NOT NULL,
      affiliation TEXT NOT NULL DEFAULT 'Self',
      is_citizen_self INTEGER NOT NULL DEFAULT 1,
      position TEXT NOT NULL,
      testified INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'TLO Witness List'
    );

    CREATE TABLE IF NOT EXISTS constituent_communications (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      politician_id TEXT REFERENCES politicians(id) ON DELETE SET NULL,
      committee_name TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL,
      stance TEXT NOT NULL,
      volume_count INTEGER NOT NULL DEFAULT 1,
      summary TEXT NOT NULL,
      topic_keywords TEXT NOT NULL DEFAULT '',
      logged_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS statutes_codes (
      code TEXT PRIMARY KEY,
      zip_code TEXT NOT NULL,
      code_id INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      chapter_count INTEGER NOT NULL DEFAULT 0,
      section_count INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS statute_sections (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      code_name TEXT NOT NULL,
      chapter TEXT NOT NULL,
      chapter_title TEXT NOT NULL DEFAULT '',
      section_number TEXT NOT NULL,
      section_title TEXT NOT NULL,
      full_text TEXT NOT NULL,
      acts_history TEXT NOT NULL DEFAULT '',
      sessions_amended_json TEXT NOT NULL DEFAULT '[]',
      last_amended_session TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'TLO FTP /pub/statutes'
    );

    CREATE INDEX IF NOT EXISTS idx_statute_code_sec ON statute_sections(code, section_number);

    CREATE VIRTUAL TABLE IF NOT EXISTS statutes_fts USING fts5(
      code,
      code_name,
      chapter,
      section_number,
      section_title,
      full_text,
      acts_history,
      content='statute_sections',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS statute_sections_ai AFTER INSERT ON statute_sections BEGIN
      INSERT INTO statutes_fts(rowid, code, code_name, chapter, section_number, section_title, full_text, acts_history)
      VALUES (new.rowid, new.code, new.code_name, new.chapter, new.section_number, new.section_title, new.full_text, new.acts_history);
    END;

    CREATE TRIGGER IF NOT EXISTS statute_sections_ad AFTER DELETE ON statute_sections BEGIN
      INSERT INTO statutes_fts(statutes_fts, rowid, code, code_name, chapter, section_number, section_title, full_text, acts_history)
      VALUES ('delete', old.rowid, old.code, old.code_name, old.chapter, old.section_number, old.section_title, old.full_text, old.acts_history);
    END;

    CREATE TRIGGER IF NOT EXISTS statute_sections_au AFTER UPDATE ON statute_sections BEGIN
      INSERT INTO statutes_fts(statutes_fts, rowid, code, code_name, chapter, section_number, section_title, full_text, acts_history)
      VALUES ('delete', old.rowid, old.code, old.code_name, old.chapter, old.section_number, old.section_title, old.full_text, old.acts_history);
      INSERT INTO statutes_fts(rowid, code, code_name, chapter, section_number, section_title, full_text, acts_history)
      VALUES (new.rowid, new.code, new.code_name, new.chapter, new.section_number, new.section_title, new.full_text, new.acts_history);
    END;

    CREATE TABLE IF NOT EXISTS statute_snapshots (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL,
      code TEXT NOT NULL,
      section_number TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      header_text TEXT NOT NULL DEFAULT '',
      full_text TEXT NOT NULL,
      acts_history TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'tcss.legis.texas.gov',
      fetched_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_statute_snap_sec ON statute_snapshots(section_id, snapshot_date);

    CREATE TABLE IF NOT EXISTS bill_documents (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL,
      version_code TEXT NOT NULL,
      version_label TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      full_text TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_bill_docs_bill ON bill_documents(bill_id);
  `);
}

export function normalizeIsoDate(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  return s;
}

export function syncBillFts(billId: string): void {
  const row = db
    .prepare(
      `SELECT id, session, bill_number, title, summary, subjects_json, statute_codes, primary_author, full_text
       FROM bills WHERE id = ?`
    )
    .get(billId) as
    | {
        id: string;
        session: string;
        bill_number: string;
        title: string;
        summary: string;
        subjects_json: string;
        statute_codes: string;
        primary_author: string;
        full_text: string;
      }
    | undefined;

  if (!row) return;

  db.prepare(`DELETE FROM bills_fts WHERE bill_id = ?`).run(billId);
  const subjects = (JSON.parse(row.subjects_json || '[]') as string[]).join(' · ');
  const statutes = (JSON.parse(row.statute_codes || '[]') as string[]).join(' · ');
  db.prepare(
    `INSERT INTO bills_fts (bill_id, session, bill_number, title, summary, subjects, statute_codes, primary_author, full_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.session,
    row.bill_number,
    row.title,
    row.summary,
    subjects,
    statutes,
    row.primary_author,
    row.full_text
  );
}

export function syncAmendmentFts(amendmentId: string): void {
  const row = db
    .prepare(
      `SELECT id, bill_id, version_label, sponsor, summary, full_text
       FROM amendments WHERE id = ?`
    )
    .get(amendmentId) as
    | {
        id: string;
        bill_id: string;
        version_label: string;
        sponsor: string;
        summary: string;
        full_text: string;
      }
    | undefined;

  if (!row) return;

  db.prepare(`DELETE FROM amendments_fts WHERE amendment_id = ?`).run(amendmentId);
  db.prepare(
    `INSERT INTO amendments_fts (amendment_id, bill_id, version_label, sponsor, summary, full_text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.bill_id, row.version_label, row.sponsor, row.summary, row.full_text);
}

const STAGE_WEIGHTS: Record<string, number> = {
  Signed: 34,
  Enrolled: 32,
  Engrossed: 24,
  'Committee Reported': 18,
  'Committee Hearing': 11,
  Filed: 6,
  'Pre-Filed': 5,
  Vetoed: 20,
  Stalled: 12,
};

export function recomputeBillMetrics(billId: string): void {
  const bill = db
    .prepare(
      `SELECT id, coauthors_json, cosponsors_json, stage, primary_author FROM bills WHERE id = ?`
    )
    .get(billId) as
    | {
        id: string;
        coauthors_json: string;
        cosponsors_json: string;
        stage: string;
        primary_author: string;
      }
    | undefined;
  if (!bill) return;

  const coauthors = JSON.parse(bill.coauthors_json || '[]') as string[];
  const cosponsors = JSON.parse(bill.cosponsors_json || '[]') as string[];
  const amendCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM amendments WHERE bill_id = ?`).get(billId) as { c: number }
  ).c;
  const actionCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM bill_actions WHERE bill_id = ?`).get(billId) as { c: number }
  ).c;
  const linkCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM bill_links WHERE source_bill_id = ? OR target_bill_id = ?`
      )
      .get(billId, billId) as { c: number }
  ).c;

  const chairMatch = db
    .prepare(
      `SELECT p.leadership_role,
              (SELECT COUNT(*) FROM committee_memberships cm WHERE cm.politician_id = p.id AND cm.role = 'Chair') AS is_chair
       FROM politicians p
       WHERE p.short_name = ? OR p.name LIKE ?`
    )
    .get(bill.primary_author, `%${bill.primary_author}%`) as
    | { leadership_role: string; is_chair: number }
    | undefined;

  const coauthorWeight = Number(((coauthors.length + cosponsors.length) * 0.6).toFixed(1));
  const amendmentWeight = Number((amendCount * 3.5).toFixed(1));
  const actionWeight = Number((Math.min(actionCount, 25) * 0.8).toFixed(1));
  const stageWeight = STAGE_WEIGHTS[bill.stage] ?? 6;
  const leadershipBonus = chairMatch && (chairMatch.is_chair > 0 || chairMatch.leadership_role) ? 10 : 0;
  const linkWeight = Number((linkCount * 4).toFixed(1));

  const total = Number(
    Math.min(
      100,
      coauthorWeight + amendmentWeight + actionWeight + stageWeight + leadershipBonus + linkWeight
    ).toFixed(1)
  );

  const breakdown: InfluenceBreakdown = {
    coauthorWeight,
    amendmentWeight,
    actionWeight,
    stageWeight,
    leadershipBonus,
    linkWeight,
    total,
  };

  let momentumLabel = 'Early Filing';
  if (bill.stage === 'Signed' || bill.stage === 'Enrolled') {
    momentumLabel = 'Enacted Law';
  } else if (bill.stage === 'Engrossed') {
    momentumLabel = 'Cross-Chamber Active';
  } else if (bill.stage === 'Stalled' || bill.stage === 'Vetoed') {
    momentumLabel = bill.stage;
  } else if (amendCount >= 3 || coauthors.length >= 10) {
    momentumLabel = 'High Floor Activity';
  } else if (bill.stage === 'Committee Reported') {
    momentumLabel = 'Calendar Ready';
  } else if (bill.stage === 'Pre-Filed') {
    momentumLabel = '90th Pre-File';
  }

  db.prepare(
    `UPDATE bills
     SET influence_score = ?,
         influence_breakdown_json = ?,
         momentum_label = ?,
         amendment_count = ?,
         action_count = ?
     WHERE id = ?`
  ).run(total, JSON.stringify(breakdown), momentumLabel, amendCount, actionCount, billId);
}

export function refreshSessionCounts(): void {
  db.exec(`
    UPDATE sessions
    SET bill_count = (SELECT COUNT(*) FROM bills WHERE bills.session = sessions.code);
  `);
}

/**
 * Sanitizes user input for SQLite FTS5 MATCH while preserving Boolean operators
 * (AND, OR, NOT), exact quoted phrases ("..."), and prefix wildcards (*).
 */
export function buildSafeFtsQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Tokenize keeping quoted phrases intact
  const tokens: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(trimmed)) !== null) {
    if (match[1] !== undefined) {
      const phrase = match[1].replace(/"/g, '').trim();
      if (phrase) tokens.push(`"${phrase}"`);
    } else if (match[2]) {
      const word = match[2];
      if (word === 'AND' || word === 'OR' || word === 'NOT') {
        tokens.push(word);
      } else {
        const hasStar = word.endsWith('*');
        const cleaned = word.replace(/[^\w\d_-]/g, '').replace(/-/g, ' ').trim();
        if (!cleaned) continue;
        if (cleaned.includes(' ')) {
          tokens.push(`"${cleaned}"`);
        } else {
          tokens.push(hasStar ? `${cleaned}*` : cleaned);
        }
      }
    }
  }

  // Ensure operators don't lead/trail invalidly
  while (tokens.length > 0 && (tokens[0] === 'AND' || tokens[0] === 'OR' || tokens[0] === 'NOT')) {
    tokens.shift();
  }
  while (
    tokens.length > 0 &&
    (tokens[tokens.length - 1] === 'AND' ||
      tokens[tokens.length - 1] === 'OR' ||
      tokens[tokens.length - 1] === 'NOT')
  ) {
    tokens.pop();
  }

  return tokens.join(' ');
}

/**
 * Evaluates active keyword alert rules deterministically using FTS5 MATCH.
 */
export function evaluateAlertRules(targetBillId?: string): number {
  const rules = db
    .prepare(`SELECT * FROM alert_rules WHERE is_active = 1`)
    .all() as Array<{
    id: string;
    name: string;
    query: string;
    session: string;
    chamber: string;
    committee: string;
    politician: string;
  }>;

  let inserted = 0;
  const now = new Date().toISOString();

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO alert_events (id, rule_id, bill_id, amendment_id, match_type, snippet, triggered_at, is_read)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `);

  for (const rule of rules) {
    const ftsQuery = buildSafeFtsQuery(rule.query);
    if (!ftsQuery) continue;

    try {
      const billSql = `
        SELECT b.id, b.session, b.chamber, b.committees_json, b.primary_author, b.coauthors_json,
               snippet(bills_fts, -1, '<mark class="fts-hit">', '</mark>', ' … ', 18) AS hit_snippet
        FROM bills_fts
        JOIN bills b ON b.id = bills_fts.bill_id
        WHERE bills_fts MATCH ?
        ${targetBillId ? 'AND b.id = ?' : ''}
        LIMIT 40
      `;
      const params = targetBillId ? [ftsQuery, targetBillId] : [ftsQuery];
      const billHits = db.prepare(billSql).all(...params) as Array<{
        id: string;
        session: string;
        chamber: string;
        committees_json: string;
        primary_author: string;
        coauthors_json: string;
        hit_snippet: string;
      }>;

      for (const hit of billHits) {
        if (rule.session && hit.session !== rule.session) continue;
        if (rule.chamber && hit.chamber !== rule.chamber) continue;
        if (rule.committee && !hit.committees_json.toLowerCase().includes(rule.committee.toLowerCase())) {
          continue;
        }
        if (
          rule.politician &&
          !hit.primary_author.toLowerCase().includes(rule.politician.toLowerCase()) &&
          !hit.coauthors_json.toLowerCase().includes(rule.politician.toLowerCase())
        ) {
          continue;
        }
        const eventId = `evt-${rule.id}-${hit.id}`;
        const info = insertStmt.run(eventId, rule.id, hit.id, null, 'bill', hit.hit_snippet, now);
        inserted += info.changes;
      }

      const amendSql = `
        SELECT a.id AS amendment_id, a.bill_id, b.session, b.chamber, b.committees_json, a.sponsor,
               snippet(amendments_fts, -1, '<mark class="fts-hit">', '</mark>', ' … ', 18) AS hit_snippet
        FROM amendments_fts
        JOIN amendments a ON a.id = amendments_fts.amendment_id
        JOIN bills b ON b.id = a.bill_id
        WHERE amendments_fts MATCH ?
        ${targetBillId ? 'AND a.bill_id = ?' : ''}
        LIMIT 30
      `;
      const amendHits = db.prepare(amendSql).all(...params) as Array<{
        amendment_id: string;
        bill_id: string;
        session: string;
        chamber: string;
        committees_json: string;
        sponsor: string;
        hit_snippet: string;
      }>;

      for (const hit of amendHits) {
        if (rule.session && hit.session !== rule.session) continue;
        if (rule.chamber && hit.chamber !== rule.chamber) continue;
        if (rule.committee && !hit.committees_json.toLowerCase().includes(rule.committee.toLowerCase())) {
          continue;
        }
        if (rule.politician && !hit.sponsor.toLowerCase().includes(rule.politician.toLowerCase())) {
          continue;
        }
        const eventId = `evt-${rule.id}-${hit.bill_id}-${hit.amendment_id}`;
        const info = insertStmt.run(
          eventId,
          rule.id,
          hit.bill_id,
          hit.amendment_id,
          'amendment',
          hit.hit_snippet,
          now
        );
        inserted += info.changes;
      }
    } catch {
      // Skip malformed user rule queries gracefully
    }
  }

  return inserted;
}

export function slugifyLegislatorName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface UpsertLegislatorInput {
  shortName: string;
  chamber: 'House' | 'Senate';
  fullName?: string;
  session?: string;
  billsAuthored?: number;
  billsPassed?: number;
  bio?: string;
}

export function upsertLegislatorRecord(input: UpsertLegislatorInput): boolean {
  const shortName = input.shortName.replace(/\s+/g, ' ').trim();
  if (!shortName || /^(unassigned|et al\.?|committee|unknown)$/i.test(shortName)) {
    return false;
  }

  const chamber = input.chamber === 'Senate' ? 'Senate' : 'House';
  const titlePrefix = chamber === 'Senate' ? 'Sen.' : 'Rep.';
  const cleanFull = input.fullName ? input.fullName.replace(/\s+/g, ' ').trim() : '';
  const displayName = cleanFull ? `${titlePrefix} ${cleanFull}` : `${titlePrefix} ${shortName}`;

  const existing = db
    .prepare(
      `SELECT id, name, short_name, bills_authored, bills_passed, leadership_role
       FROM politicians
       WHERE LOWER(short_name) = LOWER(?) AND chamber = ?`
    )
    .get(shortName, chamber) as
    | {
        id: string;
        name: string;
        short_name: string;
        bills_authored: number;
        bills_passed: number;
        leadership_role: string;
      }
    | undefined;

  if (existing) {
    const nextAuthored = Math.max(existing.bills_authored || 0, input.billsAuthored ?? 0);
    const nextPassed = Math.max(existing.bills_passed || 0, input.billsPassed ?? 0);
    // Only replace auto-generated short placeholder name (e.g. "Rep. Capriglione") if we now have full first+last name
    const isAutoPlaceholder =
      existing.name.toLowerCase() === `${titlePrefix.toLowerCase()} ${existing.short_name.toLowerCase()}`;
    const nextName = cleanFull && isAutoPlaceholder ? displayName : existing.name;
    const nextRole =
      existing.leadership_role || (input.session ? `Member (${input.session})` : '');

    if (
      nextName !== existing.name ||
      nextAuthored !== existing.bills_authored ||
      nextPassed !== existing.bills_passed ||
      nextRole !== existing.leadership_role
    ) {
      db.prepare(
        `UPDATE politicians
         SET name = ?, bills_authored = ?, bills_passed = ?, leadership_role = ?
         WHERE id = ?`
      ).run(nextName, nextAuthored, nextPassed, nextRole, existing.id);
    }
    return false;
  }

  const slug = slugifyLegislatorName(shortName) || `member-${Date.now()}`;
  const baseId = `pol-${chamber === 'Senate' ? 's' : 'h'}-${slug}`;
  const idCollision = db.prepare(`SELECT id FROM politicians WHERE id = ?`).get(baseId);
  const id = idCollision ? `${baseId}-${Math.random().toString(36).slice(2, 6)}` : baseId;

  db.prepare(
    `INSERT OR IGNORE INTO politicians
     (id, name, short_name, chamber, district, party, tenure_years, leadership_role, bio, total_raised, bills_authored, bills_passed)
     VALUES (?, ?, ?, ?, '', '—', 0, ?, ?, 0, ?, ?)`
  ).run(
    id,
    displayName,
    shortName,
    chamber,
    input.session ? `Member (${input.session})` : '',
    input.bio || `Texas ${chamber} legislator indexed from Texas Legislature Online (TLO).`,
    input.billsAuthored ?? 0,
    input.billsPassed ?? 0
  );
  return true;
}

export function backfillPoliticiansFromBills(): number {
  const rows = db
    .prepare(
      `SELECT session, chamber, stage, primary_author, coauthors_json, sponsors_json, cosponsors_json
       FROM bills`
    )
    .all() as Array<{
    session: string;
    chamber: 'House' | 'Senate';
    stage: string;
    primary_author: string;
    coauthors_json: string;
    sponsors_json: string;
    cosponsors_json: string;
  }>;

  const stats = new Map<
    string,
    { shortName: string; chamber: 'House' | 'Senate'; authored: number; passed: number; latestSession: string }
  >();

  const bump = (rawName: string, ch: 'House' | 'Senate', isPrimary: boolean, isPassed: boolean, sess: string) => {
    const clean = (rawName || '').replace(/\s+/g, ' ').trim();
    if (!clean || /^(unassigned|et al\.?|committee|unknown)$/i.test(clean)) return;
    const key = `${ch}::${clean.toLowerCase()}`;
    const cur = stats.get(key) ?? {
      shortName: clean,
      chamber: ch,
      authored: 0,
      passed: 0,
      latestSession: sess,
    };
    if (isPrimary) {
      cur.authored++;
      if (isPassed) cur.passed++;
    }
    if (sess > cur.latestSession) cur.latestSession = sess;
    stats.set(key, cur);
  };

  for (const r of rows) {
    const billChamber: 'House' | 'Senate' = r.chamber === 'Senate' ? 'Senate' : 'House';
    const oppChamber: 'House' | 'Senate' = billChamber === 'House' ? 'Senate' : 'House';
    const passed = r.stage === 'Signed' || r.stage === 'Enrolled';

    bump(r.primary_author, billChamber, true, passed, r.session);
    for (const ca of JSON.parse(r.coauthors_json || '[]') as string[]) {
      bump(ca, billChamber, false, false, r.session);
    }
    for (const sp of JSON.parse(r.sponsors_json || '[]') as string[]) {
      bump(sp, oppChamber, false, false, r.session);
    }
    for (const csp of JSON.parse(r.cosponsors_json || '[]') as string[]) {
      bump(csp, oppChamber, false, false, r.session);
    }
  }

  let created = 0;
  const runTx = db.transaction(() => {
    for (const entry of stats.values()) {
      if (
        upsertLegislatorRecord({
          shortName: entry.shortName,
          chamber: entry.chamber,
          session: entry.latestSession,
          billsAuthored: entry.authored,
          billsPassed: entry.passed,
        })
      ) {
        created++;
      }
    }
  });
  runTx();
  return created;
}

