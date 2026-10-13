import { get } from '@/lib/api';
import type { ExecutionMetrics, ExternalFlowMetrics, FairnessMetrics } from '@/lib/types';
import { type FigureInputs, type Stats, figureRows } from './figures';

/** Reads the four public sources the home page's figures come from, and turns them into rows. A source that fails is named, not guessed. */
export async function loadFigures() {
  const [stats, execution, fairness, flow] = await Promise.all([
    get<Stats>('/v1/stats', 15),
    get<ExecutionMetrics>('/v1/metrics/execution', 15),
    get<FairnessMetrics>('/v1/metrics/fairness', 15),
    get<ExternalFlowMetrics>('/v1/metrics/external-flow', 15),
  ]);
  const inputs: FigureInputs = { stats: stats.ok ? stats.data : null, execution: execution.ok ? execution.data : null, fairness: fairness.ok ? fairness.data : null, flow: flow.ok ? flow.data : null };
  const { rows, missing } = figureRows(inputs);
  const network = inputs.stats?.network ?? inputs.execution?.network ?? inputs.fairness?.network ?? inputs.flow?.network ?? 'unknown';
  return { rows, missing, network, inputs, generatedAt: new Date().toISOString() };
}
