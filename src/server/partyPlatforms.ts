import dns from 'dns';
import net from 'net';
import { getDocumentProxy } from 'unpdf';
import { db } from './db.ts';
import type {
  BillPlatformAlignment,
  DiffWordscoresShift,
  DomainSalienceItem,
  MatchedPlatformPlank,
  PartyPlatformSummary,
  PlatformParty,
  PlatformPlank,
  RileCategoryBreakdown,
  RileDirection,
  ScalingConfidenceTier,
  WordfishDocumentEstimate,
  WordfishResult,
  WordfishWordEstimate,
  WordscoreTermContribution,
  WordscoresVocabEntry,
} from '../types.ts';

// Official 2026 Texas Party Platform PDFs provided by user
export const OFFICIAL_2026_PLATFORMS: Array<{
  id: string;
  party: PlatformParty;
  year: number;
  title: string;
  sourceUrl: string;
}> = [
  {
    id: 'platform-dem-2026',
    party: 'Democratic',
    year: 2026,
    title: 'Texas Democratic Party Platform 2026–2028',
    sourceUrl:
      'https://5aa41392-2958-4609-a10f-4bbd79e2f348.filesusr.com/ugd/061e99_153b98fadd5d43039829c3ce89c47905.pdf',
  },
  {
    id: 'platform-rep-2026',
    party: 'Republican',
    year: 2026,
    title: '2026 Platform and Resolutions of the Republican Party of Texas',
    sourceUrl:
      'https://texasgop.org/wp-content/uploads/2026/07/2026-Republican-Party-of-Texas-Platform-As-Approved.pdf',
  },
];

// ============================================================================
// SECURITY: SAFE PUBLIC URL VALIDATION (SSRF PROTECTION)
// ============================================================================

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.') ||
      lower.startsWith('::ffff:169.254.')
    ) {
      return true;
    }
    return false;
  }
  return true;
}

export async function validatePublicHttpsUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid URL format. Please provide a valid https:// URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Only https:// URLs are permitted for external platform imports.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs containing embedded credentials are not permitted.');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Local and internal hostnames are not permitted.');
  }

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error('Private or loopback IP addresses are not permitted.');
    }
    return parsed;
  }

  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    if (!addrs.length) {
      throw new Error('Could not resolve target hostname.');
    }
    for (const addr of addrs) {
      if (isPrivateOrReservedIp(addr.address)) {
        throw new Error('Target hostname resolves to a restricted network address.');
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('restricted')) throw err;
    throw new Error(`Unable to verify host "${host}" via DNS.`);
  }

  return parsed;
}

// ============================================================================
// TEXT CLEANING & STOPWORDS (FILTERING TEXAS STATUTORY BOILERPLATE)
// ============================================================================

const STANDARD_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'been', 'have',
  'has', 'had', 'not', 'but', 'all', 'any', 'can', 'will', 'may', 'must', 'should', 'would',
  'could', 'their', 'they', 'them', 'our', 'your', 'its', 'who', 'whom', 'which', 'what',
  'when', 'where', 'how', 'why', 'into', 'onto', 'upon', 'over', 'under', 'above', 'below',
  'between', 'among', 'through', 'during', 'before', 'after', 'since', 'until', 'while',
  'about', 'against', 'within', 'without', 'other', 'such', 'more', 'most', 'some', 'many',
  'much', 'each', 'every', 'both', 'either', 'neither', 'than', 'then', 'also', 'only',
  'just', 'even', 'very', 'well', 'still', 'back', 'being', 'does', 'did', 'doing', 'done',
  'these', 'those', 'because', 'whose', 'whether', 'rather', 'another', 'same', 'different',
  'make', 'made', 'making', 'take', 'taken', 'taking', 'give', 'given', 'like', 'including',
  'include', 'includes', 'included', 'ensure', 'ensuring', 'support', 'oppose', 'believe',
  'party', 'platform', 'democratic', 'democrats', 'democrat', 'republican', 'republicans',
  'gop', 'texas', 'texans', 'state', 'united', 'states', 'american', 'americans', 'nation',
  'national', 'people', 'citizens', 'public', 'government', 'federal', 'local', 'county',
  'city', 'municipal', 'agency', 'agencies', 'department', 'commission', 'board', 'office',
  'general', 'certain', 'various', 'new', 'current', 'existing', 'necessary', 'appropriate',
  'available', 'related', 'based', 'using', 'used', 'use', 'need', 'needs', 'needed',
  'provide', 'provides', 'provided', 'providing', 'require', 'requires', 'required',
  'requiring', 'allow', 'allows', 'allowed', 'allowing', 'establish', 'establishes',
  'established', 'establishing', 'create', 'creates', 'created', 'creating', 'promote',
  'protect', 'protecting', 'protects', 'protected', 'encourage', 'increase', 'reduce',
  'improve', 'expand', 'eliminate', 'repeal', 'pass', 'passed', 'urge', 'call', 'demand',
  'affirm', 'recognize', 'shall', 'thereof', 'herein', 'hereto', 'thereto', 'whereas',
  'resolved', 'therefore', 'further', 'furthermore', 'however', 'addition', 'additional',
  'order', 'years', 'year', 'time', 'days', 'day', 'date', 'one', 'two', 'three', 'four',
  'five', 'first', 'second', 'third', 'per', 'percent', 'number', 'total', 'level', 'levels',
  'policy', 'policies', 'program', 'programs', 'legislation', 'law', 'laws', 'issue',
  'issues', 'effort', 'efforts', 'action', 'actions', 'measure', 'measures', 'process',
  'processes', 'system', 'systems', 'service', 'services', 'person', 'persons', 'individual',
  'individuals', 'group', 'groups', 'area', 'areas', 'part', 'parts', 'way', 'ways', 'case',
  'cases', 'purpose', 'purposes', 'continue', 'continuing', 'continued', 'implement',
  'implemented', 'implementation', 'work', 'working', 'help', 'keep', 'full', 'high', 'low',
  'great', 'good', 'best', 'own', 'following', 'regarding', 'concerning', 'across', 'toward',
  'towards', 'especially', 'particularly', 'currently', 'recently', 'already', 'often',
]);

// Texas statutory / legislative drafting boilerplate that must NOT bias Wordscores
const TEXAS_LEGAL_STOPWORDS = new Set([
  'relating', 'section', 'sections', 'chapter', 'chapters', 'subchapter', 'subsection',
  'subsections', 'paragraph', 'paragraphs', 'subdivision', 'clause', 'article', 'title',
  'code', 'codes', 'statute', 'statutes', 'statutory', 'amended', 'amending', 'amendment',
  'amendments', 'adding', 'added', 'repealed', 'repealing', 'enacted', 'enacting', 'enact',
  'legislature', 'legislative', 'bill', 'bills', 'house', 'senate', 'committee', 'chamber',
  'session', 'regular', 'called', 'effective', 'september', 'january', 'governor', 'act',
  'acts', 'provision', 'provisions', 'pursuant', 'notwithstanding', 'applicable', 'defined',
  'definition', 'meaning', 'assigned', 'described', 'specified', 'referenced', 'read',
  'reads', 'follows', 'be', 'it', 'hereby', 'thereby', 'hereunder', 'thereunder', 'tlo',
  'ftp', 'record', 'filed', 'engrossed', 'enrolled', 'signed', 'introduced', 'substitute',
  'fiscal', 'note', 'lbb', 'biennium', 'tac', 'register', 'preamble', 'rule', 'rules',
  'rulemaking', 'proposed', 'adopted', 'withdrawn', 'notice', 'comment', 'comments',
  'adopted', 'page', 'pages', 'contents', 'table', 'plank', 'planks', 'resolution',
  'resolutions', 'member', 'members', 'district', 'chair', 'chairman', 'secretary',
]);

