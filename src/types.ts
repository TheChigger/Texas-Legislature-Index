export type Chamber = 'House' | 'Senate';

export type BillStage =
  | 'Pre-Filed'
  | 'Filed'
  | 'Committee Hearing'
  | 'Committee Reported'
  | 'Engrossed'
  | 'Enrolled'
  | 'Signed'
  | 'Vetoed'
  | 'Stalled';

export type LinkType =
  | 'Companion'
  | 'Omnibus Vehicle'
  | 'Statutory Conflict'
  | 'Budget Rider'
  | 'Supersedes'
  | 'Related Policy';

export interface InfluenceBreakdown {
  coauthorWeight: number;
  amendmentWeight: number;
  actionWeight: number;
  stageWeight: number;
  leadershipBonus: number;
  linkWeight: number;
  total: number;
}

export interface BillSummary {
  id: string;
  session: string;
  billNumber: string;
  chamber: Chamber;
  title: string;
  summary: string;
  statuteCodes: string[];
  status: string;
  stage: BillStage;
  primaryAuthor: string;
  coauthors: string[];
  sponsors: string[];
  cosponsors: string[];
  committees: Array<{
    name: string;
    chamber: Chamber;
    status: string;
    ayeVotes: number;
    nayVotes: number;
  }>;
  subjects: string[];
  lastAction: string;
  lastActionDate: string;
  filedDate: string;
  influenceScore: number;
  influenceBreakdown: InfluenceBreakdown;
  momentumLabel: string;
  bipartisanIndex: number;
  amendmentCount: number;
  actionCount: number;
  linkCount: number;
  source: string;
  snippet?: string;
  rank?: number;
}

export interface BillAmendment {
  id: string;
  billId: string;
  billNumber?: string;
  session?: string;
  billTitle?: string;
  versionCode: string;
  versionLabel: string;
  amendmentNumber: string;
  sponsor: string;
  filedDate: string;
  disposition: 'Adopted' | 'Tabled' | 'Failed' | 'Withdrawn' | 'Substituted' | 'Enacted' | 'Filed';
  yeaVotes: number;
  nayVotes: number;
  pnvVotes: number;
  summary: string;
  fullText: string;
  sortOrder: number;
  snippet?: string;
}

export interface BillAction {
  id: string;
  billId: string;
  actionDate: string;
  actionNumber: string;
  description: string;
}

export interface BillLink {
  id: string;
  sourceBillId: string;
  targetBillId: string;
  targetBillNumber: string;
  targetSession: string;
  targetTitle: string;
  targetStage: string;
  linkType: LinkType;
  notes: string;
  createdAt: string;
}

export interface KeywordOverlapMatch {
  billId: string;
  billNumber: string;
  session: string;
  title: string;
  stage: string;
  sharedKeywords: string[];
  overlapScore: number;
}

export interface WitnessRegistration {
  id: string;
  billId: string;
  chamber: Chamber;
  committeeName: string;
  hearingDate: string;
  witnessName: string;
  affiliation: string;
  isCitizenSelf: boolean;
  position: 'For' | 'Against' | 'On';
  testified: boolean;
  source: string;
}

export interface ConstituentCommunication {
  id: string;
  billId: string;
  billNumber?: string;
  session?: string;
  politicianId?: string | null;
  politicianName?: string | null;
  committeeName: string;
  channel: 'Email Campaign' | 'District Call Log' | 'Town Hall' | 'Public Comment Portal';
  stance: 'Support' | 'Oppose' | 'Amend / Concern';
  volumeCount: number;
  summary: string;
  topicKeywords: string;
  loggedDate: string;
}

export interface PublicSentimentSummary {
  forCount: number;
  againstCount: number;
  onCount: number;
  citizenSelfCount: number;
  orgCount: number;
  constituentSupportVolume: number;
  constituentOpposeVolume: number;
  constituentAmendVolume: number;
}

export interface BillDetail extends BillSummary {
  fullText: string;
  amendments: BillAmendment[];
  actions: BillAction[];
  links: BillLink[];
  keywordOverlaps: KeywordOverlapMatch[];
  witnesses: WitnessRegistration[];
  constituentLogs: ConstituentCommunication[];
  publicSentiment: PublicSentimentSummary;
}

export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffResult {
  fromVersion: { id: string; label: string; amendmentNumber: string; filedDate: string };
  toVersion: { id: string; label: string; amendmentNumber: string; filedDate: string };
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
  lines: DiffLine[];
}

export interface PoliticianSummary {
  id: string;
  name: string;
  shortName: string;
  chamber: Chamber;
  district: string;
  party: 'R' | 'D';
  tenureYears: number;
  leadershipRole: string;
  bio: string;
  totalRaised: number;
  billsAuthored: number;
  billsPassed: number;
  committeesCount: number;
  votesCount: number;
}

