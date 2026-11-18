import { useEffect, useState } from 'react';
import { Header, type ActiveView } from './components/Header.tsx';
import { LegislationView } from './components/LegislationView.tsx';
import { PoliticiansView } from './components/PoliticiansView.tsx';
import { NetworkMapView } from './components/NetworkMapView.tsx';
import { AmendmentsView } from './components/AmendmentsView.tsx';
import { AlertsView } from './components/AlertsView.tsx';
import { ReceptivityView } from './components/ReceptivityView.tsx';
import { StatutesView } from './components/StatutesView.tsx';
import { TloSyncModal } from './components/TloSyncModal.tsx';
import { NewBillModal } from './components/NewBillModal.tsx';
import { NewAlertModal } from './components/NewAlertModal.tsx';
import type { OverviewResponse, PoliticianSummary } from './types.ts';

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('legislation');
  const [activeSession, setActiveSession] = useState<string>('');
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [selectedBillId, setSelectedBillId] = useState<string>('89R-HB2');
  const [selectedPoliticianId, setSelectedPoliticianId] = useState<string>('pol-buckley');
  const [networkFocusId, setNetworkFocusId] = useState<string>('');
  const [refreshSignal, setRefreshSignal] = useState<number>(0);

  const [showTloModal, setShowTloModal] = useState(false);
  const [showNewBillModal, setShowNewBillModal] = useState(false);
  const [showNewAlertModal, setShowNewAlertModal] = useState(false);

  const triggerRefresh = () => setRefreshSignal((n) => n + 1);

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
            onOpenTloSync={() => setShowTloModal(true)}
            onOpenNewBill={() => setShowNewBillModal(true)}
            refreshSignal={refreshSignal}
            onDataMutated={triggerRefresh}
          />
        )}

        {activeView === 'politicians' && (
          <PoliticiansView
            selectedPoliticianId={selectedPoliticianId}
            onSelectPolitician={setSelectedPoliticianId}
            onOpenBill={handleOpenBill}
            onInspectInNetwork={handleInspectInNetwork}
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
      </main>

      <footer className="border-t border-[#DFD9CE] bg-[#F4F0E8]/40 mt-10">
        <div className="max-w-[1440px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4 text-xs text-[#78716C]">
          <span>
            Texas Capitol Ledger · Deterministic SQLite FTS5 Keyword Index & TLO FTP Archive (ftp://ftp.legis.state.tx.us)
          </span>
          <button
            type="button"
            onClick={() => setShowTloModal(true)}
            className="text-[#9A3412] hover:underline font-medium cursor-pointer"
          >
            Sync Historical Sessions (71R–90R)
          </button>
        </div>
      </footer>

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
