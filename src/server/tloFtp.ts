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

export interface TloSessionInfo {
  code: string;
  label: string;
  years: string;
}

export interface TloSyncOptions {
  session: string;
  billTypes?: Array<'house_bills' | 'senate_bills' | 'house_joint_resolutions' | 'senate_joint_resolutions'>;
  limit?: number;
  startNumber?: number;
  includeBillText?: boolean;
}

export interface TloSyncResult {
  session: string;
  ingestedCount: number;
  amendmentsIngested: number;
  witnessesIngested: number;
  linksCreated: number;
  alertsTriggered: number;
  bills: Array<{ id: string; billNumber: string; title: string; stage: string }>;
  sourceHost: string;
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
  const committeeName = comMatch ? comMatch[1].replace(/^(?:HOUSE|SENATE)\s+COMMITTEE\s+REPORT\s+/i, '').trim() : defaultCommittee;
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
  const m = cleaned.match(/^([A-Z]+)\s+(\d+)$/);
  const prefix = m ? m[1] : 'HB';
  const num = m ? parseInt(m[2], 10) : 1;
  const chamber: Chamber = prefix.startsWith('S') ? 'Senate' : 'House';
  const padded = `${prefix}${String(num).padStart(5, '0')}`;
  const bucketStart = Math.floor((num - 1) / 100) * 100 + 1;
  const bucketEnd = bucketStart + 99;
  const bucket = `${prefix}${String(bucketStart).padStart(5, '0')}_${prefix}${String(bucketEnd).padStart(5, '0')}`;
  return { chamber, prefix, num, padded, bucket };
}

async function downloadString(client: ftp.Client, remotePath: string): Promise<string> {
  let buffer = '';
  const writable = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString('utf8');
      cb();
    },
  });
  await client.downloadTo(writable, remotePath);
  return buffer;
}

