export function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const raw = Array.isArray(value)
    ? value.map((item) => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item))).join(' | ')
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return `"${normalized.replace(/"/g, '""')}"`;
}

export function buildCsvContent(headers: string[], rows: Array<Array<unknown>>): string {
  const headerLine = headers.map((h) => escapeCsvCell(h)).join(',');
  const bodyLines = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(','));
  // Prepend UTF-8 BOM so Excel/LibreOffice preserve section symbols and accents cleanly
  return '\uFEFF' + [headerLine, ...bodyLines].join('\r\n');
}

export function downloadCsv(filename: string, headers: string[], rows: Array<Array<unknown>>): void {
  const csv = buildCsvContent(headers, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
