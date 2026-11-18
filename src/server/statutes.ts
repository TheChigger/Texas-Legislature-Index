import * as ftp from 'basic-ftp';
import { Writable } from 'stream';
import zlib from 'zlib';
import { db } from './db.ts';
import { htmlToCleanPlainText } from './textClean.ts';

export interface TexasCodeCatalogEntry {
  code: string;
  zipCode: string;
  codeId: number;
  name: string;
}

export const TEXAS_CODE_CATALOG: TexasCodeCatalogEntry[] = [
  { code: 'CN', zipCode: 'CN', codeId: 31, name: 'Texas Constitution' },
  { code: 'AG', zipCode: 'ag', codeId: 1, name: 'Agriculture Code' },
  { code: 'AL', zipCode: 'al', codeId: 2, name: 'Alcoholic Beverage Code' },
  { code: 'BC', zipCode: 'bc', codeId: 3, name: 'Business & Commerce Code' },
  { code: 'BO', zipCode: 'bo', codeId: 4, name: 'Business Organizations Code' },
  { code: 'CP', zipCode: 'cp', codeId: 5, name: 'Civil Practice & Remedies Code' },
  { code: 'CR', zipCode: 'cr', codeId: 7, name: 'Code of Criminal Procedure' },
  { code: 'CV', zipCode: 'cv', codeId: 8, name: 'Vernon’s Civil Statutes' },
  { code: 'ED', zipCode: 'ed', codeId: 9, name: 'Education Code' },
  { code: 'EL', zipCode: 'el', codeId: 10, name: 'Election Code' },
  { code: 'ES', zipCode: 'es', codeId: 11, name: 'Estates Code' },
  { code: 'FA', zipCode: 'fa', codeId: 12, name: 'Family Code' },
  { code: 'FI', zipCode: 'fi', codeId: 13, name: 'Finance Code' },
  { code: 'GV', zipCode: 'gv', codeId: 14, name: 'Government Code' },
  { code: 'HR', zipCode: 'hr', codeId: 15, name: 'Human Resources Code' },
  { code: 'HS', zipCode: 'hs', codeId: 16, name: 'Health & Safety Code' },
  { code: 'IN', zipCode: 'in', codeId: 17, name: 'Insurance Code' },
  { code: 'I1', zipCode: 'i1', codeId: 18, name: 'Insurance Code (Not Codified)' },
  { code: 'LA', zipCode: 'la', codeId: 19, name: 'Labor Code' },
  { code: 'LG', zipCode: 'lg', codeId: 20, name: 'Local Government Code' },
  { code: 'NR', zipCode: 'nr', codeId: 21, name: 'Natural Resources Code' },
  { code: 'OC', zipCode: 'oc', codeId: 22, name: 'Occupations Code' },
  { code: 'PW', zipCode: 'pw', codeId: 23, name: 'Parks & Wildlife Code' },
  { code: 'PE', zipCode: 'pe', codeId: 24, name: 'Penal Code' },
  { code: 'PR', zipCode: 'pr', codeId: 25, name: 'Property Code' },
  { code: 'SD', zipCode: 'sd', codeId: 26, name: 'Special District Local Laws Code' },
  { code: 'TX', zipCode: 'tx', codeId: 27, name: 'Tax Code' },
  { code: 'TN', zipCode: 'tn', codeId: 28, name: 'Transportation Code' },
  { code: 'UT', zipCode: 'ut', codeId: 29, name: 'Utilities Code' },
  { code: 'WA', zipCode: 'wa', codeId: 30, name: 'Water Code' },
  { code: 'WL', zipCode: 'wl', codeId: 32, name: 'Auxiliary Water Laws' },
];

/**
 * Pure-Node ZIP Central Directory extractor (supports Store=0 and Deflate=8).
 */