export async function listTloFtpSessions(): Promise<TloSessionInfo[]> {
  const client = new ftp.Client(8000);
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

export async function syncFromTloFtp(options: TloSyncOptions): Promise<TloSyncResult> {
  const session = options.session.trim();
  const billTypes = options.billTypes?.length
    ? options.billTypes
    : ['house_bills', 'senate_bills'];
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 80);
  const startNumber = Math.max(options.startNumber ?? 1, 1);
  const includeBillText = options.includeBillText !== false;

  const client = new ftp.Client(12000);
  const ingestedBills: Array<{ id: string; billNumber: string; title: string; stage: string }> = [];
  let amendmentsIngested = 0;
  let witnessesIngested = 0;
  let linksCreated = 0;

  try {
    await client.access({ host: 'ftp.legis.state.tx.us' });

    const sessMeta = formatSessionMetadata(session);
    db.prepare(
      `INSERT OR IGNORE INTO sessions (code, label, years, synced_at, bill_count)
       VALUES (?, ?, ?, ?, 0)`
    ).run(sessMeta.code, sessMeta.label, sessMeta.years, new Date().toISOString());

    const perTypeLimit = Math.max(1, Math.ceil(limit / billTypes.length));

    for (const billType of billTypes) {
      if (ingestedBills.length >= limit) break;
      const baseDir = `/bills/${session}/billhistory/${billType}`;
      let buckets: ftp.FileInfo[] = [];
      try {
        buckets = await client.list(baseDir);
      } catch {
        continue;
      }

      const sortedBuckets = buckets
        .filter((b) => b.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name));

      const candidateFiles: Array<{ remotePath: string; fileName: string; num: number }> = [];

      for (const bucket of sortedBuckets) {
        const rangeMatch = bucket.name.match(/(\d+)_[A-Z]+(\d+)/);
        if (rangeMatch) {
          const rangeEnd = parseInt(rangeMatch[2], 10);
          if (rangeEnd < startNumber) continue;
        }

        let files: ftp.FileInfo[] = [];
        try {
          files = await client.list(`${baseDir}/${bucket.name}`);
        } catch {
          continue;
        }

        const xmlFiles = files
          .filter((f) => f.name.toLowerCase().endsWith('.xml'))
          .map((f) => {
            const m = f.name.match(/(\d+)\.xml$/i);
            return {
              remotePath: `${baseDir}/${bucket.name}/${f.name}`,
              fileName: f.name,
              num: m ? parseInt(m[1], 10) : 999999,
            };
          })
          .filter((f) => f.num >= startNumber)
          .sort((a, b) => a.num - b.num);

        candidateFiles.push(...xmlFiles);
        if (candidateFiles.length >= perTypeLimit) break;
      }

      const toFetch = candidateFiles.slice(0, perTypeLimit);

      for (const item of toFetch) {
        if (ingestedBills.length >= limit) break;
        try {
          const xml = await downloadString(client, item.remotePath);
          const rawBillAttr = xml.match(/bill="([^"]+)"/i)?.[1] ?? '';
          const billNumber = rawBillAttr.replace(/^\d+\([A-Z0-9]+\)\s*/i, '').trim() || item.fileName.replace(/\.xml$/i, '');
          const billId = `${session}-${billNumber.replace(/\s+/g, '')}`;
          const meta = parseBillNumberMeta(billNumber);

          const caption = extractTag(xml, 'caption') || `${billNumber} (${session})`;
          const lastAction = extractTag(xml, 'lastaction');
          const lastActionDateMatch = lastAction.match(/^(\d{2}\/\d{2}\/\d{4})/);
          const lastActionDate = lastActionDateMatch ? lastActionDateMatch[1] : '';

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

          // Optionally fetch actual HTML bill versions from TLO FTP
          let latestText = caption;
          const versionRows: Array<{
            id: string;
            versionCode: string;
            versionLabel: string;
            text: string;
            sortOrder: number;
          }> = [];

          if (includeBillText) {
            const textDir = `/bills/${session}/billtext/html/${billType}/${meta.bucket}`;
            try {
              const textFiles = await client.list(textDir);
              const matching = textFiles
                .filter((tf) => tf.name.toUpperCase().startsWith(meta.padded) && tf.name.toLowerCase().endsWith('.htm'))
                .sort((a, b) => a.name.localeCompare(b.name));

              const orderMap: Record<string, number> = { I: 1, H: 2, E: 3, S: 4, F: 5 };
              for (const tf of matching) {
                const vMatch = tf.name.match(/([IHESF])\.htm$/i);
                const vCode = vMatch ? vMatch[1].toUpperCase() : 'I';
                const html = await downloadString(client, `${textDir}/${tf.name}`);
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
              }
              versionRows.sort((a, b) => a.sortOrder - b.sortOrder);
              if (versionRows.length > 0) {
                latestText = versionRows[versionRows.length - 1].text;
              }
            } catch {
              // Bill text directory might not exist for some early pre-files
            }
          }

          const primaryAuthor = authors[0] || 'Unassigned';
          const statuteMatches = Array.from(
            new Set(
              latestText.match(
                /(?:Education|Tax|Utilities|Government|Health and Safety|Water|Penal|Insurance|Finance|Local Government|Property|Transportation)\s+Code/gi
              ) ?? []
            )
          );

          db.prepare(
            `INSERT OR REPLACE INTO bills (
              id, session, bill_number, chamber, title, summary, statute_codes, status, stage,
              primary_author, coauthors_json, sponsors_json, cosponsors_json, committees_json,
              subjects_json, last_action, last_action_date, filed_date, source, full_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            billId,
            session,
            billNumber,
            meta.chamber,
            caption,
            `TLO FTP Record (${session} ${billNumber}) — ${lastAction || 'Filed in ' + meta.chamber}. Primary author: ${primaryAuthor}.`,
            JSON.stringify(statuteMatches),
            lastAction || stage,
            stage,
            primaryAuthor,
            JSON.stringify(coauthors),
            JSON.stringify(sponsors),
            JSON.stringify(cosponsors),
            JSON.stringify(committees),
            JSON.stringify(subjects),
            lastAction,
            lastActionDate,
            filedDate,
            `ftp://ftp.legis.state.tx.us/bills/${session}`,
            latestText
          );

          db.prepare(`DELETE FROM bill_actions WHERE bill_id = ?`).run(billId);
          const insertAct = db.prepare(
            `INSERT OR REPLACE INTO bill_actions (id, bill_id, action_date, action_number, description)
             VALUES (?, ?, ?, ?, ?)`
          );
          for (const act of parsedActions) {
            insertAct.run(act.id, billId, act.actionDate, act.actionNumber, act.description);
          }

          for (const vr of versionRows) {
            db.prepare(
              `INSERT OR REPLACE INTO amendments (
                id, bill_id, version_code, version_label, amendment_number, sponsor, filed_date,
                disposition, yea_votes, nay_votes, pnv_votes, summary, full_text, sort_order
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              vr.id,
              billId,
              vr.versionCode,
              vr.versionLabel,
              `${billNumber} (${vr.versionCode})`,
              primaryAuthor,
              filedDate,
              vr.versionCode === 'F' ? 'Enacted' : vr.versionCode === 'I' ? 'Filed' : 'Substituted',
              committees[0]?.ayeVotes ?? 0,
              committees[0]?.nayVotes ?? 0,
              0,
              `${vr.versionLabel} downloaded from TLO FTP`,
              vr.text,
              vr.sortOrder
            );
            syncAmendmentFts(vr.id);
            amendmentsIngested++;
          }

          // Parse <companions> for automatic cross-bill linking
          const companionsXml = extractTag(xml, 'companions');
          const companionMatches = companionsXml.matchAll(/<bill[^>]*>([^<]+)<\/bill>/gi);
          for (const cmMatch of companionMatches) {
            const compNum = cmMatch[1].trim();
            const targetId = `${session}-${compNum.replace(/\s+/g, '')}`;
            const exists = db.prepare(`SELECT id FROM bills WHERE id = ?`).get(targetId);
            if (exists) {
              db.prepare(
                `INSERT OR IGNORE INTO bill_links (id, source_bill_id, target_bill_id, link_type, notes, created_at)
                 VALUES (?, ?, ?, 'Companion', 'Imported from TLO <companions> metadata', ?)`
              ).run(`lnk-${billId}-${targetId}`, billId, targetId, new Date().toISOString());
              linksCreated++;
            }
          }

          syncBillFts(billId);

          // Fetch real TLO committee witness lists (witlistbill/html) if present
          try {
            const witDir = `/bills/${session}/witlistbill/html/${billType}/${meta.bucket}`;
            const witFiles = await client.list(witDir);
            const matchingWit = witFiles.filter(
              (wf) => wf.name.toUpperCase().startsWith(meta.padded) && wf.name.toLowerCase().endsWith('.htm')
            );
            const insertWit = db.prepare(
              `INSERT OR REPLACE INTO witness_registrations
               (id, bill_id, chamber, committee_name, hearing_date, witness_name, affiliation, is_citizen_self, position, testified, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const wf of matchingWit) {
              const witHtml = await downloadString(client, `${witDir}/${wf.name}`);
              const witChamber: Chamber = wf.name.toUpperCase().endsWith('S.HTM') ? 'Senate' : 'House';
              const parsedWit = parseWitnessListHtml(
                witHtml,
                billId,
                witChamber,
                committees[0]?.name || 'Standing Committee'
              );
              for (const w of parsedWit) {
                insertWit.run(
                  `${w.id}-${witChamber}`,
                  billId,
                  witChamber,
                  w.committeeName,
                  w.hearingDate,
                  w.witnessName,
                  w.affiliation,
                  w.isCitizenSelf,
                  w.position,
                  w.testified,
                  `TLO FTP witlistbill (${session})`
                );
                witnessesIngested++;
              }
            }
          } catch {
            // Witness list may not exist for bills without hearings
          }

          recomputeBillMetrics(billId);
          ingestedBills.push({ id: billId, billNumber, title: caption, stage });
        } catch {
          // Skip individual malformed or unreachable bill file
        }
      }
    }

    db.prepare(`UPDATE sessions SET synced_at = ? WHERE code = ?`).run(new Date().toISOString(), session);
    refreshSessionCounts();
    const alertsTriggered = evaluateAlertRules();

    return {
      session,
      ingestedCount: ingestedBills.length,
      amendmentsIngested,
      witnessesIngested,
      linksCreated,
      alertsTriggered,
      bills: ingestedBills,
      sourceHost: 'ftp://ftp.legis.state.tx.us',
    };
  } finally {
    client.close();
  }
}
