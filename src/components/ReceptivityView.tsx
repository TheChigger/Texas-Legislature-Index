import React, { useEffect, useState } from 'react';
import { MessageSquarePlus, Users, Scale, Building2, FileSpreadsheet } from 'lucide-react';
import type { BillSummary, PoliticianSummary, ReceptivityReport } from '../types.ts';
import { csvDateStamp, downloadCsv } from '../utils/csv.ts';

interface ReceptivityViewProps {
  onOpenBill: (billId: string) => void;
  onOpenPolitician: (polId: string) => void;
  refreshSignal: number;
  onDataMutated: () => void;
}

export const ReceptivityView: React.FC<ReceptivityViewProps> = ({
  onOpenBill,
  onOpenPolitician,
  refreshSignal,
  onDataMutated,
}) => {
  const [report, setReport] = useState<ReceptivityReport | null>(null);
  const [bills, setBills] = useState<BillSummary[]>([]);
  const [politicians, setPoliticians] = useState<PoliticianSummary[]>([]);
  const [activeTab, setActiveTab] = useState<'committees' | 'representatives' | 'policies' | 'logs'>('committees');

  // Form state for logging constituent communication
  const [showForm, setShowForm] = useState(false);
  const [billId, setBillId] = useState('89R-HB2');
  const [politicianId, setPoliticianId] = useState('');
  const [committeeName, setCommitteeName] = useState('Public Education');
  const [channel, setChannel] = useState<'Email Campaign' | 'District Call Log' | 'Town Hall' | 'Public Comment Portal'>('District Call Log');
  const [stance, setStance] = useState<'Support' | 'Oppose' | 'Amend / Concern'>('Amend / Concern');
  const [volumeCount, setVolumeCount] = useState(125);
  const [summary, setSummary] = useState('');
  const [topicKeywords, setTopicKeywords] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadData = () => {
    fetch('/api/receptivity')
      .then((r) => r.json())
      .then((data: ReceptivityReport) => setReport(data))
      .catch(() => {});
  };

  useEffect(() => {
    loadData();
    fetch('/api/bills')
      .then((r) => r.json())
      .then((d) => setBills(d.bills ?? []))
      .catch(() => {});
    fetch('/api/politicians')
      .then((r) => r.json())
      .then((d) => setPoliticians(d.politicians ?? []))
      .catch(() => {});
  }, [refreshSignal]);

  const handleLogFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!billId || !summary.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/constituent-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          billId,
          politicianId: politicianId || null,
          committeeName,
          channel,
          stance,
          volumeCount,
          summary,
          topicKeywords,
        }),
      });
      if (res.ok) {
        setSummary('');
        setTopicKeywords('');
        setShowForm(false);
        loadData();
        onDataMutated();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleExportReceptivityCsv = () => {
    if (!report) return;
    if (activeTab === 'committees') {
      downloadCsv(
        `texas-committee-receptivity-${csvDateStamp()}.csv`,
        [
          'Chamber',
          'Committee',
          'Chair',
          'Referred Bills',
          'Post-Hearing Rewrites',
          'Citizen (Self) Witnesses',
          'Organization Witnesses',
          'Constituent Contacts',
          'Observed Posture',
          'Receptivity Score',
        ],
        report.committees.map((c) => [
          c.chamber,
          c.name,
          c.chairName,
          c.referredBills,
          c.revisedAfterHearing,
          c.citizenSelfWitnesses,
          c.orgWitnesses,
          c.constituentVolume,
          c.postureLabel,
          c.receptivityScore.toFixed(1),
        ])
      );
    } else if (activeTab === 'representatives') {
      downloadCsv(
        `texas-representative-responsiveness-${csvDateStamp()}.csv`,
        [
          'Name',
          'Party',
          'District',
          'Cross-Aisle Votes',
          'Total Votes',
          'Cross-Aisle %',
          'Citizen Witnesses',
          'Constituent Contacts',
          'Top Donor Sector',
          'Top Sector Share %',
          'Signal',
          'Responsiveness Index',
        ],
        report.representatives.map((r) => [
          r.name,
          r.party,
          r.district,
          r.crossAisleVotes,
          r.totalVotes,
          r.crossAislePct,
          r.citizenWitnessExposure,
          r.constituentContacts,
          r.topDonorSector,
          r.topSectorSharePct,
          r.responsivenessSignal,
          r.responsivenessScore.toFixed(1),
        ])
      );
    } else if (activeTab === 'policies') {
      downloadCsv(
        `texas-policy-malleability-${csvDateStamp()}.csv`,
        [
          'Policy Domain',
          'Malleability Posture',
          'Bill Count',
          'Amended Rate %',
          'Witness For %',
          'Witness Against %',
          'Constituent Outreach Volume',
        ],
        report.policies.map((p) => [
          p.domain,
          p.malleabilityLabel,
          p.billCount,
          p.amendedRatePct,
          p.citizenForPct,
          p.citizenAgainstPct,
          p.constituentVolume,
        ])
      );
    } else {
      downloadCsv(
        `texas-constituent-logs-${csvDateStamp()}.csv`,
        [
          'Session',
          'Bill Number',
          'Channel',
          'Stance',
          'Volume',
          'Committee',
          'Target Office',
          'Topic Keywords',
          'Logged Date',
          'Summary',
        ],
        report.recentCommunications.map((c) => [
          c.session,
          c.billNumber,
          c.channel,
          c.stance,
          c.volumeCount,
          c.committeeName,
          c.politicianName ?? '',
          c.topicKeywords,
          c.loggedDate,
          c.summary,
        ])
      );
    }
  };

  useEffect(() => {
    const onExport = () => handleExportReceptivityCsv();
    window.addEventListener('capitol:export-csv', onExport);
    return () => window.removeEventListener('capitol:export-csv', onExport);
  }, [report, activeTab]);

  if (!report) {
    return (
      <div className="p-8 border border-[#DFD9CE] bg-[#FFFFFF] text-sm text-[#57534E]">
        Computing committee, representative, and policy receptivity metrics...
      </div>
    );
  }

  const citizenPct =
    report.totals.witnessRegistrations > 0
      ? Math.round((report.totals.citizenSelfCount / report.totals.witnessRegistrations) * 100)
      : 0;

  return (
    <div className="space-y-6">
      {/* Masthead & Methodology Note */}
      <div className="border border-[#DFD9CE] bg-[#FFFFFF] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <h1 className="font-display text-2xl font-bold text-[#181715]">
              Public Sentiment & Legislative Receptivity Index
            </h1>
            <p className="text-sm text-[#57534E] mt-1.5 leading-relaxed">
              Correlates TLO committee witness registrations (<span className="font-mono">witlistbill</span>), private citizen vs. organized lobby ratios, post-hearing bill rewrites, cross-aisle voting, and constituent outreach logs. Signals behavioral responsiveness deterministically without claiming causal intent.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleExportReceptivityCsv}
              className="px-3.5 py-2 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              title="Export active receptivity table to CSV (Shortcut: e)"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-[#14532D]" />
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => setShowForm((v) => !v)}
              className="px-4 py-2 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] inline-flex items-center gap-1.5 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              Log Constituent Outreach
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
          <div className="p-3 bg-[#FBF9F5] border border-[#DFD9CE]">
            <div className="text-[#78716C]">TLO Witness Records</div>
            <div className="text-lg font-semibold text-[#181715] mt-0.5">
              {report.totals.witnessRegistrations}
            </div>
          </div>
          <div className="p-3 bg-[#FBF9F5] border border-[#DFD9CE]">
            <div className="text-[#78716C]">Private Citizen (Self) Share</div>
            <div className="text-lg font-semibold text-[#14532D] mt-0.5">
              {citizenPct}% ({report.totals.citizenSelfCount})
            </div>
          </div>
          <div className="p-3 bg-[#FBF9F5] border border-[#DFD9CE]">
            <div className="text-[#78716C]">Organized Group Witnesses</div>
            <div className="text-lg font-semibold text-[#1E3A5F] mt-0.5">
              {report.totals.orgWitnessCount}
            </div>
          </div>
          <div className="p-3 bg-[#FBF9F5] border border-[#DFD9CE]">
            <div className="text-[#78716C]">Logged Constituent Contacts</div>
            <div className="text-lg font-semibold text-[#9A3412] mt-0.5">
              {report.totals.constituentContacts.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Log Constituent Feedback Form */}
      {showForm && (
        <form
          onSubmit={handleLogFeedback}
          className="border border-[#C5BDB0] bg-[#F4F0E8] p-5 space-y-4"
        >
          <h2 className="font-display text-base font-bold text-[#181715]">
            Record Constituent Communication Batch
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Target Bill</label>
              <select
                value={billId}
                onChange={(e) => setBillId(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
              >
                {bills.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.session} {b.billNumber} — {b.title.slice(0, 44)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">
                Legislator Office (optional)
              </label>
              <select
                value={politicianId}
                onChange={(e) => setPoliticianId(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
              >
                <option value="">Committee-wide / Unassigned</option>
                {politicians.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.district})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Committee</label>
              <input
                type="text"
                value={committeeName}
                onChange={(e) => setCommitteeName(e.target.value)}
                placeholder="e.g. Public Education"
                className="w-full px-3 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Channel</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as typeof channel)}
                className="w-full px-3 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
              >
                <option value="District Call Log">District Call Log</option>
                <option value="Email Campaign">Email Campaign</option>
                <option value="Town Hall">Town Hall</option>
                <option value="Public Comment Portal">Public Comment Portal</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Stance</label>
              <select
                value={stance}
                onChange={(e) => setStance(e.target.value as typeof stance)}
                className="w-full px-3 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
              >
                <option value="Support">Support</option>
                <option value="Oppose">Oppose</option>
                <option value="Amend / Concern">Amend / Concern</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">
                Contact Volume
              </label>
              <input
                type="number"
                min={1}
                value={volumeCount}
                onChange={(e) => setVolumeCount(Math.max(1, Number(e.target.value)))}
                className="w-full px-3 py-2 text-xs font-mono bg-[#FFFFFF] border border-[#C5BDB0] rounded"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Keywords</label>
              <input
                type="text"
                value={topicKeywords}
                onChange={(e) => setTopicKeywords(e.target.value)}
                placeholder="e.g. rural EMS, property tax"
                className="w-full px-3 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
              />
            </div>
          </div>

          <textarea
            rows={2}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Summarize constituent requests, statutory concerns, or proposed amendments..."
            className="w-full px-3 py-2 text-xs bg-[#FFFFFF] border border-[#C5BDB0] rounded"
            required
          />

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-3 py-1.5 text-xs border border-[#C5BDB0] rounded cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 text-xs bg-[#9A3412] text-[#FBF9F5] rounded cursor-pointer"
            >
              {submitting ? 'Saving...' : 'Save & Recalculate Index'}
            </button>
          </div>
        </form>
      )}

      {/* Sub-view Switcher */}
      <div className="border-b border-[#DFD9CE] flex items-center gap-6 overflow-x-auto">
        {[
          { id: 'committees', label: 'Committee Receptivity', icon: Building2 },
          { id: 'representatives', label: 'Representative Responsiveness', icon: Users },
          { id: 'policies', label: 'Policy-Domain Malleability', icon: Scale },
          { id: 'logs', label: `Constituent Communication Log (${report.recentCommunications.length})`, icon: MessageSquarePlus },
        ].map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id as typeof activeTab)}
              className={`pb-3 text-xs font-medium inline-flex items-center gap-1.5 border-b-2 whitespace-nowrap cursor-pointer ${
                active
                  ? 'border-[#9A3412] text-[#9A3412]'
                  : 'border-transparent text-[#57534E] hover:text-[#181715]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab 1: Committees */}
      {activeTab === 'committees' && (
        <div className="border border-[#DFD9CE] bg-[#FFFFFF] overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F4F0E8] border-b border-[#DFD9CE] text-[#57534E]">
              <tr>
                <th className="px-4 py-3 font-medium">Committee & Chair</th>
                <th className="px-4 py-3 font-medium text-right">Bills</th>
                <th className="px-4 py-3 font-medium text-right">Post-Hearing Rewrites</th>
                <th className="px-4 py-3 font-medium text-right">Citizen (Self) vs. Org</th>
                <th className="px-4 py-3 font-medium text-right">Outreach Contacts</th>
                <th className="px-4 py-3 font-medium">Observed Posture</th>
                <th className="px-4 py-3 font-medium text-right">Receptivity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#DFD9CE]">
              {report.committees.map((c) => (
                <tr key={c.committeeId} className="hover:bg-[#FBF9F5]">
                  <td className="px-4 py-3">
                    <div className="font-display text-sm font-bold text-[#181715]">
                      {c.chamber} {c.name}
                    </div>
                    <div className="text-[11px] text-[#57534E]">{c.chairName}</div>
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-right">{c.referredBills}</td>
                  <td className="px-4 py-3 font-mono tabular-nums text-right">
                    {c.revisedAfterHearing} / {c.referredBills}
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-right">
                    <span className="text-[#14532D] font-medium">{c.citizenSelfWitnesses}</span>
                    <span className="text-[#78716C]"> / {c.orgWitnesses}</span>
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-right">
                    {c.constituentVolume.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-[#57534E]">{c.postureLabel}</td>
                  <td className="px-4 py-3 font-mono tabular-nums text-right font-semibold text-[#9A3412]">
                    {c.receptivityScore.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tab 2: Representatives */}
      {activeTab === 'representatives' && (
        <div className="border border-[#DFD9CE] bg-[#FFFFFF] overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#F4F0E8] border-b border-[#DFD9CE] text-[#57534E]">
              <tr>
                <th className="px-4 py-3 font-medium">Legislator</th>
                <th className="px-4 py-3 font-medium text-right">Cross-Aisle Votes</th>
                <th className="px-4 py-3 font-medium text-right">Citizen Witnesses</th>
                <th className="px-4 py-3 font-medium text-right">Constituent Contacts</th>
                <th className="px-4 py-3 font-medium">Top PAC Sector Concentration</th>
                <th className="px-4 py-3 font-medium">Signal</th>
                <th className="px-4 py-3 font-medium text-right">Index</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#DFD9CE]">
              {report.representatives.map((r) => (
                <tr key={r.politicianId} className="hover:bg-[#FBF9F5]">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onOpenPolitician(r.politicianId)}
                      className="font-display text-sm font-bold text-[#1E3A5F] hover:text-[#9A3412] hover:underline text-left cursor-pointer"
                    >
                      {r.name}
                    </button>
                    <div className="text-[11px] font-mono text-[#57534E]">
                      {r.party} · {r.district}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-right">
                    {r.crossAisleVotes}/{r.totalVotes} ({r.crossAislePct}%)
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-right">
                    {r.citizenWitnessExposure}
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-right">
                    {r.constituentContacts.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-[#57534E]">
                    {r.topDonorSector}{' '}
                    <span className="font-mono tabular-nums text-[#78716C]">
                      ({r.topSectorSharePct}%)
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#181715]">{r.responsivenessSignal}</td>
                  <td className="px-4 py-3 font-mono tabular-nums text-right font-semibold text-[#9A3412]">
                    {r.responsivenessScore.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tab 3: Policies */}
      {activeTab === 'policies' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {report.policies.map((p) => (
            <div key={p.domain} className="border border-[#DFD9CE] bg-[#FFFFFF] p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-base font-bold text-[#181715]">{p.domain}</h3>
                  <div className="text-xs font-mono text-[#78716C] mt-0.5">{p.malleabilityLabel}</div>
                </div>
                <span className="text-xs font-mono tabular-nums font-semibold text-[#9A3412]">
                  {p.amendedRatePct}% Amended
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs font-mono tabular-nums pt-2 border-t border-[#F4F0E8]">
                <div>
                  <div className="text-[#78716C]">Bills</div>
                  <div className="font-semibold text-[#181715]">{p.billCount}</div>
                </div>
                <div>
                  <div className="text-[#78716C]">Witness For / Against</div>
                  <div className="font-semibold text-[#181715]">
                    <span className="text-[#14532D]">{p.citizenForPct}%</span> /{' '}
                    <span className="text-[#991B1B]">{p.citizenAgainstPct}%</span>
                  </div>
                </div>
                <div>
                  <div className="text-[#78716C]">Outreach Vol.</div>
                  <div className="font-semibold text-[#181715]">
                    {p.constituentVolume.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tab 4: Constituent Communication Log */}
      {activeTab === 'logs' && (
        <div className="border border-[#DFD9CE] bg-[#FFFFFF] divide-y divide-[#DFD9CE]">
          {report.recentCommunications.map((c) => (
            <div key={c.id} className="p-4 space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenBill(c.billId)}
                    className="font-semibold text-[#9A3412] hover:underline cursor-pointer"
                  >
                    {c.session} {c.billNumber}
                  </button>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#181715] font-medium">{c.channel}</span>
                  <span aria-hidden="true">·</span>
                  <span
                    className={
                      c.stance === 'Support'
                        ? 'text-[#14532D] font-semibold'
                        : c.stance === 'Oppose'
                          ? 'text-[#991B1B] font-semibold'
                          : 'text-[#92400E] font-semibold'
                    }
                  >
                    {c.stance}
                  </span>
                </div>
                <span className="tabular-nums text-[#57534E]">
                  {c.volumeCount.toLocaleString()} contacts · {c.loggedDate}
                </span>
              </div>
              <p className="text-xs text-[#181715] leading-relaxed">{c.summary}</p>
              <div className="text-[11px] font-mono text-[#78716C]">
                {c.committeeName && `Committee: ${c.committeeName}`}
                {c.politicianName && ` · Target Office: ${c.politicianName}`}
                {c.topicKeywords && ` · Keywords: ${c.topicKeywords}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
