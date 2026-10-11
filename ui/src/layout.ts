import type { ScenariaNode } from "./api";

export const COL = 236;
export const ROW = 92;
export const NODE_W = 184;
export const NODE_H = 68;

export interface Placed {
  key: string;
  kind: "node" | "ghost";
  node?: ScenariaNode;
  ghost?: { decision: ScenariaNode; optionId: string; label: string; chosen: boolean };
  parentKey: string | null;
  edgeLabel?: string;
  depth: number;
  x: number;
  y: number;
}

/**
 * Tidy horizontal tree, like a scenario tree: time runs left → right (depth),
 * leaves get their own row, parents sit centered over their children.
 * Options of a decision that no branch has taken appear as ghost leaves.
 */
export function layoutTree(all: ScenariaNode[], missionId: string) {
  const nodes = all.filter((n) => n.missionId === missionId);
  const byParent = new Map<string, ScenariaNode[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const l = byParent.get(n.parentId) ?? [];
    l.push(n);
    byParent.set(n.parentId, l);
  }
  const root = nodes.find((n) => n.id === missionId);
  const placed: Placed[] = [];
  if (!root) return { placed, maxDepth: 0, rows: 0 };

  let row = 0;
  let maxDepth = 0;

  const visit = (n: ScenariaNode, depth: number, parentKey: string | null, edgeLabel?: string): number => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = byParent.get(n.id) ?? [];
    type Item = { kind: "node"; node: ScenariaNode; label?: string } | { kind: "ghost"; optionId: string; label: string; chosen: boolean };
    const items: Item[] = [];
    if (n.type === "decision" && n.options?.length) {
      const taken = new Set(kids.map((k) => k.viaOption).filter(Boolean));
      for (const o of n.options) {
        const viaKids = kids.filter((k) => k.viaOption === o.id);
        for (const k of viaKids) items.push({ kind: "node", node: k, label: o.label });
        if (!taken.has(o.id)) items.push({ kind: "ghost", optionId: o.id, label: o.label, chosen: o.id === n.chosen });
      }
      for (const k of kids.filter((k) => !k.viaOption || !n.options!.some((o) => o.id === k.viaOption))) items.push({ kind: "node", node: k });
    } else {
      for (const k of kids) items.push({ kind: "node", node: k });
    }

    const me: Placed = { key: n.id, kind: "node", node: n, parentKey, edgeLabel, depth, x: depth * COL, y: 0 };
    placed.push(me);
    if (!items.length) {
      me.y = row++ * ROW;
      return me.y;
    }
    const ys: number[] = [];
    for (const it of items) {
      if (it.kind === "node") ys.push(visit(it.node, depth + 1, n.id, it.label));
      else {
        maxDepth = Math.max(maxDepth, depth + 1);
        const y = row++ * ROW;
        placed.push({
          key: `ghost:${n.id}:${it.optionId}`,
          kind: "ghost",
          ghost: { decision: n, optionId: it.optionId, label: it.label, chosen: it.chosen },
          parentKey: n.id,
          edgeLabel: undefined,
          depth: depth + 1,
          x: (depth + 1) * COL,
          y,
        });
        ys.push(y);
      }
    }
    me.y = (ys[0] + ys[ys.length - 1]) / 2;
    return me.y;
  };
  visit(root, 0, null);
  return { placed, maxDepth, rows: row };
}

export function pathIds(all: ScenariaNode[], headId: string | null): Set<string> {
  const byId = new Map(all.map((n) => [n.id, n]));
  const out = new Set<string>();
  let cur = headId ? byId.get(headId) : undefined;
  while (cur) {
    out.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}
