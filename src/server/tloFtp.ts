import * as ftp from 'basic-ftp';
import { Writable } from 'stream';
import {
  db,
  evaluateAlertRules,
  recomputeBillMetrics,
  refreshSessionCounts,
  syncAmendmentFts,
  syncBillFts,
} from './db.ts';
import type { BillStage, Chamber } from '../types.ts';

export type TloBillType =
  | 'house_bills'
  | 'senate_bills'
  | 'house_joint_resolutions'
  | 'senate_joint_resolutions';

export interface TloSessionInfo {
  code: string;
  label: string;
  years: string;
}

export interface TloSyncOptions {
  session: string;
  billTypes?: TloBillType[];
  limit?: number;
  startNumber?: number;
  includeBillText?: boolean;
  includeWitnesses?: boolean;
  skipUnchanged?: boolean;
  concurrency?: number;
}

export interface TloSyncResult {
  session: string;
  ingestedCount: number;
  skippedCount?: number;
  failedCount?: number;
  amendmentsIngested: number;
  witnessesIngested: number;
  linksCreated: number;
  alertsTriggered: number;
  bills: Array<{ id: string; billNumber: string; title: string; stage: string }>;
  sourceHost: string;
}

export type TloSyncJobStatus =
  | 'discovering'
  | 'syncing'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface TloSyncJob {
  id: string;
  session: string;
  mode: 'full' | 'batch';
  billTypes: TloBillType[];
  includeBillText: boolean;
  includeWitnesses: boolean;
  skipUnchanged: boolean;
  concurrency: number;
  status: TloSyncJobStatus;
  phase: string;
  startedAt: string;
  finishedAt: string | null;
  totalDiscovered: number;
  processedCount: number;
  ingestedCount: number;
  skippedCount: number;
  failedCount: number;
  amendmentsIngested: number;
  witnessesIngested: number;
  linksCreated: number;
  alertsTriggered: number;
  recentBills: Array<{ id: string; billNumber: string; title: string; stage: string }>;
  error: string | null;
  sourceHost: string;
}

interface InternalJobState extends TloSyncJob {
  cancelRequested: boolean;
}

interface DiscoveredBillItem {
  billType: TloBillType;
  bucketName: string;
  remotePath: string;
  fileName: string;
  num: number;
}

const activeJobs = new Map<string, InternalJobState>();
const jobOrder: string[] = [];

function serializeJob(job: InternalJobState): TloSyncJob {
  const { cancelRequested: _ignored, ...pub } = job;
  return {
    ...pub,
    recentBills: [...pub.recentBills],
  };
}

