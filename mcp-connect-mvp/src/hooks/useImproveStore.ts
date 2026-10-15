/**
 * React subscription to the self-improvement store (scorecards, proposals,
 * lessons, changelog) for one pipeline. Re-renders on store notifies AND on
 * the window-level KONDI_IMPROVE_EVENT (fired by CLI-agnostic code paths).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { improveStore, KONDI_IMPROVE_EVENT } from '../improve/store';
import { aggregateAcrossRuns } from '../improve/run-metrics';
import type { ImproveState, RunScorecard, RunAggregate } from '../improve/types';

export function useImproveStore(pipelineId: string | null | undefined): {
  state: ImproveState | null;
  scorecards: RunScorecard[];
  latest: RunScorecard | null;
  aggregate: RunAggregate | null;
  refresh: () => void;
} {
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const unsub = improveStore.subscribe(refresh);
    window.addEventListener(KONDI_IMPROVE_EVENT, refresh);
    return () => {
      unsub();
      window.removeEventListener(KONDI_IMPROVE_EVENT, refresh);
    };
  }, [refresh]);

  return useMemo(() => {
    if (!pipelineId) return { state: null, scorecards: [], latest: null, aggregate: null, refresh };
    const state = improveStore.get(pipelineId);
    const scorecards = improveStore.listScorecards(pipelineId);
    const latest = scorecards.length ? scorecards[scorecards.length - 1] : null;
    return { state, scorecards, latest, aggregate: aggregateAcrossRuns(scorecards), refresh };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId, version]);
}