export function tokenizeForScaling(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\b-/g, ' ')
    .replace(/-\b/g, ' ');

  const rawTokens = cleaned.split(/\s+/);
  const out: string[] = [];
  for (const tok of rawTokens) {
    const t = tok.replace(/-/g, '');
    if (t.length < 3 || t.length > 28) continue;
    if (STANDARD_STOPWORDS.has(t) || TEXAS_LEGAL_STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

// ============================================================================
// MARPOR RILE CODEBOOK (BUDGE ET AL.) — 26 OFFICIAL RILE CATEGORIES
// ============================================================================

export interface MarporCategoryDef {
  code: string;
  label: string;
  direction: 'Right' | 'Left';
  patterns: RegExp[];
}

export const MARPOR_RILE_CODEBOOK: MarporCategoryDef[] = [
  // ---- 13 RIGHT-DIRECTION CATEGORIES ----
  {
    code: '104',
    label: 'Military: Positive',
    direction: 'Right',
    patterns: [
      /\b(?:national defense|military strength|armed forces|defense spending|national guard|texas state guard|border security force|pentagon|veterans? defense|missile defense)\b/i,
    ],
  },
  {
    code: '201',
    label: 'Freedom & Human Rights',
    direction: 'Right',
    patterns: [
      /\b(?:individual liberty|unalienable rights?|second amendment|right to keep and bear arms|gun rights?|firearms? rights?|free speech|religious liberty|religious freedom|conscience rights?|medical freedom|bodily autonomy against mandates|vaccine mandate|parental rights?|property rights?|eminent domain)\b/i,
    ],
  },
  {
    code: '203',
    label: 'Constitutionalism: Positive',
    direction: 'Right',
    patterns: [
      /\b(?:u\.?s\.? constitution|texas constitution|constitutional republic|originalism|tenth amendment|state sovereignty|states'? rights|nullif(?:y|ication)|enumerated powers|separation of powers|electoral college|constitutional amendment)\b/i,
    ],
  },
  {
    code: '305',
    label: 'Political Authority',
    direction: 'Right',
    patterns: [
      /\b(?:executive authority|strong leadership|party governance|closed primar(?:y|ies)|election integrity|voter id|citizenship verification|paper ballots?|hand-counted|ban electronic voting|secretary of state oversight)\b/i,
    ],
  },
  {
    code: '401',
    label: 'Free Market Economy',
    direction: 'Right',
    patterns: [
      /\b(?:free market|free enterprise|capitalism|deregulat(?:e|ion)|privatiz(?:e|ation)|private sector|school choice|education savings? account|voucher|abolish (?:the )?(?:irs|epa|department of education|federal reserve)|sound money|gold and silver|cryptocurrency|bitcoin|right to work)\b/i,
    ],
  },
  {
    code: '402',
    label: 'Incentives & Supply-Side',
    direction: 'Right',
    patterns: [
      /\b(?:tax cut|cut taxes|lower taxes|eliminate property tax|abolish property tax|property tax relief|homestead exemption|franchise tax|business friendly|entrepreneur(?:ship|s)?|small business relief|oil and gas production|fossil fuels?|dispatchable|nuclear power|natural gas)\b/i,
    ],
  },
  {
    code: '407',
    label: 'Protectionism: Negative',
    direction: 'Right',
    patterns: [
      /\b(?:free trade|reduce tariffs?|open markets?|eliminate trade barriers?)\b/i,
    ],
  },
  {
    code: '414',
    label: 'Economic Orthodoxy',
    direction: 'Right',
    patterns: [
      /\b(?:balanced budget|fiscal restraint|spending cap|spending limit|cut government spending|reduce debt|national debt|zero-based budgeting|sunset review|audit the fed|inflation|sound fiscal|rainy day fund|taxpayer-funded lobbying)\b/i,
    ],
  },
  {
    code: '505',
    label: 'Welfare State Limitation',
    direction: 'Right',
    patterns: [
      /\b(?:work requirements?|welfare reform|oppose medicaid expansion|limit public assistance|personal responsibility|private charity|health savings? account|repeal (?:the )?(?:aca|affordable care act|obamacare)|market-based healthcare)\b/i,
    ],
  },
  {
    code: '601',
    label: 'National Way of Life: Positive',
    direction: 'Right',
    patterns: [
      /\b(?:border wall|secure the border|illegal immigration|illegal aliens?|deportation|e-verify|sanctuary cit(?:y|ies)|english (?:as )?(?:the )?official language|patriotic education|texas heritage|sovereignty|national security|america first|foreign adversaries?|china|ccp)\b/i,
    ],
  },
  {
    code: '603',
    label: 'Traditional Morality: Positive',
    direction: 'Right',
    patterns: [
      /\b(?:traditional family|sanctity of life|unborn|pro-life|abolish abortion|heartbeat|prayer in schools?|ten commandments|bible|judeo-christian|biological sex|parental consent|faith-based|obscenity|protect children from)\b/i,
    ],
  },
  {
    code: '605',
    label: 'Law and Order: Positive',
    direction: 'Right',
    patterns: [
      /\b(?:law enforcement|back the blue|support police|tough on crime|bail reform|cash bail|mandatory minimum|capital punishment|death penalty|prosecute|cartel|fentanyl|human trafficking|district attorney|crime victim)\b/i,
    ],
  },
  {
    code: '606',
    label: 'Civic Mindedness: Positive',
    direction: 'Right',
    patterns: [
      /\b(?:civic duty|volunteerism|community service|charitable organizations?|meritocracy|colorblind|end dei|diversity,? equity,? and inclusion)\b/i,
    ],
  },

  // ---- 13 LEFT-DIRECTION CATEGORIES ----
  {
    code: '103',
    label: 'Anti-Imperialism',
    direction: 'Left',
    patterns: [
      /\b(?:anti-imperialism|colonialism|end endless wars?|foreign intervention|self-determination|indigenous sovereignty|reparations?)\b/i,
    ],
  },
  {
    code: '105',
    label: 'Military: Negative',
    direction: 'Left',
    patterns: [
      /\b(?:reduce military spending|cut defense budget|demilitariz(?:e|ation)|military-industrial|nuclear disarmament|arms control)\b/i,
    ],
  },
  {
    code: '106',
    label: 'Peace & Diplomacy',
    direction: 'Left',
    patterns: [
      /\b(?:diplomacy|peaceful resolution|ceasefire|humanitarian aid|conflict prevention|global peace)\b/i,
    ],
  },
  {
    code: '107',
    label: 'Internationalism: Positive',
    direction: 'Left',
    patterns: [
      /\b(?:international cooperation|paris climate|united nations|nato|multilateral|refugees?|asylum seekers?|comprehensive immigration reform|pathway to citizenship|daca|dreamers?|humane immigration)\b/i,
    ],
  },
  {
    code: '202',
    label: 'Democracy & Voting Access',
    direction: 'Left',
    patterns: [
      /\b(?:voting rights?|automatic voter registration|online voter registration|mail-in voting|vote by mail|early voting|independent redistricting|end gerrymandering|campaign finance reform|overturn citizens united|john lewis voting rights|equal representation|reproductive freedom|reproductive rights?|abortion access|lgbtq\+?|marriage equality|civil rights?|voting access|racial justice|equity)\b/i,
    ],
  },
  {
    code: '403',
    label: 'Market Regulation',
    direction: 'Left',
    patterns: [
      /\b(?:anti-?trust|break up monopolies?|monopol(?:y|ies)|consumer protection|price gouging|corporate accountability|regulate|oversight|environmental protection|clean air|clean water|climate change|climate crisis|emissions?|renewable energy|solar and wind|carbon|epa|gun safety|background checks?|red flag|assault weapons?|right to repair)\b/i,
    ],
  },
  {
    code: '404',
    label: 'Economic Planning',
    direction: 'Left',
    patterns: [
      /\b(?:green new deal|industrial strategy|public transit|high-speed rail|urban planning|infill development|inclusionary zoning|clean energy transition|grid modernization|interconnect ercot|broadband expansion)\b/i,
    ],
  },
  {
    code: '406',
    label: 'Protectionism: Positive',
    direction: 'Left',
    patterns: [
      /\b(?:buy american|domestic manufacturing|fair trade|protect domestic workers?|trade enforcement)\b/i,
    ],
  },
  {
    code: '412',
    label: 'Controlled Economy',
    direction: 'Left',
    patterns: [
      /\b(?:rent control|price caps?|cap insulin|cap prescription|minimum wage|living wage|\$15|\$20 per hour|progressive tax|tax billionaires?|wealth tax|corporate tax rate|close tax loopholes?)\b/i,
    ],
  },
  {
    code: '413',
    label: 'Nationalization / Public Ownership',
    direction: 'Left',
    patterns: [
      /\b(?:publicly owned|municipal broadband|public banking|single-payer|medicare for all|public option|worker co-?ops?|cooperative ownership)\b/i,
    ],
  },
  {
    code: '504',
    label: 'Welfare State Expansion',
    direction: 'Left',
    patterns: [
      /\b(?:expand medicaid|medicaid expansion|affordable healthcare|universal healthcare|paid family leave|paid sick leave|childcare|child care|affordable housing|public housing|homelessness|social security|snap|food assistance|mental health services?|maternal health|chip|housing assistance)\b/i,
    ],
  },
  {
    code: '506',
    label: 'Education Expansion',
    direction: 'Left',
    patterns: [
      /\b(?:public education|fully fund public schools?|basic allotment|teacher pay|teacher raise|oppose vouchers?|pre-?k|universal pre-?k|special education|student debt|tuition-free|community college|pell grant|public universities?|school meals?|free lunch|public libraries?)\b/i,
    ],
  },
  {
    code: '701',
    label: 'Labour Groups: Positive',
    direction: 'Left',
    patterns: [
      /\b(?:labor union|unions?|collective bargaining|pro act|repeal right-?to-?work|workers'? rights?|workplace safety|osha|heat protection|paid leave|prevailing wage|organized labor|farmworkers?|gig workers?)\b/i,
    ],
  },
];

const MARPOR_BY_CODE = new Map(MARPOR_RILE_CODEBOOK.map((c) => [c.code, c]));

// 10 Texas-Specific Policy Domains for Salience Comparison & Topic-Corpus Wordfish
export const TEXAS_POLICY_DOMAINS: Array<{
  name: string;
  patterns: RegExp[];
}> = [
  {
    name: 'Public Education & Vouchers',
    patterns: [
      /\b(?:school|schools|education|teacher|teachers|student|students|voucher|vouchers|esa|allotment|staar|tea|curriculum|university|universities|college|pre-?k|charter|isd|classroom|tuition|parental rights)\b/i,
    ],
  },
  {
    name: 'Taxes, Budget & Fiscal Policy',
    patterns: [
      /\b(?:tax|taxes|taxation|property tax|homestead|appraisal|budget|appropriations?|spending|fiscal|revenue|comptroller|debt|inflation|tariff|franchise tax|sales tax|billionaires?|rainy day)\b/i,
    ],
  },
  {
    name: 'Energy, Grid & Environment',
    patterns: [
      /\b(?:ercot|grid|electric|electricity|energy|oil|gas|fossil|nuclear|solar|wind|renewable|climate|carbon|emissions?|environment|environmental|epa|pollution|methane|power plant|transmission|utility|utilities|puc)\b/i,
    ],
  },
  {
    name: 'Healthcare & Medicaid',
    patterns: [
      /\b(?:health|healthcare|medicaid|medicare|hospital|hospitals|doctor|medical|insurance|prescription|insulin|mental health|maternal|vaccine|clinic|hhsc|chip|rural health|reproductive|abortion|telehealth)\b/i,
    ],
  },
  {
    name: 'Border, Immigration & Sovereignty',
    patterns: [
      /\b(?:border|immigration|immigrant|immigrants|migrant|asylum|refugee|deportation|e-verify|citizenship|daca|cartel|sanctuary|sovereignty|foreign|china|tariff|national guard|defense|military|veteran)\b/i,
    ],
  },
  {
    name: 'Elections, Democracy & Governance',
    patterns: [
      /\b(?:vote|voter|voters|voting|election|elections|ballot|ballots|redistricting|gerrymandering|primary|primaries|constitution|constitutional|campaign finance|ethics|lobbying|term limits?|open meetings?|transparency)\b/i,
    ],
  },
  {
    name: 'Justice, Firearms & Public Safety',
    patterns: [
      /\b(?:crime|criminal|police|law enforcement|firearm|firearms|gun|guns|second amendment|bail|prison|incarceration|court|courts|judicial|judge|attorney|fentanyl|trafficking|death penalty|sentencing|cannabis|marijuana)\b/i,
    ],
  },
  {
    name: 'Housing, Labor & Economy',
    patterns: [
      /\b(?:housing|zoning|rent|homeowner|mortgage|labor|labour|union|unions|wage|wages|worker|workers|employment|business|monopoly|monopolies|antitrust|consumer|agriculture|farm|ranch|banking|crypto|bitcoin|ai|artificial intelligence|data center)\b/i,
    ],
  },
  {
    name: 'Civil Rights, Privacy & Family',
    patterns: [
      /\b(?:civil rights?|privacy|lgbtq|gender|transgender|marriage|family|families|religious|religion|prayer|faith|speech|censorship|dei|discrimination|disability|disabilities|seniors?|youth|child|children)\b/i,
    ],
  },
  {
    name: 'Water, Infrastructure & Local Control',
    patterns: [
      /\b(?:water|aquifer|desalination|flood|drought|twdb|highway|transportation|transit|rail|road|roads|broadband|internet|local control|preemption|county|municipal|eminent domain|rural|ambulance|ems|infrastructure)\b/i,
    ],
  },
];

export const TEXAS_DOMAIN_NAMES = TEXAS_POLICY_DOMAINS.map((d) => d.name);

function classifyPlankMarpor(text: string): {
  code: string;
  label: string;
  direction: RileDirection;
} {
  let bestCode = '';
  let bestScore = 0;

  for (const cat of MARPOR_RILE_CODEBOOK) {
    let hits = 0;
    for (const re of cat.patterns) {
      const globalRe = new RegExp(re.source, 'gi');
      const matches = text.match(globalRe);
      if (matches) hits += matches.length;
    }
    if (hits > bestScore) {
      bestScore = hits;
      bestCode = cat.code;
    }
  }

  if (!bestCode) {
    return { code: '', label: 'Uncoded / State-Specific', direction: 'Neutral' };
  }
  const def = MARPOR_BY_CODE.get(bestCode)!;
  return { code: def.code, label: def.label, direction: def.direction };
}

export function classifyTexasDomain(text: string): string {
  let bestDomain = 'General Governance';
  let bestHits = 0;
  for (const dom of TEXAS_POLICY_DOMAINS) {
    let hits = 0;
    for (const re of dom.patterns) {
      const globalRe = new RegExp(re.source, 'gi');
      const matches = text.match(globalRe);
      if (matches) hits += matches.length;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestDomain = dom.name;
    }
  }
  return bestDomain;
}

// ============================================================================
// PDF LINE-PRESERVING EXTRACTION & STRUCTURED PLANK SEGMENTATION
// ============================================================================

async function extractPdfLinesFromBuffer(
  buf: Uint8Array
): Promise<{ pageCount: number; pages: string[][] }> {
  const pdf = await getDocumentProxy(buf);
  const pageCount = pdf.numPages;
  const pages: string[][] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines: string[] = [];
    let currentLine = '';
    let lastY: number | null = null;

    for (const rawItem of tc.items) {
      const item = rawItem as { str?: string; hasEOL?: boolean; transform?: number[] };
      const str = typeof item.str === 'string' ? item.str : '';
      const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : null;

      // Skip running footers / page numbers at very bottom of page (y < 50)
      if (y !== null && y < 50) continue;

      if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = str;
      } else {
        if (currentLine && str && !currentLine.endsWith(' ') && !str.startsWith(' ')) {
          // Join without space only for superscripts/punctuation, otherwise add space
          if (/^[.,;:!?)’'"]/.test(str) || /^(?:st|nd|rd|th)\b/i.test(str)) {
            currentLine += str;
          } else {
            currentLine += ' ' + str;
          }
        } else {
          currentLine += str;
        }
      }
      if (y !== null) lastY = y;

      if (item.hasEOL) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = '';
        lastY = null;
      }
    }
    if (currentLine.trim()) lines.push(currentLine.trim());
    pages.push(lines);
  }

  return { pageCount, pages };
}

interface ParsedPlank {
  chapter: string;
  plankNumber: string;
  heading: string;
  body: string;
}

function cleanRunningNoise(line: string): string {
  return line
    .replace(/^\d+\s+Table of Contents\s*/i, '')
    .replace(/^Table of Contents\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRepublicanPlatformPlanks(pages: string[][]): ParsedPlank[] {
  const planks: ParsedPlank[] = [];
  let currentChapter = 'Preamble & Principles';
  let currentPlank: ParsedPlank | null = null;
  let inToc = false;

  const flush = () => {
    if (!currentPlank) return;
    const body = currentPlank.body.replace(/\s+/g, ' ').trim();
    if (body.length >= 25) {
      planks.push({
        chapter: currentPlank.chapter,
        plankNumber: currentPlank.plankNumber,
        heading: currentPlank.heading.replace(/\s+/g, ' ').trim(),
        body,
      });
    }
    currentPlank = null;
  };

  for (let pIdx = 0; pIdx < pages.length; pIdx++) {
    const lines = pages[pIdx];
    for (const rawLine of lines) {
      const line = cleanRunningNoise(rawLine);
      if (!line) continue;
      // Skip Table of Contents dot-leader lines
      if (/\.{5,}\s*\d+$/.test(line)) {
        inToc = true;
        continue;
      }
      if (pIdx === 0 && /Platform Committee Members|Editorial Committee|SD\d{2}:/i.test(line)) {
        continue;
      }
      if (inToc && /^Preamble$/i.test(line)) {
        inToc = false;
      }
      if (inToc && pIdx <= 2) continue;

      // Numbered plank: e.g. "18. Parental Rights: The rights of parents..."
      const plankMatch = line.match(/^(\d{1,3})\.\s+([^:]{2,110}):\s*(.*)$/);
      if (plankMatch) {
        flush();
        currentPlank = {
          chapter: currentChapter,
          plankNumber: `Plank ${plankMatch[1]}`,
          heading: plankMatch[2].trim(),
          body: plankMatch[3].trim(),
        };
        continue;
      }

      // Legislative Priority or Resolution headings
      const resMatch = line.match(/^(?:Resolution\s+(\d+)|Legislative Priority\s+(\d+))[:.\s]+(.+)$/i);
      if (resMatch) {
        flush();
        currentChapter = resMatch[1] ? 'Resolutions' : 'Legislative Priorities';
        currentPlank = {
          chapter: currentChapter,
          plankNumber: resMatch[1] ? `Res. ${resMatch[1]}` : `Priority ${resMatch[2]}`,
          heading: resMatch[3].trim().slice(0, 120),
          body: resMatch[3].trim(),
        };
        continue;
      }

      // Short Title-Case chapter heading (no trailing period, <= 72 chars, not a sub-item a)/b))
      if (
        line.length >= 4 &&
        line.length <= 72 &&
        !/^[a-z0-9]\)/.test(line) &&
        !/[.;,]$/.test(line) &&
        /^[A-Z][A-Za-z0-9,&\-\s/]+$/.test(line) &&
        !line.includes(':') &&
        line.split(' ').length <= 9
      ) {
        if (
          /^(?:Constitutional Issues|Business, Commerce|Finance|Education|Health and Human Services|Criminal and Civil Justice|State Affairs|Government and Election Integrity|National Defense|Foreign Affairs|Resolutions|Legislative Priorities|Preamble|Principles|Agriculture|Energy|Environment|Transportation|Immigration|Border Security|Taxation|Property Rights|Parental Rights)/i.test(
            line
          )
        ) {
          flush();
          currentChapter = line;
          continue;
        }
      }

      if (currentPlank) {
        currentPlank.body += ' ' + line;
      } else if (/^Preamble$/i.test(line)) {
        currentPlank = {
          chapter: 'Preamble & Principles',
          plankNumber: 'Preamble',
          heading: 'Platform Preamble',
          body: '',
        };
      }
    }
  }
  flush();
  return planks;
}

function parseDemocraticPlatformPlanks(pages: string[][]): ParsedPlank[] {
  const planks: ParsedPlank[] = [];
  let currentChapter = 'Preamble & Core Values';
  let currentHeading = 'Platform Statement';
  let currentBullets: string[] = [];
  let plankSeq = 1;

  const flushSection = () => {
    if (currentBullets.length === 0) return;
    // Group up to 3 bullets per plank unit so plank granularity matches RPT numbered planks (~50-160 words each)
    let buf: string[] = [];
    let wordSum = 0;
    const emit = () => {
      if (buf.length === 0) return;
      const body = buf.join(' • ').replace(/\s+/g, ' ').trim();
      if (body.length >= 30) {
        planks.push({
          chapter: currentChapter,
          plankNumber: `Sec. ${plankSeq++}`,
          heading: currentHeading,
          body,
        });
      }
      buf = [];
      wordSum = 0;
    };

    for (const b of currentBullets) {
      const wc = b.split(/\s+/).length;
      if (buf.length > 0 && (wordSum + wc > 135 || buf.length >= 4)) {
        emit();
      }
      buf.push(b);
      wordSum += wc;
    }
    emit();
    currentBullets = [];
  };

  let activeBullet = '';
  const commitBullet = () => {
    const cleaned = activeBullet.replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 18) {
      currentBullets.push(cleaned);
    }
    activeBullet = '';
  };

  for (let pIdx = 0; pIdx < pages.length; pIdx++) {
    const lines = pages[pIdx];
    for (const rawLine of lines) {
      const line = cleanRunningNoise(rawLine);
      if (!line) continue;
      // Skip TOC or cover lines on page 1
      if (pIdx === 0 && /Table of Contents|TEXAS DEMOCRATIC PARTY PLATFORM\s*2026/i.test(line)) {
        continue;
      }
      if (/\.{5,}\s*\d+$/.test(line)) continue;

      // Bullet line starting with ● or • or ○
      const bulletMatch = line.match(/^[●•○▪■]\s*(.+)$/);
      if (bulletMatch) {
        commitBullet();
        activeBullet = bulletMatch[1].trim();
        continue;
      }

      // Detect major chapter or topic sub-heading: short line, no ending punctuation, Title Case or ALL CAPS
      const isShortHeading =
        line.length >= 3 &&
        line.length <= 76 &&
        !/[.;,:]$/.test(line) &&
        !/^(?:and|or|to|of|for|in|the|a|an)\s/i.test(line) &&
        line.split(' ').length <= 10 &&
        /^[A-Z]/.test(line) &&
        !line.startsWith('Texas Democrats') &&
        !line.startsWith('The Texas Democratic Party');

      if (isShortHeading) {
        // Distinguish major ALL-CAPS chapter vs Title-Case subsection
        const upperLetters = (line.match(/[A-Z]/g) || []).length;
        const lowerLetters = (line.match(/[a-z]/g) || []).length;
        commitBullet();
        flushSection();
        if (upperLetters > lowerLetters && line.length >= 5) {
          currentChapter = line
            .toLowerCase()
            .replace(/\b\w/g, (c) => c.toUpperCase());
          currentHeading = currentChapter;
        } else {
          currentHeading = line;
          if (/^(?:Executive Summary|Preamble|Economy|Education|Healthcare|Health Care|Energy|Environment|Climate|Immigration|Border|Voting|Democracy|Criminal Justice|Civil Rights|Housing|Labor|Workers|Agriculture|Rural|Gun Safety|Transportation|Infrastructure|Foreign Policy|Veterans)/i.test(line)) {
            currentChapter = line;
          }
        }
        continue;
      }

      // Introductory stem like "Texas Democrats support action to:"
      if (/:$/.test(line) && line.length <= 110) {
        commitBullet();
        continue;
      }

      if (activeBullet) {
        activeBullet += ' ' + line;
      } else if (line.length >= 35) {
        currentBullets.push(line);
      }
    }
  }
  commitBullet();
  flushSection();
  return planks;
}

function parseGenericPlatformPlanks(rawText: string): ParsedPlank[] {
  const blocks = rawText
    .split(/\n\s*\n+/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter((b) => b.length >= 35);

  const planks: ParsedPlank[] = [];
  let chapter = 'Platform Provisions';
  let seq = 1;

  for (const block of blocks) {
    if (block.length < 75 && !/[.!?]$/.test(block)) {
      chapter = block;
      continue;
    }
    const numMatch = block.match(/^(\d{1,3})\.\s+([^:]{2,90}):\s*(.+)$/);
    if (numMatch) {
      planks.push({
        chapter,
        plankNumber: `Plank ${numMatch[1]}`,
        heading: numMatch[2].trim(),
        body: numMatch[3].trim(),
      });
    } else {
      const firstSentence = block.split(/[.!?]/)[0]?.slice(0, 80) || chapter;
      planks.push({
        chapter,
        plankNumber: `Sec. ${seq++}`,
        heading: firstSentence,
        body: block,
      });
    }
  }
  return planks;
}

// ============================================================================
// PLATFORM INGESTION & MARPOR RILE / SALIENCE COMPUTATION
// ============================================================================

export function persistPlatformDocument(input: {
  id: string;
  party: PlatformParty;
  year: number;
  title: string;
  sourceUrl: string;
  pageCount: number;
  fullText: string;
  planks: ParsedPlank[];
}): { plankCount: number; wordCount: number; rileScore: number } {
  const now = new Date().toISOString();
  const wordCount = input.fullText.trim() ? input.fullText.trim().split(/\s+/).length : 0;

  let rightCount = 0;
  let leftCount = 0;
  let neutralCount = 0;
  const rileCounts = new Map<string, number>();
  const domainCounts = new Map<string, number>();

  const codedPlanks = input.planks.map((p, idx) => {
    const combined = `${p.chapter} ${p.heading} ${p.body}`;
    const marpor = classifyPlankMarpor(combined);
    const domain = classifyTexasDomain(combined);
    const wc = p.body.split(/\s+/).filter(Boolean).length;

    if (marpor.direction === 'Right') {
      rightCount++;
      rileCounts.set(marpor.code, (rileCounts.get(marpor.code) || 0) + 1);
    } else if (marpor.direction === 'Left') {
      leftCount++;
      rileCounts.set(marpor.code, (rileCounts.get(marpor.code) || 0) + 1);
    } else {
      neutralCount++;
    }
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);

    return {
      id: `${input.id}-p${idx + 1}`,
      platformId: input.id,
      party: input.party,
      year: input.year,
      chapter: p.chapter,
      plankNumber: p.plankNumber,
      heading: p.heading,
      body: p.body,
      wordCount: wc,
      rileCode: marpor.code,
      rileLabel: marpor.label,
      rileDirection: marpor.direction,
      texasDomain: domain,
      sortOrder: idx + 1,
    };
  });

  const totalPlanks = Math.max(1, codedPlanks.length);
  const rileScore = Number((((rightCount - leftCount) / totalPlanks) * 100).toFixed(2));
  const rileLogit = Number(Math.log((rightCount + 0.5) / (leftCount + 0.5)).toFixed(3));

  const rileBreakdown: RileCategoryBreakdown[] = MARPOR_RILE_CODEBOOK.map((cat) => {
    const count = rileCounts.get(cat.code) || 0;
    return {
      code: cat.code,
      label: cat.label,
      direction: cat.direction,
      count,
      sharePct: Number(((count / totalPlanks) * 100).toFixed(2)),
    };
  }).filter((c) => c.count > 0);

  const domainSalience: DomainSalienceItem[] = [
    ...TEXAS_DOMAIN_NAMES,
    'General Governance',
  ]
    .map((domain) => {
      const count = domainCounts.get(domain) || 0;
      return {
        domain,
        count,
        sharePct: Number(((count / totalPlanks) * 100).toFixed(2)),
      };
    })
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count);

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM planks_fts WHERE platform_id = ?`).run(input.id);
    db.prepare(`DELETE FROM platform_planks WHERE platform_id = ?`).run(input.id);

    db.prepare(
      `INSERT OR REPLACE INTO party_platforms (
        id, party, year, title, source_url, page_count, word_count, plank_count,
        rile_score, rile_logit, rile_right_count, rile_left_count, rile_neutral_count,
        rile_breakdown_json, domain_salience_json, top_terms_json, full_text, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`
    ).run(
      input.id,
      input.party,
      input.year,
      input.title,
      input.sourceUrl,
      input.pageCount,
      wordCount,
      codedPlanks.length,
      rileScore,
      rileLogit,
      rightCount,
      leftCount,
      neutralCount,
      JSON.stringify(rileBreakdown),
      JSON.stringify(domainSalience),
      input.fullText,
      now
    );

    const insPlank = db.prepare(
      `INSERT INTO platform_planks (
        id, platform_id, party, year, chapter, plank_number, heading, body,
        word_count, rile_code, rile_label, rile_direction, texas_domain, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insFts = db.prepare(
      `INSERT INTO planks_fts (plank_id, platform_id, party, chapter, heading, body, texas_domain)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const pl of codedPlanks) {
      insPlank.run(
        pl.id,
        pl.platformId,
        pl.party,
        pl.year,
        pl.chapter,
        pl.plankNumber,
        pl.heading,
        pl.body,
        pl.wordCount,
        pl.rileCode,
        pl.rileLabel,
        pl.rileDirection,
        pl.texasDomain,
        pl.sortOrder
      );
      insFts.run(
        pl.id,
        pl.platformId,
        pl.party,
        pl.chapter,
        pl.heading,
        pl.body,
        pl.texasDomain
      );
    }
  });

  tx();
  return { plankCount: codedPlanks.length, wordCount, rileScore };
}

async function fetchPdfBufferSafely(urlStr: string): Promise<Uint8Array> {
  let currentUrl = await validatePublicHttpsUrl(urlStr);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(currentUrl.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'TexasCapitolLedger/1.0 (Legislative Research Indexer)',
          Accept: 'application/pdf,*/*;q=0.8',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Redirect response missing Location header.');
        const nextResolved = new URL(loc, currentUrl).toString();
        currentUrl = await validatePublicHttpsUrl(nextResolved);
        continue;
      }
      break;
    }
    if (!res || !res.ok) {
      throw new Error(`HTTP ${res?.status ?? 'error'} fetching platform PDF`);
    }
    const contentLength = Number(res.headers.get('content-length') || '0');
    if (contentLength > 15 * 1024 * 1024) {
      throw new Error('Platform PDF exceeds the 15 MB size limit.');
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 15 * 1024 * 1024) {
      throw new Error('Platform PDF exceeds the 15 MB size limit.');
    }
    if (ab.byteLength < 500) {
      throw new Error('Downloaded file is too small to be a valid PDF.');
    }
    return new Uint8Array(ab);
  } finally {
    clearTimeout(timeout);
  }
}

export async function ingestPlatformFromPdfUrl(opts: {
  id: string;
  party: PlatformParty;
  year: number;
  title: string;
  sourceUrl: string;
}): Promise<{ id: string; plankCount: number; wordCount: number; pageCount: number; rileScore: number }> {
  const buf = await fetchPdfBufferSafely(opts.sourceUrl);
  const { pageCount, pages } = await extractPdfLinesFromBuffer(buf);
  const fullText = pages.map((lines) => lines.join('\n')).join('\n\n');

  let planks: ParsedPlank[];
  if (opts.party === 'Republican') {
    planks = parseRepublicanPlatformPlanks(pages);
    if (planks.length < 10) planks = parseGenericPlatformPlanks(fullText);
  } else if (opts.party === 'Democratic') {
    planks = parseDemocraticPlatformPlanks(pages);
    if (planks.length < 10) planks = parseGenericPlatformPlanks(fullText);
  } else {
    planks = parseGenericPlatformPlanks(fullText);
  }

  const saved = persistPlatformDocument({
    id: opts.id,
    party: opts.party,
    year: opts.year,
    title: opts.title,
    sourceUrl: opts.sourceUrl,
    pageCount,
    fullText,
    planks,
  });

  return {
    id: opts.id,
    plankCount: saved.plankCount,
    wordCount: saved.wordCount,
    pageCount,
    rileScore: saved.rileScore,
  };
}

export function ingestPlatformFromPlainText(opts: {
  id: string;
  party: PlatformParty;
  year: number;
  title: string;
  sourceUrl?: string;
  rawText: string;
}): { id: string; plankCount: number; wordCount: number; rileScore: number } {
  const planks = parseGenericPlatformPlanks(opts.rawText);
  const saved = persistPlatformDocument({
    id: opts.id,
    party: opts.party,
    year: opts.year,
    title: opts.title,
    sourceUrl: opts.sourceUrl || '',
    pageCount: Math.max(1, Math.ceil(opts.rawText.length / 2600)),
    fullText: opts.rawText,
    planks,
  });
  return {
    id: opts.id,
    plankCount: saved.plankCount,
    wordCount: saved.wordCount,
    rileScore: saved.rileScore,
  };
}

// ============================================================================
// WORDSCORES ENGINE (LAVER, BENOIT & GARRY 2003 + MARTIN & VANBERG 2008)
// ============================================================================

interface VocabCache {
  scores: Map<string, number>;
  demRawAnchor: number;
  repRawAnchor: number;
  demId: string;
  repId: string;
}

let cachedVocab: VocabCache | null = null;

function getWordscoresVocabCache(): VocabCache | null {
  if (cachedVocab && cachedVocab.scores.size > 0) return cachedVocab;

  const rows = db
    .prepare(`SELECT term, word_score, dem_rel_freq, rep_rel_freq FROM wordscores_vocab`)
    .all() as Array<{
    term: string;
    word_score: number;
    dem_rel_freq: number;
    rep_rel_freq: number;
  }>;

  if (rows.length === 0) return null;

  const scores = new Map<string, number>();
  let demRawAnchor = 0;
  let repRawAnchor = 0;
  let demRelSum = 0;
  let repRelSum = 0;

  for (const r of rows) {
    scores.set(r.term, r.word_score);
    demRawAnchor += r.dem_rel_freq * r.word_score;
    repRawAnchor += r.rep_rel_freq * r.word_score;
    demRelSum += r.dem_rel_freq;
    repRelSum += r.rep_rel_freq;
  }

  if (demRelSum > 0) demRawAnchor /= demRelSum;
  if (repRelSum > 0) repRawAnchor /= repRelSum;

  const demRow = db
    .prepare(`SELECT id FROM party_platforms WHERE party = 'Democratic' ORDER BY year DESC LIMIT 1`)
    .get() as { id: string } | undefined;
  const repRow = db
    .prepare(`SELECT id FROM party_platforms WHERE party = 'Republican' ORDER BY year DESC LIMIT 1`)
    .get() as { id: string } | undefined;

  cachedVocab = {
    scores,
    demRawAnchor: demRawAnchor || -0.5,
    repRawAnchor: repRawAnchor || 0.5,
    demId: demRow?.id || '',
    repId: repRow?.id || '',
  };
  return cachedVocab;
}

export function rebuildWordscoresVocabulary(): {
  vocabSize: number;
  demRawAnchor: number;
  repRawAnchor: number;
} {
  cachedVocab = null;

  const demPlatform = db
    .prepare(
      `SELECT id, full_text FROM party_platforms WHERE party = 'Democratic' ORDER BY year DESC LIMIT 1`
    )
    .get() as { id: string; full_text: string } | undefined;
  const repPlatform = db
    .prepare(
      `SELECT id, full_text FROM party_platforms WHERE party = 'Republican' ORDER BY year DESC LIMIT 1`
    )
    .get() as { id: string; full_text: string } | undefined;

  if (!demPlatform || !repPlatform) {
    return { vocabSize: 0, demRawAnchor: 0, repRawAnchor: 0 };
  }

  const demTokens = tokenizeForScaling(demPlatform.full_text);
  const repTokens = tokenizeForScaling(repPlatform.full_text);

  const demCounts = new Map<string, number>();
  const repCounts = new Map<string, number>();
  const allTerms = new Set<string>();

  for (const t of demTokens) {
    demCounts.set(t, (demCounts.get(t) || 0) + 1);
    allTerms.add(t);
  }
  for (const t of repTokens) {
    repCounts.set(t, (repCounts.get(t) || 0) + 1);
    allTerms.add(t);
  }

  const totalDem = Math.max(1, demTokens.length);
  const totalRep = Math.max(1, repTokens.length);

  // Filter out ultra-rare noise (< 3 total occurrences across reference texts)
  const vocabRows: WordscoresVocabEntry[] = [];
  for (const term of allTerms) {
    const dc = demCounts.get(term) || 0;
    const rc = repCounts.get(term) || 0;
    const total = dc + rc;
    if (total < 3) continue;

    // Laver, Benoit & Garry (2003): F_wr = c_wr / N_r; P_wr = F_wr / (F_w,Dem + F_w,Rep)
    // With A_Dem = -1.0, A_Rep = +1.0 -> S_w = P_w,Rep - P_w,Dem
    const fDem = dc / totalDem;
    const fRep = rc / totalRep;
    const denom = fDem + fRep;
    const wordScore = denom > 0 ? (fRep - fDem) / denom : 0;

    vocabRows.push({
      term,
      demCount: dc,
      repCount: rc,
      demRelFreq: fDem,
      repRelFreq: fRep,
      wordScore: Number(wordScore.toFixed(6)),
      totalCount: total,
    });
  }

  const topDemPlatformTerms = [...vocabRows]
    .filter((v) => v.demCount >= 5 && v.wordScore <= -0.45)
    .sort((a, b) => a.wordScore * Math.log(a.demCount + 1) - b.wordScore * Math.log(b.demCount + 1))
    .slice(0, 18)
    .map((v) => ({ term: v.term, count: v.demCount, wordScore: Number(v.wordScore.toFixed(3)) }));

  const topRepPlatformTerms = [...vocabRows]
    .filter((v) => v.repCount >= 5 && v.wordScore >= 0.45)
    .sort((a, b) => b.wordScore * Math.log(b.repCount + 1) - a.wordScore * Math.log(a.repCount + 1))
    .slice(0, 18)
    .map((v) => ({ term: v.term, count: v.repCount, wordScore: Number(v.wordScore.toFixed(3)) }));

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM wordscores_vocab`).run();
    const ins = db.prepare(
      `INSERT INTO wordscores_vocab (term, dem_count, rep_count, dem_rel_freq, rep_rel_freq, word_score, total_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const v of vocabRows) {
      ins.run(v.term, v.demCount, v.repCount, v.demRelFreq, v.repRelFreq, v.wordScore, v.totalCount);
    }
    db.prepare(`UPDATE party_platforms SET top_terms_json = ? WHERE id = ?`).run(
      JSON.stringify(topDemPlatformTerms),
      demPlatform.id
    );
    db.prepare(`UPDATE party_platforms SET top_terms_json = ? WHERE id = ?`).run(
      JSON.stringify(topRepPlatformTerms),
      repPlatform.id
    );
  });
  tx();

  const cache = getWordscoresVocabCache();
  return {
    vocabSize: vocabRows.length,
    demRawAnchor: cache?.demRawAnchor ?? 0,
    repRawAnchor: cache?.repRawAnchor ?? 0,
  };
}

export interface WordscoresTextResult {
  rawWordscore: number;
  transformedWordscore: number;
  standardError: number;
  matchedTokens: number;
  totalTokens: number;
  overlapPct: number;
  confidenceTier: ScalingConfidenceTier;
  topDemTerms: WordscoreTermContribution[];
  topRepTerms: WordscoreTermContribution[];
}

export function scoreTextWithWordscores(text: string): WordscoresTextResult | null {
  const cache = getWordscoresVocabCache();
  if (!cache || cache.scores.size === 0) return null;

  const tokens = tokenizeForScaling(text);
  const totalTokens = tokens.length;
  if (totalTokens === 0) {
    return {
      rawWordscore: 0,
      transformedWordscore: 0,
      standardError: 0,
      matchedTokens: 0,
      totalTokens: 0,
      overlapPct: 0,
      confidenceTier: 'Low',
      topDemTerms: [],
      topRepTerms: [],
    };
  }

  const termCounts = new Map<string, number>();
  let matchedTokens = 0;
  let scoreSum = 0;

  for (const t of tokens) {
    const sw = cache.scores.get(t);
    if (sw !== undefined) {
      matchedTokens++;
      scoreSum += sw;
      termCounts.set(t, (termCounts.get(t) || 0) + 1);
    }
  }

  if (matchedTokens === 0) {
    return {
      rawWordscore: 0,
      transformedWordscore: 0,
      standardError: 0,
      matchedTokens: 0,
      totalTokens,
      overlapPct: 0,
      confidenceTier: 'Low',
      topDemTerms: [],
      topRepTerms: [],
    };
  }

  const rawWordscore = scoreSum / matchedTokens;

  // Variance & LBG Standard Error: SE_v = sqrt( sum(F_wv * (S_w - S_v)^2) / N_matched )
  let weightedSqDev = 0;
  const contributions: WordscoreTermContribution[] = [];

  for (const [term, count] of termCounts.entries()) {
    const sw = cache.scores.get(term)!;
    const freq = count / matchedTokens;
    weightedSqDev += freq * (sw - rawWordscore) * (sw - rawWordscore);
    contributions.push({
      term,
      wordScore: Number(sw.toFixed(3)),
      count,
      contribution: Number((freq * sw).toFixed(4)),
    });
  }

  const standardError = Math.sqrt(weightedSqDev / matchedTokens);

  // Martin & Vanberg (2008) 2-reference linear rescaling so Dem anchor maps to -1.0 and Rep anchor to +1.0
  const mid = (cache.demRawAnchor + cache.repRawAnchor) / 2;
  const halfSpan = Math.max(0.15, (cache.repRawAnchor - cache.demRawAnchor) / 2);
  const transformedRaw = (rawWordscore - mid) / halfSpan;
  const transformedWordscore = Math.max(-1.25, Math.min(1.25, transformedRaw));

  const overlapPct = Number(((matchedTokens / totalTokens) * 100).toFixed(1));
  const uniqueMatched = termCounts.size;

  let confidenceTier: ScalingConfidenceTier = 'Low';
  if (matchedTokens >= 35 && uniqueMatched >= 14 && overlapPct >= 30) {
    confidenceTier = 'High';
  } else if (matchedTokens >= 15 && uniqueMatched >= 7 && overlapPct >= 20) {
    confidenceTier = 'Moderate';
  }

  const topDemTerms = contributions
    .filter((c) => c.wordScore <= -0.25)
    .sort((a, b) => a.contribution - b.contribution)
    .slice(0, 6);

  const topRepTerms = contributions
    .filter((c) => c.wordScore >= 0.25)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 6);

  return {
    rawWordscore: Number(rawWordscore.toFixed(4)),
    transformedWordscore: Number(transformedWordscore.toFixed(3)),
    standardError: Number(standardError.toFixed(4)),
    matchedTokens,
    totalTokens,
    overlapPct,
    confidenceTier,
    topDemTerms,
    topRepTerms,
  };
}

// ============================================================================
// PLANK MATCHER (SIDE-BY-SIDE DEMOCRATIC & REPUBLICAN PLANKS FOR EACH BILL)
// ============================================================================

interface IndexedPlankEntry {
  id: string;
  platformId: string;
  party: PlatformParty;
  year: number;
  chapter: string;
  plankNumber: string;
  heading: string;
  body: string;
  rileCode: string;
  texasDomain: string;
  tokenWeights: Map<string, number>;
  norm: number;
}

function buildPlankTfIdfIndex(): {
  entries: IndexedPlankEntry[];
  idf: Map<string, number>;
} {
  const rows = db
    .prepare(
      `SELECT id, platform_id, party, year, chapter, plank_number, heading, body, rile_code, texas_domain
       FROM platform_planks`
    )
    .all() as Array<{
    id: string;
    platform_id: string;
    party: PlatformParty;
    year: number;
    chapter: string;
    plank_number: string;
    heading: string;
    body: string;
    rile_code: string;
    texas_domain: string;
  }>;

  if (rows.length === 0) return { entries: [], idf: new Map() };

  const df = new Map<string, number>();
  const rawTokensPerPlank = rows.map((r) => {
    // Weight heading terms 2x
    const toks = [
      ...tokenizeForScaling(`${r.chapter} ${r.heading}`),
      ...tokenizeForScaling(`${r.heading} ${r.body}`),
    ];
    const unique = new Set(toks);
    for (const u of unique) df.set(u, (df.get(u) || 0) + 1);
    return toks;
  });

  const N = rows.length;
  const idf = new Map<string, number>();
  for (const [term, docFreq] of df.entries()) {
    idf.set(term, Math.log((N + 1) / (docFreq + 1)) + 1);
  }

  const entries: IndexedPlankEntry[] = rows.map((r, i) => {
    const tf = new Map<string, number>();
    for (const t of rawTokensPerPlank[i]) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    const weights = new Map<string, number>();
    let sqSum = 0;
    for (const [term, count] of tf.entries()) {
      const w = (1 + Math.log(count)) * (idf.get(term) || 1);
      weights.set(term, w);
      sqSum += w * w;
    }
    return {
      id: r.id,
      platformId: r.platform_id,
      party: r.party,
      year: r.year,
      chapter: r.chapter,
      plankNumber: r.plank_number,
      heading: r.heading,
      body: r.body,
      rileCode: r.rile_code,
      texasDomain: r.texas_domain,
      tokenWeights: weights,
      norm: Math.sqrt(sqSum) || 1,
    };
  });

  return { entries, idf };
}

function findTopMatchedPlanksForText(
  text: string,
  index: { entries: IndexedPlankEntry[]; idf: Map<string, number> },
  perParty = 2
): MatchedPlatformPlank[] {
  if (index.entries.length === 0) return [];
  const tokens = tokenizeForScaling(text);
  if (tokens.length < 3) return [];

  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

  const qWeights = new Map<string, number>();
  let qSq = 0;
  for (const [term, count] of tf.entries()) {
    const idfVal = index.idf.get(term);
    if (!idfVal) continue;
    const w = (1 + Math.log(count)) * idfVal;
    qWeights.set(term, w);
    qSq += w * w;
  }
  const qNorm = Math.sqrt(qSq);
  if (qNorm === 0) return [];

  const demMatches: MatchedPlatformPlank[] = [];
  const repMatches: MatchedPlatformPlank[] = [];

  for (const entry of index.entries) {
    let dot = 0;
    const shared: Array<[string, number]> = [];
    for (const [term, qw] of qWeights.entries()) {
      const pw = entry.tokenWeights.get(term);
      if (pw) {
        dot += qw * pw;
        shared.push([term, qw * pw]);
      }
    }
    if (shared.length < 2) continue;
    const cos = dot / (qNorm * entry.norm);
    if (cos < 0.06) continue;

    shared.sort((a, b) => b[1] - a[1]);
    const item: MatchedPlatformPlank = {
      plankId: entry.id,
      platformId: entry.platformId,
      party: entry.party,
      year: entry.year,
      chapter: entry.chapter,
      plankNumber: entry.plankNumber,
      heading: entry.heading,
      excerpt: entry.body.length > 260 ? `${entry.body.slice(0, 257)}…` : entry.body,
      rileCode: entry.rileCode,
      texasDomain: entry.texasDomain,
      similarityScore: Number(cos.toFixed(3)),
      sharedTerms: shared.slice(0, 5).map(([t]) => t),
    };
    if (entry.party === 'Democratic') demMatches.push(item);
    else if (entry.party === 'Republican') repMatches.push(item);
  }

  demMatches.sort((a, b) => b.similarityScore - a.similarityScore);
  repMatches.sort((a, b) => b.similarityScore - a.similarityScore);

  return [...demMatches.slice(0, perParty), ...repMatches.slice(0, perParty)];
}

export function recomputeAllEntityScalingScores(): {
  billsScored: number;
  rulesScored: number;
} {
  const vocab = rebuildWordscoresVocabulary();
  if (vocab.vocabSize === 0) {
    return { billsScored: 0, rulesScored: 0 };
  }

  const plankIndex = buildPlankTfIdfIndex();
  const now = new Date().toISOString();

  // Score bills (prefer title + summary + subjects + bill analyses + full_text excerpt)
  const billRows = db
    .prepare(
      `SELECT b.id, b.title, b.summary, b.subjects_json, b.full_text,
              (SELECT GROUP_CONCAT(d.summary || ' ' || substr(d.full_text, 1, 1800), ' ')
               FROM bill_documents d WHERE d.bill_id = b.id AND d.doc_type = 'analysis') AS analysis_text
       FROM bills b
       ORDER BY b.influence_score DESC
       LIMIT 3500`
    )
    .all() as Array<{
    id: string;
    title: string;
    summary: string;
    subjects_json: string;
    full_text: string;
    analysis_text: string | null;
  }>;

  const ruleRows = db
    .prepare(
      `SELECT id, agency_name, title, summary, statutory_authority, fiscal_note_text, full_text
       FROM agency_rules
       ORDER BY issue_date DESC
       LIMIT 1000`
    )
    .all() as Array<{
    id: string;
    agency_name: string;
    title: string;
    summary: string;
    statutory_authority: string;
    fiscal_note_text: string;
    full_text: string;
  }>;

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO entity_scaling_scores (
      entity_type, entity_id, raw_wordscore, transformed_wordscore, standard_error,
      matched_tokens, total_tokens, overlap_pct, confidence_tier,
      top_dem_terms_json, top_rep_terms_json, matched_planks_json, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let billsScored = 0;
  let rulesScored = 0;

  const tx = db.transaction(() => {
    for (const b of billRows) {
      let subjects = '';
      try {
        subjects = (JSON.parse(b.subjects_json || '[]') as string[]).join(' ');
      } catch {
        subjects = '';
      }
      const summaryPart = b.summary && b.summary !== 'TLO FTP Record' ? b.summary : '';
      const combined = `${b.title} ${b.title} ${summaryPart} ${subjects} ${b.analysis_text || ''} ${(b.full_text || '').slice(0, 4500)}`;
      const ws = scoreTextWithWordscores(combined);
      if (!ws) continue;
      const matchedPlanks = findTopMatchedPlanksForText(
        `${b.title} ${summaryPart} ${subjects} ${(b.analysis_text || '').slice(0, 1200)} ${(b.full_text || '').slice(0, 1600)}`,
        plankIndex,
        2
      );
      upsert.run(
        'bill',
        b.id,
        ws.rawWordscore,
        ws.transformedWordscore,
        ws.standardError,
        ws.matchedTokens,
        ws.totalTokens,
        ws.overlapPct,
        ws.confidenceTier,
        JSON.stringify(ws.topDemTerms),
        JSON.stringify(ws.topRepTerms),
        JSON.stringify(matchedPlanks),
        now
      );
      billsScored++;
    }

    for (const r of ruleRows) {
      const combined = `${r.title} ${r.agency_name} ${r.summary} ${r.fiscal_note_text} ${(r.full_text || '').slice(0, 4000)}`;
      const ws = scoreTextWithWordscores(combined);
      if (!ws) continue;
      const matchedPlanks = findTopMatchedPlanksForText(
        `${r.title} ${r.summary} ${(r.full_text || '').slice(0, 1400)}`,
        plankIndex,
        2
      );
      upsert.run(
        'rule',
        r.id,
        ws.rawWordscore,
        ws.transformedWordscore,
        ws.standardError,
        ws.matchedTokens,
        ws.totalTokens,
        ws.overlapPct,
        ws.confidenceTier,
        JSON.stringify(ws.topDemTerms),
        JSON.stringify(ws.topRepTerms),
        JSON.stringify(matchedPlanks),
        now
      );
      rulesScored++;
    }
  });

  tx();
  return { billsScored, rulesScored };
}

export function getEntityPlatformAlignment(
  entityType: 'bill' | 'rule',
  entityId: string
): BillPlatformAlignment | null {
  const row = db
    .prepare(
      `SELECT * FROM entity_scaling_scores WHERE entity_type = ? AND entity_id = ?`
    )
    .get(entityType, entityId) as
    | {
        entity_type: 'bill' | 'rule';
        entity_id: string;
        raw_wordscore: number;
        transformed_wordscore: number;
        standard_error: number;
        matched_tokens: number;
        total_tokens: number;
        overlap_pct: number;
        confidence_tier: ScalingConfidenceTier;
        top_dem_terms_json: string;
        top_rep_terms_json: string;
        matched_planks_json: string;
        computed_at: string;
      }
    | undefined;

  if (!row) return null;

  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    rawWordscore: Number(row.raw_wordscore),
    transformedWordscore: Number(row.transformed_wordscore),
    standardError: Number(row.standard_error),
    matchedTokens: Number(row.matched_tokens),
    totalTokens: Number(row.total_tokens),
    overlapPct: Number(row.overlap_pct),
    confidenceTier: row.confidence_tier,
    topDemTerms: JSON.parse(row.top_dem_terms_json || '[]'),
    topRepTerms: JSON.parse(row.top_rep_terms_json || '[]'),
    matchedPlanks: JSON.parse(row.matched_planks_json || '[]'),
    computedAt: row.computed_at,
  };
}

export function computeRedlineWordscoresShift(
  fromText: string,
  toText: string,
  addedLinesText: string
): DiffWordscoresShift | null {
  const fromWs = scoreTextWithWordscores(fromText);
  const toWs = scoreTextWithWordscores(toText);
  if (!fromWs || !toWs || (fromWs.matchedTokens === 0 && toWs.matchedTokens === 0)) {
    return null;
  }

  const addedWs = scoreTextWithWordscores(addedLinesText);
  const minConf: ScalingConfidenceTier =
    fromWs.confidenceTier === 'Low' || toWs.confidenceTier === 'Low'
      ? 'Low'
      : fromWs.confidenceTier === 'Moderate' || toWs.confidenceTier === 'Moderate'
        ? 'Moderate'
        : 'High';

  return {
    fromScore: fromWs.transformedWordscore,
    toScore: toWs.transformedWordscore,
    delta: Number((toWs.transformedWordscore - fromWs.transformedWordscore).toFixed(3)),
    fromRaw: fromWs.rawWordscore,
    toRaw: toWs.rawWordscore,
    fromOverlapPct: fromWs.overlapPct,
    toOverlapPct: toWs.overlapPct,
    confidenceTier: minConf,
    addedTermsDem: (addedWs?.topDemTerms || []).slice(0, 4).map((t) => ({
      term: t.term,
      wordScore: t.wordScore,
      count: t.count,
    })),
    addedTermsRep: (addedWs?.topRepTerms || []).slice(0, 4).map((t) => ({
      term: t.term,
      wordScore: t.wordScore,
      count: t.count,
    })),
  };
}

// ============================================================================
// WORDFISH UNSUPERVISED POISSON IRT SCALING (SLAPIN & PROKSCH 2008)
// ============================================================================

interface WordfishInputDoc {
  id: string;
  label: string;
  kind: WordfishDocumentEstimate['kind'];
  subtitle: string;
  text: string;
  entityId?: string;
}

function fitWordfishPoissonModel(
  docs: WordfishInputDoc[],
  mode: 'topic_corpus' | 'historical_platforms',
  domain: string
): WordfishResult {
  const now = new Date().toISOString();
  if (docs.length < 4) {
    return {
      mode,
      domain,
      available: false,
      reason:
        mode === 'historical_platforms'
          ? `Wordfish (Slapin & Proksch 2008) requires at least 4 full platform documents to identify latent drift; currently ${docs.length} platform(s) indexed. Import historical 2018–2024 Texas platforms or switch to Topic Corpus mode.`
          : `At least 4 documents are required for Wordfish Poisson scaling; found ${docs.length} in "${domain}".`,
      converged: false,
      iterations: 0,
      docCount: docs.length,
      vocabSize: 0,
      documents: [],
      words: [],
      computedAt: now,
    };
  }

  // Build document-term matrix (keep words appearing in >= 2 docs and total count >= 3, max 450 terms by variance/freq)
  const docTokens = docs.map((d) => tokenizeForScaling(d.text));
  const docFreq = new Map<string, number>();
  const totalFreq = new Map<string, number>();
  const perDocCounts = docTokens.map((toks) => {
    const m = new Map<string, number>();
    for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
    for (const [t, c] of m.entries()) {
      docFreq.set(t, (docFreq.get(t) || 0) + 1);
      totalFreq.set(t, (totalFreq.get(t) || 0) + c);
    }
    return m;
  });

  const D = docs.length;
  const candidateTerms = Array.from(totalFreq.entries())
    .filter(([t, total]) => {
      const df = docFreq.get(t) || 0;
      return df >= 2 && total >= 3;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 420)
    .map(([t]) => t);

  const W = candidateTerms.length;
  if (W < 12) {
    return {
      mode,
      domain,
      available: false,
      reason: `Insufficient shared vocabulary across the ${D} documents in "${domain}" (${W} shared terms; need at least 12).`,
      converged: false,
      iterations: 0,
      docCount: D,
      vocabSize: W,
      documents: [],
      words: [],
      computedAt: now,
    };
  }

  // Matrix Y[i][j]
  const Y: number[][] = Array.from({ length: D }, (_, i) =>
    candidateTerms.map((term) => perDocCounts[i].get(term) || 0)
  );
  const docSums = Y.map((row) => row.reduce((a, b) => a + b, 0));
  const wordSums = candidateTerms.map((_, j) => {
    let s = 0;
    for (let i = 0; i < D; i++) s += Y[i][j];
    return s;
  });

  // Initialization (Slapin & Proksch 2008):
  // alpha_i = log(docSum_i / docSum_0), psi_j = log(wordSum_j / D)
  const alpha = docSums.map((s) => Math.log(Math.max(1, s) / Math.max(1, docSums[0])));
  alpha[0] = 0;
  const psi = wordSums.map((s) => Math.log(Math.max(0.5, s) / D));

  // Initialize omega via first left singular vector approximation (power iteration on log-centered residuals)
  const M: number[][] = Array.from({ length: D }, (_, i) =>
    Array.from({ length: W }, (_, j) => Math.log(Y[i][j] + 0.5) - alpha[i] - psi[j])
  );
  let omega = docs.map((d, i) => {
    if (d.kind === 'platform_dem') return -1.2;
    if (d.kind === 'platform_rep') return 1.2;
    return (i / Math.max(1, D - 1)) * 2 - 1;
  });
  // Run 8 power-iteration steps on M * M^T to align omega with dominant lexical axis
  for (let p = 0; p < 8; p++) {
    const v = new Array<number>(W).fill(0);
    for (let j = 0; j < W; j++) {
      let s = 0;
      for (let i = 0; i < D; i++) s += M[i][j] * omega[i];
      v[j] = s;
    }
    const nextOmega = new Array<number>(D).fill(0);
    for (let i = 0; i < D; i++) {
      let s = 0;
      for (let j = 0; j < W; j++) s += M[i][j] * v[j];
      nextOmega[i] = s;
    }
    const mean = nextOmega.reduce((a, b) => a + b, 0) / D;
    const sd = Math.sqrt(nextOmega.reduce((a, b) => a + (b - mean) ** 2, 0) / D) || 1;
    omega = nextOmega.map((x) => (x - mean) / sd);
  }

  const beta = new Array<number>(W).fill(0);
  const ridge = 0.05; // Mild L2 prior for numerical stability on sparse words

  const clampStep = (delta: number, maxStep = 0.8) =>
    Math.max(-maxStep, Math.min(maxStep, delta));

  let converged = false;
  let iterations = 0;
  const maxIter = 45;

  for (let iter = 1; iter <= maxIter; iter++) {
    iterations = iter;
    const prevOmega = [...omega];

    // Step 1: Update word parameters (psi_j, beta_j) given (alpha_i, omega_i)
    for (let j = 0; j < W; j++) {
      for (let nr = 0; nr < 2; nr++) {
        let gPsi = 0;
        let gBeta = -ridge * beta[j];
        let hPP = 1e-4;
        let hPB = 0;
        let hBB = ridge + 1e-4;

        for (let i = 0; i < D; i++) {
          const eta = Math.max(-10, Math.min(10, alpha[i] + psi[j] + beta[j] * omega[i]));
          const lam = Math.exp(eta);
          const diff = Y[i][j] - lam;
          gPsi += diff;
          gBeta += diff * omega[i];
          hPP += lam;
          hPB += lam * omega[i];
          hBB += lam * omega[i] * omega[i];
        }

        const det = hPP * hBB - hPB * hPB;
        if (Math.abs(det) > 1e-8) {
          const dPsi = (hBB * gPsi - hPB * gBeta) / det;
          const dBeta = (-hPB * gPsi + hPP * gBeta) / det;
          psi[j] = Math.max(-8, Math.min(8, psi[j] + clampStep(dPsi)));
          beta[j] = Math.max(-5, Math.min(5, beta[j] + clampStep(dBeta)));
        }
      }
    }

    // Step 2: Update document parameters (alpha_i, omega_i) given (psi_j, beta_j)
    for (let i = 0; i < D; i++) {
      for (let nr = 0; nr < 2; nr++) {
        let gAlpha = 0;
        let gOmega = -ridge * omega[i];
        let hAA = 1e-4;
        let hAO = 0;
        let hOO = ridge + 1e-4;

        for (let j = 0; j < W; j++) {
          const eta = Math.max(-10, Math.min(10, alpha[i] + psi[j] + beta[j] * omega[i]));
          const lam = Math.exp(eta);
          const diff = Y[i][j] - lam;
          gAlpha += diff;
          gOmega += diff * beta[j];
          hAA += lam;
          hAO += lam * beta[j];
          hOO += lam * beta[j] * beta[j];
        }

        if (i === 0) {
          // Identification constraint: alpha[0] = 0
          omega[i] = Math.max(-4, Math.min(4, omega[i] + clampStep(gOmega / hOO)));
        } else {
          const det = hAA * hOO - hAO * hAO;
          if (Math.abs(det) > 1e-8) {
            const dAlpha = (hOO * gAlpha - hAO * gOmega) / det;
            const dOmega = (-hAO * gAlpha + hAA * gOmega) / det;
            alpha[i] = Math.max(-8, Math.min(8, alpha[i] + clampStep(dAlpha)));
            omega[i] = Math.max(-4, Math.min(4, omega[i] + clampStep(dOmega)));
          }
        }
      }
    }

    // Identification standardization: mean(omega) = 0, sd(omega) = 1
    const meanO = omega.reduce((a, b) => a + b, 0) / D;
    const sdO = Math.sqrt(omega.reduce((a, b) => a + (b - meanO) ** 2, 0) / D) || 1;
    for (let i = 0; i < D; i++) {
      omega[i] = (omega[i] - meanO) / sdO;
    }
    for (let j = 0; j < W; j++) {
      psi[j] += beta[j] * meanO;
      beta[j] *= sdO;
    }
    const a0 = alpha[0];
    for (let i = 0; i < D; i++) alpha[i] -= a0;
    for (let j = 0; j < W; j++) psi[j] += a0;

    // Check convergence via max |omega_t - omega_{t-1}|
    let maxDiff = 0;
    for (let i = 0; i < D; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(omega[i] - prevOmega[i]));
    }
    if (maxDiff < 1e-3) {
      converged = true;
      break;
    }
  }

  // Global polarity identification: orient Democratic platform anchor < Republican platform anchor
  const demIndices = docs
    .map((d, idx) => (d.kind === 'platform_dem' ? idx : -1))
    .filter((idx) => idx >= 0);
  const repIndices = docs
    .map((d, idx) => (d.kind === 'platform_rep' ? idx : -1))
    .filter((idx) => idx >= 0);

  if (demIndices.length > 0 && repIndices.length > 0) {
    const demMean = demIndices.reduce((s, idx) => s + omega[idx], 0) / demIndices.length;
    const repMean = repIndices.reduce((s, idx) => s + omega[idx], 0) / repIndices.length;
    if (demMean > repMean) {
      for (let i = 0; i < D; i++) omega[i] = -omega[i];
      for (let j = 0; j < W; j++) beta[j] = -beta[j];
    }
  }

  // Compute Fisher-information approximate standard error for omega_i
  const documents: WordfishDocumentEstimate[] = docs.map((d, i) => {
    let infoOO = ridge + 1e-4;
    for (let j = 0; j < W; j++) {
      const eta = Math.max(-10, Math.min(10, alpha[i] + psi[j] + beta[j] * omega[i]));
      infoOO += Math.exp(eta) * beta[j] * beta[j];
    }
    const se = 1 / Math.sqrt(infoOO);
    return {
      id: d.id,
      label: d.label,
      kind: d.kind,
      subtitle: d.subtitle,
      omega: Number(omega[i].toFixed(3)),
      omegaSe: Number(Math.min(0.95, se).toFixed(3)),
      alpha: Number(alpha[i].toFixed(3)),
      wordCount: docTokens[i].length,
      entityId: d.entityId,
    };
  });

  documents.sort((a, b) => a.omega - b.omega);

  const words: WordfishWordEstimate[] = candidateTerms
    .map((term, j) => ({
      term,
      beta: Number(beta[j].toFixed(3)),
      psi: Number(psi[j].toFixed(3)),
      totalCount: wordSums[j],
    }))
    .sort((a, b) => Math.abs(b.beta) * Math.log(b.totalCount + 1) - Math.abs(a.beta) * Math.log(a.totalCount + 1))
    .slice(0, 140);

  return {
    mode,
    domain,
    available: true,
    converged,
    iterations,
    docCount: D,
    vocabSize: W,
    documents,
    words,
    computedAt: now,
  };
}

export function runWordfishScaling(opts: {
  mode: 'topic_corpus' | 'historical_platforms';
  domain?: string;
}): WordfishResult {
  if (opts.mode === 'historical_platforms') {
    const platforms = db
      .prepare(
        `SELECT id, party, year, title, full_text FROM party_platforms ORDER BY year ASC, party ASC`
      )
      .all() as Array<{
      id: string;
      party: PlatformParty;
      year: number;
      title: string;
      full_text: string;
    }>;

    const docs: WordfishInputDoc[] = platforms.map((p) => ({
      id: p.id,
      label: `${p.party} ${p.year}`,
      kind:
        p.party === 'Democratic'
          ? 'platform_dem'
          : p.party === 'Republican'
            ? 'platform_rep'
            : 'platform_other',
      subtitle: p.title,
      text: p.full_text,
    }));

    return fitWordfishPoissonModel(docs, 'historical_platforms', 'All Full Party Platforms');
  }

  // Topic Corpus Wordfish:
  // - When "All Indexed Policy Domains" is selected: scale all 20 Party × Texas Domain platform chapters
  //   (comparable manifesto documents so Wordfish captures partisan policy structure, not manifesto-vs-bill genre length).
  // - When a specific Texas policy domain is selected: scale that domain's Democratic & Republican chapters
  //   alongside matching Texas bills & rules, capping chapter token length to 3x median bill length so length
  //   disparity does not dominate the first latent axis.
  const selectedDomain =
    opts.domain && opts.domain !== 'All Indexed Policy Domains'
      ? opts.domain
      : 'All Indexed Policy Domains';

  const docs: WordfishInputDoc[] = [];

  const platforms = db
    .prepare(`SELECT id, party, year, title FROM party_platforms ORDER BY year DESC`)
    .all() as Array<{ id: string; party: PlatformParty; year: number; title: string }>;

  if (selectedDomain === 'All Indexed Policy Domains') {
    for (const p of platforms) {
      const partyShort =
        p.party === 'Democratic' ? 'Dem' : p.party === 'Republican' ? 'Rep' : p.party;
      for (const dom of TEXAS_DOMAIN_NAMES) {
        const plankRows = db
          .prepare(
            `SELECT heading, body FROM platform_planks WHERE platform_id = ? AND texas_domain = ?`
          )
          .all(p.id, dom) as Array<{ heading: string; body: string }>;
        const combined = plankRows.map((r) => `${r.heading} ${r.body}`).join(' ');
        if (tokenizeForScaling(combined).length >= 25) {
          docs.push({
            id: `wf-${p.id}-${dom.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            label: `${partyShort} ${p.year} · ${dom.split(',')[0].split('&')[0].trim()}`,
            kind:
              p.party === 'Democratic'
                ? 'platform_dem'
                : p.party === 'Republican'
                  ? 'platform_rep'
                  : 'platform_other',
            subtitle: `${p.party} ${p.year} — ${dom} (${plankRows.length} planks)`,
            text: combined,
          });
        }
      }
    }
    return fitWordfishPoissonModel(docs, 'topic_corpus', 'All Platform Policy Chapters (2026)');
  }

  // Specific Texas policy domain: matching bills + domain chapters from both parties
  const billRows = db
    .prepare(
      `SELECT b.id, b.session, b.bill_number, b.title, b.summary, b.subjects_json, b.primary_author, b.stage, b.full_text,
              (SELECT GROUP_CONCAT(d.summary || ' ' || substr(d.full_text, 1, 1500), ' ')
               FROM bill_documents d WHERE d.bill_id = b.id AND d.doc_type = 'analysis') AS analysis_text
       FROM bills b
       ORDER BY b.influence_score DESC
       LIMIT 200`
    )
    .all() as Array<{
    id: string;
    session: string;
    bill_number: string;
    title: string;
    summary: string;
    subjects_json: string;
    primary_author: string;
    stage: string;
    full_text: string;
    analysis_text: string | null;
  }>;

  const billDocs: WordfishInputDoc[] = [];
  for (const b of billRows) {
    if (billDocs.length >= 20) break;
    const summaryPart = b.summary && b.summary !== 'TLO FTP Record' ? b.summary : '';
    const combined = `${b.title} ${summaryPart} ${b.analysis_text || ''} ${(b.full_text || '').slice(0, 3200)}`;
    if (tokenizeForScaling(combined).length < 15) continue;
    const dom = classifyTexasDomain(`${b.title} ${summaryPart} ${b.subjects_json}`);
    if (dom !== selectedDomain) continue;

    billDocs.push({
      id: `wf-bill-${b.id}`,
      label: `${b.session} ${b.bill_number}`,
      kind: 'bill',
      subtitle: `${b.primary_author} · ${b.stage} · ${b.title.slice(0, 80)}`,
      text: combined,
      entityId: b.id,
    });
  }

  // Add matching agency rules in this domain
  const rules = db
    .prepare(
      `SELECT id, agency_name, tac_citation, title, summary, full_text FROM agency_rules ORDER BY issue_date DESC LIMIT 25`
    )
    .all() as Array<{
    id: string;
    agency_name: string;
    tac_citation: string;
    title: string;
    summary: string;
    full_text: string;
  }>;
  for (const r of rules) {
    if (billDocs.length >= 24) break;
    const combined = `${r.title} ${r.summary} ${(r.full_text || '').slice(0, 2200)}`;
    if (classifyTexasDomain(`${r.title} ${r.summary}`) !== selectedDomain) continue;
    billDocs.push({
      id: `wf-rule-${r.id}`,
      label: r.tac_citation || r.agency_name.slice(0, 18),
      kind: 'rule',
      subtitle: `${r.agency_name} · ${r.title.slice(0, 75)}`,
      text: combined,
      entityId: r.id,
    });
  }

  // Add Dem & Rep platform sub-chapters (split large chapters into 2-3 cohesive chunks so Wordfish has balanced document lengths)
  for (const p of platforms) {
    const plankRows = db
      .prepare(
        `SELECT heading, body FROM platform_planks WHERE platform_id = ? AND texas_domain = ? ORDER BY sort_order ASC`
      )
      .all(p.id, selectedDomain) as Array<{ heading: string; body: string }>;
    if (plankRows.length === 0) continue;

    const partyShort =
      p.party === 'Democratic' ? 'Dem' : p.party === 'Republican' ? 'Rep' : p.party;
    const kind: WordfishDocumentEstimate['kind'] =
      p.party === 'Democratic'
        ? 'platform_dem'
        : p.party === 'Republican'
          ? 'platform_rep'
          : 'platform_other';

    const chunkCount = plankRows.length >= 16 ? 3 : plankRows.length >= 8 ? 2 : 1;
    const chunkSize = Math.ceil(plankRows.length / chunkCount);
    for (let c = 0; c < chunkCount; c++) {
      const slice = plankRows.slice(c * chunkSize, (c + 1) * chunkSize);
      const combined = slice.map((r) => `${r.heading} ${r.body}`).join(' ');
      if (tokenizeForScaling(combined).length >= 15) {
        docs.push({
          id: `wf-${p.id}-c${c + 1}`,
          label:
            chunkCount > 1
              ? `${partyShort} ${p.year} Platform (Pt ${c + 1}/${chunkCount})`
              : `${partyShort} ${p.year} Platform`,
          kind,
          subtitle: `${selectedDomain} (${slice.length} planks)`,
          text: combined,
        });
      }
    }
  }

  docs.push(...billDocs);
  return fitWordfishPoissonModel(docs, 'topic_corpus', selectedDomain);
}