function extractZipHtmlEntries(zipBuffer: Buffer): Array<{ fileName: string; content: string }> {
  const entries: Array<{ fileName: string; content: string }> = [];

  // Locate End of Central Directory record (PK\x05\x06)
  let eocdOffset = -1;
  const minOffset = Math.max(0, zipBuffer.length - 65557);
  for (let pos = zipBuffer.length - 22; pos >= minOffset; pos--) {
    if (zipBuffer.readUInt32LE(pos) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) return entries;

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  let cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries && cdOffset + 46 <= zipBuffer.length; i++) {
    if (zipBuffer.readUInt32LE(cdOffset) !== 0x02014b50) break;
    const compMethod = zipBuffer.readUInt16LE(cdOffset + 10);
    const compSize = zipBuffer.readUInt32LE(cdOffset + 20);
    const fnameLen = zipBuffer.readUInt16LE(cdOffset + 28);
    const extraLen = zipBuffer.readUInt16LE(cdOffset + 30);
    const commentLen = zipBuffer.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cdOffset + 42);
    const fileName = zipBuffer.toString('utf8', cdOffset + 46, cdOffset + 46 + fnameLen);

    if (
      (fileName.toLowerCase().endsWith('.htm') || fileName.toLowerCase().endsWith('.html')) &&
      localHeaderOffset + 30 <= zipBuffer.length &&
      zipBuffer.readUInt32LE(localHeaderOffset) === 0x04034b50
    ) {
      const lFnameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lFnameLen + lExtraLen;
      const compressedSlice = zipBuffer.subarray(dataStart, dataStart + compSize);
      try {
        const rawBuf =
          compMethod === 0
            ? compressedSlice
            : compMethod === 8
              ? zlib.inflateRawSync(compressedSlice)
              : null;
        if (rawBuf) {
          entries.push({ fileName, content: rawBuf.toString('utf8') });
        }
      } catch {
        // Skip unreadable ZIP entry
      }
    }

    cdOffset += 46 + fnameLen + extraLen + commentLen;
  }

  return entries;
}

function stripStatuteHtml(html: string): string {
  return htmlToCleanPlainText(html);
}

export function extractActsSessions(actsText: string): string[] {
  const matches = Array.from(actsText.matchAll(/(\d+(?:st|nd|rd|th))\s+Leg\./gi)).map((m) =>
    m[1].toLowerCase()
  );
  return Array.from(new Set(matches));
}

function parseChapterHtmlIntoSections(
  code: string,
  codeName: string,
  fileName: string,
  html: string
): Array<{
  id: string;
  code: string;
  codeName: string;
  chapter: string;
  chapterTitle: string;
  sectionNumber: string;
  sectionTitle: string;
  fullText: string;
  actsHistory: string;
  sessionsAmended: string[];
  lastAmendedSession: string;
}> {
  const plain = stripStatuteHtml(html);
  const chapMatch = plain.match(/(?:CHAPTER|ARTICLE)\s+([0-9A-Z]+(?:\.[0-9A-Z]+)?)\.\s*([^\n]{2,120})/i);
  const fallbackChap = fileName.replace(/^[^.]+\./, '').replace(/\.htm$/i, '').toUpperCase();
  const chapter = chapMatch ? chapMatch[1].trim() : fallbackChap;
  const chapterTitle = chapMatch ? chapMatch[2].trim() : `Chapter ${chapter}`;

  // Match Sec. 12.01. TITLE. or Art. 2.12. TITLE. or Sec. 1. TITLE.
  const secRegex = /(?:^|\n)\s*((?:Sec\.|Art\.)\s+[0-9A-Za-z.-]+)\.\s+([^\n.]{2,140})\./g;
  const matches = Array.from(plain.matchAll(secRegex));

  if (matches.length === 0) {
    // Store whole chapter/article if section headers don't match standard pattern
    const actsLines = plain.match(/(?:Acts\s+\d{4}|Amended by Acts[\s\S]*?$)/i)?.[0]?.trim() ?? '';
    const sessions = extractActsSessions(actsLines);
    return [
      {
        id: `${code}-${chapter}`,
        code,
        codeName,
        chapter,
        chapterTitle,
        sectionNumber: chapter,
        sectionTitle: chapterTitle,
        fullText: plain,
        actsHistory: actsLines,
        sessionsAmended: sessions,
        lastAmendedSession: sessions[sessions.length - 1] ?? '',
      },
    ];
  }

  const sections: Array<{
    id: string;
    code: string;
    codeName: string;
    chapter: string;
    chapterTitle: string;
    sectionNumber: string;
    sectionTitle: string;
    fullText: string;
    actsHistory: string;
    sessionsAmended: string[];
    lastAmendedSession: string;
  }> = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? plain.length) : plain.length;
    const body = plain.slice(start, end).trim();
    const sectionNumber = m[1].replace(/^(?:Sec\.|Art\.)\s+/i, '').trim();
    const sectionTitle = m[2].trim();

    // Extract legislative history tail (Acts ..., Amended by Acts ...)
    const actsMatch = body.match(/((?:Acts|Added by Acts|Amended by Acts|Redesignated[\s\S]*?Acts)[\s\S]+)$/i);
    const actsHistory = actsMatch ? actsMatch[1].replace(/\n+/g, ' ').trim() : '';
    const sessions = extractActsSessions(actsHistory);

    sections.push({
      id: `${code}-${sectionNumber}`,
      code,
      codeName,
      chapter,
      chapterTitle,
      sectionNumber,
      sectionTitle,
      fullText: body,
      actsHistory,
      sessionsAmended: sessions,
      lastAmendedSession: sessions[sessions.length - 1] ?? '',
    });
  }

  return sections;
}

