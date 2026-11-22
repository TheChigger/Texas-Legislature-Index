import { useEffect, useState } from 'react';
import { Header, type ActiveView } from './components/Header.tsx';
import { LegislationView } from './components/LegislationView.tsx';
import { TimelineView } from './components/TimelineView.tsx';
import { PoliticiansView } from './components/PoliticiansView.tsx';
import { NetworkMapView } from './components/NetworkMapView.tsx';
import { AmendmentsView } from './components/AmendmentsView.tsx';
import { AlertsView } from './components/AlertsView.tsx';
import { ReceptivityView } from './components/ReceptivityView.tsx';
import { StatutesView } from './components/StatutesView.tsx';
import { AgencyRulesView } from './components/AgencyRulesView.tsx';
import { PlatformsView } from './components/PlatformsView.tsx';
import { ResearchDeskView } from './components/ResearchDeskView.tsx';
import { TloSyncModal } from './components/TloSyncModal.tsx';
import { NewBillModal } from './components/NewBillModal.tsx';
import { NewAlertModal } from './components/NewAlertModal.tsx';
import { ShortcutsModal } from './components/ShortcutsModal.tsx';
import type { OverviewResponse, PoliticianSummary } from './types.ts';

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('legislation');
  const [activeSession, setActiveSession] = useState<string>('');
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [selectedBillId, setSelectedBillId] = useState<string>('89R-HB2');
  const [selectedPoliticianId, setSelectedPoliticianId] = useState<string>('pol-buckley');
  const [selectedRuleId, setSelectedRuleId] = useState<string>('');
  const [networkFocusId, setNetworkFocusId] = useState<string>('');
  const [refreshSignal, setRefreshSignal] = useState<number>(0);

  const [showTloModal, setShowTloModal] = useState(false);
  const [showNewBillModal, setShowNewBillModal] = useState(false);
  const [showNewAlertModal, setShowNewAlertModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);

  const triggerRefresh = () => setRefreshSignal((n) => n + 1);

  useEffect(() => {
    const VIEW_KEYS: Record<string, ActiveView> = {
      '1': 'legislation',
      '2': 'research',
      '3': 'timeline',
      '4': 'politicians',
      '5': 'receptivity',
      '6': 'network',
      '7': 'amendments',
      '8': 'statutes',
      '9': 'rules',
      '0': 'alerts',
    };

    const focusPrimarySearch = () => {
      const tryFocus = () => {
        const el = document.querySelector<HTMLInputElement>('[data-global-search="true"]');
        if (el) {
          el.focus();
          el.select();
          return true;
        }
        return false;
      };
      if (!tryFocus()) {
        setActiveView('legislation');
        window.requestAnimationFrame(() => {
          window.setTimeout(tryFocus, 30);
        });
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      const anyModalOpen =
        showTloModal || showNewBillModal || showNewAlertModal || showShortcutsModal;

      if (e.key === 'Escape') {
        if (anyModalOpen) {
          e.preventDefault();
          setShowShortcutsModal(false);
          setShowTloModal(false);
          setShowNewBillModal(false);
          setShowNewAlertModal(false);
          return;
        }
        if (isEditing && target) {
          target.blur();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!anyModalOpen) focusPrimarySearch();
        return;
      }

      if (isEditing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setShowShortcutsModal((prev) => !prev);
        return;
      }

      if (anyModalOpen) return;

      if (e.key === '/') {
        e.preventDefault();
        focusPrimarySearch();
        return;
      }

      const lower = e.key.toLowerCase();
      if (lower === 'n') {
        e.preventDefault();
        setShowNewBillModal(true);
      } else if (lower === 'a') {
        e.preventDefault();
        setShowNewAlertModal(true);
      } else if (lower === 't') {
        e.preventDefault();
        setShowTloModal(true);
      } else if (lower === 'e') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('capitol:export-csv'));
      } else if (lower === 'j') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('capitol:step-item', { detail: { delta: 1 } }));
      } else if (lower === 'k') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('capitol:step-item', { detail: { delta: -1 } }));
      } else if (lower === 'p') {
        e.preventDefault();
        setActiveView('platforms');
      } else if (VIEW_KEYS[e.key]) {
        e.preventDefault();
        setActiveView(VIEW_KEYS[e.key]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showTloModal, showNewBillModal, showNewAlertModal, showShortcutsModal]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (activeSession) params.set('session', activeSession);
    fetch(`/api/overview?${params.toString()}`)
      .then((r) => r.json())
      .then((data: OverviewResponse) => setOverview(data))
      .catch(() => {});
  }, [activeSession, refreshSignal]);

  const handleOpenBill = (billId: string) => {
    setSelectedBillId(billId);
    setActiveView('legislation');
  };

  const handleOpenPoliticianByName = (shortName: string) => {
    fetch(`/api/politicians?q=${encodeURIComponent(shortName)}`)
      .then((r) => r.json())
      .then((data) => {
        const match: PoliticianSummary | undefined = data.politicians?.[0];
        if (match) {
          setSelectedPoliticianId(match.id);
          setActiveView('politicians');
        }
      })
      .catch(() => {});
  };

  const handleOpenPolitician = (polId: string) => {
    setSelectedPoliticianId(polId);
    setActiveView('politicians');
  };

  const handleInspectInNetwork = (entityId: string) => {
    setNetworkFocusId(entityId);
    setActiveView('network');
  };

  const handleOpenRule = (ruleId: string) => {
    setSelectedRuleId(ruleId);
    setActiveView('rules');
  };

  return (
    <div className="min-h-screen bg-[#FBF9F5] text-[#181715] flex flex-col">
      <Header
        activeView={activeView}
        onNavigate={setActiveView}
        unreadAlertsCount={overview?.totals.unreadAlerts ?? 0}
        onNewAlert={() => setShowNewAlertModal(true)}
      />

      {/* Editorial Session & TLO Archive Strip */}
      <div className="border-b border-[#DFD9CE] bg-[#F4F0E8]/60">
        <div className="max-w-[1440px] mx-auto px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-condensed uppercase tracking-wider text-[#57534E] mr-1">
              Legislature:
            </span>
            <button
              type="button"
              onClick={() => setActiveSession('')}
              className={`px-2.5 py-1 rounded border cursor-pointer transition-colors whitespace-nowrap ${
                activeSession === ''
                  ? 'bg-[#181715] text-[#FBF9F5] border-[#181715]'
                  : 'bg-[#FFFFFF] text-[#57534E] border-[#C5BDB0] hover:border-[#181715]'
              }`}
            >
              All Sessions
            </button>
            {(overview?.sessions ?? [])
              .filter((s) => s.billCount > 0 || ['90R', '89R', '891', '88R', '87R'].includes(s.code))
              .map((s) => (
                <button
                  key={s.code}
                  type="button"
                  onClick={() => setActiveSession(s.code)}
                  className={`px-2.5 py-1 font-mono rounded border cursor-pointer transition-colors whitespace-nowrap tabular-nums ${
                    activeSession === s.code
                      ? 'bg-[#9A3412] text-[#FBF9F5] border-[#9A3412]'
                      : 'bg-[#FFFFFF] text-[#181715] border-[#C5BDB0] hover:border-[#181715]'
                  }`}
                >
                  {s.code} ({s.billCount})
                </button>
              ))}
          </div>

          {overview && (
            <div className="flex flex-wrap items-center gap-2 font-mono text-[#57534E] tabular-nums">
              <span>{overview.totals.bills} Bills</span>
              <span aria-hidden="true">·</span>
              <span>{overview.totals.amendments} Versions</span>
              <span aria-hidden="true">·</span>
              <span>{overview.totals.linksCount} Links</span>
              {typeof overview.totals.rulesCount === 'number' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{overview.totals.rulesCount} Rules</span>
                </>
              )}
              {typeof overview.totals.planksCount === 'number' && overview.totals.planksCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{overview.totals.planksCount} Planks</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>{overview.totals.politicians} Legislators</span>
              <span aria-hidden="true">·</span>
              <span>${(overview.totals.contributionsTotal / 1000000).toFixed(2)}M PAC Ledger</span>
            </div>
          )}
        </div>
      </div>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6">
        {activeView === 'legislation' && (
          <LegislationView
            overview={overview}
            activeSession={activeSession}
            selectedBillId={selectedBillId}
            onSelectBill={setSelectedBillId}
            onInspectPoliticianName={handleOpenPoliticianByName}
            onInspectInNetwork={handleInspectInNetwork}
            onOpenRule={handleOpenRule}
            onOpenPlatforms={() => setActiveView('platforms')}
            onOpenTloSync={() => setShowTloModal(true)}
            onOpenNewBill={() => setShowNewBillModal(true)}
            refreshSignal={refreshSignal}
            onDataMutated={triggerRefresh}
          />
        )}

        {activeView === 'research' && (
          <ResearchDeskView
            activeSession={activeSession}
            onOpenBill={handleOpenBill}
            onOpenPolitician={handleOpenPolitician}
            onOpenTloSync={() => setShowTloModal(true)}
          />
        )}

        {activeView === 'timeline' && (
          <TimelineView
            activeSession={activeSession}
            onOpenBill={handleOpenBill}
            refreshSignal={refreshSignal}
          />
        )}

        {activeView === 'politicians' && (
          <PoliticiansView
            selectedPoliticianId={selectedPoliticianId}
            onSelectPolitician={setSelectedPoliticianId}
            onOpenBill={handleOpenBill}
            onInspectInNetwork={handleInspectInNetwork}
            activeSession={activeSession}
            onDataMutated={triggerRefresh}
          />
        )}

        {activeView === 'network' && (
          <NetworkMapView
            activeSession={activeSession}
            focusEntityId={networkFocusId}
            onClearFocus={() => setNetworkFocusId('')}
            onOpenBill={handleOpenBill}
            onOpenPolitician={handleOpenPolitician}
            refreshSignal={refreshSignal}
          />
        )}

        {activeView === 'amendments' && (
          <AmendmentsView
            activeSession={activeSession}
            onOpenBill={handleOpenBill}
          />
        )}

        {activeView === 'alerts' && (
          <AlertsView
            onNewRule={() => setShowNewAlertModal(true)}
            onOpenBill={handleOpenBill}
            refreshSignal={refreshSignal}
            onAlertsUpdated={triggerRefresh}
          />
        )}

        {activeView === 'receptivity' && (
          <ReceptivityView
            onOpenBill={handleOpenBill}
            onOpenPolitician={handleOpenPolitician}
            refreshSignal={refreshSignal}
            onDataMutated={triggerRefresh}
          />
        )}

        {activeView === 'statutes' && (
          <StatutesView
            onOpenBill={handleOpenBill}
            refreshSignal={refreshSignal}
            onDataMutated={triggerRefresh}
          />
        )}

        {activeView === 'rules' && (
          <AgencyRulesView
            selectedRuleId={selectedRuleId}
            onSelectRule={setSelectedRuleId}
            onOpenBill={handleOpenBill}
            refreshSignal={refreshSignal}
            onDataMutated={triggerRefresh}
          />
        )}

        {activeView === 'platforms' && (
          <PlatformsView
            activeSession={activeSession}
            onOpenBill={handleOpenBill}
            onOpenRule={handleOpenRule}
            refreshSignal={refreshSignal}
            onDataMutated={triggerRefresh}
          />
        )}
      </main>

      <footer className="border-t border-[#DFD9CE] bg-[#F4F0E8]/40 mt-10">
        <div className="max-w-[1440px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4 text-xs text-[#78716C]">
          <span>
            Texas Capitol Ledger · Deterministic SQLite FTS5 Keyword Index & TLO FTP Archive (ftp://ftp.legis.state.tx.us)
          </span>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setShowShortcutsModal(true)}
              className="text-[#57534E] hover:text-[#181715] inline-flex items-center gap-1.5 cursor-pointer"
            >
              <span>Shortcuts</span>
              <kbd className="px-1.5 py-0.5 font-mono text-[10px] bg-[#FFFFFF] border border-[#C5BDB0] rounded text-[#181715]">
                ?
              </kbd>
            </button>
            <button
              type="button"
              onClick={() => setShowTloModal(true)}
              className="text-[#9A3412] hover:underline font-medium cursor-pointer"
            >
              Sync Historical Sessions (71R–90R)
            </button>
          </div>
        </div>
      </footer>

      <ShortcutsModal
        isOpen={showShortcutsModal}
        onClose={() => setShowShortcutsModal(false)}
      />

      <TloSyncModal
        isOpen={showTloModal}
        onClose={() => setShowTloModal(false)}
        onSyncComplete={triggerRefresh}
      />

      <NewBillModal
        isOpen={showNewBillModal}
        onClose={() => setShowNewBillModal(false)}
        defaultSession={activeSession || '90R'}
        onCreated={(billId) => {
          setSelectedBillId(billId);
          triggerRefresh();
        }}
      />

      <NewAlertModal
        isOpen={showNewAlertModal}
        onClose={() => setShowNewAlertModal(false)}
        onCreated={() => {
          triggerRefresh();
          setActiveView('alerts');
        }}
      />
    </div>
  );
}