// ============================================================================
// SYNC ORCHESTRATION & QUERY HELPERS
// ============================================================================

let syncInProgress = false;

export function isPlatformSyncInProgress(): boolean {
  return syncInProgress;
}

export async function syncOfficial2026Platforms(): Promise<{
  synced: Array<{ id: string; title: string; plankCount: number; wordCount: number; rileScore: number }>;
  billsScored: number;
  rulesScored: number;
}> {
  if (syncInProgress) {
    throw new Error('A platform PDF sync is already in progress.');
  }
  syncInProgress = true;
  try {
    const synced: Array<{
      id: string;
      title: string;
      plankCount: number;
      wordCount: number;
      rileScore: number;
    }> = [];

    for (const spec of OFFICIAL_2026_PLATFORMS) {
      const res = await ingestPlatformFromPdfUrl(spec);
      synced.push({
        id: res.id,
        title: spec.title,
        plankCount: res.plankCount,
        wordCount: res.wordCount,
        rileScore: res.rileScore,
      });
    }

    const { billsScored, rulesScored } = recomputeAllEntityScalingScores();
    return { synced, billsScored, rulesScored };
  } finally {
    syncInProgress = false;
  }
}

export function ensurePlatformsBootSynced(): void {
  const count = (
    db.prepare(`SELECT COUNT(*) AS c FROM party_platforms`).get() as { c: number }
  ).c;
  if (count >= 2) {
    // Ensure entity scores exist if bills/rules were added
    const scoredCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM entity_scaling_scores`).get() as { c: number }
    ).c;
    if (scoredCount === 0) {
      try {
        recomputeAllEntityScalingScores();
      } catch (err) {
        console.error('Platform score backfill skipped:', err);
      }
    }
    return;
  }

  // Non-blocking background download & parse of the two official 2026 Texas party platform PDFs
  syncOfficial2026Platforms()
    .then((res) => {
      console.log(
        `2026 Texas party platforms indexed (${res.synced.map((s) => `${s.id}: ${s.plankCount} planks, RILE ${s.rileScore}`).join('; ')}; ${res.billsScored} bills & ${res.rulesScored} rules scored)`
      );
    })
    .catch((err) => {
      console.error('Background 2026 platform sync failed:', err instanceof Error ? err.message : err);
    });
}

export function listPartyPlatforms(): PartyPlatformSummary[] {
  const rows = db
    .prepare(
      `SELECT id, party, year, title, source_url, page_count, word_count, plank_count,
              rile_score, rile_logit, rile_right_count, rile_left_count, rile_neutral_count,
              rile_breakdown_json, domain_salience_json, top_terms_json, synced_at
       FROM party_platforms
       ORDER BY year DESC, party ASC`
    )
    .all() as Array<{
    id: string;
    party: PlatformParty;
    year: number;
    title: string;
    source_url: string;
    page_count: number;
    word_count: number;
    plank_count: number;
    rile_score: number;
    rile_logit: number;
    rile_right_count: number;
    rile_left_count: number;
    rile_neutral_count: number;
    rile_breakdown_json: string;
    domain_salience_json: string;
    top_terms_json: string;
    synced_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    party: r.party,
    year: Number(r.year),
    title: r.title,
    sourceUrl: r.source_url,
    pageCount: Number(r.page_count),
    wordCount: Number(r.word_count),
    plankCount: Number(r.plank_count),
    rileScore: Number(r.rile_score),
    rileLogit: Number(r.rile_logit),
    rileRightCount: Number(r.rile_right_count),
    rileLeftCount: Number(r.rile_left_count),
    rileNeutralCount: Number(r.rile_neutral_count),
    rileBreakdown: JSON.parse(r.rile_breakdown_json || '[]'),
    domainSalience: JSON.parse(r.domain_salience_json || '[]'),
    topTerms: JSON.parse(r.top_terms_json || '[]'),
    syncedAt: r.synced_at,
  }));
}

export function getPlatformsVocabOverview(): {
  vocabStats: {
    totalTerms: number;
    scoredBillsCount: number;
    scoredRulesCount: number;
    highConfidenceBillsCount: number;
    demRawMean: number;
    repRawMean: number;
  };
  topDemTerms: WordscoresVocabEntry[];
  topRepTerms: WordscoresVocabEntry[];
} {
  const totalTerms = (
    db.prepare(`SELECT COUNT(*) AS c FROM wordscores_vocab`).get() as { c: number }
  ).c;
  const scoredBillsCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM entity_scaling_scores WHERE entity_type = 'bill'`)
      .get() as { c: number }
  ).c;
  const scoredRulesCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM entity_scaling_scores WHERE entity_type = 'rule'`)
      .get() as { c: number }
  ).c;
  const highConfidenceBillsCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM entity_scaling_scores WHERE entity_type = 'bill' AND confidence_tier IN ('High', 'Moderate')`
      )
      .get() as { c: number }
  ).c;

  const cache = getWordscoresVocabCache();

  const mapRow = (r: {
    term: string;
    dem_count: number;
    rep_count: number;
    dem_rel_freq: number;
    rep_rel_freq: number;
    word_score: number;
    total_count: number;
  }): WordscoresVocabEntry => ({
    term: r.term,
    demCount: r.dem_count,
    repCount: r.rep_count,
    demRelFreq: Number((r.dem_rel_freq * 1000).toFixed(3)),
    repRelFreq: Number((r.rep_rel_freq * 1000).toFixed(3)),
    wordScore: Number(r.word_score.toFixed(3)),
    totalCount: r.total_count,
  });

  const topDemTerms = (
    db
      .prepare(
        `SELECT * FROM wordscores_vocab
         WHERE dem_count >= 5 AND word_score <= -0.35
         ORDER BY (word_score * (dem_count + 1)) ASC
         LIMIT 25`
      )
      .all() as Parameters<typeof mapRow>[0][]
  ).map(mapRow);

  const topRepTerms = (
    db
      .prepare(
        `SELECT * FROM wordscores_vocab
         WHERE rep_count >= 5 AND word_score >= 0.35
         ORDER BY (word_score * (rep_count + 1)) DESC
         LIMIT 25`
      )
      .all() as Parameters<typeof mapRow>[0][]
  ).map(mapRow);

  return {
    vocabStats: {
      totalTerms,
      scoredBillsCount,
      scoredRulesCount,
      highConfidenceBillsCount,
      demRawMean: Number((cache?.demRawAnchor ?? 0).toFixed(4)),
      repRawMean: Number((cache?.repRawAnchor ?? 0).toFixed(4)),
    },
    topDemTerms,
    topRepTerms,
  };
}

export function mapPlankRow(r: {
  id: string;
  platform_id: string;
  party: PlatformParty;
  year: number;
  chapter: string;
  plank_number: string;
  heading: string;
  body: string;
  word_count: number;
  rile_code: string;
  rile_label: string;
  rile_direction: RileDirection;
  texas_domain: string;
  sort_order: number;
  snippet?: string;
}): PlatformPlank {
  return {
    id: r.id,
    platformId: r.platform_id,
    party: r.party,
    year: Number(r.year),
    chapter: r.chapter,
    plankNumber: r.plank_number,
    heading: r.heading,
    body: r.body,
    wordCount: Number(r.word_count),
    rileCode: r.rile_code,
    rileLabel: r.rile_label,
    rileDirection: r.rile_direction,
    texasDomain: r.texas_domain,
    sortOrder: Number(r.sort_order),
    snippet: r.snippet,
  };
}
