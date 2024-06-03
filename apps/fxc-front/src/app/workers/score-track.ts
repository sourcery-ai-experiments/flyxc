import { getOptimizer, ScoringRequest, ScoringRuleName } from '@flyxc/optimizer';

const w: Worker = self as any;

export type ScoreWorkerMessage = { request: ScoringRequest; rule: ScoringRuleName };
w.onmessage = async (message: MessageEvent<ScoreWorkerMessage>) => {
  try {
    const result = getOptimizer(message.data.request, message.data.rule).next().value;
    w.postMessage(result, {});
  } catch (e) {
    console.error('solver failed', e);
  }
};
