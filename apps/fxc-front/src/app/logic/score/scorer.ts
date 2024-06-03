import { CircuitType, ScoringResult, ScoringRuleName, ScoringTrack } from '@flyxc/optimizer';
import { LatLon } from '@flyxc/common';
import { getPathLength } from 'geolib';
import ScoreWorker from '../../workers/score-track?worker';
import { ScoreWorkerMessage } from '../../workers/score-track';

export class Score {
  distanceM: number;
  indexes: number[];
  multiplier: number;
  circuit: CircuitType;
  closingRadiusM: number | null;
  points: number;

  constructor(score: Partial<Score>) {
    this.distanceM = score.distanceM ?? 0;
    this.indexes = score.indexes ?? [];
    this.multiplier = score.multiplier ?? 1;
    this.circuit = score.circuit ?? CircuitType.OpenDistance;
    this.closingRadiusM = score.closingRadiusM ?? null;
    this.points = score.points ?? 0;
  }
}

export type LatLonAndMaybeAltTime = LatLon & {
  alt?: number;
  timeSec?: number;
};

export function computeScore(
  points: LatLonAndMaybeAltTime[],
  league: string,
  onResultCallback: (score: Score) => void,
) {
  const track: ScoringTrack = {
    points: points.map((point, i) => {
      return {
        ...point,
        alt: point.alt ?? 0,
        timeSec: point.timeSec ?? i * 60,
      };
    }),
  };

  const message: ScoreWorkerMessage = {
    request: { track },
    rule: getScoringRule(league),
  };

  getScoreWorker((result) =>
    onResultCallback(
      new Score({
        circuit: result.circuit,
        distanceM: result.lengthKm * 1000,
        multiplier: result.multiplier,
        closingRadiusM: result.closingRadiusM ? result.closingRadiusM * 1000 : null,
        indexes: result.solutionIndices,
        points: result.score,
      }),
    ),
  ).postMessage(message);
}

export function getSampledTrack(points: ({ lat: number, lon: number, timeSec: number })[], sampleIntervalSec: number) {
  let nextSampleTime = points[0].timeSec + sampleIntervalSec;
  const samples = [points[0]];
  points.forEach((point) => {
    if (point.timeSec > nextSampleTime) {
      nextSampleTime = nextSampleTime + sampleIntervalSec;
      samples.push(point);
    }
  });
  return samples;
}

export function getTrackLengthKm(track: (LatLon & { timeSec: number })[]) {
  return getPathLength(track) / 1000;
}

function getScoringRule(league: string): ScoringRuleName {
  switch (league) {
    case 'czl':
      return 'CzechLocal';
    case 'cze':
      return 'CzechEurope';
    case 'czo':
      return 'CzechOutsideEurope';
    case 'fr':
      return 'FFVL';
    case 'leo':
      return 'Leonardo';
    case 'nor':
      return 'Norway';
    case 'ukc':
      return 'UKClub';
    case 'uki':
      return 'UKInternational';
    case 'ukn':
      return 'UKNational';
    case 'xc':
      return 'XContest';
    case 'xcppg':
      return 'XContestPPG';
    case 'wxc':
      return 'WorldXC';
  }
  throw new Error(`no Scoring Rules for league ${league}`);
}

let scoreWorker: Worker | undefined;

function getScoreWorker(callback: (scoringResult: ScoringResult) => void): Worker {
  if (!scoreWorker) {
    scoreWorker = new ScoreWorker() as Worker;
  }
  scoreWorker.onmessage = (msg: MessageEvent<ScoringResult>) => {
    callback(msg.data);
  };
  return scoreWorker;
}