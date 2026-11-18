import {
  backfillPoliticiansFromBills,
  db,
  evaluateAlertRules,
  recomputeBillMetrics,
  refreshSessionCounts,
  syncAmendmentFts,
  syncBillFts,
} from './db.ts';
import { TEXAS_CODE_CATALOG, extractActsSessions } from './statutes.ts';

export function seedDatabaseIfEmpty(): void {
  const existing = db.prepare(`SELECT COUNT(*) AS c FROM bills`).get() as { c: number };
  if (existing.c > 0) {
    seedPublicSentimentIfEmpty();
    seedStatutesIfEmpty();
    seedBillDocumentsIfEmpty();
    backfillPoliticiansFromBills();
    return;
  }

  const sessions = [
    { code: '90R', label: '90th Regular Session (Pre-Filing)', years: '2027–2028', syncedAt: '2026-11-16T09:00:00Z' },
    { code: '891', label: '89th 1st Called Special Session', years: '2025', syncedAt: '2025-08-22T14:30:00Z' },
    { code: '89R', label: '89th Regular Session', years: '2025–2026', syncedAt: '2025-06-23T02:00:05Z' },
    { code: '88R', label: '88th Regular Session', years: '2023–2024', syncedAt: '2023-06-20T02:00:00Z' },
    { code: '87R', label: '87th Regular Session', years: '2021–2022', syncedAt: '2021-06-18T02:00:00Z' },
    { code: '86R', label: '86th Regular Session', years: '2019–2020', syncedAt: null },
    { code: '85R', label: '85th Regular Session', years: '2017–2018', syncedAt: null },
  ];

  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO sessions (code, label, years, synced_at, bill_count) VALUES (?, ?, ?, ?, 0)`
  );
  for (const s of sessions) {
    insertSession.run(s.code, s.label, s.years, s.syncedAt);
  }

  // 1. Seed Texas Legislators
  const politicians = [
    {
      id: 'pol-buckley',
      name: 'Rep. Brad Buckley',
      shortName: 'Buckley',
      chamber: 'House',
      district: 'HD-54 (Bell / Burnet)',
      party: 'R',
      tenureYears: 6,
      leadershipRole: 'Chair, House Public Education',
      bio: 'Veterinarian and rancher from Salado; primary House architect of public school finance and educator compensation packages.',
      totalRaised: 1420000,
      billsAuthored: 44,
      billsPassed: 14,
    },
    {
      id: 'pol-creighton',
      name: 'Sen. Brandon Creighton',
      shortName: 'Creighton',
      chamber: 'Senate',
      district: 'SD-4 (Montgomery / Chambers)',
      party: 'R',
      tenureYears: 18,
      leadershipRole: 'Chair, Senate Education K-16',
      bio: 'Former House member and Conroe attorney leading Senate Education K-16 on school choice, higher education, and workforce grants.',
      totalRaised: 3180000,
      billsAuthored: 61,
      billsPassed: 23,
    },
    {
      id: 'pol-bonnen',
      name: 'Rep. Greg Bonnen',
      shortName: 'Bonnen',
      chamber: 'House',
      district: 'HD-24 (Galveston)',
      party: 'R',
      tenureYears: 12,
      leadershipRole: 'Chair, House Appropriations',
      bio: 'Neurosurgeon and chief House budget writer overseeing biennial General Appropriations negotiations and disaster infrastructure reserves.',
      totalRaised: 1950000,
      billsAuthored: 38,
      billsPassed: 16,
    },
    {
      id: 'pol-huffman',
      name: 'Sen. Joan Huffman',
      shortName: 'Huffman',
      chamber: 'Senate',
      district: 'SD-17 (Harris / Fort Bend)',
      party: 'R',
      tenureYears: 16,
      leadershipRole: 'Chair, Senate Finance',
      bio: 'Former state district judge and prosecutor steering the Texas Senate Finance Committee and biennial state appropriations.',
      totalRaised: 2840000,
      billsAuthored: 55,
      billsPassed: 27,
    },
    {
      id: 'pol-bettencourt',
      name: 'Sen. Paul Bettencourt',
      shortName: 'Bettencourt',
      chamber: 'Senate',
      district: 'SD-7 (Harris)',
      party: 'R',
      tenureYears: 10,
      leadershipRole: 'Chair, Senate Local Government',
      bio: 'Former Harris County Tax Assessor-Collector driving property tax compression, homestead exemptions, and appraisal reform.',
      totalRaised: 2150000,
      billsAuthored: 68,
      billsPassed: 29,
    },
    {
      id: 'pol-schwertner',
      name: 'Sen. Charles Schwertner',
      shortName: 'Schwertner',
      chamber: 'Senate',
      district: 'SD-5 (Williamson / Brazos)',
      party: 'R',
      tenureYears: 14,
      leadershipRole: 'Chair, Senate Business & Commerce',
      bio: 'Orthopedic surgeon leading Senate Business & Commerce on ERCOT dispatchable generation, grid reliability, and nuclear power.',
      totalRaised: 2690000,
      billsAuthored: 49,
      billsPassed: 21,
    },
    {
      id: 'pol-kolkhorst',
      name: 'Sen. Lois Kolkhorst',
      shortName: 'Kolkhorst',
      chamber: 'Senate',
      district: 'SD-18 (Austin / Coastal Bend)',
      party: 'R',
      tenureYears: 24,
      leadershipRole: 'Chair, Senate Health & Human Services',
      bio: 'Longtime rural lawmaker overseeing Medicaid reform, rural EMS funding, and Texas water resource compacts.',
      totalRaised: 1890000,
      billsAuthored: 52,
      billsPassed: 19,
    },
    {
      id: 'pol-hunter',
      name: 'Rep. Todd Hunter',
      shortName: 'Hunter',
      chamber: 'House',
      district: 'HD-32 (Nueces / Aransas)',
      party: 'R',
      tenureYears: 20,
      leadershipRole: 'Chair, House Calendars',
      bio: 'Coastal Bend attorney controlling House floor scheduling through the House Calendars Committee.',
      totalRaised: 1640000,
      billsAuthored: 41,
      billsPassed: 18,
    },
    {
      id: 'pol-meyer',
      name: 'Rep. Morgan Meyer',
      shortName: 'Meyer',
      chamber: 'House',
      district: 'HD-108 (Dallas)',
      party: 'R',
      tenureYears: 10,
      leadershipRole: 'Chair, House Ways & Means',
      bio: 'Dallas litigator directing House tax policy, appraisal district governance, and business franchise tax exemptions.',
      totalRaised: 2290000,
      billsAuthored: 36,
      billsPassed: 15,
    },
    {
      id: 'pol-gonzalez',
      name: 'Rep. Mary González',
      shortName: 'González, Mary',
      chamber: 'House',
      district: 'HD-75 (El Paso)',
      party: 'D',
      tenureYears: 12,
      leadershipRole: 'Vice-Chair, House Appropriations',
      bio: 'Educator and El Paso representative serving as House Appropriations Vice-Chair with deep focus on special education and border water.',
      totalRaised: 780000,
      billsAuthored: 47,
      billsPassed: 11,
    },
    {
      id: 'pol-bernal',
      name: 'Rep. Diego Bernal',
      shortName: 'Bernal',
      chamber: 'House',
      district: 'HD-123 (Bexar)',
      party: 'D',
      tenureYears: 10,
      leadershipRole: 'Joint Author, Public School Finance',
      bio: 'San Antonio civil rights attorney negotiating bipartisan public school funding formulas and bilingual education allotments.',
      totalRaised: 610000,
      billsAuthored: 42,
      billsPassed: 9,
    },
    {
      id: 'pol-king-k',
      name: 'Rep. Ken King',
      shortName: 'King, Ken',
      chamber: 'House',
      district: 'HD-88 (Panhandle)',
      party: 'R',
      tenureYears: 12,
      leadershipRole: 'Chair, House State Affairs',
      bio: 'Panhandle oilfield equipment executive leading House State Affairs on grid resilience, wildfire response, and rural ambulance grants.',
      totalRaised: 1310000,
      billsAuthored: 33,
      billsPassed: 13,
    },
    {
      id: 'pol-zaffirini',
      name: 'Sen. Judith Zaffirini',
      shortName: 'Zaffirini',
      chamber: 'Senate',
      district: 'SD-21 (Webb / Bexar)',
      party: 'D',
      tenureYears: 38,
      leadershipRole: 'Dean of the Texas Senate',
      bio: 'Senior Texas Senator renowned for perfect attendance, bipartisan higher education legislation, and judicial transparency reforms.',
      totalRaised: 1120000,
      billsAuthored: 112,
      billsPassed: 46,
    },
    {
      id: 'pol-alvarado',
      name: 'Sen. Carol Alvarado',
      shortName: 'Alvarado',
      chamber: 'Senate',
      district: 'SD-6 (Harris)',
      party: 'D',
      tenureYears: 16,
      leadershipRole: 'Senate Democratic Caucus Chair',
      bio: 'Houston lawmaker focused on industrial flood mitigation, Texas Energy Fund oversight, and public school teacher retention.',
      totalRaised: 1240000,
      billsAuthored: 45,
      billsPassed: 10,
    },
    {
      id: 'pol-harris-c',
      name: 'Rep. Cody Harris',
      shortName: 'Harris, Cody',
      chamber: 'House',
      district: 'HD-8 (Anderson / Navarro)',
      party: 'R',
      tenureYears: 6,
      leadershipRole: 'Chair, House Natural Resources',
      bio: 'Real estate broker leading water infrastructure investment, nuclear industrial siting, and rural conservation.',
      totalRaised: 940000,
      billsAuthored: 29,
      billsPassed: 12,
    },
    {
      id: 'pol-guillen',
      name: 'Rep. Ryan Guillen',
      shortName: 'Guillen',
      chamber: 'House',
      district: 'HD-31 (Starr / Atascosa)',
      party: 'R',
      tenureYears: 22,
      leadershipRole: 'Member, House Ways & Means',
      bio: 'South Texas rancher and seasoned floor negotiator backing rural school allotments, property tax exemptions, and border sheriff funding.',
      totalRaised: 1080000,
      billsAuthored: 58,
      billsPassed: 22,
    },
  ];

  const insertPol = db.prepare(`
    INSERT INTO politicians (id, name, short_name, chamber, district, party, tenure_years, leadership_role, bio, total_raised, bills_authored, bills_passed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of politicians) {
    insertPol.run(
      p.id, p.name, p.shortName, p.chamber, p.district, p.party,
      p.tenureYears, p.leadershipRole, p.bio, p.totalRaised, p.billsAuthored, p.billsPassed
    );
  }

  // 2. Committees & Memberships
  const committees = [
    { id: 'com-h-pubed', name: 'Public Education', chamber: 'House', session: '89R', chairId: 'pol-buckley', viceChairId: 'pol-bernal', jurisdiction: 'Texas Education Code, public school finance, teacher compensation, STAAR assessment.' },
    { id: 'com-s-ed', name: 'Education K-16', chamber: 'Senate', session: '89R', chairId: 'pol-creighton', viceChairId: 'pol-zaffirini', jurisdiction: 'Education savings accounts, K-12 curriculum, higher education governance.' },
    { id: 'com-h-approp', name: 'Appropriations', chamber: 'House', session: '89R', chairId: 'pol-bonnen', viceChairId: 'pol-gonzalez', jurisdiction: 'Biennial General Appropriations Act, agency budgets, disaster & infrastructure reserves.' },
    { id: 'com-s-fin', name: 'Finance', chamber: 'Senate', session: '89R', chairId: 'pol-huffman', viceChairId: 'pol-alvarado', jurisdiction: 'State budget, tax compression funding, Texas Energy Fund & Water Fund allocations.' },
    { id: 'com-s-bus', name: 'Business & Commerce', chamber: 'Senate', session: '89R', chairId: 'pol-schwertner', viceChairId: 'pol-alvarado', jurisdiction: 'ERCOT electric grid reliability, PUC oversight, nuclear & natural gas generation, AI regulation.' },
    { id: 'com-h-state', name: 'State Affairs', chamber: 'House', session: '89R', chairId: 'pol-king-k', viceChairId: 'pol-hunter', jurisdiction: 'Electric utility infrastructure, regulatory efficiency, emergency communications, state agency sunsets.' },
    { id: 'com-h-ways', name: 'Ways & Means', chamber: 'House', session: '89R', chairId: 'pol-meyer', viceChairId: 'pol-guillen', jurisdiction: 'Tax Code, school district property tax compression, homestead exemptions, motor fuels exemptions.' },
    { id: 'com-s-local', name: 'Local Government', chamber: 'Senate', session: '89R', chairId: 'pol-bettencourt', viceChairId: 'pol-zaffirini', jurisdiction: 'Appraisal districts, municipal & county tax rates, homestead exemption implementation.' },
    { id: 'com-s-hhs', name: 'Health & Human Services', chamber: 'Senate', session: '89R', chairId: 'pol-kolkhorst', viceChairId: 'pol-alvarado', jurisdiction: 'Rural hospital grants, ambulance services, Medicaid oversight, mental health workforce.' },
    { id: 'com-h-natres', name: 'Natural Resources', chamber: 'House', session: '89R', chairId: 'pol-harris-c', viceChairId: 'pol-gonzalez', jurisdiction: 'Texas Water Development Board, flood infrastructure, groundwater conservation districts.' },
    { id: 'com-h-cal', name: 'Calendars', chamber: 'House', session: '89R', chairId: 'pol-hunter', viceChairId: 'pol-harris-c', jurisdiction: 'Procedural gatekeeping and daily floor calendar scheduling for House bills.' },
  ];

  const insertCom = db.prepare(
    `INSERT INTO committees (id, name, chamber, session, chair_id, vice_chair_id, jurisdiction) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMem = db.prepare(
    `INSERT INTO committee_memberships (id, committee_id, politician_id, role, session) VALUES (?, ?, ?, ?, ?)`
  );
  for (const c of committees) {
    insertCom.run(c.id, c.name, c.chamber, c.session, c.chairId, c.viceChairId, c.jurisdiction);
    insertMem.run(`mem-${c.id}-${c.chairId}`, c.id, c.chairId, 'Chair', c.session);
    if (c.viceChairId) {
      insertMem.run(`mem-${c.id}-${c.viceChairId}`, c.id, c.viceChairId, 'Vice-Chair', c.session);
    }
  }
  const extraMemberships = [
    ['com-h-pubed', 'pol-guillen', 'Member'],
    ['com-h-pubed', 'pol-harris-c', 'Member'],
    ['com-s-ed', 'pol-bettencourt', 'Member'],
    ['com-s-ed', 'pol-kolkhorst', 'Member'],
    ['com-s-fin', 'pol-creighton', 'Member'],
    ['com-s-fin', 'pol-bettencourt', 'Member'],
    ['com-s-fin', 'pol-schwertner', 'Member'],
    ['com-s-fin', 'pol-kolkhorst', 'Member'],
    ['com-s-fin', 'pol-zaffirini', 'Member'],
    ['com-h-approp', 'pol-buckley', 'Member'],
    ['com-h-approp', 'pol-meyer', 'Member'],
    ['com-h-approp', 'pol-bernal', 'Member'],
    ['com-h-state', 'pol-harris-c', 'Member'],
    ['com-h-ways', 'pol-hunter', 'Member'],
    ['com-h-ways', 'pol-bernal', 'Member'],
  ];
  for (const [cid, pid, role] of extraMemberships) {
    insertMem.run(`mem-${cid}-${pid}`, cid, pid, role, '89R');
  }

  // 3. Seed Donors & Campaign Contributions (Texas Ethics Commission style)
  const donors = [
    { id: 'don-tppc', name: 'Texas School Choice & Liberty PAC', sector: 'Education Advocacy', pacId: 'TEC-00084120', city: 'Austin, TX' },
    { id: 'don-tepac', name: 'Texas Public Educators Coalition PAC', sector: 'Education Advocacy', pacId: 'TEC-00019344', city: 'Austin, TX' },
    { id: 'don-txoga', name: 'Texas Oil & Gas Good Government PAC', sector: 'Energy & Grid', pacId: 'TEC-00022190', city: 'Austin, TX' },
    { id: 'don-ercot-gen', name: 'Texas Competitive Power Advocates PAC', sector: 'Energy & Grid', pacId: 'TEC-00067411', city: 'Houston, TX' },
    { id: 'don-realtors', name: 'Texas Association of Realtors PAC (TREPAC)', sector: 'Real Estate & Construction', pacId: 'TEC-00011052', city: 'Austin, TX' },
    { id: 'don-builders', name: 'Associated General Contractors of Texas PAC', sector: 'Real Estate & Construction', pacId: 'TEC-00034908', city: 'Austin, TX' },
    { id: 'don-tma', name: 'Texas Medical Association PAC (TEXPAC)', sector: 'Healthcare', pacId: 'TEC-00014289', city: 'Austin, TX' },
    { id: 'don-hospitals', name: 'Texas Hospital Association HOSPAC', sector: 'Healthcare', pacId: 'TEC-00018722', city: 'Austin, TX' },
    { id: 'don-tech', name: 'Texas Digital Infrastructure & Cloud PAC', sector: 'Tech & Telecom', pacId: 'TEC-00091204', city: 'Dallas, TX' },
    { id: 'don-tlr', name: 'Texans for Lawsuit Reform PAC', sector: 'Legal & Regulatory', pacId: 'TEC-00031500', city: 'Houston, TX' },
  ];

  const insertDonor = db.prepare(`INSERT INTO donors (id, name, sector, pac_id, city) VALUES (?, ?, ?, ?, ?)`);
  for (const d of donors) insertDonor.run(d.id, d.name, d.sector, d.pacId, d.city);

  const contribRows: Array<[string, string, string, number, string]> = [
    ['don-tppc', 'pol-creighton', '2024–2025', 225000, '2024-10-28'],
    ['don-tppc', 'pol-buckley', '2024–2025', 140000, '2024-10-29'],
    ['don-tppc', 'pol-bettencourt', '2024–2025', 110000, '2024-10-25'],
    ['don-tppc', 'pol-meyer', '2024–2025', 75000, '2024-10-22'],
    ['don-tepac', 'pol-bernal', '2024–2025', 48000, '2024-10-21'],
    ['don-tepac', 'pol-gonzalez', '2024–2025', 52000, '2024-10-24'],
    ['don-tepac', 'pol-zaffirini', '2024–2025', 38000, '2024-10-19'],
    ['don-tepac', 'pol-buckley', '2024–2025', 35000, '2025-01-08'],
    ['don-txoga', 'pol-schwertner', '2024–2025', 195000, '2024-10-30'],
    ['don-txoga', 'pol-huffman', '2024–2025', 165000, '2024-10-27'],
    ['don-txoga', 'pol-king-k', '2024–2025', 120000, '2024-10-24'],
    ['don-txoga', 'pol-bonnen', '2024–2025', 115000, '2024-10-20'],
    ['don-ercot-gen', 'pol-schwertner', '2024–2025', 175000, '2025-01-05'],
    ['don-ercot-gen', 'pol-king-k', '2024–2025', 85000, '2025-01-06'],
    ['don-ercot-gen', 'pol-alvarado', '2024–2025', 42000, '2024-10-28'],
    ['don-realtors', 'pol-bettencourt', '2024–2025', 135000, '2024-10-29'],
    ['don-realtors', 'pol-meyer', '2024–2025', 125000, '2024-10-26'],
    ['don-realtors', 'pol-guillen', '2024–2025', 65000, '2024-10-21'],
    ['don-realtors', 'pol-harris-c', '2024–2025', 70000, '2024-10-18'],
    ['don-builders', 'pol-bonnen', '2024–2025', 95000, '2024-10-25'],
    ['don-builders', 'pol-huffman', '2024–2025', 110000, '2024-10-27'],
    ['don-builders', 'pol-alvarado', '2024–2025', 55000, '2024-10-22'],
    ['don-tma', 'pol-bonnen', '2024–2025', 180000, '2024-10-26'],
    ['don-tma', 'pol-schwertner', '2024–2025', 160000, '2024-10-26'],
    ['don-tma', 'pol-kolkhorst', '2024–2025', 125000, '2024-10-28'],
    ['don-hospitals', 'pol-kolkhorst', '2024–2025', 98000, '2025-01-04'],
    ['don-hospitals', 'pol-gonzalez', '2024–2025', 45000, '2024-10-30'],
    ['don-tech', 'pol-meyer', '2024–2025', 90000, '2025-01-09'],
    ['don-tech', 'pol-hunter', '2024–2025', 80000, '2024-10-29'],
    ['don-tlr', 'pol-creighton', '2024–2025', 210000, '2024-10-24'],
    ['don-tlr', 'pol-hunter', '2024–2025', 145000, '2024-10-25'],
    ['don-tlr', 'pol-huffman', '2024–2025', 190000, '2024-10-28'],
  ];
  const insertContrib = db.prepare(
    `INSERT INTO contributions (id, donor_id, politician_id, cycle, amount, filing_date) VALUES (?, ?, ?, ?, ?, ?)`
  );
  contribRows.forEach(([did, pid, cycle, amount, fdate], i) => {
    insertContrib.run(`ctr-${i + 1}`, did, pid, cycle, amount, fdate);
  });

  // 4. Seed Multi-Session Texas Bills (87R, 88R, 89R, 891, 90R)
  const billsSeed = [
    {
      id: '89R-HB2',
      session: '89R',
      billNumber: 'HB 2',
      chamber: 'House',
      title: 'Relating to public education and public school finance, teacher compensation allotments, and special education funding.',
      summary: 'Enacts an $8.5 billion biennial investment in Texas public education, increasing the basic allotment, creating tiered teacher retention allotments based on district size and tenure, reforming special education intensity weights, and expanding prekindergarten and career technical allotments.',
      statuteCodes: ['Education Code Ch. 48', 'Education Code Ch. 21', 'Education Code Ch. 29'],
      status: 'Signed by the Governor — Effective Sept 1, 2025',
      stage: 'Signed',
      primaryAuthor: 'Buckley',
      coauthors: ['Bernal', 'Guillen', 'Bonnen', 'Meyer', 'Hunter', 'Harris, Cody', 'King, Ken', 'González, Mary'],
      sponsors: ['Creighton'],
      cosponsors: ['Bettencourt', 'Huffman', 'Zaffirini', 'Alvarado', 'Kolkhorst', 'Schwertner'],
      committees: [
        { name: 'Public Education', chamber: 'House', status: 'Out of committee', ayeVotes: 13, nayVotes: 2 },
        { name: 'Education K-16', chamber: 'Senate', status: 'Out of committee', ayeVotes: 9, nayVotes: 0 },
      ],
      subjects: [
        'Education--Primary & Secondary--Finance',
        'Education--Primary & Secondary--Teachers',
        'Education--Primary & Secondary--Special',
        'Foundation School Fund',
        'Teacher Retention Allotment',
      ],
      lastAction: '06/20/2025 E Signed by the Governor',
      lastActionDate: '2025-06-20',
      filedDate: '2025-02-20',
      fullText: `SECTION 1.01. Section 48.051, Education Code, is amended to increase the basic allotment per student in average daily attendance to $6,555 and establish an automatic inflationary adjustment study by the Legislative Budget Board.\nSECTION 2.04. Subchapter D, Chapter 48, Education Code, is amended by adding Section 48.158, establishing the Teacher Retention Allotment providing $2,500 to $8,000 in dedicated salary increases for classroom teachers with three or more years of experience, weighted for rural districts under 5,000 enrollment.\nSECTION 3.01. Special Education Funding Transition: Replaces instructional arrangement weights with an intensity-of-service funding tier administered by the Texas Education Agency.\nSECTION 4.02. Establishes uncertified teacher reduction milestones and school safety allotment increases per campus.`,
      amendments: [
        {
          id: '89R-HB2-v1',
          versionCode: 'I',
          versionLabel: 'Introduced (As Filed)',
          amendmentNumber: 'Filed Version',
          sponsor: 'Buckley',
          filedDate: '2025-02-20',
          disposition: 'Filed',
          yeaVotes: 0,
          nayVotes: 0,
          pnvVotes: 0,
          summary: 'Original filed draft setting basic allotment increase to $6,380 with flat teacher incentive allotment expansion.',
          fullText: `SECTION 1.01. Section 48.051, Education Code, is amended to increase the basic allotment per student in average daily attendance to $6,380.\nSECTION 2.04. Expands the Teacher Incentive Allotment merit tiers without a universal tenure-based retention floor.\nSECTION 3.01. Directs the Texas Education Agency to study special education intensity-of-service weights by 2027.\nSECTION 4.02. Increases school safety allotment to $10.00 per student.`,
          sortOrder: 1,
        },
        {
          id: '89R-HB2-v2',
          versionCode: 'H',
          versionLabel: 'House Committee Substitute (CSHB 2)',
          amendmentNumber: 'CSHB 2',
          sponsor: 'Buckley',
          filedDate: '2025-04-03',
          disposition: 'Substituted',
          yeaVotes: 13,
          nayVotes: 2,
          pnvVotes: 0,
          summary: 'Public Education committee substitute lifting basic allotment to $6,555 and inserting dedicated rural teacher retention allotments.',
          fullText: `SECTION 1.01. Section 48.051, Education Code, is amended to increase the basic allotment per student in average daily attendance to $6,555.\nSECTION 2.04. Subchapter D, Chapter 48, Education Code, is amended by adding Section 48.158, establishing the Teacher Retention Allotment providing $2,500 to $5,000 for classroom teachers with three or more years of experience.\nSECTION 3.01. Special Education Funding Transition: Replaces instructional arrangement weights with an intensity-of-service funding tier administered by the Texas Education Agency.\nSECTION 4.02. Increases school safety allotment to $20.00 per student and $28,000 per campus.`,
          sortOrder: 2,
        },
        {
          id: '89R-HB2-fa1',
          versionCode: 'FA1',
          versionLabel: 'House Floor Amendment No. 4 (Bernal)',
          amendmentNumber: 'Floor Amend. #4',
          sponsor: 'Bernal',
          filedDate: '2025-04-16',
          disposition: 'Adopted',
          yeaVotes: 121,
          nayVotes: 24,
          pnvVotes: 2,
          summary: 'Requires at least 40% of basic allotment increases to fund non-administrative staff compensation including bus drivers, paraprofessionals, and nurses.',
          fullText: `SECTION 1.01. Section 48.051, Education Code, is amended to increase the basic allotment per student in average daily attendance to $6,555 and mandates 40 percent support staff compensation pass-through.\nSECTION 2.04. Subchapter D, Chapter 48, Education Code, is amended by adding Section 48.158, establishing the Teacher Retention Allotment providing $2,500 to $8,000 in dedicated salary increases for classroom teachers with three or more years of experience, weighted for rural districts under 5,000 enrollment.\nSECTION 3.01. Special Education Funding Transition: Replaces instructional arrangement weights with an intensity-of-service funding tier administered by the Texas Education Agency.\nSECTION 4.02. Increases school safety allotment and restricts uncertified teacher assignments in core foundation courses.`,
          sortOrder: 3,
        },
        {
          id: '89R-HB2-v5',
          versionCode: 'F',
          versionLabel: 'Enrolled (Final Conference Text)',
          amendmentNumber: 'Enrolled',
          sponsor: 'Buckley',
          filedDate: '2025-05-30',
          disposition: 'Enacted',
          yeaVotes: 144,
          nayVotes: 4,
          pnvVotes: 1,
          summary: 'Final enacted $8.5B compromise adopted by House and Senate balancing basic allotment gains with targeted teacher raises and special education tiers.',
          fullText: `SECTION 1.01. Section 48.051, Education Code, is amended to increase the basic allotment per student in average daily attendance to $6,555 and establish an automatic inflationary adjustment study by the Legislative Budget Board.\nSECTION 2.04. Subchapter D, Chapter 48, Education Code, is amended by adding Section 48.158, establishing the Teacher Retention Allotment providing $2,500 to $8,000 in dedicated salary increases for classroom teachers with three or more years of experience, weighted for rural districts under 5,000 enrollment.\nSECTION 3.01. Special Education Funding Transition: Replaces instructional arrangement weights with an intensity-of-service funding tier administered by the Texas Education Agency.\nSECTION 4.02. Establishes uncertified teacher reduction milestones and school safety allotment increases per campus.`,
          sortOrder: 4,
        },
      ],
      actions: [
        { date: '2025-02-20', num: 'H001', desc: 'Filed in Texas House of Representatives' },
        { date: '2025-02-25', num: 'H115', desc: 'Referred to Public Education' },
        { date: '2025-03-04', num: 'H215', desc: 'Considered in public hearing; testimony recorded' },
        { date: '2025-04-03', num: 'H252', desc: 'Reported favorably as substituted (13-2)' },
        { date: '2025-04-16', num: 'H405', desc: 'Passed House with Floor Amendments (142-6)' },
        { date: '2025-05-22', num: 'S310', desc: 'Passed Senate with amendments (29-2)' },
        { date: '2025-06-20', num: 'E090', desc: 'Signed by the Governor' },
      ],
    },
    {
      id: '89R-SB2',
      session: '89R',
      billNumber: 'SB 2',
      chamber: 'Senate',
      title: 'Relating to the establishment of the Texas Education Freedom Accounts program for eligible private and specialized educational expenses.',
      summary: 'Creates a $1 billion statewide education savings account (school voucher) program administered by the Comptroller, providing up to $10,000 per participating student for accredited private tuition, instructional materials, and therapies for students with disabilities.',
      statuteCodes: ['Education Code Ch. 29 Subch. J', 'Government Code Ch. 403'],
      status: 'Signed by the Governor — Effective Sept 1, 2025',
      stage: 'Signed',
      primaryAuthor: 'Creighton',
      coauthors: ['Bettencourt', 'Huffman', 'Schwertner', 'Kolkhorst'],
      sponsors: ['Buckley'],
      cosponsors: ['Meyer', 'Hunter', 'Harris, Cody', 'King, Ken'],
      committees: [
        { name: 'Education K-16', chamber: 'Senate', status: 'Out of committee', ayeVotes: 8, nayVotes: 3 },
        { name: 'Public Education', chamber: 'House', status: 'Out of committee', ayeVotes: 9, nayVotes: 6 },
      ],
      subjects: [
        'Education Savings Accounts',
        'School Choice',
        'Comptroller of Public Accounts',
        'Disabilities, Persons with',
        'Education--Primary & Secondary--Private Schools',
      ],
      lastAction: '05/03/2025 E Signed by the Governor',
      lastActionDate: '2025-05-03',
      filedDate: '2025-01-23',
      fullText: `SECTION 1. Chapter 29, Education Code, is amended by adding Subchapter J, Section 29.351: Texas Education Freedom Accounts.\nSECTION 2.02. Program Cap & Lottery Prioritization: Caps biennial program expenditures at $1,000,000,000. If applications exceed available appropriations, 80 percent of slots are prioritized for households at or below 500 percent of federal poverty guidelines and students with an individualized education program.\nSECTION 2.05. Allotment Value: Accredited private school enrollees receive 85 percent of average statewide per-pupil funding (approx. $10,000), while homeschool participants receive up to $2,000 for verified curricula.\nSECTION 3.01. Audit & Testing Mandate: Participating private schools must administer a nationally norm-referenced assessment annually and undergo Comptroller financial auditing.`,
      amendments: [
        {
          id: '89R-SB2-v1',
          versionCode: 'I',
          versionLabel: 'Introduced (As Filed)',
          amendmentNumber: 'Filed Version',
          sponsor: 'Creighton',
          filedDate: '2025-01-23',
          disposition: 'Filed',
          yeaVotes: 0,
          nayVotes: 0,
          pnvVotes: 0,
          summary: 'Uncapped universal eligibility draft providing $10,500 per student without lottery income tiers.',
          fullText: `SECTION 1. Chapter 29, Education Code, is amended by adding Subchapter J, Section 29.351: Texas Education Freedom Accounts.\nSECTION 2.02. Universal Eligibility: All Texas resident school-age children are eligible without statutory enrollment caps.\nSECTION 2.05. Allotment Value: $10,500 per participating student regardless of private or homeschool setting.`,
          sortOrder: 1,
        },
        {
          id: '89R-SB2-v2',
          versionCode: 'H',
          versionLabel: 'House Committee Substitute (CSSB 2)',
          amendmentNumber: 'CSSB 2',
          sponsor: 'Buckley',
          filedDate: '2025-04-03',
          disposition: 'Substituted',
          yeaVotes: 9,
          nayVotes: 6,
          pnvVotes: 0,
          summary: 'Adds $1B biennial spending cap, 500% FPL lottery prioritization, homeschool $2,000 ceiling, and norm-referenced testing.',
          fullText: `SECTION 1. Chapter 29, Education Code, is amended by adding Subchapter J, Section 29.351: Texas Education Freedom Accounts.\nSECTION 2.02. Program Cap & Lottery Prioritization: Caps biennial program expenditures at $1,000,000,000. If applications exceed available appropriations, 80 percent of slots are prioritized for households at or below 500 percent of federal poverty guidelines and students with an individualized education program.\nSECTION 2.05. Allotment Value: Accredited private school enrollees receive 85 percent of average statewide per-pupil funding (approx. $10,000), while homeschool participants receive up to $2,000 for verified curricula.\nSECTION 3.01. Audit & Testing Mandate: Participating private schools must administer a nationally norm-referenced assessment annually and undergo Comptroller financial auditing.`,
          sortOrder: 2,
        },
        {
          id: '89R-SB2-fa2',
          versionCode: 'FA2',
          versionLabel: 'House Floor Amendment No. 11 (González, Mary)',
          amendmentNumber: 'Floor Amend. #11',
          sponsor: 'González, Mary',
          filedDate: '2025-04-17',
          disposition: 'Tabled',
          yeaVotes: 61,
          nayVotes: 86,
          pnvVotes: 1,
          summary: 'Motion to require full STAAR accountability parity for private campuses accepting Education Freedom Accounts.',
          fullText: `AMENDMENT: Insert Section 29.364 requiring any nonpublic school accepting Education Freedom Account funds to administer the state STAAR assessment and publish A-F campus ratings identical to public independent school districts.`,
          sortOrder: 3,
        },
      ],
      actions: [
        { date: '2025-01-23', num: 'S001', desc: 'Filed in Texas Senate' },
        { date: '2025-02-05', num: 'S252', desc: 'Passed Senate (19-12)' },
        { date: '2025-04-03', num: 'H252', desc: 'Reported favorably from House Public Education (9-6)' },
        { date: '2025-04-17', num: 'H410', desc: 'Passed House (85-63) after 14-hour floor debate' },
        { date: '2025-05-03', num: 'E090', desc: 'Signed by the Governor' },
      ],
    },
    {
      id: '89R-SB1',
      session: '89R',
      billNumber: 'SB 1',
      chamber: 'Senate',
      title: 'General Appropriations Bill for the 2026–2027 Fiscal Biennium.',
      summary: 'Sets the $338 billion two-year Texas state operating budget, including $51 billion for property tax relief, $8.5 billion for public education (HB 2), $1 billion for Education Freedom Accounts (SB 2), Texas Water Fund capitalization, and Texas Energy Fund grid loans.',
      statuteCodes: ['General Appropriations Act', 'Tax Code Ch. 26', 'Water Code Ch. 15'],
      status: 'Enacted — Comptroller Certified',
      stage: 'Signed',
      primaryAuthor: 'Huffman',
      coauthors: ['Creighton', 'Bettencourt', 'Schwertner', 'Kolkhorst', 'Zaffirini'],
      sponsors: ['Bonnen'],
      cosponsors: ['González, Mary', 'Buckley', 'Meyer', 'King, Ken'],
      committees: [
        { name: 'Finance', chamber: 'Senate', status: 'Out of committee', ayeVotes: 16, nayVotes: 1 },
        { name: 'Appropriations', chamber: 'House', status: 'Out of committee', ayeVotes: 24, nayVotes: 3 },
      ],
      subjects: [
        'State Finances--Appropriations',
        'Taxation--Property--Appraisal & Compression',
        'Texas Energy Fund',
        'Texas Water Fund',
        'Rural Ambulance Grants',
      ],
      lastAction: '06/21/2025 E Signed by the Governor with line-item vetoes',
      lastActionDate: '2025-06-21',
      filedDate: '2025-01-22',
      fullText: `ARTICLE I. GENERAL GOVERNMENT: Allocates $2.8 billion for Texas Facilities Commission and Regulatory Efficiency Office.\nARTICLE III. PUBLIC & HIGHER EDUCATION: Appropriates $8.5 billion contingent on HB 2 enactment and $1.0 billion for Education Freedom Accounts (SB 2); includes $51 billion total property tax compression and homestead exemption backfill.\nARTICLE VI. NATURAL RESOURCES & INFRASTRUCTURE: Transfers $2.5 billion to the Texas Water Fund and $5.0 billion to the Texas Energy Fund for dispatchable generation and nuclear grant matching.\nARTICLE IX. RURAL & BORDER CONTINGENCY: Allocates $90 million for rural emergency ambulance grants (HB 3000) and $20 million for sheriff law enforcement reimbursements.`,
      amendments: [
        {
          id: '89R-SB1-v1',
          versionCode: 'I',
          versionLabel: 'Introduced Senate Budget Draft',
          amendmentNumber: 'Filed Version',
          sponsor: 'Huffman',
          filedDate: '2025-01-22',
          disposition: 'Filed',
          yeaVotes: 0,
          nayVotes: 0,
          pnvVotes: 0,
          summary: 'Initial $332.9B baseline budget draft prior to Article III school finance and Article VI water negotiations.',
          fullText: `ARTICLE III. PUBLIC EDUCATION: Baseline Foundation School Program funding of $71.4 billion plus $4.8 billion contingent school finance reserve.\nARTICLE VI. WATER: $1.0 billion transfer to Texas Water Fund.`,
          sortOrder: 1,
        },
        {
          id: '89R-SB1-ccr',
          versionCode: 'F',
          versionLabel: 'Conference Committee Report (Enrolled)',
          amendmentNumber: 'CCR Enrolled',
          sponsor: 'Huffman',
          filedDate: '2025-05-31',
          disposition: 'Enacted',
          yeaVotes: 131,
          nayVotes: 16,
          pnvVotes: 0,
          summary: 'Reconciled $338B House-Senate Conference Report expanding water fund to $2.5B and locking $8.5B HB 2 + $1B SB 2 contingencies.',
          fullText: `ARTICLE I. GENERAL GOVERNMENT: Allocates $2.8 billion for Texas Facilities Commission and Regulatory Efficiency Office.\nARTICLE III. PUBLIC & HIGHER EDUCATION: Appropriates $8.5 billion contingent on HB 2 enactment and $1.0 billion for Education Freedom Accounts (SB 2); includes $51 billion total property tax compression and homestead exemption backfill.\nARTICLE VI. NATURAL RESOURCES & INFRASTRUCTURE: Transfers $2.5 billion to the Texas Water Fund and $5.0 billion to the Texas Energy Fund for dispatchable generation and nuclear grant matching.\nARTICLE IX. RURAL & BORDER CONTINGENCY: Allocates $90 million for rural emergency ambulance grants (HB 3000) and $20 million for sheriff law enforcement reimbursements.`,
          sortOrder: 2,
        },
      ],
      actions: [
        { date: '2025-01-22', num: 'S001', desc: 'Filed in Texas Senate' },
        { date: '2025-03-25', num: 'S250', desc: 'Passed Senate unanimously (31-0)' },
        { date: '2025-04-10', num: 'H400', desc: 'Passed House with House substitute (118-26)' },
        { date: '2025-05-31', num: 'E050', desc: 'Conference Committee Report adopted by both chambers' },
        { date: '2025-06-21', num: 'E090', desc: 'Signed by the Governor' },
      ],
    },
    {
      id: '89R-HB14',
      session: '89R',
      billNumber: 'HB 14',
      chamber: 'House',
      title: 'Relating to support for the development of the nuclear energy and advanced reactor industry for electric grid reliability.',
      summary: 'Establishes the Texas Advanced Nuclear Energy Office and a $350 million matching grant fund within the Governor’s Office to accelerate small modular reactor (SMR) permitting, grid interconnection inside ERCOT, and nuclear workforce pipelines.',
      statuteCodes: ['Utilities Code Ch. 35', 'Government Code Ch. 483'],
      status: 'Signed by the Governor — Effective Sept 1, 2025',
      stage: 'Signed',
      primaryAuthor: 'Harris, Cody',
      coauthors: ['King, Ken', 'Bonnen', 'Hunter', 'Meyer', 'Guillen'],
      sponsors: ['Schwertner'],
      cosponsors: ['Huffman', 'Creighton', 'Alvarado'],
      committees: [
        { name: 'State Affairs', chamber: 'House', status: 'Out of committee', ayeVotes: 12, nayVotes: 1 },
        { name: 'Business & Commerce', chamber: 'Senate', status: 'Out of committee', ayeVotes: 10, nayVotes: 1 },
      ],
      subjects: [
        'Nuclear Energy & Advanced Reactors',
        'ERCOT Electric Grid Reliability',
        'Texas Energy Fund',
        'Utilities--Electric',
      ],
      lastAction: '06/14/2025 E Signed by the Governor',
      lastActionDate: '2025-06-14',
      filedDate: '2025-02-11',
      fullText: `SECTION 1. Government Code Chapter 483 is added to create the Texas Advanced Nuclear Energy Office and Texas Nuclear Development Fund.\nSECTION 2. Authorizes $350,000,000 in matching reimbursement grants for NRC licensing milestones, site characterization, and ERCOT transmission interconnection for dispatchable nuclear generation.\nSECTION 3. Directs the Public Utility Commission of Texas to prioritize firm zero-emission baseload generation in ERCOT capacity adequacy filings.`,
      amendments: [
        {
          id: '89R-HB14-v1',
          versionCode: 'I',
          versionLabel: 'Introduced (As Filed)',
          amendmentNumber: 'Filed Version',
          sponsor: 'Harris, Cody',
          filedDate: '2025-02-11',
          disposition: 'Filed',
          yeaVotes: 0,
          nayVotes: 0,
          pnvVotes: 0,
          summary: 'Creates Texas Nuclear Energy Office with $200M grant authorization.',
          fullText: `SECTION 1. Government Code Chapter 483 is added to create the Texas Advanced Nuclear Energy Office.\nSECTION 2. Authorizes $200,000,000 in grant funding for nuclear feasibility studies.`,
          sortOrder: 1,
        },
        {
          id: '89R-HB14-v2',
          versionCode: 'E',
          versionLabel: 'Engrossed House Bill (With $350M Fund)',
          amendmentNumber: 'Engrossed',
          sponsor: 'King, Ken',
          filedDate: '2025-04-28',
          disposition: 'Enacted',
          yeaVotes: 129,
          nayVotes: 15,
          pnvVotes: 1,
          summary: 'Expands nuclear grant fund to $350M and adds PUC ERCOT interconnection priority.',
          fullText: `SECTION 1. Government Code Chapter 483 is added to create the Texas Advanced Nuclear Energy Office and Texas Nuclear Development Fund.\nSECTION 2. Authorizes $350,000,000 in matching reimbursement grants for NRC licensing milestones, site characterization, and ERCOT transmission interconnection for dispatchable nuclear generation.\nSECTION 3. Directs the Public Utility Commission of Texas to prioritize firm zero-emission baseload generation in ERCOT capacity adequacy filings.`,
          sortOrder: 2,
        },
      ],
      actions: [
        { date: '2025-02-11', num: 'H001', desc: 'Filed in Texas House' },
        { date: '2025-03-19', num: 'H252', desc: 'Reported favorably from House State Affairs' },
        { date: '2025-04-28', num: 'H410', desc: 'Passed House (129-15)' },
        { date: '2025-06-14', num: 'E090', desc: 'Signed by the Governor' },
      ],
    },
    {
      id: '89R-SB14',
      session: '89R',
      billNumber: 'SB 14',
      chamber: 'Senate',
      title: 'Relating to the creation of the Texas Regulatory Efficiency Office and periodic sunset review of administrative rules.',
      summary: 'Establishes the Texas Regulatory Efficiency Office inside the Governor’s Office to audit agency rules, quantify compliance costs on small businesses, and repeal obsolete Texas Administrative Code provisions.',
      statuteCodes: ['Government Code Ch. 2001', 'Government Code Ch. 436'],
      status: 'Signed by the Governor — Effective Sept 1, 2025',
      stage: 'Signed',
      primaryAuthor: 'King, Phil',
      coauthors: ['Schwertner', 'Creighton', 'Bettencourt', 'Huffman', 'Kolkhorst'],
      sponsors: ['Harris, Cody'],
      cosponsors: ['Meyer', 'King, Ken', 'Hunter'],
      committees: [
        { name: 'Business & Commerce', chamber: 'Senate', status: 'Out of committee', ayeVotes: 9, nayVotes: 2 },
        { name: 'State Affairs', chamber: 'House', status: 'Out of committee', ayeVotes: 10, nayVotes: 4 },
      ],
      subjects: [
        'Regulatory Efficiency',
        'Administrative Code & Rulemaking',
        'Small Business Compliance',
        'State Agencies',
      ],
      lastAction: '05/19/2025 E Signed by the Governor',
      lastActionDate: '2025-05-19',
      filedDate: '2025-01-30',
      fullText: `SECTION 1. Creates the Texas Regulatory Efficiency Office to coordinate agency cost-benefit reviews of proposed Texas Administrative Code regulations exceeding $1 million in statewide compliance impact.\nSECTION 2. Requires plain-language regulatory impact statements and establishes an interactive public rule-reduction portal.`,
      amendments: [
        {
          id: '89R-SB14-v1',
          versionCode: 'I',
          versionLabel: 'Introduced (As Filed)',
          amendmentNumber: 'Filed Version',
          sponsor: 'Schwertner',
          filedDate: '2025-01-30',
          disposition: 'Filed',
          yeaVotes: 0,
          nayVotes: 0,
          pnvVotes: 0,
          summary: 'Creates Regulatory Efficiency Office with automatic 5-year rule expiration.',
          fullText: `SECTION 1. Creates the Texas Regulatory Efficiency Office.\nSECTION 2. All state agency rules automatically expire every 5 years unless affirmatively re-adopted by legislative joint resolution.`,
          sortOrder: 1,
        },
        {
          id: '89R-SB14-v2',
          versionCode: 'F',
          versionLabel: 'Enrolled (Cost-Benefit Threshold Compromise)',
          amendmentNumber: 'Enrolled',
          sponsor: 'Harris, Cody',
          filedDate: '2025-05-10',
          disposition: 'Enacted',
          yeaVotes: 98,
          nayVotes: 47,
          pnvVotes: 0,
          summary: 'Replaces automatic 5-year rule sunset with $1M economic impact threshold review and public repeal portal.',
          fullText: `SECTION 1. Creates the Texas Regulatory Efficiency Office to coordinate agency cost-benefit reviews of proposed Texas Administrative Code regulations exceeding $1 million in statewide compliance impact.\nSECTION 2. Requires plain-language regulatory impact statements and establishes an interactive public rule-reduction portal.`,
          sortOrder: 2,
        },
      ],
      actions: [
        { date: '2025-01-30', num: 'S001', desc: 'Filed in Texas Senate' },
        { date: '2025-03-11', num: 'S252', desc: 'Passed Senate (22-9)' },
        { date: '2025-05-10', num: 'H410', desc: 'Passed House (98-47)' },
        { date: '2025-05-19', num: 'E090', desc: 'Signed by the Governor' },
      ],
    },
    {
      id: '89R-HB4',
      session: '89R',
      billNumber: 'HB 4',
      chamber: 'House',
      title: 'Relating to public school assessment and accountability reform, replacing STAAR with through-year adaptive benchmarks.',
      summary: 'Proposed phasing out single-day STAAR exams in favor of shorter beginning-, middle-, and end-of-year adaptive assessments and updating campus A-F accountability metrics. Passed House but stalled in Senate-House impasse before sine die.',
      statuteCodes: ['Education Code Ch. 39'],
      status: 'Stalled in Conference — Sine Die',
      stage: 'Stalled',
      primaryAuthor: 'Buckley',
      coauthors: ['Bernal', 'González, Mary', 'Guillen', 'Meyer'],
      sponsors: ['Creighton'],
      cosponsors: ['Zaffirini'],
      committees: [
        { name: 'Public Education', chamber: 'House', status: 'Out of committee', ayeVotes: 14, nayVotes: 1 },
        { name: 'Education K-16', chamber: 'Senate', status: 'Pending', ayeVotes: 0, nayVotes: 0 },
      ],
      subjects: [
        'Education--Primary & Secondary--Accountability',
        'STAAR Testing Reform',
        'A-F School Ratings',
      ],
      lastAction: '05/29/2025 S Left pending in Senate Education K-16 conference impasse',
      lastActionDate: '2025-05-29',
      filedDate: '2025-02-24',
      fullText: `SECTION 1. Replaces the single annual STAAR summative test with three shorter adaptive instructional checkpoints administered in fall, winter, and spring.\nSECTION 2. Incorporates extracurricular readiness, career certifications, and growth percentiles into campus A-F accountability ratings.`,
      amendments: [
        {
          id: '89R-HB4-v1',
          versionCode: 'I',
          versionLabel: 'Introduced (As Filed)',
          amendmentNumber: 'Filed Version',
          sponsor: 'Buckley',
          filedDate: '2025-02-24',
          disposition: 'Filed',
          yeaVotes: 0,
          nayVotes: 0,
          pnvVotes: 0,
          summary: 'Proposes replacement of STAAR with three through-year formative benchmarks.',
          fullText: `SECTION 1. Replaces STAAR with three adaptive checkpoints.\nSECTION 2. Delays A-F rating sanctions during two-year transition.`,
          sortOrder: 1,
        },
        {
          id: '89R-HB4-v2',
          versionCode: 'E',
          versionLabel: 'Engrossed House Bill (Amended)',
          amendmentNumber: 'Engrossed',
          sponsor: 'Bernal',
          filedDate: '2025-04-22',
          disposition: 'Adopted',
          yeaVotes: 136,
          nayVotes: 8,
          pnvVotes: 1,
          summary: 'Adds teacher grading turnaround limits and bans test-prep instructional days exceeding 5% of calendar.',
          fullText: `SECTION 1. Replaces the single annual STAAR summative test with three shorter adaptive instructional checkpoints administered in fall, winter, and spring.\nSECTION 2. Incorporates extracurricular readiness, career certifications, and growth percentiles into campus A-F accountability ratings.`,
          sortOrder: 2,
        },
      ],
      actions: [
        { date: '2025-02-24', num: 'H001', desc: 'Filed in Texas House' },
        { date: '2025-04-22', num: 'H410', desc: 'Passed House overwhelmingly (136-8)' },
        { date: '2025-05-29', num: 'S245', desc: 'Stalled over Senate A-F accountability parity demands' },
      ],
    },
    {
      id: '89R-HB3000',
      session: '89R',
      billNumber: 'HB 3000',
      chamber: 'House',
      title: 'Relating to the rural emergency ambulance grant program and county EMS funding.',
      summary: 'Creates a $90 million Texas Comptroller grant program enabling rural counties under 68,750 population to purchase replacement ambulances and retain certified paramedics.',
      statuteCodes: ['Health and Safety Code Ch. 773', 'Government Code Ch. 403'],
      status: 'Signed by the Governor',
      stage: 'Signed',
      primaryAuthor: 'King, Ken',
      coauthors: ['Guillen', 'Harris, Cody', 'González, Mary'],
      sponsors: ['Kolkhorst'],
      cosponsors: ['Zaffirini', 'Huffman'],
      committees: [
        { name: 'State Affairs', chamber: 'House', status: 'Out of committee', ayeVotes: 13, nayVotes: 0 },
        { name: 'Health & Human Services', chamber: 'Senate', status: 'Out of committee', ayeVotes: 9, nayVotes: 0 },
      ],
      subjects: ['Rural Ambulance Grants', 'Healthcare--Emergency Services', 'County Finances'],
      lastAction: '06/18/2025 E Signed by the Governor',
      lastActionDate: '2025-06-18',
      filedDate: '2025-02-19',
      fullText: `SECTION 1. Establishes the Rural Ambulance Grant Program administered by the Comptroller to award up to $500,000 per eligible rural county or emergency services district for vehicle procurement.`,
      amendments: [
        {
          id: '89R-HB3000-v1',
          versionCode: 'F',
          versionLabel: 'Enrolled',
          amendmentNumber: 'Enrolled',
          sponsor: 'King, Ken',
          filedDate: '2025-05-24',
          disposition: 'Enacted',
          yeaVotes: 141,
          nayVotes: 3,
          pnvVotes: 0,
          summary: 'Enacted rural ambulance procurement grant funded via SB 1 Article IX.',
          fullText: `SECTION 1. Establishes the Rural Ambulance Grant Program administered by the Comptroller to award up to $500,000 per eligible rural county or emergency services district for vehicle procurement.`,
          sortOrder: 1,
        },
      ],
      actions: [
        { date: '2025-02-19', num: 'H001', desc: 'Filed in Texas House' },
        { date: '2025-06-18', num: 'E090', desc: 'Signed by the Governor' },
      ],
    },
    {
      id: '89R-HB1109',
      session: '89R',
      billNumber: 'HB 1109',
      chamber: 'House',
      title: 'Relating to exempting Texas counties from state motor fuels taxes on fleet vehicles.',
      summary: 'Amends Chapter 162, Tax Code to exempt county governments and road-and-bridge precincts from state gasoline and diesel taxes used for official county operations.',
      statuteCodes: ['Tax Code Ch. 162'],
      status: 'Signed by the Governor',
      stage: 'Signed',
      primaryAuthor: 'Meyer',
      coauthors: ['Guillen', 'Harris, Cody', 'Bonnen'],
      sponsors: ['Bettencourt'],
      cosponsors: ['Zaffirini'],
      committees: [
        { name: 'Ways & Means', chamber: 'House', status: 'Out of committee', ayeVotes: 11, nayVotes: 0 },
        { name: 'Local Government', chamber: 'Senate', status: 'Out of committee', ayeVotes: 7, nayVotes: 0 },
      ],
      subjects: ['Taxation--Motor Fuels', 'County Finances', 'Local Government'],
      lastAction: '06/12/2025 E Signed by the Governor',
      lastActionDate: '2025-06-12',
      filedDate: '2025-01-16',
      fullText: `SECTION 1. Section 162.104, Tax Code, is amended to exempt Texas counties from state motor fuel excise taxation on county-owned road maintenance and sheriff fleets.`,
      amendments: [],
      actions: [
        { date: '2025-01-16', num: 'H001', desc: 'Filed in Texas House' },
        { date: '2025-06-12', num: 'E090', desc: 'Signed by the Governor' },
      ],
    },
    // 89th Special Session (891)
    {
      id: '891-SB4',
      session: '891',
      billNumber: 'SB 4',
      chamber: 'Senate',
      title: 'Relating to increasing the mandatory school district residence homestead property tax exemption to $140,000.',
      summary: 'Special session constitutional enabling measure raising the homestead exemption to $140,000 ($200,000 for seniors and disabled homeowners) and compressing school M&O tax rates.',
      statuteCodes: ['Tax Code Ch. 11', 'Education Code Ch. 48'],
      status: 'Enrolled — Voter Constitutional Approval Nov 2025',
      stage: 'Enrolled',
      primaryAuthor: 'Bettencourt',
      coauthors: ['Huffman', 'Creighton', 'Schwertner', 'Zaffirini'],
      sponsors: ['Meyer'],
      cosponsors: ['Guillen', 'Bonnen', 'Buckley'],
      committees: [
        { name: 'Local Government', chamber: 'Senate', status: 'Out of committee', ayeVotes: 7, nayVotes: 0 },
        { name: 'Ways & Means', chamber: 'House', status: 'Out of committee', ayeVotes: 10, nayVotes: 1 },
      ],
      subjects: ['Taxation--Property--Appraisal & Compression', 'Homestead Exemption', 'Foundation School Fund'],
      lastAction: '08/19/2025 E Enrolled and sent to Governor',
      lastActionDate: '2025-08-19',
      filedDate: '2025-07-21',
      fullText: `SECTION 1. Section 11.13(b), Tax Code, is amended to increase the mandatory school district residence homestead exemption from $100,000 to $140,000, with full state hold-harmless reimbursement through the Foundation School Program.`,
      amendments: [
        {
          id: '891-SB4-v1',
          versionCode: 'I',
          versionLabel: 'Introduced ($125k Exemption)',
          amendmentNumber: 'Filed Version',
          sponsor: 'Bettencourt',
          filedDate: '2025-07-21',
          disposition: 'Filed',
          yeaVotes: 0,
          nayVotes: 0,
          pnvVotes: 0,
          summary: 'Proposed $125,000 homestead exemption.',
          fullText: `SECTION 1. Section 11.13(b), Tax Code, increases the homestead exemption to $125,000.`,
          sortOrder: 1,
        },
        {
          id: '891-SB4-v2',
          versionCode: 'F',
          versionLabel: 'Enrolled ($140k Compromise)',
          amendmentNumber: 'Enrolled',
          sponsor: 'Meyer',
          filedDate: '2025-08-18',
          disposition: 'Enacted',
          yeaVotes: 138,
          nayVotes: 5,
          pnvVotes: 0,
          summary: 'Raised homestead exemption to $140,000 with Foundation School Fund backfill.',
          fullText: `SECTION 1. Section 11.13(b), Tax Code, is amended to increase the mandatory school district residence homestead exemption from $100,000 to $140,000, with full state hold-harmless reimbursement through the Foundation School Program.`,
          sortOrder: 2,
        },
      ],
      actions: [
        { date: '2025-07-21', num: 'S001', desc: 'Filed in 89th 1st Called Special Session' },
        { date: '2025-08-19', num: 'E080', desc: 'Enrolled' },
      ],
    },
    // 90th Regular Session Pre-Files (Nov 2026!)
    {
      id: '90R-HB18',
      session: '90R',
      billNumber: 'HB 18',
      chamber: 'House',
      title: 'Relating to ERCOT grid capacity reserves for artificial intelligence data centers and advanced nuclear colocation.',
      summary: '90th Legislature pre-filed bill requiring large flexible data center loads (>75 MW) to contract dedicated dispatchable or small modular reactor generation and curtail during ERCOT Emergency Alert Level 2.',
      statuteCodes: ['Utilities Code Ch. 39', 'Government Code Ch. 483'],
      status: 'Pre-Filed for 90th Legislature (Convenes Jan 2027)',
      stage: 'Pre-Filed',
      primaryAuthor: 'King, Ken',
      coauthors: ['Harris, Cody', 'Meyer'],
      sponsors: [],
      cosponsors: [],
      committees: [{ name: 'State Affairs', chamber: 'House', status: 'Pending Referral', ayeVotes: 0, nayVotes: 0 }],
      subjects: [
        'ERCOT Electric Grid Reliability',
        'Nuclear Energy & Advanced Reactors',
        'Data Centers & Artificial Intelligence Loads',
        'Utilities--Electric',
      ],
      lastAction: '11/10/2026 H Pre-filed for 90th Legislature',
      lastActionDate: '2026-11-10',
      filedDate: '2026-11-10',
      fullText: `SECTION 1. Subchapter Z, Chapter 39, Utilities Code, requires electric loads exceeding 75 megawatts associated with hyperscale data centers or cryptocurrency compute facilities to register curtailment protocols with ERCOT.\nSECTION 2. Grants expedited Texas Advanced Nuclear Energy Office interconnection priority when data center operators co-locate behind-the-meter nuclear or dispatchable generation.`,
      amendments: [],
      actions: [{ date: '2026-11-10', num: 'H000', desc: 'Pre-filed for 90th Regular Session' }],
    },
    {
      id: '90R-SB5',
      session: '90R',
      billNumber: 'SB 5',
      chamber: 'Senate',
      title: 'Relating to biennial inflation indexing of the public school basic allotment and STAAR diagnostic replacement.',
      summary: '90th Legislature pre-filed education bill reviving HB 4 through-year assessment replacement while pairing automatic biennial CPI indexing for the Education Code Section 48.051 basic allotment.',
      statuteCodes: ['Education Code Ch. 48', 'Education Code Ch. 39'],
      status: 'Pre-Filed for 90th Legislature (Convenes Jan 2027)',
      stage: 'Pre-Filed',
      primaryAuthor: 'Zaffirini',
      coauthors: ['Alvarado', 'Creighton'],
      sponsors: [],
      cosponsors: [],
      committees: [{ name: 'Education K-16', chamber: 'Senate', status: 'Pending Referral', ayeVotes: 0, nayVotes: 0 }],
      subjects: [
        'Education--Primary & Secondary--Finance',
        'Education--Primary & Secondary--Accountability',
        'STAAR Testing Reform',
        'Foundation School Fund',
      ],
      lastAction: '11/12/2026 S Pre-filed for 90th Legislature',
      lastActionDate: '2026-11-12',
      filedDate: '2026-11-12',
      fullText: `SECTION 1. Amends Section 48.051, Education Code, to index the basic allotment biennially to the Texas Education Cost Index computed by the Legislative Budget Board.\nSECTION 2. Re-introduces three-window adaptive instructional assessments replacing single-day STAAR administration.`,
      amendments: [],
      actions: [{ date: '2026-11-12', num: 'S000', desc: 'Pre-filed for 90th Regular Session' }],
    },
    {
      id: '90R-HB42',
      session: '90R',
      billNumber: 'HB 42',
      chamber: 'House',
      title: 'Relating to regional water supply desalination and brackish aquifer interconnects under the Texas Water Fund.',
      summary: '90th Legislature pre-file authorizing $3.0 billion in dedicated multi-decade water supply bonds for brackish groundwater desalination, municipal pipeline interconnects, and Gulf Coast flood gates.',
      statuteCodes: ['Water Code Ch. 15', 'Water Code Ch. 16'],
      status: 'Pre-Filed for 90th Legislature (Convenes Jan 2027)',
      stage: 'Pre-Filed',
      primaryAuthor: 'Harris, Cody',
      coauthors: ['González, Mary', 'Guillen', 'Bonnen'],
      sponsors: [],
      cosponsors: [],
      committees: [{ name: 'Natural Resources', chamber: 'House', status: 'Pending Referral', ayeVotes: 0, nayVotes: 0 }],
      subjects: ['Texas Water Fund', 'Water Supply & Desalination', 'Flood Infrastructure'],
      lastAction: '11/14/2026 H Pre-filed for 90th Legislature',
      lastActionDate: '2026-11-14',
      filedDate: '2026-11-14',
      fullText: `SECTION 1. Amends Chapter 15, Water Code, directing the Texas Water Development Board to prioritize non-potable industrial desalination and inter-basin municipal transfers from the Texas Water Fund.`,
      amendments: [],
      actions: [{ date: '2026-11-14', num: 'H000', desc: 'Pre-filed for 90th Regular Session' }],
    },
    {
      id: '90R-SB12',
      session: '90R',
      billNumber: 'SB 12',
      chamber: 'Senate',
      title: 'Relating to school district appraisal caps, commercial property valuation transparency, and homestead compression.',
      summary: '90th Legislature pre-file lowering annual appraisal growth caps from 10 percent to 5 percent on homesteads and requiring mandatory sales-price disclosure for non-residential commercial real estate.',
      statuteCodes: ['Tax Code Ch. 23', 'Tax Code Ch. 26'],
      status: 'Pre-Filed for 90th Legislature (Convenes Jan 2027)',
      stage: 'Pre-Filed',
      primaryAuthor: 'Bettencourt',
      coauthors: ['Huffman', 'Schwertner'],
      sponsors: [],
      cosponsors: [],
      committees: [{ name: 'Local Government', chamber: 'Senate', status: 'Pending Referral', ayeVotes: 0, nayVotes: 0 }],
      subjects: ['Taxation--Property--Appraisal & Compression', 'Homestead Exemption', 'Commercial Valuation'],
      lastAction: '11/11/2026 S Pre-filed for 90th Legislature',
      lastActionDate: '2026-11-11',
      filedDate: '2026-11-11',
      fullText: `SECTION 1. Amends Section 23.23, Tax Code, reducing the maximum annual increase in appraised value of a residence homestead to 5 percent.`,
      amendments: [],
      actions: [{ date: '2026-11-11', num: 'S000', desc: 'Pre-filed for 90th Regular Session' }],
    },
    // 88th Regular Session (2023)
    {
      id: '88R-SB2627',
      session: '88R',
      billNumber: 'SB 2627',
      chamber: 'Senate',
      title: 'Relating to funding mechanisms to support the construction, maintenance, modernization, and operation of electric generating facilities (Powering Texas Forward Act).',
      summary: 'Created the $5 billion Texas Energy Fund offering low-interest loans and completion bonuses for dispatchable natural gas power plants inside ERCOT.',
      statuteCodes: ['Utilities Code Ch. 34'],
      status: 'Signed by the Governor — Voter Approved Nov 2023',
      stage: 'Signed',
      primaryAuthor: 'Schwertner',
      coauthors: ['Huffman', 'Creighton', 'Bettencourt', 'Kolkhorst'],
      sponsors: ['Hunter'],
      cosponsors: ['King, Ken', 'Bonnen', 'Harris, Cody'],
      committees: [
        { name: 'Business & Commerce', chamber: 'Senate', status: 'Out of committee', ayeVotes: 10, nayVotes: 1 },
        { name: 'State Affairs', chamber: 'House', status: 'Out of committee', ayeVotes: 11, nayVotes: 2 },
      ],
      subjects: ['Texas Energy Fund', 'ERCOT Electric Grid Reliability', 'Utilities--Electric'],
      lastAction: '06/09/2023 E Signed by the Governor',
      lastActionDate: '2023-06-09',
      filedDate: '2023-03-10',
      fullText: `SECTION 1. Adds Chapter 34, Utilities Code, establishing the Texas Energy Fund administered by the Public Utility Commission to finance dispatchable electric generating facilities.`,
      amendments: [],
      actions: [{ date: '2023-06-09', num: 'E090', desc: 'Signed by the Governor' }],
    },
    {
      id: '88R-SB2',
      session: '88R',
      billNumber: 'SB 2 (88-2)',
      chamber: 'Senate',
      title: 'Relating to providing property tax relief through school district tax rate compression and a $100,000 homestead exemption.',
      summary: 'Historic $18 billion property tax cut enacted in 2023 compressing school district tax rates by 10.7 cents and raising the homestead exemption from $40,000 to $100,000.',
      statuteCodes: ['Tax Code Ch. 11', 'Education Code Ch. 48'],
      status: 'Signed by the Governor',
      stage: 'Signed',
      primaryAuthor: 'Bettencourt',
      coauthors: ['Huffman', 'Creighton', 'Schwertner', 'Zaffirini'],
      sponsors: ['Meyer'],
      cosponsors: ['Bonnen', 'Guillen', 'Hunter'],
      committees: [
        { name: 'Local Government', chamber: 'Senate', status: 'Out of committee', ayeVotes: 8, nayVotes: 0 },
        { name: 'Ways & Means', chamber: 'House', status: 'Out of committee', ayeVotes: 11, nayVotes: 0 },
      ],
      subjects: ['Taxation--Property--Appraisal & Compression', 'Homestead Exemption', 'Foundation School Fund'],
      lastAction: '07/22/2023 E Signed by the Governor',
      lastActionDate: '2023-07-22',
      filedDate: '2023-07-11',
      fullText: `SECTION 1. Increases the mandatory school district residence homestead exemption to $100,000 and establishes a 20 percent circuit breaker cap on non-homestead commercial real estate under $5 million.`,
      amendments: [],
      actions: [{ date: '2023-07-22', num: 'E090', desc: 'Signed by the Governor' }],
    },
    {
      id: '88R-SB28',
      session: '88R',
      billNumber: 'SB 28',
      chamber: 'Senate',
      title: 'Relating to financial assistance provided and programs administered by the Texas Water Development Board (Texas Water Fund).',
      summary: 'Established the $1 billion Texas Water Fund and New Water Supply for Texas Fund to finance municipal water loss repairs and desalination projects.',
      statuteCodes: ['Water Code Ch. 15'],
      status: 'Signed by the Governor',
      stage: 'Signed',
      primaryAuthor: 'Perry',
      coauthors: ['Kolkhorst', 'Huffman', 'Zaffirini', 'Alvarado'],
      sponsors: ['Harris, Cody'],
      cosponsors: ['González, Mary', 'Guillen'],
      committees: [{ name: 'Natural Resources', chamber: 'House', status: 'Out of committee', ayeVotes: 11, nayVotes: 0 }],
      subjects: ['Texas Water Fund', 'Water Supply & Desalination', 'Flood Infrastructure'],
      lastAction: '05/29/2023 E Signed by the Governor',
      lastActionDate: '2023-05-29',
      filedDate: '2023-02-15',
      fullText: `SECTION 1. Creates the Texas Water Fund inside the state treasury outside the general revenue fund to finance water supply and aging municipal pipe remediation.`,
      amendments: [],
      actions: [{ date: '2023-05-29', num: 'E090', desc: 'Signed by the Governor' }],
    },
    // 87th Regular Session (2021) — Post-Winter Storm Uri Baseline
    {
      id: '87R-SB3',
      session: '87R',
      billNumber: 'SB 3',
      chamber: 'Senate',
      title: 'Relating to preparing for, preventing, and responding to weather emergencies and power outages in the ERCOT electric grid.',
      summary: 'Omnibus post-Winter Storm Uri legislation mandating power plant and natural gas weatherization, creating the Texas Energy Reliability Council, and overhauling ERCOT emergency alert notifications.',
      statuteCodes: ['Utilities Code Ch. 35', 'Natural Resources Code Ch. 86'],
      status: 'Signed by the Governor',
      stage: 'Signed',
      primaryAuthor: 'Schwertner',
      coauthors: ['Huffman', 'Creighton', 'Kolkhorst', 'Zaffirini'],
      sponsors: ['Hunter'],
      cosponsors: ['King, Ken', 'Bonnen'],
      committees: [
        { name: 'Business & Commerce', chamber: 'Senate', status: 'Out of committee', ayeVotes: 9, nayVotes: 0 },
        { name: 'State Affairs', chamber: 'House', status: 'Out of committee', ayeVotes: 12, nayVotes: 1 },
      ],
      subjects: ['ERCOT Electric Grid Reliability', 'Utilities--Electric', 'Weatherization'],
      lastAction: '06/08/2021 E Signed by the Governor',
      lastActionDate: '2021-06-08',
      filedDate: '2021-02-25',
      fullText: `SECTION 1. Requires electric generation entities and transmission utilities within ERCOT to implement mandatory extreme weather emergency preparedness standards subject to PUC administrative penalties up to $1,000,000 per day.`,
      amendments: [],
      actions: [{ date: '2021-06-08', num: 'E090', desc: 'Signed by the Governor' }],
    },
  ];

  const insertBill = db.prepare(`
    INSERT INTO bills (
      id, session, bill_number, chamber, title, summary, statute_codes, status, stage,
      primary_author, coauthors_json, sponsors_json, cosponsors_json, committees_json,
      subjects_json, last_action, last_action_date, filed_date, bipartisan_index, source, full_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAmend = db.prepare(`
    INSERT INTO amendments (
      id, bill_id, version_code, version_label, amendment_number, sponsor, filed_date,
      disposition, yea_votes, nay_votes, pnv_votes, summary, full_text, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAction = db.prepare(`
    INSERT INTO bill_actions (id, bill_id, action_date, action_number, description)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const b of billsSeed) {
    const bipartisan = b.coauthors.some((c) => ['Bernal', 'González, Mary', 'Zaffirini', 'Alvarado'].includes(c))
      ? 0.78
      : 0.24;
    insertBill.run(
      b.id,
      b.session,
      b.billNumber,
      b.chamber,
      b.title,
      b.summary,
      JSON.stringify(b.statuteCodes),
      b.status,
      b.stage,
      b.primaryAuthor,
      JSON.stringify(b.coauthors),
      JSON.stringify(b.sponsors),
      JSON.stringify(b.cosponsors),
      JSON.stringify(b.committees),
      JSON.stringify(b.subjects),
      b.lastAction,
      b.lastActionDate,
      b.filedDate,
      bipartisan,
      `TLO FTP Archive (${b.session})`,
      b.fullText
    );
    for (const a of b.amendments) {
      insertAmend.run(
        a.id, b.id, a.versionCode, a.versionLabel, a.amendmentNumber, a.sponsor, a.filedDate,
        a.disposition, a.yeaVotes, a.nayVotes, a.pnvVotes, a.summary, a.fullText, a.sortOrder
      );
      syncAmendmentFts(a.id);
    }
    b.actions.forEach((act, idx) => {
      insertAction.run(`${b.id}-act-${idx + 1}`, b.id, act.date, act.num, act.desc);
    });
    syncBillFts(b.id);
  }

  // 5. Seed Cross-Bill Relationship Links
  const links = [
    ['lnk-1', '89R-HB2', '89R-SB2', 'Companion', 'House public school funding compromise paired with Senate Education Freedom Accounts in final budget negotiations.', '2025-04-17T18:00:00Z'],
    ['lnk-2', '89R-SB1', '89R-HB2', 'Budget Rider', 'Article III General Appropriations allocates $8.5B contingent upon enactment of HB 2.', '2025-05-31T12:00:00Z'],
    ['lnk-3', '89R-SB1', '89R-SB2', 'Budget Rider', 'Article III appropriates $1.0B for Texas Education Freedom Accounts.', '2025-05-31T12:05:00Z'],
    ['lnk-4', '89R-SB1', '89R-HB3000', 'Budget Rider', 'Article IX funds $90M rural emergency ambulance grants created by HB 3000.', '2025-05-31T12:15:00Z'],
    ['lnk-5', '90R-HB18', '89R-HB14', 'Related Policy', '90th pre-file connects hyperscale data center curtailment to HB 14 Texas Advanced Nuclear Energy Office siting.', '2026-11-10T10:00:00Z'],
    ['lnk-6', '89R-HB14', '88R-SB2627', 'Supersedes', 'Extends 88R Texas Energy Fund dispatchable generation framework to advanced nuclear licensing.', '2025-04-28T11:00:00Z'],
    ['lnk-7', '88R-SB2627', '87R-SB3', 'Related Policy', 'Follow-on capacity financing after 87R SB 3 weatherization mandates.', '2023-06-10T09:00:00Z'],
    ['lnk-8', '90R-SB5', '89R-HB4', 'Supersedes', 'Revives stalled 89R HB 4 STAAR diagnostic replacement alongside CPI basic allotment indexing.', '2026-11-12T15:00:00Z'],
    ['lnk-9', '90R-SB12', '891-SB4', 'Related Policy', 'Builds on $140,000 homestead exemption by lowering Tax Code Ch. 23 appraisal cap from 10% to 5%.', '2026-11-11T14:00:00Z'],
    ['lnk-10', '891-SB4', '88R-SB2', 'Supersedes', 'Raises mandatory school homestead exemption from $100,000 (88R) to $140,000 (89-1).', '2025-08-19T11:00:00Z'],
    ['lnk-11', '90R-HB42', '88R-SB28', 'Related Policy', 'Expands 88R Texas Water Fund with $3B desalination and brackish aquifer interconnects.', '2026-11-14T09:30:00Z'],
  ];
  const insertLink = db.prepare(
    `INSERT INTO bill_links (id, source_bill_id, target_bill_id, link_type, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const [id, src, tgt, ltype, notes, created] of links) {
    insertLink.run(id, src, tgt, ltype, notes, created);
  }

  // 6. Seed Roll-Call Votes for Politicians
  const voteRecords: Array<[string, string | null, string, 'Yea' | 'Nay' | 'PNV' | 'Absent', string, string, number]> = [
    ['89R-HB2', '89R-HB2-v5', 'pol-buckley', 'Yea', '2025-05-30', 'Adopt Conference Report HB 2', 1],
    ['89R-HB2', '89R-HB2-v5', 'pol-bernal', 'Yea', '2025-05-30', 'Adopt Conference Report HB 2', 1],
    ['89R-HB2', '89R-HB2-v5', 'pol-gonzalez', 'Yea', '2025-05-30', 'Adopt Conference Report HB 2', 1],
    ['89R-HB2', '89R-HB2-v5', 'pol-bonnen', 'Yea', '2025-05-30', 'Adopt Conference Report HB 2', 1],
    ['89R-HB2', '89R-HB2-v5', 'pol-creighton', 'Yea', '2025-05-30', 'Senate Concur HB 2', 1],
    ['89R-HB2', '89R-HB2-v5', 'pol-zaffirini', 'Yea', '2025-05-30', 'Senate Concur HB 2', 1],
    ['89R-SB2', '89R-SB2-v2', 'pol-creighton', 'Yea', '2025-02-05', 'Senate Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-v2', 'pol-bettencourt', 'Yea', '2025-02-05', 'Senate Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-v2', 'pol-huffman', 'Yea', '2025-02-05', 'Senate Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-v2', 'pol-zaffirini', 'Nay', '2025-02-05', 'Senate Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-v2', 'pol-alvarado', 'Nay', '2025-02-05', 'Senate Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-fa2', 'pol-buckley', 'Yea', '2025-04-17', 'House Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-fa2', 'pol-meyer', 'Yea', '2025-04-17', 'House Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-fa2', 'pol-hunter', 'Yea', '2025-04-17', 'House Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-fa2', 'pol-guillen', 'Yea', '2025-04-17', 'House Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-fa2', 'pol-bernal', 'Nay', '2025-04-17', 'House Final Passage SB 2', 1],
    ['89R-SB2', '89R-SB2-fa2', 'pol-gonzalez', 'Nay', '2025-04-17', 'House Final Passage SB 2', 1],
    ['89R-SB1', '89R-SB1-ccr', 'pol-huffman', 'Yea', '2025-05-31', 'Adopt Budget CCR SB 1', 1],
    ['89R-SB1', '89R-SB1-ccr', 'pol-bonnen', 'Yea', '2025-05-31', 'Adopt Budget CCR SB 1', 1],
    ['89R-SB1', '89R-SB1-ccr', 'pol-gonzalez', 'Yea', '2025-05-31', 'Adopt Budget CCR SB 1', 0],
    ['89R-SB1', '89R-SB1-ccr', 'pol-zaffirini', 'Yea', '2025-05-31', 'Adopt Budget CCR SB 1', 0],
    ['89R-HB14', '89R-HB14-v2', 'pol-harris-c', 'Yea', '2025-04-28', 'House Passage HB 14 (Nuclear)', 1],
    ['89R-HB14', '89R-HB14-v2', 'pol-king-k', 'Yea', '2025-04-28', 'House Passage HB 14 (Nuclear)', 1],
    ['89R-HB14', '89R-HB14-v2', 'pol-schwertner', 'Yea', '2025-05-20', 'Senate Passage HB 14 (Nuclear)', 1],
    ['89R-HB14', '89R-HB14-v2', 'pol-alvarado', 'Yea', '2025-05-20', 'Senate Passage HB 14 (Nuclear)', 0],
    ['89R-SB14', '89R-SB14-v2', 'pol-schwertner', 'Yea', '2025-03-11', 'Senate Passage SB 14 (Regulatory)', 1],
    ['89R-SB14', '89R-SB14-v2', 'pol-alvarado', 'Nay', '2025-03-11', 'Senate Passage SB 14 (Regulatory)', 1],
    ['89R-HB4', '89R-HB4-v2', 'pol-buckley', 'Yea', '2025-04-22', 'House Passage HB 4 (STAAR)', 1],
    ['89R-HB4', '89R-HB4-v2', 'pol-bernal', 'Yea', '2025-04-22', 'House Passage HB 4 (STAAR)', 0],
    ['891-SB4', '891-SB4-v2', 'pol-bettencourt', 'Yea', '2025-08-18', 'Adopt $140k Homestead Exemption', 1],
    ['891-SB4', '891-SB4-v2', 'pol-meyer', 'Yea', '2025-08-18', 'Adopt $140k Homestead Exemption', 1],
    ['891-SB4', '891-SB4-v2', 'pol-guillen', 'Yea', '2025-08-18', 'Adopt $140k Homestead Exemption', 1],
  ];
  const insertVote = db.prepare(
    `INSERT INTO votes (id, bill_id, amendment_id, politician_id, vote_cast, vote_date, motion, party_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  voteRecords.forEach(([bid, aid, pid, vcast, vdate, motion, pl], idx) => {
    insertVote.run(`vot-${idx + 1}`, bid, aid, pid, vcast, vdate, motion, pl);
  });

  // Recompute deterministic influence scores for all bills
  for (const b of billsSeed) {
    recomputeBillMetrics(b.id);
  }
  refreshSessionCounts();

  // 7. Seed Automated Keyword Alert Rules and evaluate immediately
  const rules = [
    {
      id: 'rule-edu-vouchers',
      name: 'School Finance & Education Freedom Accounts',
      query: '"Education Freedom Accounts" OR "basic allotment" OR "Teacher Retention"',
      session: '',
      chamber: '',
      committee: '',
      politician: '',
      createdAt: '2025-02-01T08:00:00Z',
    },
    {
      id: 'rule-ercot-nuclear',
      name: 'ERCOT Grid, Nuclear & Hyperscale Data Loads',
      query: '(ERCOT OR nuclear) AND (generation OR grid OR "data center")',
      session: '',
      chamber: '',
      committee: '',
      politician: '',
      createdAt: '2025-02-15T09:30:00Z',
    },
    {
      id: 'rule-property-tax',
      name: 'Homestead Exemption & Appraisal Caps',
      query: 'homestead OR "appraisal" OR compression',
      session: '',
      chamber: '',
      committee: '',
      politician: '',
      createdAt: '2025-03-01T10:15:00Z',
    },
    {
      id: 'rule-water-desal',
      name: 'Texas Water Fund & Desalination',
      query: '"Texas Water Fund" OR desalination OR aquifer',
      session: '',
      chamber: '',
      committee: '',
      politician: '',
      createdAt: '2026-11-10T11:00:00Z',
    },
  ];
  const insertRule = db.prepare(
    `INSERT INTO alert_rules (id, name, query, session, chamber, committee, politician, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  );
  for (const r of rules) {
    insertRule.run(r.id, r.name, r.query, r.session, r.chamber, r.committee, r.politician, r.createdAt);
  }

  evaluateAlertRules();
  seedPublicSentimentIfEmpty();
  seedStatutesIfEmpty();
  seedBillDocumentsIfEmpty();
  backfillPoliticiansFromBills();
}

export function seedPublicSentimentIfEmpty(): void {
  const existingWit = db.prepare(`SELECT COUNT(*) AS c FROM witness_registrations`).get() as { c: number };
  if (existingWit.c > 0) return;

  const witnesses: Array<[string, string, string, string, string, string, number, 'For' | 'Against' | 'On', number]> = [
    ['89R-HB2', 'House', 'Public Education', '2025-03-04', 'Lara, Billie', 'Self (Classroom Teacher)', 1, 'For', 1],
    ['89R-HB2', 'House', 'Public Education', '2025-03-04', 'Crawford, Marty', 'Texas School Alliance', 0, 'For', 1],
    ['89R-HB2', 'House', 'Public Education', '2025-03-04', 'Gilbert, Greg', 'Texas Association of Rural Schools', 0, 'For', 1],
    ['89R-HB2', 'House', 'Public Education', '2025-03-04', 'Williams, Paige', 'Texas Classroom Teachers Association', 0, 'On', 1],
    ['89R-HB2', 'House', 'Public Education', '2025-03-04', 'Brown, Ashlynn', 'Self (Parent)', 1, 'For', 0],
    ['89R-HB2', 'House', 'Public Education', '2025-03-04', 'Davis, Marilyn', 'Self (Taxpayer)', 1, 'Against', 0],
    ['89R-HB2', 'Senate', 'Education K-16', '2025-05-06', 'Sanderson, Josh', 'Equity Center', 0, 'For', 1],
    ['89R-HB2', 'Senate', 'Education K-16', '2025-05-06', 'Rasti, Kelly', 'Texas Association of School Boards', 0, 'For', 1],

    ['89R-SB2', 'House', 'Public Education', '2025-03-11', 'Jensen, Scott', 'American Federation for Children', 0, 'For', 1],
    ['89R-SB2', 'House', 'Public Education', '2025-03-11', 'Hernandez, Rosa', 'Self (Public School Parent)', 1, 'Against', 1],
    ['89R-SB2', 'House', 'Public Education', '2025-03-11', 'Miller, Travis', 'Self (Rural ISD Trustee)', 1, 'Against', 1],
    ['89R-SB2', 'House', 'Public Education', '2025-03-11', 'Garza, Elena', 'Self (Special Ed Parent)', 1, 'For', 1],
    ['89R-SB2', 'House', 'Public Education', '2025-03-11', 'Villanueva, Chandra', 'Every Texan', 0, 'Against', 1],
    ['89R-SB2', 'House', 'Public Education', '2025-03-11', 'Alvarez, Marco', 'Self', 1, 'Against', 0],
    ['89R-SB2', 'House', 'Public Education', '2025-03-11', 'Patel, Priya', 'Self', 1, 'Against', 0],
    ['89R-SB2', 'Senate', 'Education K-16', '2025-01-28', 'DeAngelis, Corey', 'American Federation for Children', 0, 'For', 1],
    ['89R-SB2', 'Senate', 'Education K-16', '2025-01-28', 'Kling, Sarah', 'Self (Bell County Parent)', 1, 'Against', 1],

    ['89R-HB4', 'House', 'Public Education', '2025-03-18', 'Toscano, Roland', 'East Central ISD', 0, 'For', 1],
    ['89R-HB4', 'House', 'Public Education', '2025-03-18', 'Vega, Carmen', 'Self (Elementary Teacher)', 1, 'For', 1],
    ['89R-HB4', 'House', 'Public Education', '2025-03-18', 'Pruneda, Mary Lynn', 'Texas 2036', 0, 'On', 1],
    ['89R-HB4', 'House', 'Public Education', '2025-03-18', 'Sutton, Rachel', 'Self (Parent)', 1, 'For', 0],

    ['89R-HB14', 'House', 'State Affairs', '2025-03-12', 'Reed, Cyrus', 'Lone Star Chapter Sierra Club', 0, 'On', 1],
    ['89R-HB14', 'House', 'State Affairs', '2025-03-12', 'Cunningham, Paul', 'Texas Nuclear Alliance', 0, 'For', 1],
    ['89R-HB14', 'House', 'State Affairs', '2025-03-12', 'Gomez, Hector', 'Self (Grid Engineer)', 1, 'For', 1],
    ['89R-HB14', 'Senate', 'Business & Commerce', '2025-05-08', 'Boyd, Michelle', 'Texas Competitive Power Advocates', 0, 'For', 1],

    ['89R-SB14', 'Senate', 'Business & Commerce', '2025-02-25', 'Quintero, James', 'Texas Public Policy Foundation', 0, 'For', 1],
    ['89R-SB14', 'Senate', 'Business & Commerce', '2025-02-25', 'Ramos, Diana', 'Self (Small Business Owner)', 1, 'For', 1],
    ['89R-SB14', 'House', 'State Affairs', '2025-04-16', 'Metzger, Luke', 'Environment Texas', 0, 'Against', 1],
    ['89R-SB14', 'House', 'State Affairs', '2025-04-16', 'Holloway, Claire', 'Self (Consumer Advocate)', 1, 'Against', 1],

    ['89R-HB3000', 'House', 'State Affairs', '2025-03-26', 'Wheeler, Ray', 'County Judges & Commissioners Assn', 0, 'For', 1],
    ['89R-HB3000', 'House', 'State Affairs', '2025-03-26', 'Foster, Linda', 'Self (Rural EMS Paramedic)', 1, 'For', 1],
    ['89R-HB3000', 'Senate', 'Health & Human Services', '2025-05-14', 'Barton, James', 'Self (Volunteer Fire Chief)', 1, 'For', 1],

    ['891-SB4', 'Senate', 'Local Government', '2025-07-24', 'Craymer, Dale', 'Texas Taxpayers & Research Assn', 0, 'For', 1],
    ['891-SB4', 'Senate', 'Local Government', '2025-07-24', 'McClure, Denise', 'Self (Harris County Homeowner)', 1, 'For', 1],
    ['891-SB4', 'House', 'Ways & Means', '2025-08-05', 'Nguyen, Kevin', 'Self (Dallas Homeowner)', 1, 'For', 1],

    ['88R-SB28', 'House', 'Natural Resources', '2023-04-11', 'Mace, Robert', 'Meadows Center for Water', 0, 'For', 1],
    ['88R-SB28', 'House', 'Natural Resources', '2023-04-11', 'Ortiz, Manuel', 'Self (Rural Water District)', 1, 'For', 1],
  ];

  const insertWit = db.prepare(
    `INSERT OR IGNORE INTO witness_registrations
     (id, bill_id, chamber, committee_name, hearing_date, witness_name, affiliation, is_citizen_self, position, testified, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'TLO Witness List Archive')`
  );
  witnesses.forEach(([bid, ch, com, hdate, wname, aff, isSelf, pos, test], idx) => {
    const billExists = db.prepare(`SELECT id FROM bills WHERE id = ?`).get(bid);
    if (billExists) {
      insertWit.run(`wit-seed-${idx + 1}`, bid, ch, com, hdate, wname, aff, isSelf, pos, test);
    }
  });

  const comms: Array<[string, string | null, string, string, string, number, string, string, string]> = [
    ['89R-HB2', 'pol-buckley', 'Public Education', 'Email Campaign', 'Amend / Concern', 1420, 'District teachers & parents urging inclusion of paraprofessionals, bus drivers, and nurses in salary pass-through prior to Floor Amend. #4.', 'teacher salary paraprofessional basic allotment', '2025-03-28'],
    ['89R-HB2', 'pol-bernal', 'Public Education', 'Town Hall', 'Support', 380, 'Bexar County public school town hall backing $6,555 basic allotment and special education intensity weights.', 'special education basic allotment', '2025-03-19'],
    ['89R-SB2', 'pol-creighton', 'Education K-16', 'Email Campaign', 'Support', 940, 'Montgomery County parent coalition supporting Education Freedom Accounts priority access for special needs.', 'voucher education savings accounts', '2025-02-01'],
    ['89R-SB2', 'pol-buckley', 'Public Education', 'District Call Log', 'Oppose', 1860, 'HD-54 rural school superintendents and parents calling to oppose uncapped vouchers and request rural public school protections.', 'rural schools voucher cap', '2025-03-25'],
    ['89R-HB4', 'pol-buckley', 'Public Education', 'Public Comment Portal', 'Support', 760, 'Parent and educator submissions backing elimination of high-stakes single-day STAAR testing.', 'STAAR adaptive assessment testing', '2025-04-12'],
    ['89R-HB14', 'pol-harris-c', 'State Affairs', 'District Call Log', 'Support', 210, 'Industrial & rural utility co-ops requesting ERCOT dispatchable baseload interconnection priority.', 'nuclear ERCOT baseload grid', '2025-03-22'],
    ['89R-SB14', 'pol-schwertner', 'Business & Commerce', 'Email Campaign', 'Amend / Concern', 520, 'Small business and consumer groups requesting removal of automatic 5-year rule expiration in favor of $1M threshold review.', 'regulatory sunset threshold', '2025-03-04'],
    ['89R-HB3000', 'pol-king-k', 'State Affairs', 'Town Hall', 'Support', 490, 'Panhandle county commissioners and volunteer EMS crews urging $90M rural ambulance procurement grants.', 'rural ambulance EMS county', '2025-03-20'],
    ['891-SB4', 'pol-bettencourt', 'Local Government', 'Email Campaign', 'Support', 1650, 'Homeowners across Harris and Dallas counties backing $140,000 homestead exemption and M&O compression.', 'homestead exemption property tax', '2025-07-30'],
    ['90R-HB18', 'pol-king-k', 'State Affairs', 'Public Comment Portal', 'Amend / Concern', 315, 'West Texas ratepayers asking for strict curtailment rules so AI data center loads do not raise residential grid prices.', 'data center ERCOT curtailment', '2026-11-12'],
    ['90R-HB42', 'pol-harris-c', 'Natural Resources', 'Town Hall', 'Support', 410, 'Municipal water districts and coastal farmers urging $3B brackish desalination bonds under Texas Water Fund.', 'water desalination aquifer bonds', '2026-11-15'],
  ];

  const insertComm = db.prepare(
    `INSERT OR IGNORE INTO constituent_communications
     (id, bill_id, politician_id, committee_name, channel, stance, volume_count, summary, topic_keywords, logged_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  comms.forEach(([bid, pid, com, chan, stance, vol, sum, kw, ldate], idx) => {
    const billExists = db.prepare(`SELECT id FROM bills WHERE id = ?`).get(bid);
    if (billExists) {
      insertComm.run(`comm-seed-${idx + 1}`, bid, pid, com, chan, stance, vol, sum, kw, ldate);
    }
  });
}

export function seedStatutesIfEmpty(): void {
  const codeCount = db.prepare(`SELECT COUNT(*) AS c FROM statutes_codes`).get() as { c: number };
  if (codeCount.c === 0) {
    const insertCode = db.prepare(
      `INSERT OR IGNORE INTO statutes_codes (code, zip_code, code_id, name, chapter_count, section_count, synced_at)
       VALUES (?, ?, ?, ?, 0, 0, NULL)`
    );
    for (const entry of TEXAS_CODE_CATALOG) {
      insertCode.run(entry.code, entry.zipCode, entry.codeId, entry.name);
    }
  }

  const secCount = db.prepare(`SELECT COUNT(*) AS c FROM statute_sections`).get() as { c: number };
  if (secCount.c > 0) return;

  const starterSections: Array<{
    id: string;
    code: string;
    codeName: string;
    chapter: string;
    chapterTitle: string;
    sectionNumber: string;
    sectionTitle: string;
    fullText: string;
    actsHistory: string;
  }> = [
    {
      id: 'ED-48.051',
      code: 'ED',
      codeName: 'Education Code',
      chapter: '48',
      chapterTitle: 'CHAPTER 48. FOUNDATION SCHOOL PROGRAM',
      sectionNumber: '48.051',
      sectionTitle: 'BASIC ALLOTMENT',
      fullText: `Sec. 48.051. BASIC ALLOTMENT. (a) For each student in average daily attendance, not including the time students spend each day in special education programs in an instructional arrangement other than mainstream or career and technology education programs, for which an additional allotment is made under Subchapter C, a district is entitled to an allotment equal to the lesser of $6,160 or the amount that results from the following formula: A = $6,160 X TR / MCR.\n(b) A greater amount for any school year may be provided by appropriation.\n(c) During any school year for which the value of "A" under Subsection (a) is less than the basic allotment provided during the preceding school year, the agency shall notify the governor and Legislative Budget Board.\nAdded by Acts 1995, 74th Leg., ch. 260, Sec. 1, eff. May 30, 1995. Transferred, redesignated and amended from Education Code, Section 42.101 by Acts 2019, 86th Leg., R.S., Ch. 943 (H.B. 3), Sec. 1A.006, eff. September 1, 2019.`,
      actsHistory:
        'Added by Acts 1995, 74th Leg., ch. 260, Sec. 1, eff. May 30, 1995. Amended by Acts 2009, 81st Leg., ch. 1328; Acts 2011, 82nd Leg., 1st C.S., ch. 4; Acts 2015, 84th Leg., ch. 448; Transferred, redesignated and amended from Education Code Sec. 42.101 by Acts 2019, 86th Leg., R.S., Ch. 943 (H.B. 3), Sec. 1A.006, eff. Sept. 1, 2019.',
    },
    {
      id: 'TX-11.13',
      code: 'TX',
      codeName: 'Tax Code',
      chapter: '11',
      chapterTitle: 'CHAPTER 11. TAXABLE PROPERTY AND EXEMPTIONS',
      sectionNumber: '11.13',
      sectionTitle: 'RESIDENCE HOMESTEAD',
      fullText: `Sec. 11.13. RESIDENCE HOMESTEAD. (a) A family or single adult is entitled to an exemption from taxation for the county purposes authorized in Article VIII, Section 1-a, of the Texas Constitution of $3,000 of the assessed value of his residence homestead.\n(b) An adult is entitled to exemption from taxation by a school district of $100,000 of the appraised value of the adult's residence homestead, except that only $5,000 of the exemption applies to an entity operating under former Chapter 17, 18, 25, 26, 27, or 28, Education Code.\n(c) In addition to the exemption provided by Subsection (b), an adult who is disabled or is 65 or older is entitled to an exemption from taxation by a school district of $10,000 of the appraised value of his residence homestead.\nActs 1979, 66th Leg., p. 2235, ch. 841, Sec. 1, eff. Jan. 1, 1980. Amended by Acts 1997, 75th Leg., ch. 592, Sec. 2; Acts 2015, 84th Leg., R.S., Ch. 465 (S.B. 1), Sec. 1; Acts 2021, 87th Leg., 2nd C.S., Ch. 12 (S.B. 1); Acts 2023, 88th Leg., 2nd C.S., Ch. 1 (S.B. 2), Sec. 3.01, eff. Nov. 7, 2023.`,
      actsHistory:
        'Acts 1979, 66th Leg., p. 2235, ch. 841. Amended by Acts 1997, 75th Leg., ch. 592; Acts 2015, 84th Leg., R.S., Ch. 465 (S.B. 1); Acts 2021, 87th Leg., 2nd C.S., Ch. 12 (S.B. 1); Acts 2023, 88th Leg., 2nd C.S., Ch. 1 (S.B. 2), Sec. 3.01.',
    },
    {
      id: 'UT-39.159',
      code: 'UT',
      codeName: 'Utilities Code',
      chapter: '39',
      chapterTitle: 'CHAPTER 39. RESTRUCTURING OF ELECTRIC UTILITY INDUSTRY',
      sectionNumber: '39.159',
      sectionTitle: 'POWER REGION RELIABILITY AND DISPATCHABLE GENERATION',
      fullText: `Sec. 39.159. POWER REGION RELIABILITY AND DISPATCHABLE GENERATION. (a) For the purposes of this section, a generation facility is considered to be non-dispatchable if the facility's output is controlled primarily by forces outside of human control.\n(b) The commission shall ensure that the independent organization certified under Section 39.151 for the ERCOT power region:\n(1) establishes requirements to meet the reliability needs of the power region;\n(2) periodically, but at least annually, determines the quantity and characteristics of ancillary or reliability services necessary to ensure appropriate reliability during extreme heat and extreme cold weather conditions and during times of low non-dispatchable power production.\nAdded by Acts 2021, 87th Leg., R.S., Ch. 426 (S.B. 3), Sec. 18, eff. June 8, 2021. Amended by Acts 2023, 88th Leg., R.S., Ch. 410 (H.B. 1500), Sec. 23, eff. Sept. 1, 2023.`,
      actsHistory:
        'Added by Acts 2021, 87th Leg., R.S., Ch. 426 (S.B. 3), Sec. 18, eff. June 8, 2021. Amended by Acts 2023, 88th Leg., R.S., Ch. 410 (H.B. 1500), Sec. 23, eff. Sept. 1, 2023.',
    },
    {
      id: 'WA-15.102',
      code: 'WA',
      codeName: 'Water Code',
      chapter: '15',
      chapterTitle: 'CHAPTER 15. TEXAS WATER ASSISTANCE PROGRAM',
      sectionNumber: '15.102',
      sectionTitle: 'TEXAS WATER FUND',
      fullText: `Sec. 15.102. TEXAS WATER FUND. (a) The Texas water fund is a special fund in the state treasury outside the general revenue fund to be administered by the board under rules adopted by the board.\n(b) The board may use the fund only to transfer money to the water assistance fund, the water infrastructure fund, the rural water assistance fund, and the New Water Supply for Texas Fund.\nAdded by Acts 2023, 88th Leg., R.S., Ch. 457 (S.B. 28), Sec. 2, eff. Jan. 1, 2024.`,
      actsHistory: 'Added by Acts 2023, 88th Leg., R.S., Ch. 457 (S.B. 28), Sec. 2, eff. Jan. 1, 2024.',
    },
    {
      id: 'HS-773.004',
      code: 'HS',
      codeName: 'Health & Safety Code',
      chapter: '773',
      chapterTitle: 'CHAPTER 773. EMERGENCY HEALTH CARE ACT',
      sectionNumber: '773.004',
      sectionTitle: 'EXEMPTIONS AND RURAL EMERGENCY MEDICAL SERVICES',
      fullText: `Sec. 773.004. EXEMPTIONS. (a) This chapter does not apply to ground transfer vehicles and staff used to transport a patient who is under a physician's care between medical facilities or between a medical facility and a private residence, unless medically necessary.\n(b) The department shall administer rural emergency ambulance and trauma care preparedness standards in coordination with regional advisory councils.\nActs 1989, 71st Leg., ch. 678, Sec. 1, eff. Sept. 1, 1989. Amended by Acts 1991, 72nd Leg., ch. 14; Acts 2015, 84th Leg., R.S., Ch. 1 (S.B. 219), Sec. 3.1536, eff. April 2, 2015.`,
      actsHistory:
        'Acts 1989, 71st Leg., ch. 678, Sec. 1. Amended by Acts 1991, 72nd Leg., ch. 14; Acts 2015, 84th Leg., R.S., Ch. 1 (S.B. 219), Sec. 3.1536.',
    },
    {
      id: 'PE-12.01',
      code: 'PE',
      codeName: 'Penal Code',
      chapter: '12',
      chapterTitle: 'CHAPTER 12. PUNISHMENTS',
      sectionNumber: '12.01',
      sectionTitle: 'PUNISHMENT IN ACCORDANCE WITH CODE',
      fullText: `Sec. 12.01. PUNISHMENT IN ACCORDANCE WITH CODE. (a) A person adjudged guilty of an offense under this code shall be punished in accordance with this chapter and the Code of Criminal Procedure.\n(b) Penal laws enacted after the effective date of this code shall be classified for punishment purposes in accordance with this chapter.\n(c) This chapter does not deprive a court of authority conferred by law to forfeit property, dissolve a corporation, suspend or cancel a license or permit, remove a person from office, cite for contempt, or impose any other civil penalty.\nActs 1973, 63rd Leg., p. 883, ch. 399, Sec. 1, eff. Jan. 1, 1974. Amended by Acts 1993, 73rd Leg., ch. 900, Sec. 1.01, eff. Sept. 1, 1994.`,
      actsHistory:
        'Acts 1973, 63rd Leg., p. 883, ch. 399, Sec. 1, eff. Jan. 1, 1974. Amended by Acts 1993, 73rd Leg., ch. 900, Sec. 1.01, eff. Sept. 1, 1994.',
    },
    {
      id: 'CN-7.1',
      code: 'CN',
      codeName: 'Texas Constitution',
      chapter: '7',
      chapterTitle: 'ARTICLE 7. EDUCATION',
      sectionNumber: '7.1',
      sectionTitle: 'SUPPORT AND MAINTENANCE OF SYSTEM OF PUBLIC FREE SCHOOLS',
      fullText: `Sec. 1. SUPPORT AND MAINTENANCE OF SYSTEM OF PUBLIC FREE SCHOOLS. A general diffusion of knowledge being essential to the preservation of the liberties and rights of the people, it shall be the duty of the Legislature of the State to establish and make suitable provision for the support and maintenance of an efficient system of public free schools.\nAdopted Feb. 15, 1876.`,
      actsHistory: 'Adopted Feb. 15, 1876 (Constitutional Convention of 1875).',
    },
    {
      id: 'GV-2001.004',
      code: 'GV',
      codeName: 'Government Code',
      chapter: '2001',
      chapterTitle: 'CHAPTER 2001. ADMINISTRATIVE PROCEDURE',
      sectionNumber: '2001.004',
      sectionTitle: 'REQUIREMENT TO ADOPT RULES OF PRACTICE AND INDEX RULES, ORDERS, AND DECISIONS',
      fullText: `Sec. 2001.004. REQUIREMENT TO ADOPT RULES OF PRACTICE AND INDEX RULES, ORDERS, AND DECISIONS. In addition to other requirements under law, a state agency shall:\n(1) adopt rules of practice stating the nature and requirements of all available formal and informal procedures;\n(2) index, cross-index to statute, and make available for public inspection all rules and other written statements of policy or interpretations that are prepared, adopted, or used by the agency in discharging its functions.\nAdded by Acts 1993, 73rd Leg., ch. 268, Sec. 1, eff. Sept. 1, 1993.`,
      actsHistory: 'Added by Acts 1993, 73rd Leg., ch. 268, Sec. 1, eff. Sept. 1, 1993.',
    },
  ];

  const insertSec = db.prepare(`
    INSERT OR IGNORE INTO statute_sections
    (id, code, code_name, chapter, chapter_title, section_number, section_title, full_text, acts_history, sessions_amended_json, last_amended_session, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Seeded Texas Statutory Archive')
  `);

  for (const s of starterSections) {
    const sessions = extractActsSessions(s.actsHistory);
    insertSec.run(
      s.id,
      s.code,
      s.codeName,
      s.chapter,
      s.chapterTitle,
      s.sectionNumber,
      s.sectionTitle,
      s.fullText,
      s.actsHistory,
      JSON.stringify(sessions),
      sessions[sessions.length - 1] ?? ''
    );
  }

  // Seed representative historical point-in-time snapshots (Education Code Basic Allotment & Tax Code Homestead Exemption)
  const starterSnapshots: Array<[string, string, string, string, string, string, string]> = [
    [
      'ED-48.051',
      'ED',
      '48.051',
      '2015-09-01',
      'Education Code Ch. 42 (Pre-HB 3 Redesignation) — Sec. 42.101 Basic Allotment',
      `Sec. 42.101. BASIC ALLOTMENT. (a) For each student in average daily attendance, not including the time students spend each day in special education programs in an instructional arrangement other than mainstream or career and technology education programs, a district is entitled to an allotment equal to the lesser of $5,140 or the amount that results from the following formula: A = $5,140 X TR / DTR.\nAdded by Acts 1995, 74th Leg., ch. 260, Sec. 1. Amended by Acts 2015, 84th Leg., R.S., Ch. 448 (H.B. 1).`,
      'Acts 1995, 74th Leg., ch. 260; Amended by Acts 2015, 84th Leg., R.S., Ch. 448 (H.B. 1).',
    ],
    [
      'ED-48.051',
      'ED',
      '48.051',
      '2019-09-01',
      'Education Code Ch. 48 (HB 3 Reform) — Sec. 48.051 Basic Allotment',
      `Sec. 48.051. BASIC ALLOTMENT. (a) For each student in average daily attendance, not including the time students spend each day in special education programs in an instructional arrangement other than mainstream or career and technology education programs, for which an additional allotment is made under Subchapter C, a district is entitled to an allotment equal to the lesser of $6,160 or the amount that results from the following formula: A = $6,160 X TR / MCR.\n(b) A greater amount for any school year may be provided by appropriation.\nTransferred, redesignated and amended from Education Code, Section 42.101 by Acts 2019, 86th Leg., R.S., Ch. 943 (H.B. 3), Sec. 1A.006, eff. Sept. 1, 2019.`,
      'Transferred and amended by Acts 2019, 86th Leg., R.S., Ch. 943 (H.B. 3), Sec. 1A.006.',
    ],
    [
      'TX-11.13',
      'TX',
      '11.13',
      '2015-09-01',
      'Tax Code Ch. 11 — Sec. 11.13 Residence Homestead ($25,000 Exemption)',
      `Sec. 11.13. RESIDENCE HOMESTEAD. (a) A family or single adult is entitled to an exemption from taxation for the county purposes authorized in Article VIII, Section 1-a, of the Texas Constitution of $3,000 of the assessed value of his residence homestead.\n(b) An adult is entitled to exemption from taxation by a school district of $25,000 of the appraised value of the adult's residence homestead.\nActs 1979, 66th Leg., p. 2235, ch. 841. Amended by Acts 2015, 84th Leg., R.S., Ch. 465 (S.B. 1), Sec. 1.`,
      'Acts 1979, 66th Leg., ch. 841; Amended by Acts 2015, 84th Leg., R.S., Ch. 465 (S.B. 1).',
    ],
    [
      'TX-11.13',
      'TX',
      '11.13',
      '2022-05-07',
      'Tax Code Ch. 11 — Sec. 11.13 Residence Homestead ($40,000 Exemption)',
      `Sec. 11.13. RESIDENCE HOMESTEAD. (a) A family or single adult is entitled to an exemption from taxation for the county purposes authorized in Article VIII, Section 1-a, of the Texas Constitution of $3,000 of the assessed value of his residence homestead.\n(b) An adult is entitled to exemption from taxation by a school district of $40,000 of the appraised value of the adult's residence homestead.\nActs 1979, 66th Leg., p. 2235, ch. 841. Amended by Acts 2021, 87th Leg., 2nd C.S., Ch. 12 (S.B. 1).`,
      'Acts 1979, 66th Leg., ch. 841; Amended by Acts 2021, 87th Leg., 2nd C.S., Ch. 12 (S.B. 1).',
    ],
    [
      'TX-11.13',
      'TX',
      '11.13',
      '2024-01-01',
      'Tax Code Ch. 11 — Sec. 11.13 Residence Homestead ($100,000 Exemption)',
      `Sec. 11.13. RESIDENCE HOMESTEAD. (a) A family or single adult is entitled to an exemption from taxation for the county purposes authorized in Article VIII, Section 1-a, of the Texas Constitution of $3,000 of the assessed value of his residence homestead.\n(b) An adult is entitled to exemption from taxation by a school district of $100,000 of the appraised value of the adult's residence homestead.\nActs 1979, 66th Leg., p. 2235, ch. 841. Amended by Acts 2023, 88th Leg., 2nd C.S., Ch. 1 (S.B. 2), Sec. 3.01, eff. Nov. 7, 2023.`,
      'Acts 1979, 66th Leg., ch. 841; Amended by Acts 2023, 88th Leg., 2nd C.S., Ch. 1 (S.B. 2), Sec. 3.01.',
    ],
  ];

  const insertSnap = db.prepare(`
    INSERT OR IGNORE INTO statute_snapshots
    (id, section_id, code, section_number, snapshot_date, header_text, full_text, acts_history, source, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Texas Historical Statute Archive', '2026-11-17T00:00:00Z')
  `);
  for (const [sid, code, secNum, sdate, header, txt, acts] of starterSnapshots) {
    insertSnap.run(`${sid}-${sdate}`, sid, code, secNum, sdate, header, txt, acts);
  }
}

export function seedBillDocumentsIfEmpty(): void {
  const existing = db.prepare(`SELECT COUNT(*) AS c FROM bill_documents`).get() as { c: number };
  if (existing.c > 0) return;

  const docs: Array<{
    id: string;
    billId: string;
    docType: 'analysis' | 'fiscal_note';
    versionCode: string;
    versionLabel: string;
    title: string;
    summary: string;
    fullText: string;
    source: string;
  }> = [
    {
      id: '89R-HB2-doc-analysis-H',
      billId: '89R-HB2',
      docType: 'analysis',
      versionCode: 'H',
      versionLabel: 'House Committee Report',
      title: 'HB 2 House Research Organization / Committee Bill Analysis (CSHB 2)',
      summary:
        'Committee substitute increases the basic allotment from $6,160 to $6,555, creates the Teacher Retention Allotment ($2,500–$8,000), and transitions special education funding to intensity-of-service tiers.',
      fullText: `BACKGROUND AND PURPOSE\nCSHB 2 consolidates House Public Education school finance proposals into a single $8.5 billion biennial package.\nKEY REVISIONS IN CSHB 2\n- Raises the Sec. 48.051 basic allotment to $6,555 per ADA (up from $6,380 as introduced).\n- Adds Sec. 48.158 Teacher Retention Allotment providing tiered salary raises for teachers with 3+ years of tenure, with higher rural weightings.\n- Shifts Special Education funding toward intensity-of-service tiers and boosts campus school safety allotments to $28,000 per campus.`,
      source: 'TLO HRO / Committee Bill Analysis (89R)',
    },
    {
      id: '89R-HB2-doc-fiscal-H',
      billId: '89R-HB2',
      docType: 'fiscal_note',
      versionCode: 'H',
      versionLabel: 'House Committee Report',
      title: 'HB 2 Legislative Budget Board Fiscal Note (CSHB 2)',
      summary:
        'LBB estimates an $8.50 billion General Revenue and Foundation School Fund biennial cost for FY 2026–2027, contingent upon SB 1 Article III appropriations.',
      fullText: `FISCAL IMPACT SUMMARY (LBB)\nProbable Net General Revenue-Related Impact: -$8,500,000,000 for the 2026–2027 biennium.\nIncludes $3.9B for the basic allotment increase, $2.8B for Teacher Retention and Incentive Allotments, $850M for Special Education intensity-of-service transition, and $430M for campus safety allotments.`,
      source: 'TLO LBB Fiscal Note (89R)',
    },
    {
      id: '89R-SB2-doc-analysis-H',
      billId: '89R-SB2',
      docType: 'analysis',
      versionCode: 'H',
      versionLabel: 'House Committee Report',
      title: 'SB 2 House Committee Bill Analysis (CSSB 2)',
      summary:
        'House committee substitute replaces uncapped universal eligibility with a $1.0B biennial appropriation cap and prioritizes 80% of slots for households under 500% FPL and students with disabilities.',
      fullText: `BACKGROUND AND PURPOSE\nCSSB 2 establishes Texas Education Freedom Accounts under Subchapter J, Chapter 29, Education Code.\nCOMMITTEE SUBSTITUTIONS\n- Caps biennial expenditures at $1,000,000,000 rather than open-ended entitlement.\n- Sets private tuition allotment at 85% of statewide per-pupil public funding (~$10,000) and $2,000 for verified homeschool instructional materials.\n- Mandates annual norm-referenced assessments and Comptroller financial audits.`,
      source: 'TLO Committee Bill Analysis (89R)',
    },
    {
      id: '89R-SB2-doc-fiscal-H',
      billId: '89R-SB2',
      docType: 'fiscal_note',
      versionCode: 'H',
      versionLabel: 'House Committee Report',
      title: 'SB 2 Legislative Budget Board Fiscal Note (CSSB 2)',
      summary:
        'LBB estimates $1.00 billion General Revenue cost in FY 2026–2027 for Education Freedom Accounts plus Comptroller administrative staffing of 42.0 FTEs.',
      fullText: `FISCAL IMPACT SUMMARY (LBB)\nBiennial Cost: $1,000,000,000 General Revenue cap for FY 2026–2027 (rising to $2.4B/year in out-years if cap is raised by future legislatures). Comptroller program administration and vendor auditing platform estimated at $18.4M.`,
      source: 'TLO LBB Fiscal Note (89R)',
    },
    {
      id: '89R-SB1-doc-fiscal-F',
      billId: '89R-SB1',
      docType: 'fiscal_note',
      versionCode: 'F',
      versionLabel: 'Enrolled',
      title: 'SB 1 General Appropriations Conference Summary (LBB)',
      summary:
        'Certifies $338.0B all-funds biennial budget locking $51B property tax relief, $8.5B for HB 2 school finance, $1.0B for SB 2 vouchers, and $2.5B for the Texas Water Fund.',
      fullText: `LBB CONFERENCE BUDGET SUMMARY\nAll Funds 2026–2027: $338.0 billion. General Revenue: $154.2 billion.\nRider Contingencies: Appropriates $8.5B contingent upon HB 2 enactment, $1.0B contingent upon SB 2, and $90M for HB 3000 rural emergency ambulance grants.`,
      source: 'TLO LBB Fiscal Note (89R)',
    },
    {
      id: '89R-HB14-doc-analysis-E',
      billId: '89R-HB14',
      docType: 'analysis',
      versionCode: 'E',
      versionLabel: 'Engrossed',
      title: 'HB 14 House Bill Analysis (Engrossed)',
      summary:
        'Establishes the Texas Advanced Nuclear Energy Office and expands matching grant authorization from $200M to $350M for NRC licensing and ERCOT firm baseload interconnection.',
      fullText: `DIGEST\nHB 14 creates Chapter 483, Government Code, establishing the Texas Advanced Nuclear Energy Office and a $350M matching reimbursement grant fund to accelerate small modular reactor siting and ERCOT interconnection.`,
      source: 'TLO Committee Bill Analysis (89R)',
    },
    {
      id: '89R-SB14-doc-analysis-F',
      billId: '89R-SB14',
      docType: 'analysis',
      versionCode: 'F',
      versionLabel: 'Enrolled',
      title: 'SB 14 Senate Research Center Bill Analysis (Enrolled)',
      summary:
        'Replaces mandatory 5-year rule expiration from the filed draft with targeted cost-benefit audits for agency rules exceeding $1M in statewide compliance impact.',
      fullText: `AUTHOR'S / SPONSOR'S STATEMENT OF INTENT\nSB 14 creates the Texas Regulatory Efficiency Office to coordinate agency cost-benefit reviews for proposed Texas Administrative Code rules exceeding $1,000,000 in statewide compliance costs.`,
      source: 'TLO SRC Bill Analysis (89R)',
    },
    {
      id: '89R-HB4-doc-analysis-E',
      billId: '89R-HB4',
      docType: 'analysis',
      versionCode: 'E',
      versionLabel: 'Engrossed',
      title: 'HB 4 Bill Analysis (Engrossed — Stalled in Conference)',
      summary:
        'Replaced single-day STAAR exams with three shorter through-year adaptive checkpoints; stalled late in May 2025 over Senate A-F accountability parity demands.',
      fullText: `DIGEST\nHB 4 amends Chapter 39, Education Code, replacing STAAR summative exams with fall, winter, and spring adaptive instructional checkpoints and limiting test-prep days to 5% of the instructional calendar.`,
      source: 'TLO Committee Bill Analysis (89R)',
    },
  ];

  const insertDoc = db.prepare(`
    INSERT OR IGNORE INTO bill_documents
    (id, bill_id, doc_type, version_code, version_label, title, summary, full_text, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const checkBill = db.prepare(`SELECT id FROM bills WHERE id = ?`);

  for (const d of docs) {
    if (checkBill.get(d.billId)) {
      insertDoc.run(d.id, d.billId, d.docType, d.versionCode, d.versionLabel, d.title, d.summary, d.fullText, d.source);
    }
  }
}



