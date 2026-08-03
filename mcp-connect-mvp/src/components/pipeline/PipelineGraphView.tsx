/**
 * PipelineGraphView: the primary pipeline surface — a node graph of steps.
 *
 * Stages are an internal execution detail and are NOT shown: steps render as
 * chained nodes (steps that share a stage still sit side by side and run per
 * the stage's execution mode, but there is no stage chrome). The graph is
 * editable: "+ Add Step" appends a new step (its own sequential stage under
 * the hood), each node has a remove ✕, and nodes that ran expose "view
 * deliberation". Clicking the Input node or a step selects it — the side
 * panel shows the pipeline input or the step's config.
 *
 * Condition branches render as real edges: loop_to_stage as an amber
 * back-edge (labeled with maxLoops), skip_next_stage as a dotted bypass,
 * stop as a badge. Node left-border reflects live step status.
 */

import type {
  Pipeline,
  PipelineStep,
  StepConfig,
  ConditionStepConfig,
} from '../../pipeline/types';
import { isCouncilType } from '../../pipeline/types';
import './PipelineGraphView.css';

export function getStepIcon(type: StepConfig['type']): string {
  switch (type) {
    case 'council': return '🏛️';
    case 'code_planning': return '📋';
    case 'analysis': return '🤔';
    case 'agent': return '🤖';
    case 'coding': return '💻';
    case 'review': return '📝';
    case 'enrich': return '💡';
    case 'gate': return '🚧';
    case 'script': return '⚡';
    case 'condition': return '🔀';
    default: return '❓';
  }
}

export function getStepSummary(step: PipelineStep): string {
  if (isCouncilType(step.config.type)) {
    const c = step.config as { councilSetup?: { personas: unknown[] } };
    if (c.councilSetup) {
      const count = c.councilSetup.personas.length;
      return `${count} persona${count !== 1 ? 's' : ''}`;
    }
    return (step.config as { model?: string }).model || step.config.type;
  }
  if (step.config.type === 'gate') return 'Approval checkpoint';
  if (step.config.type === 'script') {
    const cmd = (step.config as { command?: string }).command || '';
    return cmd ? cmd.slice(0, 40) + (cmd.length > 40 ? '...' : '') : 'No command';
  }
  if (step.config.type === 'condition') {
    const cfg = step.config as { mode?: string; expression?: string };
    return cfg.expression ? `${cfg.mode}: ${cfg.expression.slice(0, 30)}` : 'No expression';
  }
  return '';
}

interface PipelineGraphViewProps {
  pipeline: Pipeline;
  selectedStepId: string | null;
  /** True when the Input pseudo-node is selected (side panel shows pipeline input). */
  inputSelected?: boolean;
  onStepSelect: (stepId: string) => void;
  onSelectInput?: () => void;
  onAddStep?: () => void;
  onRemoveStep?: (stageId: string, stepId: string) => void;
  /** Add a step ALONGSIDE this one (same layer — a parallel/sequential sibling). */
  onAddSibling?: (stageId: string) => void;
  /** Toggle a multi-step layer between sequential and parallel execution. */
  onToggleLayerMode?: (stageId: string) => void;
  /** Open the full deliberation of a step's council. */
  onOpenCouncil?: (councilId: string) => void;
}

const NODE_W = 190;
const NODE_H = 92;
const INPUT_W = 150;
const INPUT_H = 40;
const H_GAP = 36;
const V_GAP = 56;
const SIDE_PAD = 120;
const TOP_PAD = 24;
const LANE_STEP = 16;
const BADGE_SPACE = 26;
const ADD_W = 150;
const ADD_H = 44;

interface GraphNode {
  step: PipelineStep | null;
  stageId: string;
  x: number;
  y: number;
}

