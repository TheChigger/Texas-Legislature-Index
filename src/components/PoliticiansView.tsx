import React, { useEffect, useState } from 'react';
import { Search, Share2 } from 'lucide-react';
import type { PoliticianDetail, PoliticianSummary } from '../types.ts';

interface PoliticiansViewProps {
  selectedPoliticianId: string;
  onSelectPolitician: (id: string) => void;
  onOpenBill: (billId: string) => void;
  onInspectInNetwork: (polId: string) => void;
}

export const PoliticiansView: React.FC<PoliticiansViewProps> = ({
  selectedPoliticianId,
  onSelectPolitician,
  onOpenBill,
  onInspectInNetwork,
}) => {
  const [query, setQuery] = useState('');
  const [chamber, setChamber] = useState('');
  const [party, setParty] = useState('');
  const [politicians, setPoliticians] = useState<PoliticianSummary[]>([]);
  const [detail, setDetail] = useState<PoliticianDetail | null>(null);
  const [tab, setTab] = useState<'votes' | 'sponsorships' | 'committees' | 'donors' | 'outreach'>('donors');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (chamber) params.set('chamber', chamber);
    if (party) params.set('party', party);

    fetch(`/api/politicians?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        const list: PoliticianSummary[] = data.politicians ?? [];
        setPoliticians(list);
        if (list.length > 0 && (!selectedPoliticianId || !list.some((p) => p.id === selectedPoliticianId))) {
          onSelectPolitician(list[0].id);
        }
      })
      .catch(() => {});
  }, [query, chamber, party]);

  useEffect(() => {
    if (!selectedPoliticianId) return;
    setLoading(true);
    fetch(`/api/politicians/${encodeURIComponent(selectedPoliticianId)}`)
      .then((r) => r.json())
      .then((data: PoliticianDetail) => setDetail(data))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [selectedPoliticianId]);

  return (
    <div className="space-y-6">
      <div className="border border-[#DFD9CE] bg-[#F4F0E8] p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 text-[#57534E] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Texas Senators & Representatives by name, district, or committee chair..."
            className="w-full pl-9 pr-4 py-2 bg-[#FFFFFF] border border-[#C5BDB0] text-sm rounded"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex border border-[#C5BDB0] bg-[#FFFFFF] rounded overflow-hidden">
            {['', 'House', 'Senate'].map((ch) => (
              <button
                key={ch || 'all'}
                type="button"
                onClick={() => setChamber(ch)}
                className={`px-3 py-1.5 text-xs font-medium cursor-pointer ${
                  chamber === ch ? 'bg-[#181715] text-[#FBF9F5]' : 'text-[#57534E]'
                }`}
              >
                {ch || 'All Chambers'}
              </button>
            ))}
          </div>
          <div className="inline-flex border border-[#C5BDB0] bg-[#FFFFFF] rounded overflow-hidden">
            {[
              { id: '', label: 'All Parties' },
              { id: 'R', label: 'Republican (R)' },
              { id: 'D', label: 'Democratic (D)' },
            ].map((pt) => (
              <button
                key={pt.id || 'all'}
                type="button"
                onClick={() => setParty(pt.id)}
                className={`px-3 py-1.5 text-xs font-medium cursor-pointer ${
                  party === pt.id ? 'bg-[#181715] text-[#FBF9F5]' : 'text-[#57534E]'
                }`}
              >
                {pt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Roster */}
        <div className="lg:col-span-4 border border-[#DFD9CE] bg-[#FFFFFF]">
          <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] text-xs font-mono text-[#57534E] tabular-nums">
            {politicians.length} Legislators Indexed
          </div>
          <div className="divide-y divide-[#DFD9CE] max-h-[760px] overflow-y-auto">
            {politicians.map((p) => {
              const active = p.id === selectedPoliticianId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSelectPolitician(p.id)}
                  className={`w-full p-4 text-left block cursor-pointer transition-colors ${
                    active ? 'bg-[#F4F0E8]' : 'hover:bg-[#FBF9F5]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs font-mono text-[#57534E]">
                    <span>
                      {p.party} · {p.chamber} · {p.district}
                    </span>
                    <span className="tabular-nums text-[#181715] font-medium">
                      ${(p.totalRaised / 1000000).toFixed(2)}M
                    </span>
                  </div>
                  <div className="font-display text-sm font-bold text-[#181715] mt-1">
                    {p.name}
                  </div>
                  {p.leadershipRole && (
                    <div className="text-xs text-[#9A3412] mt-0.5">{p.leadershipRole}</div>
                  )}
                  <div className="text-[11px] font-mono text-[#78716C] mt-1.5 tabular-nums">
                    {p.committeesCount} committees · {p.billsAuthored} authored · {p.votesCount} roll-call votes
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Dossier */}
        <div className="lg:col-span-8 border border-[#DFD9CE] bg-[#FFFFFF]">
          {loading ? (
            <div className="p-8 text-sm text-[#57534E]">Loading politician influence dossier...</div>
          ) : !detail ? (
            <div className="p-8 text-sm text-[#57534E]">Select a legislator to inspect their record.</div>
          ) : (
            <div>
              <div className="p-6 border-b border-[#DFD9CE] bg-[#FBF9F5]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs font-mono text-[#57534E]">
                    {detail.party === 'R' ? 'Republican' : 'Democratic'} · Texas {detail.chamber} ·{' '}
                    {detail.district} · {detail.tenureYears} yrs tenure
                  </div>
                  <button
                    type="button"
                    onClick={() => onInspectInNetwork(detail.id)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1E3A5F] hover:text-[#9A3412] cursor-pointer"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    Trace Influence in Network Map
                  </button>
                </div>

                <h2 className="font-display text-2xl font-bold text-[#181715] mt-1.5">
                  {detail.name}
                </h2>
                {detail.leadershipRole && (
                  <p className="text-sm font-medium text-[#9A3412] mt-0.5">
                    {detail.leadershipRole}
                  </p>
                )}
                <p className="text-sm text-[#57534E] mt-2 leading-relaxed">{detail.bio}</p>

                <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono tabular-nums">
                  <div className="p-3 bg-[#FFFFFF] border border-[#DFD9CE]">
                    <div className="text-[#78716C]">Career / Cycle Raised</div>
                    <div className="text-base font-semibold text-[#181715] mt-0.5">
                      ${detail.totalRaised.toLocaleString()}
                    </div>
                  </div>
                  <div className="p-3 bg-[#FFFFFF] border border-[#DFD9CE]">
                    <div className="text-[#78716C]">Bills Authored / Passed</div>
                    <div className="text-base font-semibold text-[#181715] mt-0.5">
                      {detail.billsAuthored} / {detail.billsPassed}
                    </div>
                  </div>
                  <div className="p-3 bg-[#FFFFFF] border border-[#DFD9CE]">
                    <div className="text-[#78716C]">Committee Seats</div>
                    <div className="text-base font-semibold text-[#181715] mt-0.5">
                      {detail.committees.length}
                    </div>
                  </div>
                  <div className="p-3 bg-[#FFFFFF] border border-[#DFD9CE]">
                    <div className="text-[#78716C]">Indexed Roll-Call Votes</div>
                    <div className="text-base font-semibold text-[#181715] mt-0.5">
                      {detail.votes.length}
                    </div>
                  </div>
                </div>

                <div className="mt-5 pt-3 border-t border-[#DFD9CE] flex items-center gap-6 overflow-x-auto">
                  {[
                    { id: 'donors', label: `Donors & PAC Ledger (${detail.contributions.length})` },
                    { id: 'votes', label: `Voting Record (${detail.votes.length})` },
                    { id: 'sponsorships', label: `Bill Sponsorships (${detail.sponsorships.length})` },
                    { id: 'committees', label: `Committees & Gatekeeping (${detail.committees.length})` },
                    { id: 'outreach', label: `Constituent Outreach (${detail.constituentLogs?.length ?? 0})` },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTab(t.id as typeof tab)}
                      className={`text-xs font-medium whitespace-nowrap pb-1 border-b-2 cursor-pointer ${
                        tab === t.id
                          ? 'border-[#9A3412] text-[#9A3412]'
                          : 'border-transparent text-[#57534E] hover:text-[#181715]'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-6">
                {tab === 'donors' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] mb-3">
                        Texas Ethics Commission Sector Concentration
                      </h3>
                      {detail.sectorTotals.length === 0 ? (
                        <p className="text-xs text-[#78716C]">No itemized PAC contributions indexed.</p>
                      ) : (
                        <div className="space-y-2.5">
                          {detail.sectorTotals.map((sec) => {
                            const maxSec = detail.sectorTotals[0].total || 1;
                            const pct = Math.max(8, Math.round((sec.total / maxSec) * 100));
                            return (
                              <div key={sec.sector} className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="font-medium text-[#181715]">{sec.sector}</span>
                                  <span className="font-mono tabular-nums text-[#57534E]">
                                    ${sec.total.toLocaleString()} ({sec.count} filings)
                                  </span>
                                </div>
                                <div className="h-2 bg-[#F4F0E8] w-full">
                                  <div
                                    style={{ width: `${pct}%` }}
                                    className="h-full bg-[#9A3412]"
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="border-t border-[#DFD9CE] pt-4">
                      <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] mb-2">
                        Itemized PAC & Major Donor Filings
                      </h3>
                      <div className="overflow-x-auto border border-[#DFD9CE]">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-[#F4F0E8] border-b border-[#DFD9CE] text-[#57534E]">
                            <tr>
                              <th className="px-3 py-2.5 font-medium">Donor / PAC Committee</th>
                              <th className="px-3 py-2.5 font-medium">Sector</th>
                              <th className="px-3 py-2.5 font-medium">TEC ID</th>
                              <th className="px-3 py-2.5 font-medium">Filing Date</th>
                              <th className="px-3 py-2.5 font-medium text-right">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#DFD9CE]">
                            {detail.contributions.map((c) => (
                              <tr key={c.id} className="hover:bg-[#FBF9F5]">
                                <td className="px-3 py-2.5 font-medium text-[#181715]">
                                  {c.donorName}
                                </td>
                                <td className="px-3 py-2.5 text-[#57534E]">{c.sector}</td>
                                <td className="px-3 py-2.5 font-mono text-[#78716C]">{c.pacId}</td>
                                <td className="px-3 py-2.5 font-mono tabular-nums text-[#57534E]">
                                  {c.filingDate}
                                </td>
                                <td className="px-3 py-2.5 font-mono tabular-nums text-right font-semibold text-[#181715]">
                                  ${c.amount.toLocaleString()}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}

                {tab === 'votes' && (
                  <div className="overflow-x-auto border border-[#DFD9CE]">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-[#F4F0E8] border-b border-[#DFD9CE] text-[#57534E]">
                        <tr>
                          <th className="px-3 py-2.5 font-medium">Bill</th>
                          <th className="px-3 py-2.5 font-medium">Motion / Record Vote</th>
                          <th className="px-3 py-2.5 font-medium">Date</th>
                          <th className="px-3 py-2.5 font-medium">Alignment</th>
                          <th className="px-3 py-2.5 font-medium text-right">Vote Cast</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#DFD9CE]">
                        {detail.votes.map((v) => (
                          <tr key={v.id} className="hover:bg-[#FBF9F5]">
                            <td className="px-3 py-2.5 font-mono whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => onOpenBill(v.billId)}
                                className="font-semibold text-[#9A3412] hover:underline cursor-pointer"
                              >
                                {v.session} {v.billNumber}
                              </button>
                            </td>
                            <td className="px-3 py-2.5 text-[#181715]">
                              <div className="font-medium">{v.motion}</div>
                              <div className="text-[#78716C] truncate max-w-md">{v.billTitle}</div>
                            </td>
                            <td className="px-3 py-2.5 font-mono tabular-nums text-[#57534E] whitespace-nowrap">
                              {v.voteDate}
                            </td>
                            <td className="px-3 py-2.5 text-[#57534E] whitespace-nowrap">
                              {v.partyLine ? 'With Party Majority' : 'Cross-Aisle Vote'}
                            </td>
                            <td
                              className={`px-3 py-2.5 font-mono font-semibold text-right whitespace-nowrap ${
                                v.voteCast === 'Yea'
                                  ? 'text-[#14532D]'
                                  : v.voteCast === 'Nay'
                                    ? 'text-[#991B1B]'
                                    : 'text-[#57534E]'
                              }`}
                            >
                              {v.voteCast}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {tab === 'sponsorships' && (
                  <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                    {detail.sponsorships.map((sp) => (
                      <div key={sp.billId} className="p-4 flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs font-mono">
                            <span className="font-semibold text-[#9A3412]">{sp.role}</span>
                            <span aria-hidden="true">·</span>
                            <button
                              type="button"
                              onClick={() => onOpenBill(sp.billId)}
                              className="font-semibold text-[#1E3A5F] hover:underline cursor-pointer"
                            >
                              {sp.session} {sp.billNumber}
                            </button>
                            <span aria-hidden="true">·</span>
                            <span className="text-[#57534E]">{sp.stage}</span>
                          </div>
                          <p className="text-sm text-[#181715] mt-1">{sp.title}</p>
                        </div>
                        <span className="text-xs font-mono tabular-nums text-[#57534E] shrink-0">
                          IDX {sp.influenceScore.toFixed(1)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'committees' && (
                  <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                    {detail.committees.map((c) => (
                      <div key={c.committeeId} className="p-4 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-display text-sm font-bold text-[#181715]">
                            {c.chamber} {c.name}
                          </div>
                          <span className="text-xs font-mono font-semibold text-[#9A3412]">
                            {c.role} · {c.session}
                          </span>
                        </div>
                        <p className="text-xs text-[#57534E]">{c.jurisdiction}</p>
                        <div className="text-xs font-mono text-[#78716C] tabular-nums pt-1">
                          {c.referredBillsCount} indexed bills referred to this panel
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'outreach' && (
                  <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                    {!detail.constituentLogs || detail.constituentLogs.length === 0 ? (
                      <div className="p-4 text-xs text-[#78716C]">
                        No direct constituent outreach logs recorded for this legislator yet.
                      </div>
                    ) : (
                      detail.constituentLogs.map((c) => (
                        <div key={c.id} className="p-4 space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                            <div className="flex items-center gap-2">
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
                          {c.topicKeywords && (
                            <div className="text-[11px] font-mono text-[#78716C]">
                              Keywords: {c.topicKeywords}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
