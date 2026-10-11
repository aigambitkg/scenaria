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

const GLYPH: Record<string, string> = { mission: "◎", goal: "◉", decision: "◇", checkpoint: "■", branch: "⑂", autosave: "↺" };

type ScData = {
  placed: Placed;
  onPath: boolean;
  isHead: boolean;
  t: Dict;
  fileCount?: number;
  onToggleFold?: (id: string) => void;
  containsHead?: boolean;
};

/** Missing context/rationale is the most common quality gap — show it on the map. */
export function qualityFlag(n: ScenariaNode, t: Dict): { cls: string; text: string } | null {
  if (n.type !== "decision") return null;
  if (n.chosen && !n.rationale) return { cls: "q-bad", text: t.missingRationale };
  if (!n.context && !n.trigger) return { cls: "q-warn", text: t.missingContext };
  if (!n.servesGoal) return { cls: "q-info", text: t.missingGoalLink };
  return null;
}

const ScNode = memo(({ data, selected }: NodeProps<Node<ScData>>) => {
  const { placed, onPath, isHead, t } = data;
  if (placed.kind === "ghost") {
    const g = placed.ghost!;
    return (
      <div className={`sc-node ghost ${g.chosen ? "chosen" : ""} ${selected ? "is-sel" : ""}`} title={g.chosen ? t.ghostChosenHint : t.ghostHint}>
        <Handle type="target" position={Position.Left} isConnectable={false} />
        <div className="sc-node-row">
          <span className="glyph">○</span>
          <span className="sc-kind">{g.chosen ? t.ghostChosen : t.types.ghost}</span>
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
  } else if (placed.folded) sub = `${placed.folded.steps} ${t.steps} · ${placed.folded.decisions} ${t.decisionsShort}${placed.folded.failed ? ` · ${placed.folded.failed} ✘` : ""}`;
  else if (n.changedFiles?.length) sub = `${n.changedFiles.length} ${n.changedFiles.length === 1 ? t.file : t.files}`;
  else if (n.type === "mission") sub = n.goal ?? t.goalMissing;
  else if (n.type === "goal" && n.goal && n.goal !== n.title) sub = n.goal;
  const via = n.type !== "branch" ? placed.edgeLabel : undefined;
  const q = qualityFlag(n, t);
  const canFold = n.type === "goal" && data.onToggleFold;
  return (
    <div
      className={`sc-node t-${n.type} v-${v} ${onPath ? "on-path" : ""} ${isHead ? "is-head" : ""} ${selected ? "is-sel" : ""} ${placed.folded ? "is-folded" : ""} ${n.type === "mission" && !n.goal ? "no-goal" : ""} ${n.status ? `st-${n.status}` : ""}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {isHead && <span className="head-tab">{t.head}</span>}
      {!isHead && data.containsHead && <span className="head-tab inside">{t.head} ▸</span>}
      {q && <span className={`q-flag ${q.cls}`} title={q.text}>{q.cls === "q-bad" ? "!" : "?"}</span>}
      {canFold && (
        <button
          className="fold nodrag nopan"
          title={placed.folded ? t.expand : t.collapse}
          aria-label={placed.folded ? t.expand : t.collapse}
          onClick={(e) => {
            e.stopPropagation();
            data.onToggleFold!(n.id);
          }}
        >
          {placed.folded ? "+" : "−"}
        </button>
      )}
      <div className="sc-node-row">
        <NodeId id={n.id} />
        <span className="glyph" aria-hidden>
          {GLYPH[n.type]}
        </span>
        {via ? <span className="sc-kind via" title={t.types[n.type]}>↳ {via}</span> : <span className="sc-kind">{t.types[n.type]}</span>}
        {n.scenarioId && <span className="vlabel">{n.scenarioId}/v{n.version}</span>}
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
  rootId: string;
  headId: string | null;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  folded: Set<string>;
  onToggleFold: (id: string) => void;
  t: Dict;
}) {
  const { nodes, rootId, headId, selectedKey, onSelect, folded, onToggleFold, t } = props;
  const { flowNodes, flowEdges, shape, focus } = useMemo(() => {
    const { placed, maxDepth, rows } = layoutTree(nodes, rootId, folded);
    const onPath = pathIds(nodes, headId);
    const visible = new Set(placed.map((p) => p.key));
    const flowNodes: Node[] = placed.map((p) => ({
      id: p.key,
      type: "sc",
      position: { x: p.x, y: p.y },
      data: {
        placed: p,
        onPath: p.kind === "node" && onPath.has(p.key),
        isHead: p.key === headId,
        t,
        onToggleFold,
        containsHead: Boolean(p.folded && headId && !visible.has(headId) && onPath.has(p.key)),
      } satisfies ScData,
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
    return { flowNodes, flowEdges, shape: `${rootId}:${placed.length}:${headId}`, focus };
  }, [nodes, rootId, headId, selectedKey, t, folded, onToggleFold]);

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
