/**
 * PipelineGraphView: node-graph projection of a pipeline.
 *
 * Stages render as vertical layers, steps as clickable nodes. Condition
 * branches are drawn as real edges: loop_to_stage as an amber back-edge on
 * the left lane, skip_next_stage as a dashed bypass on the right lane, stop
 * as a terminal badge. Clicking a node opens the existing StepConfigPanel.
 * Structural editing (add/remove stages & steps) stays in the List view.
 */

import type {
  Pipeline,
  PipelineStep,
  ConditionStepConfig,
} from '../../pipeline/types';
import { getStepIcon, getStepSummary } from './StageRow';
import './PipelineGraphView.css';

interface PipelineGraphViewProps {
  pipeline: Pipeline;
  selectedStepId: string | null;
  onStepSelect: (stepId: string) => void;
}

const NODE_W = 190;
const NODE_H = 92;
const INPUT_W = 150;
const INPUT_H = 40;
const H_GAP = 36;
const V_GAP = 76;
const SIDE_PAD = 96;
const TOP_PAD = 30;
const LANE_STEP = 16;
const BADGE_SPACE = 26;

interface GraphNode {
  step: PipelineStep | null; // null = empty-stage placeholder
  x: number;
  y: number;
}

interface GraphRow {
  stageId: string;
  label: string;
  mode: 'sequential' | 'parallel';
  y: number;
  nodes: GraphNode[];
}

interface GraphEdge {
  path: string;
  cls: 'flow' | 'chain' | 'loop' | 'skip';
  label?: string;
  lx?: number;
  ly?: number;
}

