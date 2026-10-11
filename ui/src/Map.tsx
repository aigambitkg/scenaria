import { memo, useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getStraightPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { ScenariaNode } from "./api";
import type { Dict } from "./i18n";
import { COL, NODE_H, NODE_W, ROW, layoutTree, pathIds, type Placed } from "./layout";

export function NodeId({ id, big }: { id: string; big?: boolean }) {
  const m = id.match(/^([a-z]+)(\d+)$/i);
  return (
    <span className={big ? "nid nid-big" : "nid"} aria-label={id}>
      {m ? (
        <>
          <i>{m[1]}</i>
          {m[2]}
        </>
      ) : (
        id
      )}
    </span>
  );
}

const GLYPH: Record<string, string> = { mission: "◎", decision: "◇", checkpoint: "■", branch: "⑂", autosave: "↺" };

type ScData = {
  placed: Placed;
  onPath: boolean;
  isHead: boolean;
  t: Dict;
  fileCount?: number;
};

const ScNode = memo(({ data, selected }: NodeProps<Node<ScData>>) => {
  const { placed, onPath, isHead, t } = data;
  if (placed.kind === "ghost") {
    const g = placed.ghost!;
    return (
      <div className={`sc-node ghost ${selected ? "is-sel" : ""}`} title={t.ghostHint}>
        <Handle type="target" position={Position.Left} isConnectable={false} />
        <div className="sc-node-row">
          <span className="glyph">○</span>
          <span className="sc-kind">{t.types.ghost}</span>
        </div>
        <div className="sc-title">{g.label}</div>
      </div>
    );
  }
  const n = placed.node!;
  const v = n.verification?.status ?? "unverified";
  let sub = "";
  if (n.type === "decision") {
    const chosen = n.options?.find((o) => o.id === n.chosen)?.label;
    sub = chosen ? `→ ${chosen}` : "→ …";
  } else if (n.changedFiles?.length) sub = `${n.changedFiles.length} ${n.changedFiles.length === 1 ? t.file : t.files}`;
  else if (n.type === "mission" && n.goal) sub = n.goal;
  const via = n.type !== "branch" ? placed.edgeLabel : undefined;
  return (
    <div className={`sc-node t-${n.type} v-${v} ${onPath ? "on-path" : ""} ${isHead ? "is-head" : ""} ${selected ? "is-sel" : ""}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {isHead && <span className="head-tab">{t.head}</span>}
      <div className="sc-node-row">
        <NodeId id={n.id} />
        <span className="glyph" aria-hidden>
          {GLYPH[n.type]}
        </span>
        {via ? <span className="sc-kind via" title={t.types[n.type]}>↳ {via}</span> : <span className="sc-kind">{t.types[n.type]}</span>}
        <span className={`vdot v-${v}`} title={t.verification[v]} />
      </div>
      <div className="sc-title">{n.type === "decision" ? n.question ?? n.title : n.title}</div>
      {sub && <div className="sc-sub">{sub}</div>}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

type AxisData = { steps: number };
const AxisNode = memo(({ data }: NodeProps<Node<AxisData>>) => (
  <div className="axis" style={{ width: data.steps * COL + NODE_W }}>
    <div className="axis-line" />
    {Array.from({ length: data.steps + 1 }, (_, i) => (
      <div key={i} className="axis-tick" style={{ left: i * COL + NODE_W / 2 }}>
        <span className="axis-label">
          <i>t</i>
          <sub>{i + 1}</sub>
        </span>
      </div>
    ))}
  </div>
));

type EdgeData = { onPath: boolean; ghost: boolean; label?: string };
function ScEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<EdgeData>>) {
  const [path, lx, ly] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const labelX = sourceX + (targetX - sourceX) * 0.58;
  const labelY = sourceY + (targetY - sourceY) * 0.58;
  void lx;
  void ly;
  return (
    <>
      {data?.onPath && <path d={path} className="edge-marker" />}
      <BaseEdge id={id} path={path} className={`edge ${data?.ghost ? "edge-ghost" : ""} ${data?.onPath ? "edge-on" : ""}`} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div className={`edge-label ${data.onPath ? "on" : ""}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { sc: ScNode, axis: AxisNode };
const edgeTypes = { sc: ScEdge };

/** Fit the whole tree; if that gets unreadably small, focus the active timeline around HEAD. */
function FitOnChange({ k, focus }: { k: string; focus: string[] }) {
  const rf = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(async () => {
      await rf.fitView({ padding: 0.12, maxZoom: 1.05 });
      if (rf.getZoom() < 0.78 && focus.length) {
        await rf.fitView({ nodes: focus.map((id) => ({ id })), padding: 0.2, maxZoom: 1.05, minZoom: 0.6, duration: 250 });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [k, rf]);
  return null;
}

export function ScenarioMap(props: {
  nodes: ScenariaNode[];
  missionId: string;
  headId: string | null;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  t: Dict;
}) {
  const { nodes, missionId, headId, selectedKey, onSelect, t } = props;
  const { flowNodes, flowEdges, shape, focus } = useMemo(() => {
    const { placed, maxDepth, rows } = layoutTree(nodes, missionId);
    const onPath = pathIds(nodes, headId);
    const flowNodes: Node[] = placed.map((p) => ({
      id: p.key,
      type: "sc",
      position: { x: p.x, y: p.y },
      data: { placed: p, onPath: p.kind === "node" && onPath.has(p.key), isHead: p.key === headId, t } satisfies ScData,
      draggable: false,
      connectable: false,
      selected: p.key === selectedKey,
      width: NODE_W,
      height: NODE_H,
    }));
    if (placed.length) {
      flowNodes.push({
        id: "__axis",
        type: "axis",
        position: { x: 0, y: rows * ROW + 6 },
        data: { steps: maxDepth } satisfies AxisData,
        draggable: false,
        selectable: false,
        focusable: false,
        connectable: false,
      });
    }
    const flowEdges: Edge[] = placed
      .filter((p) => p.parentKey)
      .map((p) => ({
        id: `e:${p.parentKey}->${p.key}`,
        source: p.parentKey!,
        target: p.key,
        type: "sc",
        selectable: false,
        focusable: false,
        data: {
          onPath: p.kind === "node" && onPath.has(p.key) && onPath.has(p.parentKey!),
          ghost: p.kind === "ghost" || p.node?.type === "autosave",
        } satisfies EdgeData,
      }));
    const head = placed.find((p) => p.key === headId) ?? placed[0];
    const minDepth = head ? Math.max(0, head.depth - 3) : 0;
    const focus = placed
      .filter((p) => p.depth >= minDepth && p.depth <= (head?.depth ?? 0) + 1)
      .map((p) => p.key);
    return { flowNodes, flowEdges, shape: `${missionId}:${placed.length}:${headId}`, focus };
  }, [nodes, missionId, headId, selectedKey, t]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => n.id !== "__axis" && onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      fitView
    >
      <Background id="minor" variant={BackgroundVariant.Lines} gap={20} lineWidth={1} className="grid-minor" />
      <Background id="major" variant={BackgroundVariant.Lines} gap={100} lineWidth={1} className="grid-major" />
      <Controls showInteractive={false} position="bottom-left" />
      <FitOnChange k={shape} focus={focus} />
    </ReactFlow>
  );
}
