import React, { useEffect, useState } from 'react';
import {
  Sparkles,
  Send,
  Trash2,
  Database,
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
  Copy,
  Check,
  Users,
  FileText,
  Download,
  RefreshCw,
} from 'lucide-react';
import type { ResearchQueryRecord } from '../types.ts';
import { OutcomeIndicator } from './OutcomeIndicator.tsx';

interface ResearchDeskViewProps {
  activeSession: string;
  onOpenBill: (billId: string) => void;
  onOpenPolitician: (politicianId: string) => void;
  onOpenTloSync: () => void;
}

const EXAMPLE_QUESTIONS: Array<{ label: string; question: string }> = [
  {
    label: 'Autonomous Driving Count',
    question: 'How many bills have been introduced about autonomous driving?',
  },
  {
    label: 'Medicaid Influence (House)',
    question: 'Which representatives have the greatest influence over Medicaid policy?',
  },
  {
    label: '89R Education Pass/Fail',
    question: 'How many public education bills passed vs. failed in 89R?',
  },
  {
    label: 'ERCOT Grid Influence',
    question: 'Which senators and committees have the greatest influence over ERCOT electric grid policy?',
  },
  {
    label: 'Property Tax Enactments',
    question: 'What property tax bills passed across 88R and 891?',
  },
  {
    label: 'Most Expensive 89R Bills',
    question: 'What are the most expensive bills passed in 89R according to LBB fiscal notes?',
  },
  {
    label: 'HB 2 Agency Rules',
    question: 'Which Texas Register agency rule changes implement HB 2?',
  },
  {
    label: '2026 Platforms on Education',
    question: 'How do the 2026 Texas Democratic and Republican platforms compare on public education and vouchers?',
  },
  {
    label: 'Platform RILE & Wordscores',
    question: 'What are the MARPOR RILE scores for the 2026 Texas party platforms and which bills align most strongly via Wordscores?',
  },
];

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-[#181715]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <em key={idx} className="italic text-[#57534E]">
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={idx}
          className="px-1 py-0.5 bg-[#F4F0E8] border border-[#DFD9CE] font-mono text-[11px] text-[#181715]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function ResearchAnswerBody({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = (keyPrefix: string) => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`ul-${keyPrefix}`} className="space-y-1.5 pl-4 list-disc text-sm text-[#181715] leading-relaxed">
        {listItems.map((item, i) => (
          <li key={i}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) {
      flushList(String(idx));
      return;
    }
    if (line.startsWith('### ') || line.startsWith('## ')) {
      flushList(String(idx));
      const headingText = line.replace(/^#{2,3}\s+/, '');
      blocks.push(
        <h3
          key={`h-${idx}`}
          className="font-display text-base font-bold text-[#181715] pt-2 first:pt-0 border-b border-[#F4F0E8] pb-1"
        >
          {renderInlineMarkdown(headingText)}
        </h3>
      );
      return;
    }
    if (/^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      listItems.push(line.replace(/^([-*•]|\d+\.)\s+/, ''));
      return;
    }
    flushList(String(idx));
    blocks.push(
      <p key={`p-${idx}`} className="text-sm text-[#181715] leading-relaxed">
        {renderInlineMarkdown(line)}
      </p>
    );
  });
  flushList('end');

  return <div className="space-y-2.5">{blocks}</div>;
}

export const ResearchDeskView: React.FC<ResearchDeskViewProps> = ({
  activeSession,
  onOpenBill,
  onOpenPolitician,
  onOpenTloSync,
}) => {
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<ResearchQueryRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [useSessionScope, setUseSessionScope] = useState(false);
  const [includeFollowUpContext, setIncludeFollowUpContext] = useState(false);
  const [showToolAudit, setShowToolAudit] = useState(true);
  const [copiedId, setCopiedId] = useState('');

  useEffect(() => {
    setLoadingHistory(true);
    fetch('/api/research/history')
      .then((r) => r.json())
      .then((data) => {
        const items: ResearchQueryRecord[] = data.items ?? [];
        setHistory(items);
        if (items.length > 0 && !selectedId) {
          setSelectedId(items[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, []);

  const activeRecord = history.find((h) => h.id === selectedId) || history[0] || null;

  const submitQuestion = async (promptText: string) => {
    const trimmed = promptText.trim();
    if (!trimmed || asking) return;
    setAsking(true);
    setError('');
    try {
      const priorTurns =
        includeFollowUpContext && activeRecord
          ? [{ question: activeRecord.question, answer: activeRecord.answer }]
          : [];
      const res = await fetch('/api/research/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: trimmed,
          sessionScope: useSessionScope && activeSession ? activeSession : '',
          priorTurns,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Research query failed');
      const rec: ResearchQueryRecord = data.record;
      setHistory((prev) => [rec, ...prev]);
      setSelectedId(rec.id);
      setQuestion('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Research query failed');
    } finally {
      setAsking(false);
    }
  };

  const handleDeleteRecord = async (id: string) => {
    await fetch(`/api/research/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setHistory((prev) => {
      const next = prev.filter((item) => item.id !== id);
      if (selectedId === id) {
        setSelectedId(next[0]?.id || '');
      }
      return next;
    });
  };

  const handleCopyAnswer = (rec: ResearchQueryRecord) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(rec.answer);
    setCopiedId(rec.id);
    window.setTimeout(() => setCopiedId(''), 1800);
  };

  return (
    <div className="space-y-6">
      {/* Section 1: Research Desk Command Masthead */}
      <section className="border border-[#DFD9CE] bg-[#F4F0E8] p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-lg font-bold text-[#181715] flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#9A3412]" />
              AI Legislative Research Desk
            </h1>
            <p className="text-xs text-[#57534E] mt-0.5">
              Ask natural-language policy questions. The agent runs read-only SQLite FTS5, committee, outcome, and donor queries against your local archive and cites every bill and legislator it finds.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenTloSync}
            className="px-3 py-1.5 text-xs font-medium bg-[#FFFFFF] border border-[#C5BDB0] text-[#181715] rounded hover:border-[#181715] inline-flex items-center gap-1.5 self-start whitespace-nowrap cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[#9A3412]" />
            Sync More Sessions
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitQuestion(question);
          }}
          className="flex flex-col sm:flex-row gap-2.5"
        >
          <div className="relative flex-1">
            <input
              type="text"
              data-global-search="true"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={asking}
              placeholder='Ask a question (e.g., "How many bills have been introduced about autonomous driving?" or "Which representatives have the greatest influence over Medicaid policy?")'
              className="w-full px-3.5 py-2.5 bg-[#FFFFFF] border border-[#C5BDB0] text-sm text-[#181715] rounded focus:outline-none focus:border-[#9A3412]"
            />
          </div>
          <button
            type="submit"
            disabled={asking || !question.trim()}
            className="px-4 py-2.5 text-xs font-medium bg-[#181715] text-[#FBF9F5] hover:bg-[#9A3412] disabled:opacity-50 rounded inline-flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer transition-colors"
          >
            {asking ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Querying Archive…
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" />
                Run Research Query
              </>
            )}
          </button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[#57534E]">Example inquiries:</span>
            {EXAMPLE_QUESTIONS.map((ex) => (
              <button
                key={ex.label}
                type="button"
                disabled={asking}
                onClick={() => {
                  setQuestion(ex.question);
                  void submitQuestion(ex.question);
                }}
                className="px-2.5 py-1 bg-[#FFFFFF] border border-[#DFD9CE] hover:border-[#9A3412] text-[#181715] rounded text-[11px] cursor-pointer transition-colors disabled:opacity-50"
                title={ex.question}
              >
                {ex.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-4 text-[11px] text-[#57534E]">
            {activeSession && (
              <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useSessionScope}
                  onChange={(e) => setUseSessionScope(e.target.checked)}
                  className="accent-[#9A3412]"
                />
                <span>Restrict to {activeSession}</span>
              </label>
            )}
            {activeRecord && (
              <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeFollowUpContext}
                  onChange={(e) => setIncludeFollowUpContext(e.target.checked)}
                  className="accent-[#9A3412]"
                />
                <span>Follow up on selected memo</span>
              </label>
            )}
          </div>
        </div>

        {error && (
          <div className="px-3.5 py-2.5 bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#991B1B]">
            {error}
          </div>
        )}
      </section>

      {/* Section 2: Two-Column Research Split (Saved Inquiry Ledger + Active Grounded Memo) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:items-stretch">
        {/* Left 4 cols: Saved Research Ledger */}
        <div className="lg:col-span-4 lg:relative">
          <div className="border border-[#DFD9CE] bg-[#FFFFFF] flex flex-col lg:absolute lg:inset-0">
            <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between text-xs font-medium text-[#57534E] shrink-0">
              <span className="font-mono tabular-nums">
                {loadingHistory ? 'Loading ledger…' : `${history.length} saved memos`}
              </span>
              <span>Stored in SQLite</span>
            </div>

            {history.length === 0 && !loadingHistory ? (
              <div className="p-6 text-xs text-[#78716C] leading-relaxed">
                No research memos yet. Ask a legislative question above or click an example inquiry to run your first grounded query.
              </div>
            ) : (
              <div className="divide-y divide-[#DFD9CE] flex-1 min-h-0 max-h-[540px] lg:max-h-none overflow-y-auto">
                {history.map((item) => {
                  const isActive = activeRecord?.id === item.id;
                  return (
                    <div
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      className={`p-4 cursor-pointer transition-colors ${
                        isActive ? 'bg-[#F4F0E8]' : 'hover:bg-[#FBF9F5]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-display text-sm font-semibold text-[#181715] leading-snug">
                          {item.question}
                        </p>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteRecord(item.id);
                          }}
                          className="p-1 text-[#78716C] hover:text-[#991B1B] shrink-0 cursor-pointer"
                          title="Delete saved memo"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-[#78716C] tabular-nums">
                        <span>{item.createdAt.slice(0, 10)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{item.toolCalls.length} queries</span>
                        {item.citedBills.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{item.citedBills.length} bills</span>
                          </>
                        )}
                        {item.citedPoliticians.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{item.citedPoliticians.length} legislators</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right 8 cols: Active Research Brief & Evidence Ledger */}
        <div className="lg:col-span-8 border border-[#DFD9CE] bg-[#FFFFFF] lg:min-h-[600px]">
          {asking ? (
            <div className="p-8 space-y-3">
              <div className="inline-flex items-center gap-2 text-sm font-medium text-[#181715]">
                <RefreshCw className="w-4 h-4 text-[#9A3412] animate-spin" />
                Running legislative research tools against SQLite &amp; FTS5…
              </div>
              <p className="text-xs text-[#57534E]">
                Querying bills, prior-session outcomes, committee jurisdictions, roll-call votes, and TEC donor sectors, then synthesizing with your local LLM.
              </p>
            </div>
          ) : !activeRecord ? (
            <div className="p-8 space-y-5">
              <div>
                <h2 className="font-display text-xl font-bold text-[#181715]">
                  Ask Any Texas Legislative Question
                </h2>
                <p className="text-sm text-[#57534E] mt-1 leading-relaxed">
                  The Research Agent translates plain-English questions into verified database queries across your local Texas Capitol archive and returns cited bills, ranked legislators, and exact session counts.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {EXAMPLE_QUESTIONS.slice(0, 4).map((ex) => (
                  <button
                    key={ex.label}
                    type="button"
                    onClick={() => void submitQuestion(ex.question)}
                    className="p-4 text-left border border-[#DFD9CE] bg-[#FBF9F5] hover:border-[#9A3412] transition-colors cursor-pointer"
                  >
                    <div className="text-[11px] font-mono uppercase tracking-wider text-[#9A3412]">
                      {ex.label}
                    </div>
                    <div className="text-sm font-medium text-[#181715] mt-1 leading-snug">
                      “{ex.question}”
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              {/* Active Memo Header */}
              <div className="p-6 border-b border-[#DFD9CE] bg-[#FBF9F5] space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-[#57534E]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[#9A3412] font-semibold">RESEARCH MEMO</span>
                    <span aria-hidden="true">·</span>
                    <span>Scope: {activeRecord.sessionScope || 'All Indexed Sessions'}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {activeRecord.mode === 'llm_agent'
                        ? `Agent (${activeRecord.model})`
                        : activeRecord.mode === 'llm_grounded'
                          ? `Grounded LLM (${activeRecord.model})`
                          : 'Direct SQLite / FTS5 Evidence'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">{activeRecord.createdAt.slice(0, 10)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopyAnswer(activeRecord)}
                    className="inline-flex items-center gap-1 text-xs font-sans font-medium text-[#1E3A5F] hover:text-[#9A3412] cursor-pointer"
                  >
                    {copiedId === activeRecord.id ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-[#14532D]" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy Memo
                      </>
                    )}
                  </button>
                </div>

                <h2 className="font-display text-2xl font-bold text-[#181715] leading-tight">
                  {activeRecord.question}
                </h2>

                {activeRecord.warning && (
                  <div className="px-3 py-2 bg-[#FFF7ED] border border-[#FED7AA] text-xs text-[#9A3412]">
                    {activeRecord.warning}
                  </div>
                )}
              </div>

              <div className="p-6 space-y-6">
                {/* Tool-Call Audit Trail */}
                {activeRecord.toolCalls.length > 0 && (
                  <div className="border border-[#DFD9CE] bg-[#FBF9F5]">
                    <button
                      type="button"
                      onClick={() => setShowToolAudit((v) => !v)}
                      className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-mono text-[#57534E] hover:text-[#181715] cursor-pointer"
                    >
                      <span className="inline-flex items-center gap-2 font-medium text-[#181715]">
                        <Database className="w-3.5 h-3.5 text-[#1E3A5F]" />
                        Verified Database Queries Executed ({activeRecord.toolCalls.length})
                      </span>
                      {showToolAudit ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </button>
                    {showToolAudit && (
                      <div className="border-t border-[#DFD9CE] divide-y divide-[#EAE4D9] bg-[#FFFFFF]">
                        {activeRecord.toolCalls.map((tc) => (
                          <div
                            key={tc.id}
                            className="px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs font-mono"
                          >
                            <div className="min-w-0">
                              <span className="font-semibold text-[#1E3A5F]">{tc.name}</span>
                              <span className="text-[#78716C] ml-1.5">
                                ({Object.entries(tc.args)
                                  .filter(([, v]) => v !== undefined && v !== '')
                                  .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                                  .join(', ')})
                              </span>
                            </div>
                            <div className="text-[#57534E] tabular-nums shrink-0">
                              {tc.summary} · {tc.durationMs}ms
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Synthesized Research Answer */}
                <div className="border-b border-[#DFD9CE] pb-6">
                  <ResearchAnswerBody content={activeRecord.answer} />
                </div>

                {/* Ranked / Cited Legislators */}
                {activeRecord.citedPoliticians.length > 0 && (
                  <div className="space-y-2.5">
                    <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-[#9A3412]" />
                      Ranked &amp; Cited Legislators ({activeRecord.citedPoliticians.length})
                    </h3>
                    <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                      {activeRecord.citedPoliticians.map((pol, idx) => (
                        <button
                          key={pol.id}
                          type="button"
                          onClick={() => onOpenPolitician(pol.id)}
                          className="w-full p-3.5 text-left hover:bg-[#FBF9F5] transition-colors flex items-start justify-between gap-3 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                              {pol.score !== undefined && (
                                <span className="text-[#9A3412] font-semibold tabular-nums">
                                  #{idx + 1}
                                </span>
                              )}
                              <span className="font-display text-sm font-bold text-[#181715]">
                                {pol.name}
                              </span>
                              <span className="text-[#57534E]">
                                ({pol.party !== '—' ? `${pol.party}-` : ''}
                                {pol.chamber}
                                {pol.district ? ` · ${pol.district}` : ''})
                              </span>
                            </div>
                            {(pol.reason || pol.leadershipRole) && (
                              <p className="text-xs text-[#57534E] mt-1">
                                {pol.reason || pol.leadershipRole}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 flex items-center gap-2 font-mono text-xs tabular-nums">
                            {pol.score !== undefined && (
                              <span className="font-semibold text-[#181715]">
                                INF {pol.score.toFixed(1)}
                              </span>
                            )}
                            <span className="text-[#1E3A5F] inline-flex items-center gap-0.5">
                              Profile <ArrowUpRight className="w-3 h-3" />
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Cited Legislation */}
                {activeRecord.citedBills.length > 0 && (
                  <div className="space-y-2.5">
                    <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-[#1E3A5F]" />
                      Cited Legislation ({activeRecord.citedBills.length})
                    </h3>
                    <div className="divide-y divide-[#DFD9CE] border border-[#DFD9CE]">
                      {activeRecord.citedBills.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => onOpenBill(b.id)}
                          className="w-full p-3.5 text-left hover:bg-[#FBF9F5] transition-colors flex items-start justify-between gap-3 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono text-[#57534E]">
                              <span className="font-semibold text-[#9A3412]">{b.session}</span>
                              <span className="font-semibold text-[#181715]">{b.billNumber}</span>
                              <OutcomeIndicator outcome={b.outcome} detail={b.outcomeDetail} />
                              <span aria-hidden="true">·</span>
                              <span>{b.chamber}</span>
                              {(b.outcome === 'Active' ||
                                (b.outcome === 'Failed' && b.stage !== 'Stalled')) && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>{b.stage}</span>
                                </>
                              )}
                              <span aria-hidden="true">·</span>
                              <span>Author: {b.primaryAuthor}</span>
                            </div>
                            <p className="text-sm text-[#181715] mt-1 leading-snug">{b.title}</p>
                          </div>
                          <div className="shrink-0 flex items-center gap-2 font-mono text-xs tabular-nums">
                            <span className="font-medium text-[#181715]">
                              IDX {b.influenceScore.toFixed(1)}
                            </span>
                            <span className="text-[#1E3A5F] inline-flex items-center gap-0.5">
                              Dossier <ArrowUpRight className="w-3 h-3" />
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
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