export default function PipelineGraphView({
  pipeline,
  selectedStepId,
  onStepSelect,
}: PipelineGraphViewProps) {
  const stages = pipeline.stages;

  // ---- Layout ----
  const rowWidth = (n: number) => Math.max(n, 1) * NODE_W + (Math.max(n, 1) - 1) * H_GAP;
  const canvasW =
    Math.max(INPUT_W, ...stages.map((s) => rowWidth(s.steps.length))) + SIDE_PAD * 2;

  const inputY = TOP_PAD;
  const stageY = (i: number) => inputY + INPUT_H + V_GAP + i * (NODE_H + V_GAP + BADGE_SPACE);

  const rows: GraphRow[] = stages.map((stage, i) => {
    const n = Math.max(stage.steps.length, 1);
    const startX = (canvasW - rowWidth(n)) / 2;
    const y = stageY(i);
    const nodes: GraphNode[] =
      stage.steps.length > 0
        ? stage.steps.map((step, j) => ({ step, x: startX + j * (NODE_W + H_GAP), y }))
        : [{ step: null, x: startX, y }];
    return {
      stageId: stage.id,
      label: `Stage ${i + 1} · ${stage.name}`,
      mode: stage.executionMode || 'sequential',
      y,
      nodes,
    };
  });

  const canvasH =
    (rows.length > 0 ? rows[rows.length - 1].y + NODE_H : inputY + INPUT_H) + BADGE_SPACE + TOP_PAD;

  // ---- Edges ----
  const edges: GraphEdge[] = [];
  const badges = new Map<string, string[]>(); // stepId -> badge texts
  let loopLane = 0;
  let skipLane = 0;

  const downEdge = (x1: number, y1: number, x2: number, y2: number): string =>
    `M ${x1} ${y1} C ${x1} ${y1 + (y2 - y1) / 2}, ${x2} ${y1 + (y2 - y1) / 2}, ${x2} ${y2 - 3}`;

  // Input node → stage 1 entry
  const inputX = (canvasW - INPUT_W) / 2;
  if (rows.length > 0) {
    const entry = rows[0].mode === 'sequential' ? [rows[0].nodes[0]] : rows[0].nodes;
    for (const t of entry) {
      edges.push({
        path: downEdge(inputX + INPUT_W / 2, inputY + INPUT_H, t.x + NODE_W / 2, t.y),
        cls: 'flow',
      });
    }
  }

  rows.forEach((row, i) => {
    // Stage-to-stage flow: every prior-stage step feeds this stage's entry node(s)
    if (i > 0) {
      const prev = rows[i - 1];
      const entry = row.mode === 'sequential' ? [row.nodes[0]] : row.nodes;
      for (const s of prev.nodes) {
        for (const t of entry) {
          edges.push({
            path: downEdge(s.x + NODE_W / 2, s.y + NODE_H, t.x + NODE_W / 2, t.y),
            cls: 'flow',
          });
        }
      }
    }

    // Sibling chain in sequential stages (execution order)
    if (row.mode === 'sequential') {
      for (let j = 1; j < row.nodes.length; j++) {
        const a = row.nodes[j - 1];
        const b = row.nodes[j];
        edges.push({
          path: `M ${a.x + NODE_W} ${a.y + NODE_H / 2} L ${b.x - 3} ${b.y + NODE_H / 2}`,
          cls: 'chain',
        });
      }
    }

    // Condition branches
    for (const node of row.nodes) {
      if (!node.step || node.step.config.type !== 'condition') continue;
      const cfg = node.step.config as ConditionStepConfig;
      const branches: { tag: 'T' | 'F'; action: ConditionStepConfig['trueAction'] }[] = [
        { tag: 'T', action: cfg.trueAction },
        { tag: 'F', action: cfg.falseAction },
      ];
      for (const { tag, action } of branches) {
        if (action === 'continue') continue;

        if (action === 'stop') {
          const list = badges.get(node.step.id) || [];
          list.push(`${tag} → stop`);
          badges.set(node.step.id, list);
        } else if (action === 'loop_to_stage') {
          const ti = stages.findIndex((s) => s.id === cfg.loopTargetStageId);
          const list = badges.get(node.step.id) || [];
          if (ti >= 0 && ti <= i) {
            const target = rows[ti].nodes[0];
            const laneX = 24 + loopLane * LANE_STEP;
            loopLane++;
            const sy = node.y + NODE_H / 2;
            const ty = target.y + NODE_H / 2;
            edges.push({
              path: `M ${node.x} ${sy} H ${laneX} V ${ty} H ${target.x - 3}`,
              cls: 'loop',
              label: `${tag} · loop ≤${cfg.maxLoops ?? 3}`,
              lx: laneX + 6,
              ly: (sy + ty) / 2,
            });
          } else {
            list.push(`${tag} → loop (no target)`);
            badges.set(node.step.id, list);
          }
        } else if (action === 'skip_next_stage') {
          const ti = i + 2;
          if (ti < rows.length) {
            const target = rows[ti].nodes[rows[ti].nodes.length - 1];
            const laneX = canvasW - 24 - skipLane * LANE_STEP;
            skipLane++;
            const sy = node.y + NODE_H / 2;
            const ty = target.y + NODE_H / 2;
            edges.push({
              path: `M ${node.x + NODE_W} ${sy} H ${laneX} V ${ty} H ${target.x + NODE_W + 3}`,
              cls: 'skip',
              label: `${tag} · skip`,
              lx: laneX - 52,
              ly: (sy + ty) / 2,
            });
          } else {
            const list = badges.get(node.step.id) || [];
            list.push(`${tag} → skip (ends run)`);
            badges.set(node.step.id, list);
          }
        }
      }
    }
  });

  return (
    <div className="pipeline-graph-view">
      <div className="graph-legend">
        <span className="legend-item"><span className="legend-line flow" /> flow</span>
        <span className="legend-item"><span className="legend-line loop" /> loop back</span>
        <span className="legend-item"><span className="legend-line skip" /> skip</span>
        <span className="legend-hint">
          Click a node to edit its config. Sequential steps also receive the previous
          stage's outputs. Add or remove stages in List view.
        </span>
      </div>

      <div className="graph-scroll">
        <div className="graph-canvas" style={{ width: canvasW, height: canvasH }}>
          <svg className="graph-edges" width={canvasW} height={canvasH}>
            <defs>
              <marker id="pg-arrow-flow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8 z" className="arrow-flow" />
              </marker>
              <marker id="pg-arrow-loop" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8 z" className="arrow-loop" />
              </marker>
              <marker id="pg-arrow-skip" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8 z" className="arrow-skip" />
              </marker>
            </defs>
            {edges.map((e, i) => (
              <path
                key={i}
                d={e.path}
                className={`graph-edge ${e.cls}`}
                markerEnd={`url(#pg-arrow-${e.cls === 'chain' ? 'flow' : e.cls})`}
              />
            ))}
            {edges.map((e, i) =>
              e.label ? (
                <text key={`l${i}`} x={e.lx} y={e.ly} className={`graph-edge-label ${e.cls}`}>
                  {e.label}
                </text>
              ) : null
            )}
          </svg>

          {/* Initial input pseudo-node */}
          <div
            className="graph-input-node"
            style={{ left: inputX, top: inputY, width: INPUT_W, height: INPUT_H }}
            title={pipeline.initialInput || 'No initial input set'}
          >
            <span className="graph-input-icon">▶</span> Initial Input
          </div>

          {rows.map((row, i) => (
            <div key={row.stageId}>
              <div className="graph-stage-label" style={{ top: row.y - 22 }}>
                {row.label}
                {row.nodes.length > 1 && (
                  <span className={`graph-stage-mode ${row.mode}`}>{row.mode}</span>
                )}
              </div>
              {row.nodes.map((node, j) =>
                node.step ? (
                  <div
                    key={node.step.id}
                    className={[
                      'graph-node',
                      `status-${node.step.status}`,
                      node.step.config.type === 'condition' ? 'condition' : '',
                      selectedStepId === node.step.id ? 'selected' : '',
                    ].join(' ')}
                    style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
                    onClick={() => onStepSelect(node.step!.id)}
                  >
                    <div className="graph-node-type">
                      <span>{getStepIcon(node.step.config.type)}</span>
                      <span>{node.step.config.type}</span>
                    </div>
                    <div className="graph-node-name">{node.step.name}</div>
                    <div className="graph-node-summary">{getStepSummary(node.step)}</div>
                    {node.step.status !== 'pending' && (
                      <div className="graph-node-status">
                        <span className={`step-status-dot ${node.step.status}`} />
                        {node.step.status === 'waiting_approval' ? 'Waiting' : node.step.status}
                      </div>
                    )}
                    {badges.has(node.step.id) && (
                      <div className="graph-node-badges" style={{ top: NODE_H + 3 }}>
                        {badges.get(node.step.id)!.map((b, k) => (
                          <span key={k} className="graph-node-badge">{b}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    key={`empty-${i}-${j}`}
                    className="graph-node placeholder"
                    style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
                  >
                    <div className="graph-node-summary">No steps yet — add in List view</div>
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