export async function syncTexasCodeFromTloFtp(
  codeInput: string,
  chapterLimit?: number
): Promise<{
  code: string;
  codeName: string;
  chaptersSynced: number;
  sectionsIndexed: number;
}> {
  const entry = TEXAS_CODE_CATALOG.find(
    (c) => c.code.toUpperCase() === codeInput.toUpperCase() || c.zipCode.toUpperCase() === codeInput.toUpperCase()
  );
  if (!entry) {
    throw new Error(`Unknown Texas statutory code: ${codeInput}`);
  }

  const client = new ftp.Client(20000);
  try {
    await client.access({ host: 'ftp.legis.state.tx.us' });
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });

    await client.downloadTo(writable, `/pub/statutes/${entry.zipCode}.htm.zip`);
    const zipBuffer = Buffer.concat(chunks);
    const htmlFiles = extractZipHtmlEntries(zipBuffer);
    const targetFiles = chapterLimit && chapterLimit > 0 ? htmlFiles.slice(0, chapterLimit) : htmlFiles;

    const allSections: ReturnType<typeof parseChapterHtmlIntoSections> = [];
    for (const file of targetFiles) {
      if (/toc|index|contents/i.test(file.fileName)) continue;
      const parsed = parseChapterHtmlIntoSections(entry.code, entry.name, file.fileName, file.content);
      allSections.push(...parsed);
    }

    const insertSection = db.prepare(`
      INSERT OR REPLACE INTO statute_sections
      (id, code, code_name, chapter, chapter_title, section_number, section_title, full_text, acts_history, sessions_amended_json, last_amended_session, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const sec of allSections) {
        insertSection.run(
          sec.id,
          sec.code,
          sec.codeName,
          sec.chapter,
          sec.chapterTitle,
          sec.sectionNumber,
          sec.sectionTitle,
          sec.fullText,
          sec.actsHistory,
          JSON.stringify(sec.sessionsAmended),
          sec.lastAmendedSession,
          `ftp://ftp.legis.state.tx.us/pub/statutes/${entry.zipCode}.htm.zip`
        );
      }
      const countRow = db
        .prepare(`SELECT COUNT(*) AS c FROM statute_sections WHERE code = ?`)
        .get(entry.code) as { c: number };
      db.prepare(
        `INSERT OR REPLACE INTO statutes_codes (code, zip_code, code_id, name, chapter_count, section_count, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.code,
        entry.zipCode,
        entry.codeId,
        entry.name,
        targetFiles.length,
        countRow.c,
        new Date().toISOString()
      );
    });

    tx();

    return {
      code: entry.code,
      codeName: entry.name,
      chaptersSynced: targetFiles.length,
      sectionsIndexed: allSections.length,
    };
  } finally {
    client.close();
  }
}

/**
 * Fetches a point-in-time historical snapshot of a Texas statute section (since Jan 1, 2004)
 * from the Texas Legislative Council's public StatutesByDate service.
 */
export async function fetchStatuteSnapshotByDate(
  code: string,
  sectionNumber: string,
  snapshotDate: string
): Promise<{
  id: string;
  sectionId: string;
  code: string;
  sectionNumber: string;
  snapshotDate: string;
  headerText: string;
  fullText: string;
  actsHistory: string;
  source: string;
  fetchedAt: string;
}> {
  const upperCode = code.toUpperCase();
  const entry = TEXAS_CODE_CATALOG.find((c) => c.code === upperCode);
  if (!entry) {
    throw new Error(`Unsupported Texas code for StatutesByDate lookup: ${code}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate) || snapshotDate < '2004-01-01') {
    throw new Error('Historical statute snapshots require YYYY-MM-DD format on or after 2004-01-01.');
  }

  const sectionId = `${upperCode}-${sectionNumber}`;
  const existing = db
    .prepare(
      `SELECT id, section_id AS sectionId, code, section_number AS sectionNumber,
              snapshot_date AS snapshotDate, header_text AS headerText,
              full_text AS fullText, acts_history AS actsHistory,
              source, fetched_at AS fetchedAt
       FROM statute_snapshots
       WHERE section_id = ? AND snapshot_date = ?`
    )
    .get(sectionId, snapshotDate) as
    | {
        id: string;
        sectionId: string;
        code: string;
        sectionNumber: string;
        snapshotDate: string;
        headerText: string;
        fullText: string;
        actsHistory: string;
        source: string;
        fetchedAt: string;
      }
    | undefined;

  if (existing) return existing;

  const base = 'https://tcss.legis.texas.gov/api/StatutesByDate';
  const cleanSec = sectionNumber.replace(/^(?:Sec\.|Art\.)\s+/i, '').trim();
  const chapterGuess = cleanSec.split('.')[0];

  let hid = 0;
  let ahid = 0;
  let headerText = `${entry.name} Sec. ${cleanSec}`;

  if (upperCode === 'CV') {
    const secs = (await fetch(`${base}/GetArtSecList/8/CV/AS/0/${snapshotDate}`).then((r) =>
      r.json()
    )) as Array<{ text: string; value: string; url: string }>;
    const match = secs.find((s) => s.url === cleanSec || s.text.includes(cleanSec));
    if (match && match.value.includes('.')) {
      const parts = match.value.split('.');
      hid = Number(parts[0]);
      ahid = Number(parts[1]);
      headerText = match.text;
    }
  } else {
    const chapMode = upperCode === 'CN' ? 'AR' : 'CH';
    const chaps = (await fetch(
      `${base}/GetChapters/${entry.codeId}/${chapMode}/${snapshotDate}`
    ).then((r) => r.json())) as Array<{ text: string; value: string; url: string }>;

    const targetChap = chaps.find(
      (c) =>
        c.url === chapterGuess ||
        c.text.toUpperCase().includes(`CHAPTER ${chapterGuess}.`) ||
        c.text.toUpperCase().includes(`ARTICLE ${chapterGuess}.`)
    );

    if (!targetChap || !targetChap.value.includes('.')) {
      throw new Error(
        `Chapter/Article ${chapterGuess} of ${entry.name} did not exist or was not found on ${snapshotDate}.`
      );
    }

    const chapHid = Number(targetChap.value.split('.')[0]);
    const secMode = ['BA', 'CR', 'I1', 'PB', 'WL'].includes(upperCode) ? 'AS' : 'SE';
    const secs = (await fetch(
      `${base}/GetArtSecList/${entry.codeId}/${upperCode}/${secMode}/${chapHid}/${snapshotDate}`
    ).then((r) => r.json())) as Array<{ text: string; value: string; url: string }>;

    const match = secs.find(
      (s) =>
        s.url?.toUpperCase() === cleanSec.toUpperCase() ||
        s.text.toUpperCase().includes(` ${cleanSec.toUpperCase()}.`)
    );
    if (!match || !match.value.includes('.')) {
      throw new Error(
        `Section ${cleanSec} of ${entry.name} did not exist on ${snapshotDate} (it may have been enacted after that date or repealed earlier).`
      );
    }

    const parts = match.value.split('.');
    hid = Number(parts[0]);
    ahid = Number(parts[1]);
    headerText = `${targetChap.text} — ${match.text}`;
  }

  const bodyRes = await fetch(`${base}/GetStatuteBody/${hid}/${ahid}/${snapshotDate}`);
  if (!bodyRes.ok) {
    throw new Error(`StatutesByDate returned HTTP ${bodyRes.status} for ${sectionId} on ${snapshotDate}`);
  }
  const bodyJson = (await bodyRes.json()) as { statuteBody?: string; hadText?: boolean };
  const plainBody = stripStatuteHtml(bodyJson.statuteBody || '');
  if (!plainBody) {
    throw new Error(`No statute body returned for ${sectionId} on ${snapshotDate}`);
  }

  const actsMatch = plainBody.match(/((?:Acts|Added by Acts|Amended by Acts)[\s\S]+)$/i);
  const actsHistory = actsMatch ? actsMatch[1].replace(/\n+/g, ' ').trim() : '';
  const fetchedAt = new Date().toISOString();
  const snapId = `${sectionId}-${snapshotDate}`;

  db.prepare(
    `INSERT OR REPLACE INTO statute_snapshots
     (id, section_id, code, section_number, snapshot_date, header_text, full_text, acts_history, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapId,
    sectionId,
    upperCode,
    cleanSec,
    snapshotDate,
    headerText,
    plainBody,
    actsHistory,
    `tcss.legis.texas.gov/api/StatutesByDate (${snapshotDate})`,
    fetchedAt
  );

  return {
    id: snapId,
    sectionId,
    code: upperCode,
    sectionNumber: cleanSec,
    snapshotDate,
    headerText,
    fullText: plainBody,
    actsHistory,
    source: `tcss.legis.texas.gov/api/StatutesByDate (${snapshotDate})`,
    fetchedAt,
  };
}