function parseWitnessListHtml(
  html: string,
  billId: string,
  chamber: Chamber,
  defaultCommittee: string
): Array<{
  id: string;
  committeeName: string;
  hearingDate: string;
  witnessName: string;
  affiliation: string;
  isCitizenSelf: number;
  position: 'For' | 'Against' | 'On';
  testified: number;
}> {
  const clean = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/&#xa0;|&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const comMatch = clean.match(/([A-Za-z0-9 &,-]+?)\s+Committee\s+([A-Z][a-z]+\s+\d+,\s+\d{4})/i);
  const committeeName = comMatch
    ? comMatch[1].replace(/^(?:HOUSE|SENATE)\s+COMMITTEE\s+REPORT\s+/i, '').trim()
    : defaultCommittee;
  const hearingDate = comMatch ? comMatch[2].trim() : '';

  const results: Array<{
    id: string;
    committeeName: string;
    hearingDate: string;
    witnessName: string;
    affiliation: string;
    isCitizenSelf: number;
    position: 'For' | 'Against' | 'On';
    testified: number;
  }> = [];

  const regMarker = clean.indexOf('Registering, but not testifying:');
  const sections: Array<{ text: string; testified: number }> =
    regMarker >= 0
      ? [
          { text: clean.slice(0, regMarker), testified: 1 },
          { text: clean.slice(regMarker), testified: 0 },
        ]
      : [{ text: clean, testified: 1 }];

  let seq = 0;
  for (const sec of sections) {
    const posMatches = Array.from(sec.text.matchAll(/\b(For|Against|On)\s*:/gi));
    for (let i = 0; i < posMatches.length; i++) {
      const pos = posMatches[i][1] as 'For' | 'Against' | 'On';
      const normalizedPos: 'For' | 'Against' | 'On' =
        pos.toLowerCase() === 'for' ? 'For' : pos.toLowerCase() === 'against' ? 'Against' : 'On';
      const start = (posMatches[i].index ?? 0) + posMatches[i][0].length;
      const end = i + 1 < posMatches.length ? (posMatches[i + 1].index ?? sec.text.length) : sec.text.length;
      const chunk = sec.text.slice(start, end);

      const entryRegex = /([A-Z][A-Za-z'., -]{2,50}?)\s*\(([^()]{2,90})\)/g;
      let em: RegExpExecArray | null;
      while ((em = entryRegex.exec(chunk)) !== null) {
        const witnessName = em[1].replace(/^\d+\s+WITNESS LIST.*$/i, '').trim();
        const affiliation = em[2].trim();
        if (!witnessName || witnessName.length < 3) continue;
        const isCitizenSelf = /^self$/i.test(affiliation) ? 1 : 0;
        seq++;
        results.push({
          id: `${billId}-wit-${seq}`,
          committeeName: committeeName || 'Committee Hearing',
          hearingDate,
          witnessName,
          affiliation,
          isCitizenSelf,
          position: normalizedPos,
          testified: sec.testified,
        });
        if (results.length >= 1000) return results;
      }
    }
  }
  return results;
}

function formatSessionMetadata(code: string): TloSessionInfo {
  const numMatch = code.match(/^(\d+)([RrSs\d]*)$/);
  if (!numMatch) return { code, label: `Session ${code}`, years: '' };
  const legNum = parseInt(numMatch[1], 10);
  const suffix = numMatch[2].toUpperCase();
  const baseYear = 1989 + (legNum - 71) * 2;
  const years = `${baseYear}–${baseYear + 1}`;
  if (suffix === 'R') {
    return { code, label: `${legNum}th Regular Session`, years };
  }
  const specialNum = suffix.replace(/[^0-9]/g, '') || '1';
  return { code, label: `${legNum}th Special Session #${specialNum}`, years };
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(regex);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

function extractAllTags(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    results.push(decodeXmlEntities(m[1].trim()));
  }
  return results;
}

function htmlToPlainText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<(?:p|div|tr|li|br|h[1-6])[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim()
  );
}

function inferStageFromTlo(lastAction: string, committees: Array<{ status: string }>): BillStage {
  const lower = lastAction.toLowerCase();
  if (lower.includes('signed by the governor') || lower.includes('effective')) return 'Signed';
  if (lower.includes('vetoed')) return 'Vetoed';
  if (lower.includes('enrolled')) return 'Enrolled';
  if (lower.includes('engrossed') || lower.includes('passed to third reading') || lower.includes('passed')) {
    return 'Engrossed';
  }
  if (committees.some((c) => c.status.toLowerCase().includes('out of committee'))) {
    return 'Committee Reported';
  }
  if (lower.includes('referred to') || lower.includes('hearing') || committees.length > 0) {
    return 'Committee Hearing';
  }
  if (lower.includes('pre-filed') || lower.includes('prefiled')) return 'Pre-Filed';
  return 'Filed';
}

function parseBillNumberMeta(billNumber: string): {
  chamber: Chamber;
  prefix: string;
  num: number;
  padded: string;
  bucket: string;
} {
  const cleaned = billNumber.replace(/\s+/g, ' ').trim().toUpperCase();
  const m = cleaned.match(/^([A-Z]+)\s*(\d+)$/);
  const prefix = m ? m[1] : 'HB';
  const num = m ? parseInt(m[2], 10) : 1;
  const chamber: Chamber = prefix.startsWith('S') ? 'Senate' : 'House';
  const padded = `${prefix}${String(num).padStart(5, '0')}`;
  const bucketStart = num < 100 ? 1 : Math.floor(num / 100) * 100;
  const bucketEnd = num < 100 ? 99 : bucketStart + 99;
  const bucket = `${prefix}${String(bucketStart).padStart(5, '0')}_${prefix}${String(bucketEnd).padStart(5, '0')}`;
  return { chamber, prefix, num, padded, bucket };
}

async function downloadString(client: ftp.Client, remotePath: string): Promise<string> {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  await client.downloadTo(writable, remotePath);
  return Buffer.concat(chunks).toString('utf8');
}

async function ensureFtpConnected(clientRef: { current: ftp.Client }): Promise<ftp.Client> {
  if (!clientRef.current.closed) {
    return clientRef.current;
  }
  const fresh = new ftp.Client(15000);
  await fresh.access({ host: 'ftp.legis.state.tx.us' });
  clientRef.current = fresh;
  return fresh;
}

async function withFtpRetry<T>(
  clientRef: { current: ftp.Client },
  operation: (client: ftp.Client) => Promise<T>
): Promise<T> {
  try {
    const c = await ensureFtpConnected(clientRef);
    return await operation(c);
  } catch (err) {
    const code = (err as { code?: number | string })?.code;
    // Do not retry permanent 550 "file/directory not found" errors
    if (code === 550) {
      throw err;
    }
    try {
      clientRef.current.close();
    } catch {
      // ignore close errors
    }
    const fresh = new ftp.Client(15000);
    await fresh.access({ host: 'ftp.legis.state.tx.us' });
    clientRef.current = fresh;
    return await operation(fresh);
  }
}

export async function listTloFtpSessions(): Promise<TloSessionInfo[]> {
  const client = new ftp.Client(10000);
  try {
    await client.access({ host: 'ftp.legis.state.tx.us' });
    const list = await client.list('/bills');
    const codes = list
      .filter((item) => item.isDirectory && /^\d+[A-Z0-9]+$/i.test(item.name))
      .map((item) => item.name)
      .sort((a, b) => {
        const na = parseInt(a, 10);
        const nb = parseInt(b, 10);
        if (na !== nb) return nb - na;
        return b.localeCompare(a);
      });
    return codes.map(formatSessionMetadata);
  } finally {
    client.close();
  }
}

const VERSION_LABELS: Record<string, string> = {
  I: 'Introduced (As Filed)',
  H: 'House Committee Report',
  S: 'Senate Committee Report',
  E: 'Engrossed',
  F: 'Enrolled (Final)',
};

/**
 * Shared bucket directory index: lists each 100-bill directory ONCE across all workers
 * and indexes filenames by bill prefix (e.g. HB00001 -> ['HB00001I.htm', 'HB00001E.htm']).
 */
function createBucketIndexCache(session: string, subRoot: 'billtext/html' | 'witlistbill/html') {
  const cache = new Map<string, Promise<Map<string, string[]>>>();

  return (
    clientRef: { current: ftp.Client },
    billType: TloBillType,
    bucket: string
  ): Promise<Map<string, string[]>> => {
    const key = `${billType}/${bucket}`;
    const existing = cache.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const index = new Map<string, string[]>();
      const dirPath = `/bills/${session}/${subRoot}/${billType}/${bucket}`;
      try {
        const files = await withFtpRetry(clientRef, (c) => c.list(dirPath));
        for (const f of files) {
          if (!f.name.toLowerCase().endsWith('.htm')) continue;
          const prefixMatch = f.name.toUpperCase().match(/^([A-Z]+\d{5})/);
          if (!prefixMatch) continue;
          const pfx = prefixMatch[1];
          const list = index.get(pfx);
          if (list) list.push(f.name);
          else index.set(pfx, [f.name]);
        }
        for (const list of index.values()) {
          list.sort((a, b) => a.localeCompare(b));
        }
      } catch {
        // Directory may not exist for early pre-files or sessions with no hearings yet
      }
      return index;
    })();

    cache.set(key, promise);
    return promise;
  };
}

