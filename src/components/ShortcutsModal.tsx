import React from 'react';
import { X, Keyboard } from 'lucide-react';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUT_GROUPS: Array<{
  heading: string;
  items: Array<{ keys: string[]; description: string }>;
}> = [
  {
    heading: 'Search & Quick Actions',
    items: [
      { keys: ['/'], description: 'Focus active search bar (or jump to Legislation FTS5 search)' },
      { keys: ['⌘K', 'Ctrl+K'], description: 'Focus search bar from anywhere' },
      { keys: ['n'], description: 'Open Index New Bill modal' },
      { keys: ['a'], description: 'Open New Alert Rule modal' },
      { keys: ['t'], description: 'Open TLO FTP Archive Sync modal' },
      { keys: ['e'], description: 'Export active table or dataset to CSV' },
    ],
  },
  {
    heading: 'Navigation & Triage',
    items: [
      { keys: ['1', '–', '9'], description: 'Switch views (Legislation, Research Desk, Timeline, Politicians, Receptivity, Network, Amendments, Statutes, Alerts)' },
      { keys: ['j', 'k'], description: 'Select next / previous record in active index list' },
      { keys: ['?'], description: 'Toggle this keyboard shortcuts reference' },
      { keys: ['Esc'], description: 'Close open modal or unfocus search input' },
    ],
  },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#181715]/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#FBF9F5] border border-[#C5BDB0] w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[#DFD9CE] bg-[#F4F0E8] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-[#9A3412]" />
            <h2 className="font-display text-lg font-bold text-[#181715]">
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-[#57534E] hover:text-[#181715] cursor-pointer"
            aria-label="Close shortcuts guide"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.heading} className="space-y-2.5">
              <h3 className="text-xs font-condensed uppercase tracking-wider text-[#57534E] border-b border-[#DFD9CE] pb-1">
                {group.heading}
              </h3>
              <div className="space-y-2">
                {group.items.map((item) => (
                  <div
                    key={item.description}
                    className="flex items-center justify-between gap-4 text-xs"
                  >
                    <span className="text-[#181715]">{item.description}</span>
                    <span className="flex items-center gap-1 shrink-0 font-mono">
                      {item.keys.map((k, idx) =>
                        k === '–' ? (
                          <span key={idx} className="text-[#78716C] px-0.5">
                            –
                          </span>
                        ) : (
                          <kbd
                            key={k}
                            className="px-1.5 py-0.5 bg-[#FFFFFF] border border-[#C5BDB0] text-[11px] text-[#181715] rounded"
                          >
                            {k}
                          </kbd>
                        )
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-6 py-3 border-t border-[#DFD9CE] bg-[#F4F0E8]/60 flex items-center justify-between text-xs text-[#78716C]">
          <span>Shortcuts pause automatically while typing in inputs.</span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 border border-[#C5BDB0] bg-[#FFFFFF] text-[#181715] rounded hover:border-[#181715] cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