export interface PoliticianDetail extends PoliticianSummary {
  committees: Array<{
    committeeId: string;
    name: string;
    chamber: Chamber;
    role: 'Chair' | 'Vice-Chair' | 'Member';
    session: string;
    jurisdiction: string;
    referredBillsCount: number;
  }>;
  sponsorships: Array<{
    billId: string;
    billNumber: string;
    session: string;
    title: string;
    stage: string;
    role: string;
    influenceScore: number;
  }>;
  votes: Array<{
    id: string;
    billId: string;
    billNumber: string;
    session: string;
    billTitle: string;
    amendmentId?: string | null;
    motion: string;
    voteCast: 'Yea' | 'Nay' | 'PNV' | 'Absent';
    voteDate: string;
    partyLine: boolean;
  }>;
  contributions: Array<{
    id: string;
    donorId: string;
    donorName: string;
    sector: string;
    pacId: string;
    city: string;
    cycle: string;
    amount: number;
    filingDate: string;
  }>;
  sectorTotals: Array<{
    sector: string;
    total: number;
    count: number;
  }>;
  constituentLogs: ConstituentCommunication[];
}

export interface AlertRule {
  id: string;
  name: string;
  query: string;
  session: string;
  chamber: string;
  committee: string;
  politician: string;
  isActive: boolean;
  createdAt: string;
  matchCount: number;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  billId: string;
  billNumber: string;
  session: string;
  billTitle: string;
  amendmentId?: string | null;
  matchType: 'bill' | 'amendment';
  snippet: string;
  triggeredAt: string;
  isRead: boolean;
}

export type NetworkLayer = 'money' | 'lineage' | 'committee' | 'keyword' | 'public';

export interface NetworkNode {
  id: string;
  kind: 'politician' | 'bill' | 'donor' | 'committee' | 'public_bloc';
  label: string;
  subtitle: string;
  party?: 'R' | 'D';
  chamber?: Chamber;
  sector?: string;
  session?: string;
  weight: number;
  entityId: string;
}

export interface NetworkEdge {
  id: string;
  source: string;
  target: string;
  layer: NetworkLayer;
  label: string;
  weight: number;
  meta?: string;
}

export interface NetworkGraph {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  stats: {
    moneyEdges: number;
    lineageEdges: number;
    committeeEdges: number;
    keywordEdges: number;
    publicEdges: number;
  };
}

export interface CommitteeReceptivityRow {
  committeeId: string;
  name: string;
  chamber: Chamber;
  chairName: string;
  referredBills: number;
  revisedAfterHearing: number;
  stalledWithOpposition: number;
  citizenSelfWitnesses: number;
  orgWitnesses: number;
  constituentVolume: number;
  receptivityScore: number;
  postureLabel: string;
}

export interface RepresentativeResponsivenessRow {
  politicianId: string;
  name: string;
  chamber: Chamber;
  party: 'R' | 'D';
  district: string;
  leadershipRole: string;
  crossAisleVotes: number;
  totalVotes: number;
  crossAislePct: number;
  citizenWitnessExposure: number;
  constituentContacts: number;
  topDonorSector: string;
  topSectorSharePct: number;
  responsivenessScore: number;
  responsivenessSignal: string;
}

export interface PolicyMalleabilityRow {
  domain: string;
  query: string;
  billCount: number;
  amendedRatePct: number;
  citizenForPct: number;
  citizenAgainstPct: number;
  constituentVolume: number;
  malleabilityLabel: string;
}

export interface ReceptivityReport {
  totals: {
    witnessRegistrations: number;
    citizenSelfCount: number;
    orgWitnessCount: number;
    constituentContacts: number;
  };
  committees: CommitteeReceptivityRow[];
  representatives: RepresentativeResponsivenessRow[];
  policies: PolicyMalleabilityRow[];
  recentCommunications: ConstituentCommunication[];
}

export interface SessionTrendPoint {
  session: string;
  label: string;
  years: string;
  totalBills: number;
}

export interface KeywordTrendSeries {
  keyword: string;
  query: string;
  totalHits: number;
  changeLabel: string;
  bySession: Array<{
    session: string;
    count: number;
  }>;
}

export interface OverviewResponse {
  totals: {
    bills: number;
    amendments: number;
    politicians: number;
    contributionsTotal: number;
    unreadAlerts: number;
    linksCount: number;
  };
  sessions: Array<{
    code: string;
    label: string;
    years: string;
    billCount: number;
    syncedAt: string | null;
  }>;
  influentialBills: BillSummary[];
  keywordTrends: KeywordTrendSeries[];
  committeeBottlenecks: Array<{
    name: string;
    chamber: Chamber;
    referredCount: number;
    reportedCount: number;
    passageRate: number;
  }>;
  topKeywords: Array<{ term: string; billCount: number }>;
}

export interface StatuteCodeInfo {
  code: string;
  zipCode: string;
  codeId: number;
  name: string;
  chapterCount: number;
  sectionCount: number;
  syncedAt: string | null;
}

export interface StatuteSectionSummary {
  id: string;
  code: string;
  codeName: string;
  chapter: string;
  chapterTitle: string;
  sectionNumber: string;
  sectionTitle: string;
  actsHistory: string;
  sessionsAmended: string[];
  lastAmendedSession: string;
  source: string;
  snippet?: string;
}

export interface StatuteSnapshot {
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

export interface StatuteSectionDetail extends StatuteSectionSummary {
  fullText: string;
  snapshots: StatuteSnapshot[];
  relatedBills: Array<{
    id: string;
    session: string;
    billNumber: string;
    title: string;
    stage: string;
  }>;
}

