import React, { useState } from 'react';
import { X, BellPlus } from 'lucide-react';

interface NewAlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialQuery?: string;
  onCreated: () => void;
}

export const NewAlertModal: React.FC<NewAlertModalProps> = ({
  isOpen,
  onClose,
  initialQuery = '',
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [query, setQuery] = useState(initialQuery);
  const [session, setSession] = useState('');
  const [chamber, setChamber] = useState('');
  const [committee, setCommittee] = useState('');
  const [politician, setPolitician] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !query.trim()) {
      setError('Rule name and FTS5 keyword expression are required.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/alerts/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, query, session, chamber, committee, politician }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create alert rule');
      setName('');
      setQuery('');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create alert rule');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#181715]/50 flex items-center justify-center p-4">
      <div className="bg-[#FBF9F5] border border-[#C5BDB0] w-full max-w-lg">
        <div className="px-6 py-4 border-b border-[#DFD9CE] flex items-center justify-between bg-[#F4F0E8]">
          <h2 className="font-display text-lg font-bold text-[#181715]">
            Create Automated Keyword Alert Rule
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
          <div>
            <label className="block text-xs font-medium text-[#57534E] mb-1">Alert Name</label>
            <input
              type="text"
              placeholder="e.g. Desalination & Brackish Water Bonds"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[#57534E] mb-1">
              FTS5 Boolean Keyword Query
            </label>
            <input
              type="text"
              placeholder='e.g. (water OR desalination) AND "Texas Water Fund"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm font-mono rounded"
              required
            />
            <p className="text-[11px] text-[#78716C] mt-1">
              Evaluated automatically across bills, full statutory text, and archived floor amendments.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Session Scope</label>
              <select
                value={session}
                onChange={(e) => setSession(e.target.value)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              >
                <option value="">All Sessions</option>
                <option value="90R">90R (Pre-Files)</option>
                <option value="891">891 (Special)</option>
                <option value="89R">89R (Regular)</option>
                <option value="88R">88R (Regular)</option>
                <option value="87R">87R (Regular)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">Chamber</label>
              <select
                value={chamber}
                onChange={(e) => setChamber(e.target.value)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              >
                <option value="">House & Senate</option>
                <option value="House">House Only</option>
                <option value="Senate">Senate Only</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">
                Committee Filter (optional)
              </label>
              <input
                type="text"
                placeholder="e.g. Public Education"
                value={committee}
                onChange={(e) => setCommittee(e.target.value)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#57534E] mb-1">
                Legislator Filter (optional)
              </label>
              <input
                type="text"
                placeholder="e.g. Creighton"
                value={politician}
                onChange={(e) => setPolitician(e.target.value)}
                className="w-full px-3 py-2 border border-[#C5BDB0] bg-[#FFFFFF] text-sm rounded"
              />
            </div>
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
              <BellPlus className="w-3.5 h-3.5" />
              {submitting ? 'Scanning Index...' : 'Save Rule & Run Scan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
