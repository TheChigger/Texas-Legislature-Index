import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, ArrowUpRight } from 'lucide-react';
import type { NetworkEdge, NetworkGraph, NetworkLayer, NetworkNode } from '../types.ts';

interface NetworkMapViewProps {
  activeSession: string;
  focusEntityId: string;
  onClearFocus: () => void;
  onOpenBill: (billId: string) => void;
  onOpenPolitician: (polId: string) => void;
  refreshSignal: number;
}

interface SimNode extends NetworkNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const LAYER_META: Array<{ id: NetworkLayer; label: string; color: string; dashed?: boolean }> = [
  { id: 'money', label: 'Donor & PAC Money Flows', color: '#9A3412' },
  { id: 'lineage', label: 'Co-Sponsorship & Bill Lineage', color: '#1E3A5F' },
  { id: 'committee', label: 'Committee & Chair Clusters', color: '#14532D' },
  { id: 'keyword', label: 'Cross-Bill Keyword Overlap', color: '#78716C', dashed: true },
  { id: 'public', label: 'Public Testimony & Outreach', color: '#92400E' },
];

export const NetworkMapView: React.FC<NetworkMapViewProps> = ({
  activeSession,
  focusEntityId,
  onClearFocus,
  onOpenBill,
  onOpenPolitician,
  refreshSignal,
}) => {
  const [graph, setGraph] = useState<NetworkGraph | null>(null);
  const [layers, setLayers] = useState<Record<NetworkLayer, boolean>>({
    money: true,
    lineage: true,
    committee: true,
    keyword: true,
    public: true,
  });
  const [minContribution, setMinContribution] = useState(0);
  const [minOverlap, setMinOverlap] = useState(3);
  const [selectedNodeId, setSelectedNodeId] = useState<string>(focusEntityId || '');
  const [hopDepth, setHopDepth] = useState<'all' | '1' | '2'>(focusEntityId ? '1' : 'all');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const dragRef = useRef<{
    type: 'none' | 'pan' | 'node';
    nodeId?: string;
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
  }>({ type: 'none', startX: 0, startY: 0, origPanX: 0, origPanY: 0 });

  useEffect(() => {
    if (focusEntityId) {
      setSelectedNodeId(focusEntityId);
      setHopDepth('1');
    }
  }, [focusEntityId]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (activeSession) params.set('session', activeSession);
    params.set('minContribution', String(minContribution));
    params.set('minOverlap', String(minOverlap));

    fetch(`/api/network?${params.toString()}`)
      .then((r) => r.json())
      .then((data: NetworkGraph) => setGraph(data))
      .catch(() => {});
  }, [activeSession, minContribution, minOverlap, refreshSignal]);

  // Filter visible edges & nodes by active layers and optional ego-network hop depth
  const visible = useMemo(() => {
    if (!graph) return { nodes: [] as NetworkNode[], edges: [] as NetworkEdge[] };

    const activeEdges = graph.edges.filter((e) => layers[e.layer]);

    if (!selectedNodeId || hopDepth === 'all') {
      const connectedIds = new Set<string>();
      for (const e of activeEdges) {
        connectedIds.add(e.source);
        connectedIds.add(e.target);
      }
      const nodes = graph.nodes.filter((n) => connectedIds.has(n.id) || n.id === selectedNodeId);
      return { nodes, edges: activeEdges };
    }

    const maxHops = hopDepth === '1' ? 1 : 2;
    const reachable = new Set<string>([selectedNodeId]);
    let frontier = new Set<string>([selectedNodeId]);

    for (let h = 0; h < maxHops; h++) {
      const next = new Set<string>();
      for (const e of activeEdges) {
        if (frontier.has(e.source) && !reachable.has(e.target)) next.add(e.target);
        if (frontier.has(e.target) && !reachable.has(e.source)) next.add(e.source);
      }
      for (const id of next) reachable.add(id);
      frontier = next;
    }

    const filteredEdges = activeEdges.filter(
      (e) => reachable.has(e.source) && reachable.has(e.target)
    );
    const filteredNodes = graph.nodes.filter((n) => reachable.has(n.id));
    return { nodes: filteredNodes, edges: filteredEdges };
  }, [graph, layers, selectedNodeId, hopDepth]);

  // Initialize deterministic clustered positions when visible graph changes
  useEffect(() => {
    const width = 920;
    const height = 620;
    const prevMap = new Map(simNodesRef.current.map((n) => [n.id, n]));

    const kindAngles: Record<NetworkNode['kind'], number> = {
      donor: -Math.PI * 0.75,
      politician: -Math.PI * 0.25,
      committee: Math.PI * 0.25,
      bill: Math.PI * 0.75,
      public_bloc: Math.PI * 0.5,
    };

    const nextSim: SimNode[] = visible.nodes.map((n, i) => {
      const existing = prevMap.get(n.id);
      if (existing) {
        return { ...n, x: existing.x, y: existing.y, vx: 0, vy: 0 };
      }
      const baseAngle = kindAngles[n.kind] + (i % 11) * 0.22;
      const r = 140 + (i % 5) * 32;
      return {
        ...n,
        x: width / 2 + Math.cos(baseAngle) * r,
        y: height / 2 + Math.sin(baseAngle) * r,
        vx: 0,
        vy: 0,
      };
    });
    simNodesRef.current = nextSim;
  }, [visible.nodes]);

  // Force simulation & Canvas render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    let tick = 0;

    const renderFrame = () => {
      const nodes = simNodesRef.current;
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const w = canvas.width;
      const h = canvas.height;

      // Run light settling physics for the first 180 frames
      if (tick < 180 && nodes.length > 0) {
        const kRepel = 2600;
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          // Gentle center pull
          a.vx += (w / 2 - a.x) * 0.0025;
          a.vy += (h / 2 - a.y) * 0.0025;

          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const distSq = dx * dx + dy * dy + 40;
            const force = kRepel / distSq;
            const dist = Math.sqrt(distSq);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
          }
        }

        for (const e of visible.edges) {
          const s = nodeById.get(e.source);
          const t = nodeById.get(e.target);
          if (!s || !t) continue;
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const targetLen = e.layer === 'keyword' ? 145 : 115;
          const spring = (dist - targetLen) * 0.014;
          const fx = (dx / dist) * spring;
          const fy = (dy / dist) * spring;
          s.vx += fx;
          s.vy += fy;
          t.vx -= fx;
          t.vy -= fy;
        }

        for (const n of nodes) {
          if (dragRef.current.type === 'node' && dragRef.current.nodeId === n.id) continue;
          n.vx *= 0.82;
          n.vy *= 0.82;
          n.x = Math.max(45, Math.min(w - 45, n.x + n.vx));
          n.y = Math.max(45, Math.min(h - 45, n.y + n.vy));
        }
        tick++;
      }

      // Draw Broadsheet Paper Canvas
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#FBF9F5';
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.translate(w / 2 + pan.x, h / 2 + pan.y);
      ctx.scale(zoom, zoom);
      ctx.translate(-w / 2, -h / 2);

      // Draw Edges
      for (const e of visible.edges) {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        if (!s || !t) continue;

        const isHighlighted =
          selectedNodeId && (e.source === selectedNodeId || e.target === selectedNodeId);
        const dimOthers = Boolean(selectedNodeId) && !isHighlighted;

        ctx.save();
        ctx.globalAlpha = dimOthers ? 0.14 : isHighlighted ? 0.92 : 0.45;
        ctx.lineWidth = isHighlighted ? Math.max(1.8, e.weight * 0.7) : Math.max(1, e.weight * 0.45);
        if (e.layer === 'money') ctx.strokeStyle = '#9A3412';
        else if (e.layer === 'lineage') ctx.strokeStyle = '#1E3A5F';
        else if (e.layer === 'committee') ctx.strokeStyle = '#14532D';
        else if (e.layer === 'public') ctx.strokeStyle = '#92400E';
        else {
          ctx.strokeStyle = '#78716C';
          ctx.setLineDash([4, 4]);
        }

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();

        if (isHighlighted && e.label) {
          ctx.setLineDash([]);
          ctx.fillStyle = '#181715';
          ctx.font = '500 9px "Roboto Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(e.label, (s.x + t.x) / 2, (s.y + t.y) / 2 - 4);
        }
        ctx.restore();
      }

      // Draw Nodes
      for (const n of nodes) {
        const isSelected = n.id === selectedNodeId;
        const isConnected =
          !selectedNodeId ||
          isSelected ||
          visible.edges.some(
            (e) =>
              (e.source === selectedNodeId && e.target === n.id) ||
              (e.target === selectedNodeId && e.source === n.id)
          );

        const radius = isSelected ? 11 : n.kind === 'committee' ? 9 : 8;
        ctx.save();
        ctx.globalAlpha = isConnected ? 1 : 0.25;

        if (n.kind === 'donor') {
          // Diamond shape for PAC / Donor
          ctx.beginPath();
          ctx.moveTo(n.x, n.y - radius - 2);
          ctx.lineTo(n.x + radius + 2, n.y);
          ctx.lineTo(n.x, n.y + radius + 2);
          ctx.lineTo(n.x - radius - 2, n.y);
          ctx.closePath();
          ctx.fillStyle = '#F4F0E8';
          ctx.fill();
          ctx.lineWidth = isSelected ? 2.5 : 1.5;
          ctx.strokeStyle = '#9A3412';
          ctx.stroke();
        } else if (n.kind === 'bill') {
          // Crisp rectangular document node for Bills
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(n.x - radius, n.y - radius * 0.8, radius * 2, radius * 1.6);
          ctx.lineWidth = isSelected ? 2.5 : 1.5;
          ctx.strokeStyle = '#1E3A5F';
          ctx.strokeRect(n.x - radius, n.y - radius * 0.8, radius * 2, radius * 1.6);
        } else if (n.kind === 'committee') {
          // Hexagon for Committees
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const ang = (Math.PI / 3) * k;
            const px = n.x + Math.cos(ang) * (radius + 1);
            const py = n.y + Math.sin(ang) * (radius + 1);
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = '#DCFCE7';
          ctx.fill();
          ctx.lineWidth = isSelected ? 2.5 : 1.5;
          ctx.strokeStyle = '#14532D';
          ctx.stroke();
        } else if (n.kind === 'public_bloc') {
          // Upward triangle for Public Witness & Constituent Blocs
          ctx.beginPath();
          ctx.moveTo(n.x, n.y - radius - 2);
          ctx.lineTo(n.x + radius + 2, n.y + radius);
          ctx.lineTo(n.x - radius - 2, n.y + radius);
          ctx.closePath();
          ctx.fillStyle = '#FEF3C7';
          ctx.fill();
          ctx.lineWidth = isSelected ? 2.5 : 1.5;
          ctx.strokeStyle = '#92400E';
          ctx.stroke();
        } else {
          // Circle for Politicians
          ctx.beginPath();
          ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = n.party === 'D' ? '#1E3A5F' : '#181715';
          ctx.fill();
          if (isSelected) {
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#9A3412';
            ctx.stroke();
          }
        }

        // Crisp ink label
        ctx.fillStyle = '#181715';
        ctx.font = isSelected ? '700 11px "Roboto", sans-serif' : '500 10px "Roboto", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + radius + 13);
        ctx.restore();
      }

      ctx.restore();
      animId = requestAnimationFrame(renderFrame);
    };

    animId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(animId);
  }, [visible, selectedNodeId, zoom, pan]);

  const screenToWorld = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const sx = (clientX - rect.left) * scaleX;
    const sy = (clientY - rect.top) * scaleY;
    const w = canvas.width;
    const h = canvas.height;
    return {
      x: (sx - w / 2 - pan.x) / zoom + w / 2,
      y: (sy - h / 2 - pan.y) / zoom + h / 2,
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pt = screenToWorld(e.clientX, e.clientY);
    const hit = simNodesRef.current.find((n) => {
      const dx = n.x - pt.x;
      const dy = n.y - pt.y;
      return dx * dx + dy * dy <= 16 * 16;
    });
    if (hit) {
      setSelectedNodeId(hit.id);
      dragRef.current = {
        type: 'node',
        nodeId: hit.id,
        startX: e.clientX,
        startY: e.clientY,
        origPanX: pan.x,
        origPanY: pan.y,
      };
    } else {
      dragRef.current = {
        type: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        origPanX: pan.x,
        origPanY: pan.y,
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current.type === 'pan') {
      setPan({
        x: dragRef.current.origPanX + (e.clientX - dragRef.current.startX),
        y: dragRef.current.origPanY + (e.clientY - dragRef.current.startY),
      });
    } else if (dragRef.current.type === 'node' && dragRef.current.nodeId) {
      const pt = screenToWorld(e.clientX, e.clientY);
      const node = simNodesRef.current.find((n) => n.id === dragRef.current.nodeId);
      if (node) {
        node.x = pt.x;
        node.y = pt.y;
      }
    }
  };

  const handleMouseUp = () => {
    dragRef.current.type = 'none';
  };

  const selectedNode = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph, selectedNodeId]
  );

  const selectedConnections = useMemo(() => {
    if (!selectedNode) return [];
    const nodeById = new Map(graph?.nodes.map((n) => [n.id, n]) ?? []);
    return visible.edges
      .filter((e) => e.source === selectedNode.id || e.target === selectedNode.id)
      .map((e) => {
        const otherId = e.source === selectedNode.id ? e.target : e.source;
        return { edge: e, other: nodeById.get(otherId) };
      });
  }, [selectedNode, visible.edges, graph]);

  return (
    <div className="space-y-4">
      {/* Controls Bar */}
      <div className="border border-[#DFD9CE] bg-[#F4F0E8] p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          {LAYER_META.map((layer) => (
            <label
              key={layer.id}
              className="inline-flex items-center gap-2 text-xs font-medium text-[#181715] cursor-pointer"
            >
              <input
                type="checkbox"
                checked={layers[layer.id]}
                onChange={(e) =>
                  setLayers((prev) => ({ ...prev, [layer.id]: e.target.checked }))
                }
                className="w-3.5 h-3.5 accent-[#9A3412]"
              />
              <span
                className="inline-block w-4 h-0.5"
                style={{
                  backgroundColor: layer.dashed ? 'transparent' : layer.color,
                  borderTop: layer.dashed ? `2px dashed ${layer.color}` : 'none',
                }}
              />
              <span>{layer.label}</span>
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <select
            value={selectedNodeId}
            onChange={(e) => {
              setSelectedNodeId(e.target.value);
              if (!e.target.value) {
                setHopDepth('all');
                onClearFocus();
              } else if (hopDepth === 'all') {
                setHopDepth('1');
              }
            }}
            className="px-2.5 py-1.5 bg-[#FFFFFF] border border-[#C5BDB0] rounded text-xs max-w-[220px]"
          >
            <option value="">All Entities ({graph?.nodes.length ?? 0})</option>
            {graph?.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                [{n.kind.toUpperCase()}] {n.label}
              </option>
            ))}
          </select>

          <div className="inline-flex border border-[#C5BDB0] bg-[#FFFFFF] rounded overflow-hidden">
            {[
              { id: 'all', label: 'Full Map' },
              { id: '1', label: '1-Hop' },
              { id: '2', label: '2-Hop' },
            ].map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => setHopDepth(h.id as typeof hopDepth)}
                disabled={!selectedNodeId && h.id !== 'all'}
                className={`px-2.5 py-1 text-xs cursor-pointer disabled:opacity-40 ${
                  hopDepth === h.id ? 'bg-[#181715] text-[#FBF9F5]' : 'text-[#57534E]'
                }`}
              >
                {h.label}
              </button>
            ))}
          </div>

          <label className="inline-flex items-center gap-1.5 text-[#57534E] font-mono tabular-nums">
            <span>Min PAC $</span>
            <input
              type="range"
              min={0}
              max={150000}
              step={25000}
              value={minContribution}
              onChange={(e) => setMinContribution(Number(e.target.value))}
              className="w-20 accent-[#9A3412]"
            />
            <span>${(minContribution / 1000).toFixed(0)}k</span>
          </label>

          <label className="inline-flex items-center gap-1.5 text-[#57534E] font-mono tabular-nums">
            <span>Min Terms</span>
            <input
              type="range"
              min={2}
              max={6}
              step={1}
              value={minOverlap}
              onChange={(e) => setMinOverlap(Number(e.target.value))}
              className="w-16 accent-[#1E3A5F]"
            />
            <span>{minOverlap}</span>
          </label>
        </div>
      </div>

      {/* Canvas + Inspector Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 border border-[#DFD9CE] bg-[#FBF9F5] relative">
          <div className="px-4 py-2 border-b border-[#DFD9CE] bg-[#FFFFFF] flex items-center justify-between text-xs font-mono text-[#57534E] tabular-nums">
            <span>
              {visible.nodes.length} nodes · {visible.edges.length} connections (drag nodes to rearrange, click to inspect)
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(2.2, z + 0.2))}
                className="p-1 hover:text-[#181715] cursor-pointer"
                aria-label="Zoom in"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.2))}
                className="p-1 hover:text-[#181715] cursor-pointer"
                aria-label="Zoom out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                  setSelectedNodeId('');
                  setHopDepth('all');
                  onClearFocus();
                }}
                className="p-1 hover:text-[#181715] cursor-pointer"
                aria-label="Reset network view"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>

          <canvas
            ref={canvasRef}
            width={920}
            height={620}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            className="w-full h-[560px] block cursor-grab active:cursor-grabbing"
          />

          <div className="px-4 py-2 border-t border-[#DFD9CE] bg-[#FFFFFF] flex flex-wrap items-center gap-4 text-[11px] font-mono text-[#57534E]">
            <span>Shapes: ● Politician (Black R / Lapis D)</span>
            <span>■ Bill</span>
            <span>◆ PAC / Donor</span>
            <span>⬡ Committee</span>
            <span>▲ Public Testimony / Constituent Bloc</span>
          </div>
        </div>

        {/* Right Node Inspector */}
        <div className="lg:col-span-4 border border-[#DFD9CE] bg-[#FFFFFF]">
          <div className="px-4 py-3 border-b border-[#DFD9CE] bg-[#F4F0E8] text-xs font-medium text-[#181715]">
            Network Node Inspector
          </div>

          {!selectedNode ? (
            <div className="p-6 text-xs text-[#57534E] space-y-3">
              <p>
                Click any Legislator, Bill, PAC Donor, Committee, or Public Testimony Bloc on the network canvas to inspect its multi-layer connections.
              </p>
              {graph && (
                <div className="pt-3 border-t border-[#DFD9CE] space-y-1.5 font-mono tabular-nums">
                  <div>Donor Money Edges: {graph.stats.moneyEdges}</div>
                  <div>Bill & Sponsorship Edges: {graph.stats.lineageEdges}</div>
                  <div>Committee Gatekeeping Edges: {graph.stats.committeeEdges}</div>
                  <div>Keyword Overlap Edges: {graph.stats.keywordEdges}</div>
                  <div>Public Testimony Edges: {graph.stats.publicEdges}</div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 space-y-4">
              <div>
                <div className="text-[11px] font-mono uppercase text-[#9A3412]">
                  {selectedNode.kind === 'public_bloc' ? 'Public Testimony Bloc' : selectedNode.kind}
                </div>
                <h3 className="font-display text-lg font-bold text-[#181715] mt-0.5">
                  {selectedNode.label}
                </h3>
                <p className="text-xs text-[#57534E] mt-1">{selectedNode.subtitle}</p>

                <div className="mt-3 flex flex-wrap gap-2">
                  {(selectedNode.kind === 'bill' || selectedNode.kind === 'public_bloc') && (
                    <button
                      type="button"
                      onClick={() => onOpenBill(selectedNode.entityId)}
                      className="px-3 py-1.5 text-xs font-medium bg-[#181715] text-[#FBF9F5] rounded inline-flex items-center gap-1 cursor-pointer"
                    >
                      Open Bill Dossier <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {selectedNode.kind === 'politician' && (
                    <button
                      type="button"
                      onClick={() => onOpenPolitician(selectedNode.entityId)}
                      className="px-3 py-1.5 text-xs font-medium bg-[#181715] text-[#FBF9F5] rounded inline-flex items-center gap-1 cursor-pointer"
                    >
                      Open Politician Profile <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="border-t border-[#DFD9CE] pt-3">
                <div className="text-xs font-mono text-[#57534E] mb-2 tabular-nums">
                  Connected Edges ({selectedConnections.length})
                </div>
                <div className="divide-y divide-[#F4F0E8] max-h-96 overflow-y-auto">
                  {selectedConnections.map(({ edge, other }) => (
                    <button
                      key={edge.id}
                      type="button"
                      onClick={() => other && setSelectedNodeId(other.id)}
                      className="w-full py-2 text-left hover:bg-[#FBF9F5] cursor-pointer block"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-[#181715] truncate">
                          {other?.label ?? edge.target}
                        </span>
                        <span className="font-mono text-[#9A3412] shrink-0">{edge.label}</span>
                      </div>
                      {edge.meta && (
                        <div className="text-[11px] text-[#78716C] truncate">{edge.meta}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
