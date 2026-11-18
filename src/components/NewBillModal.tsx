import React, { useState } from 'react';
import { X, FilePlus2 } from 'lucide-react';
import type { BillStage, Chamber } from '../types.ts';

interface NewBillModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultSession: string;
  onCreated: (billId: string, alertsTriggered: number) => void;
}

export const NewBillModal: React.FC<NewBillModalProps> = ({
  isOpen,
  onClose,
  defaultSession,
  onCreated,
}) => {
  const [session, setSession] = useState(defaultSession || '90R');
  const [billNumber, setBillNumber] = useState('');
  const [chamber, setChamber] = useState<Chamber>('House');
  const [stage, setStage] = useState<BillStage>('Pre-Filed');
  const [primaryAuthor, setPrimaryAuthor] = useState('Buckley');
  const [committee, setCommittee] = useState('Public Education');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [subjectsText, setSubjectsText] = useState('');
  const [statutesText, setStatutesText] = useState('');
  const [fullText, setFullText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!billNumber.trim() || !title.trim()) {
      setError('Bill number and caption title are required.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session,
          billNumber,
          chamber,
          stage,
          primaryAuthor,
          committee,
          title,
          summary: summary || title,
          subjects: subjectsText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          statuteCodes: statutesText
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          fullText: fullText || summary || title,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to file bill');
      onCreated(data.bill.id, data.alertsTriggered ?? 0);
      setBillNumber('');
      setTitle('');
      setSummary('');
      setFullText('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to file bill');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#181715]/50 flex items-center justify-center p-4">
      <div className="bg-[#FBF9F5] border border-[#C5BDB0] w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-[#DFD9CE] flex items-center justify-between bg-[#F4F0E8]">
          <h2 className="font-display text-lg font-bold text-[#181715]">
            Index New Legislation Record
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-[#57534E] hover:text-[#181715] cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Session</label>
              <select
                value={session}
                onChange={(e) => setSession(e.target.value)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              >
                <option value="90R">90R (2027)</option>
                <option value="891">891 (Special)</option>
                <option value="89R">89R (2025)</option>
                <option value="88R">88R (2023)</option>
                <option value="87R">87R (2021)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Bill Number</label>
              <input
                type="text"
                placeholder="e.g. HB 105"
                value={billNumber}
                onChange={(e) => setBillNumber(e.target.value)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm font-mono rounded"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Chamber</label>
              <select
                value={chamber}
                onChange={(e) => setChamber(e.target.value as Chamber)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              >
                <option value="House">House</option>
                <option value="Senate">Senate</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Stage</label>
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value as BillStage)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              >
                <option value="Pre-Filed">Pre-Filed</option>
                <option value="Filed">Filed</option>
                <option value="Committee Hearing">Committee Hearing</option>
                <option value="Committee Reported">Committee Reported</option>
                <option value="Engrossed">Engrossed</option>
                <option value="Enrolled">Enrolled</option>
                <option value="Signed">Signed</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Primary Author</label>
              <input
                type="text"
                value={primaryAuthor}
                onChange={(e) => setPrimaryAuthor(e.target.value)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Referred Committee</label>
              <input
                type="text"
                value={committee}
                onChange={(e) => setCommittee(e.target.value)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#57534E] mb-1">
              Official Caption / Title
            </label>
            <input
              type="text"
              placeholder="Relating to..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[#57534E] mb-1">
              Policy Summary
            </label>
            <textarea
              rows={2}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Concise summary indexed by FTS5..."
              className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">
                Subjects (comma-separated)
              </label>
              <input
                type="text"
                value={subjectsText}
                onChange={(e) => setSubjectsText(e.target.value)}
                placeholder="ERCOT Electric Grid, Nuclear Energy"
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">
                Texas Statute Codes (comma-separated)
              </label>
              <input
                type="text"
                value={statutesText}
                onChange={(e) => setStatutesText(e.target.value)}
                placeholder="Utilities Code Ch. 39, Tax Code Ch. 26"
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm font-mono rounded"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#57534E] mb-1">
              Statutory Text / Bill Sections (indexed for FTS5 & redline diffing)
            </label>
            <textarea
              rows={4}
              value={fullText}
              onChange={(e) => setFullText(e.target.value)}
              placeholder="SECTION 1. ..."
              className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-xs font-mono rounded"
            />
          </div>

          {error && <div className="text-xs text-[#991B1B]">{error}</div>}

          <div className="pt-3 border-t border-[#DFD9CE] flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-[#57534E] border border-[#C5BDB0] rounded cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] inline-flex items-center gap-2 cursor-pointer"
            >
              <FilePlus2 className="w-3.5 h-3.5" />
              {submitting ? 'Indexing...' : 'Save & Evaluate Alerts'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
