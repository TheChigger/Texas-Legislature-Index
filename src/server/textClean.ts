const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  sbquo: '‚',
  bdquo: '„',
  mdash: '—',
  ndash: '–',
  minus: '−',
  sect: '§',
  para: '¶',
  deg: '°',
  bull: '•',
  middot: '·',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  times: '×',
  divide: '÷',
  plusmn: '±',
  aacute: 'á',
  Aacute: 'Á',
  eacute: 'é',
  Eacute: 'É',
  iacute: 'í',
  Iacute: 'Í',
  oacute: 'ó',
  Oacute: 'Ó',
  uacute: 'ú',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
};

const KNOWN_HTML_TAGS_REGEX =
  /<\/?(?:a|abbr|acronym|address|article|aside|b|base|bdi|bdo|big|blockquote|body|br|button|caption|center|cite|code|col|colgroup|data|dd|del|details|dfn|div|dl|dt|em|fieldset|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|meta|nav|nobr|noscript|o:p|object|ol|optgroup|option|p|param|pre|q|s|samp|script|section|select|small|span|strike|strong|style|sub|summary|sup|table|tbody|td|textarea|tfoot|th|thead|time|title|tr|tt|u|ul|var|wbr)\b[^>]*>/gi;

export function decodeHtmlEntities(input: string): string {
  if (!input) return '';
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const codePoint = parseInt(hex, 16);
      if (Number.isNaN(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return ' ';
      if (codePoint === 0xa0) return ' ';
      return String.fromCodePoint(codePoint);
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const codePoint = parseInt(dec, 10);
      if (Number.isNaN(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return ' ';
      if (codePoint === 0xa0) return ' ';
      return String.fromCodePoint(codePoint);
    })
    .replace(/&([a-zA-Z0-9]+);/g, (full, name: string) => {
      if (name in NAMED_HTML_ENTITIES) return NAMED_HTML_ENTITIES[name];
      const lower = name.toLowerCase();
      if (lower in NAMED_HTML_ENTITIES) return NAMED_HTML_ENTITIES[lower];
      return full;
    })
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function normalizePlainTextWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

/**
 * Converts HTML documents (TLO bill text, analyses, LBB fiscal notes, author reports,
 * Texas Statutes ZIP chapters, StatutesByDate bodies) into clean indexed plain text.
 */
export function htmlToCleanPlainText(rawHtml: string): string {
  if (!rawHtml) return '';
  const stripped = rawHtml
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(
      /<\/?(?:p|div|tr|li|br|hr|h[1-6]|table|thead|tbody|tfoot|blockquote|section|article|header|footer|pre)\b[^>]*>/gi,
      '\n'
    )
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const decoded = decodeHtmlEntities(stripped);
  return normalizePlainTextWhitespace(decoded);
}

/**
 * Sanitizes already-stored plain text (preserving non-HTML angle brackets like "< 5%",
 * while stripping stray HTML tags and decoding leftover HTML/numeric entities).
 */
export function sanitizeStoredPlainText(rawText: string): string {
  if (!rawText) return '';
  const cleaned = rawText
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(KNOWN_HTML_TAGS_REGEX, (tag) =>
      /^<\/?(?:p|div|tr|li|br|hr|h[1-6]|table|blockquote)\b/i.test(tag) ? '\n' : ' '
    );
  const decoded = decodeHtmlEntities(cleaned);
  return normalizePlainTextWhitespace(decoded);
}