interface CoreIngestParams {
  session: string;
  billTypes: TloBillType[];
  limit: number | null;
  startNumber: number;
  includeBillText: boolean;
  includeWitnesses: boolean;
  skipUnchanged: boolean;
  concurrency: number;
  job?: InternalJobState;
}

async function runConcurrentTloSync(params: CoreIngestParams): Promise<TloSyncResult> {
  const {
    session,
    billTypes,
    limit,
    startNumber,
    includeBillText,
    includeWitnesses,
    skipUnchanged,
    concurrency,
    job,
  } = params;

  const sessMeta = formatSessionMetadata(session);
  db.prepare(
    `INSERT OR IGNORE INTO sessions (code, label, years, synced_at, bill_count)
     VALUES (?, ?, ?, ?, 0)`
  ).run(sessMeta.code, sessMeta.label, sessMeta.years, new Date().toISOString());

  // 1. Discover bill XML files using a single discovery client
  const discoveryRef = { current: new ftp.Client(15000) };
  const candidates: DiscoveredBillItem[] = [];

  try {
    await discoveryRef.current.access({ host: 'ftp.legis.state.tx.us' });
    const perTypeLimit = limit !== null ? Math.max(1, Math.ceil(limit / billTypes.length)) : null;

    for (const billType of billTypes) {
      if (job?.cancelRequested) break;
      if (limit !== null && candidates.length >= limit) break;

      if (job) {
        job.phase = `Scanning ${session} ${billType.replace(/_/g, ' ')} directories…`;
      }

      const baseDir = `/bills/${session}/billhistory/${billType}`;
      let buckets: ftp.FileInfo[] = [];
      try {
        buckets = await withFtpRetry(discoveryRef, (c) => c.list(baseDir));
      } catch {
        continue;
      }

      const sortedBuckets = buckets
        .filter((b) => b.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name));

      const typeCandidates: DiscoveredBillItem[] = [];
      for (const bucket of sortedBuckets) {
        if (job?.cancelRequested) break;

        const rangeMatch = bucket.name.match(/(\d+)_[A-Z]+(\d+)/);
        if (rangeMatch) {
          const rangeEnd = parseInt(rangeMatch[2], 10);
          if (rangeEnd < startNumber) continue;
        }

        let files: ftp.FileInfo[] = [];
        try {
          files = await withFtpRetry(discoveryRef, (c) => c.list(`${baseDir}/${bucket.name}`));
        } catch {
          continue;
        }

        const xmlFiles = files
          .filter((f) => f.name.toLowerCase().endsWith('.xml'))
          .map((f) => {
            const m = f.name.match(/(\d+)\.xml$/i);
            return {
              billType,
              bucketName: bucket.name,
              remotePath: `${baseDir}/${bucket.name}/${f.name}`,
              fileName: f.name,
              num: m ? parseInt(m[1], 10) : 999999,
            };
          })
          .filter((f) => f.num >= startNumber)
          .sort((a, b) => a.num - b.num);

        typeCandidates.push(...xmlFiles);
        if (job) {
          job.totalDiscovered = candidates.length + typeCandidates.length;
        }
        if (perTypeLimit !== null && typeCandidates.length >= perTypeLimit) break;
      }

      const chosen = perTypeLimit !== null ? typeCandidates.slice(0, perTypeLimit) : typeCandidates;
      candidates.push(...chosen);
      if (job) {
        job.totalDiscovered = candidates.length;
      }
    }
  } finally {
    try {
      discoveryRef.current.close();
    } catch {
      // ignore
    }
  }

  if (job?.cancelRequested) {
    return {
      session,
      ingestedCount: job.ingestedCount,
      skippedCount: job.skippedCount,
      failedCount: job.failedCount,
      amendmentsIngested: job.amendmentsIngested,
      witnessesIngested: job.witnessesIngested,
      linksCreated: job.linksCreated,
      alertsTriggered: job.alertsTriggered,
      bills: job.recentBills,
      sourceHost: 'ftp://ftp.legis.state.tx.us',
    };
  }

  const finalQueue = limit !== null ? candidates.slice(0, limit) : candidates;
  if (job) {
    job.totalDiscovered = finalQueue.length;
    job.status = 'syncing';
    job.phase =
      finalQueue.length === 0
        ? `No matching XML files found in ${session}.`
        : `Syncing ${finalQueue.length.toLocaleString()} bills across ${concurrency} FTP workers…`;
  }

  // Prepared SQLite statements reused across all workers (better-sqlite3 is synchronous on main thread)
  const selectExistingStmt = db.prepare(
    `SELECT last_action, last_action_date, amendment_count FROM bills WHERE id = ?`
  );
  const upsertBillStmt = db.prepare(
    `INSERT OR REPLACE INTO bills (
      id, session, bill_number, chamber, title, summary, statute_codes, status, stage,
      primary_author, coauthors_json, sponsors_json, cosponsors_json, committees_json,
      subjects_json, last_action, last_action_date, filed_date, source, full_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const deleteActionsStmt = db.prepare(`DELETE FROM bill_actions WHERE bill_id = ?`);
  const insertActionStmt = db.prepare(
    `INSERT OR REPLACE INTO bill_actions (id, bill_id, action_date, action_number, description)
     VALUES (?, ?, ?, ?, ?)`
  );
  const upsertAmendStmt = db.prepare(
    `INSERT OR REPLACE INTO amendments (
      id, bill_id, version_code, version_label, amendment_number, sponsor, filed_date,
      disposition, yea_votes, nay_votes, pnv_votes, summary, full_text, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const checkBillExistsStmt = db.prepare(`SELECT id FROM bills WHERE id = ?`);
  const insertLinkStmt = db.prepare(
    `INSERT OR IGNORE INTO bill_links (id, source_bill_id, target_bill_id, link_type, notes, created_at)
     VALUES (?, ?, ?, 'Companion', 'Imported from TLO <companions> metadata', ?)`
  );
  const deleteWitnessesStmt = db.prepare(`DELETE FROM witness_registrations WHERE bill_id = ? AND source LIKE 'TLO FTP%'`);
  const insertWitnessStmt = db.prepare(
    `INSERT OR REPLACE INTO witness_registrations
     (id, bill_id, chamber, committee_name, hearing_date, witness_name, affiliation, is_citizen_self, position, testified, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const getTextBucket = createBucketIndexCache(session, 'billtext/html');
  const getWitBucket = createBucketIndexCache(session, 'witlistbill/html');

  const ingestedBills: Array<{ id: string; billNumber: string; title: string; stage: string }> = [];
  let ingestedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let amendmentsIngested = 0;
  let witnessesIngested = 0;
  let linksCreated = 0;
  let processedCount = 0;
  let cursor = 0;

  const persistBillTransaction = db.transaction(
    (payload: {
      billId: string;
      billNumber: string;
      chamber: Chamber;
      caption: string;
      primaryAuthor: string;
      coauthors: string[];
      sponsors: string[];
      cosponsors: string[];
      committees: Array<{ name: string; chamber: Chamber; status: string; ayeVotes: number; nayVotes: number }>;
      subjects: string[];
      statuteMatches: string[];
      lastAction: string;
      lastActionDate: string;
      filedDate: string;
      stage: BillStage;
      latestText: string;
      parsedActions: Array<{ id: string; actionDate: string; actionNumber: string; description: string }>;
      versionRows: Array<{ id: string; versionCode: string; versionLabel: string; text: string; sortOrder: number }>;
      companionNums: string[];
      witnessRows: Array<{
        id: string;
        chamber: Chamber;
        committeeName: string;
        hearingDate: string;
        witnessName: string;
        affiliation: string;
        isCitizenSelf: number;
        position: 'For' | 'Against' | 'On';
        testified: number;
      }>;
    }) => {
      upsertBillStmt.run(
        payload.billId,
        session,
        payload.billNumber,
        payload.chamber,
        payload.caption,
        `TLO FTP Record (${session} ${payload.billNumber}) — ${payload.lastAction || 'Filed in ' + payload.chamber}. Primary author: ${payload.primaryAuthor}.`,
        JSON.stringify(payload.statuteMatches),
        payload.lastAction || payload.stage,
        payload.stage,
        payload.primaryAuthor,
        JSON.stringify(payload.coauthors),
        JSON.stringify(payload.sponsors),
        JSON.stringify(payload.cosponsors),
        JSON.stringify(payload.committees),
        JSON.stringify(payload.subjects),
        payload.lastAction,
        payload.lastActionDate,
        payload.filedDate,
        `ftp://ftp.legis.state.tx.us/bills/${session}`,
        payload.latestText
      );

      deleteActionsStmt.run(payload.billId);
      for (const act of payload.parsedActions) {
        insertActionStmt.run(act.id, payload.billId, act.actionDate, act.actionNumber, act.description);
      }

      for (const vr of payload.versionRows) {
        upsertAmendStmt.run(
          vr.id,
          payload.billId,
          vr.versionCode,
          vr.versionLabel,
          `${payload.billNumber} (${vr.versionCode})`,
          payload.primaryAuthor,
          payload.filedDate,
          vr.versionCode === 'F' ? 'Enacted' : vr.versionCode === 'I' ? 'Filed' : 'Substituted',
          payload.committees[0]?.ayeVotes ?? 0,
          payload.committees[0]?.nayVotes ?? 0,
          0,
          `${vr.versionLabel} downloaded from TLO FTP`,
          vr.text,
          vr.sortOrder
        );
        syncAmendmentFts(vr.id);
      }

      let addedLinks = 0;
      for (const compNum of payload.companionNums) {
        const targetId = `${session}-${compNum.replace(/\s+/g, '')}`;
        if (checkBillExistsStmt.get(targetId)) {
          const info = insertLinkStmt.run(
            `lnk-${payload.billId}-${targetId}`,
            payload.billId,
            targetId,
            new Date().toISOString()
          );
          addedLinks += info.changes;
        }
      }

      if (payload.witnessRows.length > 0) {
        deleteWitnessesStmt.run(payload.billId);
        for (const w of payload.witnessRows) {
          insertWitnessStmt.run(
            w.id,
            payload.billId,
            w.chamber,
            w.committeeName,
            w.hearingDate,
            w.witnessName,
            w.affiliation,
            w.isCitizenSelf,
            w.position,
            w.testified,
            `TLO FTP witlistbill (${session})`
          );
        }
      }

      syncBillFts(payload.billId);
      recomputeBillMetrics(payload.billId);
      return addedLinks;
    }
  );

  const workerCount = Math.min(Math.max(concurrency, 1), Math.max(1, finalQueue.length));

  const runWorker = async () => {
    const clientRef = { current: new ftp.Client(15000) };
    try {
      await clientRef.current.access({ host: 'ftp.legis.state.tx.us' });

      while (true) {
        if (job?.cancelRequested) break;
        const myIdx = cursor++;
        if (myIdx >= finalQueue.length) break;

        const item = finalQueue[myIdx];
        try {
          const xml = await withFtpRetry(clientRef, (c) => downloadString(c, item.remotePath));
          const rawBillAttr = xml.match(/bill="([^"]+)"/i)?.[1] ?? '';
          const billNumber =
            rawBillAttr.replace(/^\d+\([A-Z0-9]+\)\s*/i, '').trim() ||
            item.fileName.replace(/\.xml$/i, '');
          const billId = `${session}-${billNumber.replace(/\s+/g, '')}`;
          const meta = parseBillNumberMeta(billNumber);

          const caption = extractTag(xml, 'caption') || `${billNumber} (${session})`;
          const lastAction = extractTag(xml, 'lastaction');
          const lastActionDateMatch = lastAction.match(/^(\d{2}\/\d{2}\/\d{4})/);
          const lastActionDate = lastActionDateMatch ? lastActionDateMatch[1] : '';

          if (skipUnchanged) {
            const existing = selectExistingStmt.get(billId) as
              | { last_action: string; last_action_date: string; amendment_count: number }
              | undefined;
            if (
              existing &&
              existing.last_action === lastAction &&
              existing.last_action_date === lastActionDate &&
              (!includeBillText || existing.amendment_count > 0)
            ) {
              skippedCount++;
              processedCount++;
              if (job) {
                job.skippedCount = skippedCount;
                job.processedCount = processedCount;
              }
              continue;
            }
          }

          const authors = extractTag(xml, 'authors')
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean);
          const coauthors = extractTag(xml, 'coauthors')
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean);
          const sponsors = extractTag(xml, 'sponsors')
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean);
          const cosponsors = extractTag(xml, 'cosponsors')
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean);

          const subjectsXml = extractTag(xml, 'subjects');
          const subjects = extractAllTags(subjectsXml, 'subject').map((s) =>
            s.replace(/\s*\([A-Z0-9]+\)$/, '').trim()
          );

          const committeesXml = extractTag(xml, 'committees');
          const committees: Array<{
            name: string;
            chamber: Chamber;
            status: string;
            ayeVotes: number;
            nayVotes: number;
          }> = [];
          const comRegex = /<(house|senate)\s+([^>]+?)\/?>/gi;
          let cm: RegExpExecArray | null;
          while ((cm = comRegex.exec(committeesXml)) !== null) {
            const cChamber: Chamber = cm[1].toLowerCase() === 'senate' ? 'Senate' : 'House';
            const attrs = cm[2];
            const name = decodeXmlEntities(attrs.match(/name="([^"]*)"/i)?.[1] ?? '');
            const status = decodeXmlEntities(attrs.match(/status="([^"]*)"/i)?.[1] ?? 'Pending');
            const ayeVotes = parseInt(attrs.match(/ayeVotes="(\d+)"/i)?.[1] ?? '0', 10);
            const nayVotes = parseInt(attrs.match(/nayVotes="(\d+)"/i)?.[1] ?? '0', 10);
            if (name) {
              committees.push({ name, chamber: cChamber, status, ayeVotes, nayVotes });
            }
          }

          const actionsXml = extractTag(xml, 'actions');
          const actionBlocks = extractAllTags(actionsXml, 'action');
          const parsedActions = actionBlocks.map((block, idx) => ({
            id: `${billId}-act-${idx + 1}`,
            actionDate: extractTag(block, 'date'),
            actionNumber: extractTag(block, 'actionNumber'),
            description: extractTag(block, 'description'),
          }));

          const filedDate = parsedActions[0]?.actionDate || lastActionDate || 'Pre-Filed';
          const stage = inferStageFromTlo(lastAction, committees);

          let latestText = caption;
          const versionRows: Array<{
            id: string;
            versionCode: string;
            versionLabel: string;
            text: string;
            sortOrder: number;
          }> = [];

          const targetBucket = item.bucketName || meta.bucket;

          if (includeBillText) {
            const bucketMap = await getTextBucket(clientRef, item.billType, targetBucket);
            const matchingNames = bucketMap.get(meta.padded) ?? [];
            const orderMap: Record<string, number> = { I: 1, H: 2, E: 3, S: 4, F: 5 };
            const textDir = `/bills/${session}/billtext/html/${item.billType}/${targetBucket}`;

            for (const fileName of matchingNames) {
              if (job?.cancelRequested) break;
              const vMatch = fileName.match(/([IHESF])\.htm$/i);
              const vCode = vMatch ? vMatch[1].toUpperCase() : 'I';
              try {
                const html = await withFtpRetry(clientRef, (c) =>
                  downloadString(c, `${textDir}/${fileName}`)
                );
                const plain = htmlToPlainText(html);
                if (plain) {
                  versionRows.push({
                    id: `${billId}-ver-${vCode}`,
                    versionCode: vCode,
                    versionLabel: VERSION_LABELS[vCode] ?? `Version ${vCode}`,
                    text: plain,
                    sortOrder: orderMap[vCode] ?? 2,
                  });
                }
              } catch {
                // Skip unreadable HTML version
              }
            }
            versionRows.sort((a, b) => a.sortOrder - b.sortOrder);
            if (versionRows.length > 0) {
              latestText = versionRows[versionRows.length - 1].text;
            }
          }

          const witnessRows: Array<{
            id: string;
            chamber: Chamber;
            committeeName: string;
            hearingDate: string;
            witnessName: string;
            affiliation: string;
            isCitizenSelf: number;
            position: 'For' | 'Against' | 'On';
            testified: number;
          }> = [];

          if (includeWitnesses) {
            const witMap = await getWitBucket(clientRef, item.billType, targetBucket);
            const matchingWit = witMap.get(meta.padded) ?? [];
            const witDir = `/bills/${session}/witlistbill/html/${item.billType}/${targetBucket}`;

            for (const wfName of matchingWit) {
              if (job?.cancelRequested) break;
              try {
                const witHtml = await withFtpRetry(clientRef, (c) =>
                  downloadString(c, `${witDir}/${wfName}`)
                );
                const witChamber: Chamber = wfName.toUpperCase().endsWith('S.HTM')
                  ? 'Senate'
                  : 'House';
                const parsedWit = parseWitnessListHtml(
                  witHtml,
                  billId,
                  witChamber,
                  committees[0]?.name || 'Standing Committee'
                );
                for (const w of parsedWit) {
                  witnessRows.push({
                    id: `${w.id}-${witChamber}`,
                    chamber: witChamber,
                    committeeName: w.committeeName,
                    hearingDate: w.hearingDate,
                    witnessName: w.witnessName,
                    affiliation: w.affiliation,
                    isCitizenSelf: w.isCitizenSelf,
                    position: w.position,
                    testified: w.testified,
                  });
                }
              } catch {
                // Skip unreadable witness HTML
              }
            }
          }

          const companionsXml = extractTag(xml, 'companions');
          const companionNums: string[] = [];
          for (const cmMatch of companionsXml.matchAll(/<bill[^>]*>([^<]+)<\/bill>/gi)) {
            const compNum = cmMatch[1].trim();
            if (compNum) companionNums.push(compNum);
          }

          const primaryAuthor = authors[0] || 'Unassigned';
          const statuteMatches = Array.from(
            new Set(
              latestText.match(
                /(?:Education|Tax|Utilities|Government|Health and Safety|Water|Penal|Insurance|Finance|Local Government|Property|Transportation)\s+Code/gi
              ) ?? []
            )
          );

          const addedLinks = persistBillTransaction({
            billId,
            billNumber,
            chamber: meta.chamber,
            caption,
            primaryAuthor,
            coauthors,
            sponsors,
            cosponsors,
            committees,
            subjects,
            statuteMatches,
            lastAction,
            lastActionDate,
            filedDate,
            stage,
            latestText,
            parsedActions,
            versionRows,
            companionNums,
            witnessRows,
          });

          ingestedCount++;
          amendmentsIngested += versionRows.length;
          witnessesIngested += witnessRows.length;
          linksCreated += addedLinks;
          processedCount++;

          const summaryEntry = { id: billId, billNumber, title: caption, stage };
          if (job) {
            job.ingestedCount = ingestedCount;
            job.amendmentsIngested = amendmentsIngested;
            job.witnessesIngested = witnessesIngested;
            job.linksCreated = linksCreated;
            job.processedCount = processedCount;
            job.recentBills.unshift(summaryEntry);
            if (job.recentBills.length > 25) job.recentBills.length = 25;
            if (ingestedCount % 100 === 0) {
              refreshSessionCounts();
              job.phase = `Syncing ${processedCount.toLocaleString()} / ${finalQueue.length.toLocaleString()} bills (${workerCount} FTP workers)…`;
            }
            if (ingestedCount % 500 === 0) {
              job.alertsTriggered += evaluateAlertRules();
            }
          } else {
            ingestedBills.push(summaryEntry);
          }
        } catch {
          failedCount++;
          processedCount++;
          if (job) {
            job.failedCount = failedCount;
            job.processedCount = processedCount;
          }
        }
      }
    } finally {
      try {
        clientRef.current.close();
      } catch {
        // ignore
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  let finalAlerts = 0;
  if (db.open) {
    db.prepare(`UPDATE sessions SET synced_at = ? WHERE code = ?`).run(new Date().toISOString(), session);
    refreshSessionCounts();
    finalAlerts = evaluateAlertRules();
    if (job) {
      job.alertsTriggered += finalAlerts;
    }
  }

  return {
    session,
    ingestedCount,
    skippedCount,
    failedCount,
    amendmentsIngested,
    witnessesIngested,
    linksCreated,
    alertsTriggered: job ? job.alertsTriggered : finalAlerts,
    bills: job ? job.recentBills : ingestedBills,
    sourceHost: 'ftp://ftp.legis.state.tx.us',
  };
}

export async function syncFromTloFtp(options: TloSyncOptions): Promise<TloSyncResult> {
  const session = options.session.trim();
  const billTypes: TloBillType[] = options.billTypes?.length
    ? options.billTypes
    : ['house_bills', 'senate_bills'];
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  const startNumber = Math.max(options.startNumber ?? 1, 1);
  const includeBillText = options.includeBillText !== false;
  const includeWitnesses = options.includeWitnesses ?? includeBillText;
  const skipUnchanged = options.skipUnchanged ?? false;
  const concurrency = Math.min(Math.max(options.concurrency ?? 4, 1), 6);

  return runConcurrentTloSync({
    session,
    billTypes,
    limit,
    startNumber,
    includeBillText,
    includeWitnesses,
    skipUnchanged,
    concurrency,
  });
}

export interface TloSyncJobOptions {
  session: string;
  mode: 'full' | 'batch';
  billTypes?: TloBillType[];
  limit?: number;
  startNumber?: number;
  includeBillText?: boolean;
  includeWitnesses?: boolean;
  skipUnchanged?: boolean;
  concurrency?: number;
}

export function startTloSyncJob(options: TloSyncJobOptions): TloSyncJob {
  // Reuse active running job if one is already running so modest servers don't double-load FTP
  const existingRunning = getLatestRunningTloSyncJob();
  if (existingRunning) {
    return existingRunning;
  }

  const session = options.session.trim();
  const billTypes: TloBillType[] = options.billTypes?.length
    ? options.billTypes
    : ['house_bills', 'senate_bills'];
  const mode = options.mode === 'batch' ? 'batch' : 'full';
  const limit = mode === 'full' ? null : Math.min(Math.max(options.limit ?? 100, 1), 5000);
  const startNumber = Math.max(options.startNumber ?? 1, 1);
  const includeBillText = options.includeBillText !== false;
  const includeWitnesses = options.includeWitnesses ?? includeBillText;
  const skipUnchanged = options.skipUnchanged !== false;
  const concurrency = Math.min(Math.max(options.concurrency ?? 4, 1), 6);

  const id = `tlo-${session}-${Date.now()}`;
  const job: InternalJobState = {
    id,
    session,
    mode,
    billTypes,
    includeBillText,
    includeWitnesses,
    skipUnchanged,
    concurrency,
    status: 'discovering',
    phase: `Connecting to ftp.legis.state.tx.us for ${session}…`,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalDiscovered: 0,
    processedCount: 0,
    ingestedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    amendmentsIngested: 0,
    witnessesIngested: 0,
    linksCreated: 0,
    alertsTriggered: 0,
    recentBills: [],
    error: null,
    sourceHost: 'ftp://ftp.legis.state.tx.us',
    cancelRequested: false,
  };

  activeJobs.set(id, job);
  jobOrder.unshift(id);
  if (jobOrder.length > 10) {
    const oldId = jobOrder.pop();
    if (oldId) activeJobs.delete(oldId);
  }

  void runConcurrentTloSync({
    session,
    billTypes,
    limit,
    startNumber,
    includeBillText,
    includeWitnesses,
    skipUnchanged,
    concurrency,
    job,
  })
    .then(() => {
      job.status = job.cancelRequested ? 'cancelled' : 'completed';
      job.phase = job.cancelRequested
        ? `Cancelled after ${job.ingestedCount.toLocaleString()} synced (${job.skippedCount.toLocaleString()} skipped).`
        : `Completed ${job.session}: ${job.ingestedCount.toLocaleString()} synced, ${job.skippedCount.toLocaleString()} unchanged skipped.`;
      job.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : 'TLO FTP synchronization failed';
      job.phase = `Sync stopped: ${job.error}`;
      job.finishedAt = new Date().toISOString();
    });

  return serializeJob(job);
}

export function getTloSyncJob(jobId: string): TloSyncJob | undefined {
  const job = activeJobs.get(jobId);
  return job ? serializeJob(job) : undefined;
}

export function getLatestRunningTloSyncJob(): TloSyncJob | undefined {
  for (const id of jobOrder) {
    const job = activeJobs.get(id);
    if (job && (job.status === 'discovering' || job.status === 'syncing')) {
      return serializeJob(job);
    }
  }
  return undefined;
}

export function getLatestTloSyncJob(): TloSyncJob | undefined {
  const running = getLatestRunningTloSyncJob();
  if (running) return running;
  const firstId = jobOrder[0];
  if (!firstId) return undefined;
  const job = activeJobs.get(firstId);
  return job ? serializeJob(job) : undefined;
}

export function cancelTloSyncJob(jobId: string): TloSyncJob | undefined {
  const job = activeJobs.get(jobId);
  if (!job) return undefined;
  job.cancelRequested = true;
  if (job.status === 'discovering' || job.status === 'syncing') {
    job.phase = 'Cancelling after in-flight FTP downloads finish…';
  }
  return serializeJob(job);
}