interface GraphRow {
  stageId: string;
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
  inputSelected,
  onStepSelect,
  onSelectInput,
  onAddStep,
  onRemoveStep,
  onAddSibling,
  onToggleLayerMode,
  onOpenCouncil,
}: PipelineGraphViewProps) {
  const stages = pipeline.stages.filter((s) => s.steps.length > 0);

  // ---- Layout ----
  const rowWidth = (n: number) => Math.max(n, 1) * NODE_W + (Math.max(n, 1) - 1) * H_GAP;
  const canvasW =
    Math.max(INPUT_W, ADD_W, ...stages.map((s) => rowWidth(s.steps.length))) + SIDE_PAD * 2;

  const inputY = TOP_PAD;
  const stageY = (i: number) => inputY + INPUT_H + V_GAP + i * (NODE_H + V_GAP + BADGE_SPACE);

  const rows: GraphRow[] = stages.map((stage, i) => {
    const n = stage.steps.length;
    const startX = (canvasW - rowWidth(n)) / 2;
    const y = stageY(i);
    return {
      stageId: stage.id,
      y,
      nodes: stage.steps.map((step, j) => ({
        step,
        stageId: stage.id,
        x: startX + j * (NODE_W + H_GAP),
        y,
      })),
    };
  });

  const addY = stageY(rows.length);
  const canvasH = addY + ADD_H + TOP_PAD;

  // ---- Edges ----
  const edges: GraphEdge[] = [];
  const badges = new Map<string, string[]>();
  let loopLane = 0;
  let skipLane = 0;

  const downEdge = (x1: number, y1: number, x2: number, y2: number): string =>
    `M ${x1} ${y1} C ${x1} ${y1 + (y2 - y1) / 2}, ${x2} ${y1 + (y2 - y1) / 2}, ${x2} ${y2 - 3}`;

  const inputX = (canvasW - INPUT_W) / 2;
  if (rows.length > 0) {
    const first = rows[0];
    const mode = stages[0].executionMode || 'sequential';
    const entry = mode === 'sequential' ? [first.nodes[0]] : first.nodes;
    for (const t of entry) {
      edges.push({
        path: downEdge(inputX + INPUT_W / 2, inputY + INPUT_H, t.x + NODE_W / 2, t.y),
        cls: 'flow',
      });
    }
  }

  rows.forEach((row, i) => {
    const mode = stages[i].executionMode || 'sequential';

    if (i > 0) {
      const prev = rows[i - 1];
      const entry = mode === 'sequential' ? [row.nodes[0]] : row.nodes;
      for (const s of prev.nodes) {
        for (const t of entry) {
          edges.push({
            path: downEdge(s.x + NODE_W / 2, s.y + NODE_H, t.x + NODE_W / 2, t.y),
            cls: 'flow',
          });
        }
      }
    }

    if (mode === 'sequential') {
      for (let j = 1; j < row.nodes.length; j++) {
        const a = row.nodes[j - 1];
        const b = row.nodes[j];
        edges.push({
          path: `M ${a.x + NODE_W} ${a.y + NODE_H / 2} L ${b.x - 3} ${b.y + NODE_H / 2}`,
          cls: 'chain',
        });
      }
    }

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

  // Edge from last row to the add node
  if (onAddStep) {
    const addX = (canvasW - ADD_W) / 2;
    const from = rows.length > 0
      ? rows[rows.length - 1].nodes.map((n) => ({ x: n.x + NODE_W / 2, y: n.y + NODE_H }))
      : [{ x: inputX + INPUT_W / 2, y: inputY + INPUT_H }];
    for (const f of from) {
      edges.push({ path: downEdge(f.x, f.y, addX + ADD_W / 2, addY), cls: 'chain' });
    }
  }

  return (
    <div className="pipeline-graph-view">
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

          {/* Initial input pseudo-node — click to edit the pipeline input */}
          <div
            className={`graph-input-node clickable ${inputSelected ? 'selected' : ''}`}
            style={{ left: inputX, top: inputY, width: INPUT_W, height: INPUT_H }}
            title={
              pipeline.inputSource?.kind && pipeline.inputSource.kind !== 'text'
                ? `${pipeline.inputSource.kind}: ${pipeline.inputSource.value || '(not set)'}`
                : pipeline.initialInput || 'Click to set the pipeline input'
            }
            onClick={() => onSelectInput?.()}
          >
            <span className="graph-input-icon">▶</span>
            {pipeline.inputSource?.kind && pipeline.inputSource.kind !== 'text'
              ? `Input · ${pipeline.inputSource.kind}`
              : 'Input'}
          </div>

          {rows.map((row, rowIdx) => (
            <div key={row.stageId}>
              {/* Sibling add — a "+" just right of the layer's last node */}
              {onAddSibling && (
                <button
                  className="graph-sibling-add"
                  style={{
                    left: row.nodes[row.nodes.length - 1].x + NODE_W + 8,
                    top: row.y + NODE_H / 2 - 12,
                  }}
                  title="Add a step alongside — runs in the same layer"
                  onClick={() => onAddSibling(row.stageId)}
                >
                  +
                </button>
              )}
              {/* Execution mode of a multi-step layer — click to toggle */}
              {row.nodes.length > 1 && onToggleLayerMode && (
                <button
                  className={`graph-layer-mode ${stages[rowIdx].executionMode === 'parallel' ? 'parallel' : 'sequential'}`}
                  style={{
                    left: row.nodes[row.nodes.length - 1].x + NODE_W + 36,
                    top: row.y + NODE_H / 2 - 10,
                  }}
                  title="How the steps in this layer run — click to toggle"
                  onClick={() => onToggleLayerMode(row.stageId)}
                >
                  {stages[rowIdx].executionMode === 'parallel' ? 'parallel' : 'sequential'}
                </button>
              )}
              {row.nodes.map((node) => {
                if (!node.step) return null;
                const councilId = node.step.artifact?.metadata?.councilId;
                return (
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
                      {onRemoveStep && (
                        <button
                          className="graph-node-remove"
                          title="Remove step"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveStep(node.stageId, node.step!.id);
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <div className="graph-node-name">{node.step.name}</div>
                    <div className="graph-node-summary">{getStepSummary(node.step)}</div>
                    <div className="graph-node-foot">
                      {node.step.status !== 'pending' && (
                        <span className="graph-node-status">
                          <span className={`step-status-dot ${node.step.status}`} />
                          {node.step.status === 'waiting_approval' ? 'Waiting' : node.step.status}
                        </span>
                      )}
                      {councilId && onOpenCouncil && (
                        <button
                          className="graph-node-delib"
                          title="View this step's full deliberation"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenCouncil(councilId);
                          }}
                        >
                          ⚖ deliberation
                        </button>
                      )}
                    </div>
                    {badges.has(node.step.id) && (
                      <div className="graph-node-badges" style={{ top: NODE_H + 3 }}>
                        {badges.get(node.step.id)!.map((b, k) => (
                          <span key={k} className="graph-node-badge">{b}</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {onAddStep && (
            <button
              className="graph-add-node"
              style={{ left: (canvasW - ADD_W) / 2, top: addY, width: ADD_W, height: ADD_H }}
              onClick={onAddStep}
            >
              + Add Step
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
