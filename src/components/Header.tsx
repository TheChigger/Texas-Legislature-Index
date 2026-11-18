import React from 'react';

export type ActiveView =
  | 'legislation'
  | 'politicians'
  | 'receptivity'
  | 'network'
  | 'amendments'
  | 'statutes'
  | 'alerts';

interface HeaderProps {
  activeView: ActiveView;
  onNavigate: (view: ActiveView) => void;
  unreadAlertsCount: number;
  onNewAlert: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeView,
  onNavigate,
  unreadAlertsCount,
  onNewAlert,
}) => {
  const navItems: Array<{ id: ActiveView; label: string }> = [
    { id: 'legislation', label: 'Legislation' },
    { id: 'politicians', label: 'Politicians' },
    { id: 'receptivity', label: 'Receptivity' },
    { id: 'network', label: 'Network Map' },
    { id: 'amendments', label: 'Amendments' },
    { id: 'statutes', label: 'Statutes' },
    {
      id: 'alerts',
      label: unreadAlertsCount > 0 ? `Alerts (${unreadAlertsCount})` : 'Alerts',
    },
  ];

  return (
    <header className="sticky top-0 z-30 bg-[#FBF9F5]/95 backdrop-blur-sm border-b border-[#DFD9CE]">
      <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
        <button
          type="button"
          onClick={() => onNavigate('legislation')}
          className="font-display text-xl font-bold tracking-tight text-[#181715] whitespace-nowrap shrink-0 cursor-pointer hover:text-[#9A3412] transition-colors"
        >
          Texas Capitol Ledger
        </button>

        <nav className="flex items-center gap-6 overflow-x-auto" aria-label="Primary navigation">
          {navItems.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`relative py-5 text-sm font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  isActive
                    ? 'text-[#9A3412]'
                    : 'text-[#57534E] hover:text-[#181715]'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 right-0 bottom-0 h-[2px] bg-[#9A3412]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={onNewAlert}
            className="px-4 py-2 text-xs font-medium bg-[#9A3412] text-[#FBF9F5] rounded hover:bg-[#7C2D12] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            New Alert Rule
          </button>
        </div>
      </div>
    </header>
  );
};
