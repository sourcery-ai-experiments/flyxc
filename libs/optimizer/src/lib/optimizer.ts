import { Solution, solver } from 'igc-xc-score';
import { BRecord, IGCFile } from 'igc-parser';
import { createSegments } from './utils/createSegments';
import { mergeTracks } from './utils/mergeTracks';
import { ScoringRules, scoringRules } from './scoringRules';

// TODO: all console.xxx statements are commented. In the future, we should use a logging library

export interface LatLonAltTime {
  alt: number;
  lat: number;
  lon: number;
  /**
   * time in seconds elapsed since the beginning of the track (see ScoringTrack.startTimeSec)
   */
  timeSec: number;
}

export interface ScoringTrack {
  /**
   * the points that describe the track
   */
  points: LatLonAltTime[];
  /**
   * Timestamp in seconds
   * the "timeSec" values in LatLonAltTime's are offsets according to this timestamp.
   */
  startTimeSec: number;
}

export interface OptimizationOptions {
  /**
   * maximum duration in milliseconds for an optimization round trip.
   * If undefined, calculation duration is unbounded.
   */
  maxCycleDurationMs?: number;
  /**
   * maximum number of iterations allowed for an optimization round trip.
   * If undefined, number of allowed iterations is unbounded
   */
  maxNumCycles?: number;
}

/**
 * optimize function argument
 */
export interface OptimizationRequest {
  track: ScoringTrack;
  options?: OptimizationOptions;
}

export enum CircuitType {
  OpenDistance = 'Open distance',
  FlatTriangle = 'Flat triangle',
  FaiTriangle = 'Fai triangle',
  OutAndReturn = 'Out and return',
}

export interface OptimizationResult {
  /**
   * the score for the track in the given league
   */
  score: number;
  /**
   * the length of the optimized track in kms
   */
  lengthKm: number;
  /**
   * multiplier for computing score. score = lengthKm * multiplier
   */
  multiplier: number;
  /**
   * type of the optimized track
   */
  circuit?: CircuitType;
  /**
   * if applicable, distance in m for closing the circuit
   */
  closingRadius?: number;
  /**
   * indices of solutions points in ScoringTrack.points array
   */
  solutionIndices: number[];
  /**
   * the result is optimal (no need to get a next result of Iterator<OptimizationResult, OptimizationResult>)
   */
  optimal: boolean;
}

const ZERO_SCORE: OptimizationResult = {
  score: 0,
  lengthKm: 0,
  multiplier: 0,
  solutionIndices: [],
  optimal: true,
};

/**
 * returns an iterative optimizer that computes iteratively the score for the flight. At each iteration, the score
 * should be a better solutions.
 * @param request the OptimizationRequest. if request.options is undefined, then there will be one iteration, and the result
 *                will be the best solution
 * @param rules the ScoringRules to apply for computation
 * @return an Iterator over the successive OptimizationResult
 * @see README.md
 */
export function* getOptimizer(
  request: OptimizationRequest,
  rules: ScoringRules,
): Iterator<OptimizationResult, OptimizationResult> {
  if (request.track.points.length === 0 || request.track.points.length === 1) {
    // console.warn('Empty track received in optimization request. Returns a 0 score');
    return ZERO_SCORE;
  }
  const originalTrack = request.track;
  const solverTrack = new SolverTrack(originalTrack);
  const flight = solverTrack.toIgcFile();
  const solverScoringRules = scoringRules.get(rules);
  const options = toSolverOptions(request.options);
  const solutionIterator = solver(flight, solverScoringRules ?? {}, options);
  while (true) {
    const solution = solutionIterator.next();
    if (solution.done) {
      // console.debug('solution', JSON.stringify(solution.value, undefined, 2));
      return toOptimizationResult(solution.value, solverTrack);
    }
    yield toOptimizationResult(solution.value, solverTrack);
  }
}

type SolverOptions = { maxloop?: number; maxcycle?: number };

function toSolverOptions(options?: OptimizationOptions): SolverOptions {
  return {
    maxcycle: options?.maxCycleDurationMs,
    maxloop: options?.maxNumCycles,
  };
}

function toOptimizationResult(solution: Solution, solverTrack: SolverTrack): OptimizationResult {
  return {
    score: solution.score ?? 0,
    lengthKm: solution.scoreInfo?.distance ?? 0,
    multiplier: solution.opt.scoring.multiplier,
    circuit: toCircuitType(solution.opt.scoring.code),
    closingRadius: getClosingRadius(solution),
    solutionIndices: getIndicesInScoringTrack(solution, solverTrack),
    optimal: solution.optimal || false,
  };
}

function getClosingRadius(solution: Solution) {
  // @ts-ignore : closingDistanceFixed is not exposed by library
  const closingDistanceFixed: number | undefined = solution.opt.scoring?.closingDistanceFixed;
  // @ts-ignore : closingDistanceRelative is not exposed by library
  const closingDistanceRelativeRatio: number | undefined = solution.opt.scoring?.closingDistanceRelative;
  const closingDistanceRelative =
    solution.scoreInfo?.distance && closingDistanceRelativeRatio
      ? closingDistanceRelativeRatio * solution.scoreInfo?.distance
      : undefined;
  const closingDistance = solution.scoreInfo?.cp?.d;
  if (closingDistance == null) {
    return undefined;
  }
  if (closingDistanceFixed != null && closingDistance < closingDistanceFixed) {
    return closingDistanceFixed;
  } else if (closingDistanceRelative != null && closingDistance < closingDistanceRelative) {
    return closingDistanceRelative;
  }
  return undefined;
}

const circuitTypeCodes = ['od' , 'tri' , 'fai' , 'oar']
type CircuitTypeCode = (typeof circuitTypeCodes)[number];

function toCircuitType(code: CircuitTypeCode) {
  switch (code) {
    case 'od':
      return CircuitType.OpenDistance;
    case 'fai':
      return CircuitType.FaiTriangle;
    case 'oar':
      return CircuitType.OutAndReturn;
    case 'tri':
      return CircuitType.FlatTriangle;
  }
  throw new Error(`no CircuitType found for ${code}`);
}

// return indices of solution points. This permit to identify the solution points in the ScoringTrack.points array
// it contains (when applicable):
// - the starting point
// - the 'in' closing point
// - the turn points
// - the 'out' closing point
// - the finish point
function getIndicesInScoringTrack(solution: Solution, solverTrack: SolverTrack) {
  const result: number[] = [];
  pushInResult(getEntryPointsStartIndex(solution, solverTrack), result);
  pushInResult(getClosingPointsInIndex(solution, solverTrack), result);
  solution.scoreInfo?.tp
    ?.map((turnPoint) => turnPoint.r)
    .forEach((index) => pushInResult(solverTrack.getIndexInScoringTrack(index), result));
  pushInResult(getClosingPointsOutIndex(solution, solverTrack), result);
  pushInResult(getEntryPointsFinishIndex(solution, solverTrack), result);
  return result;

}

function pushInResult(index: number, result: number[]) {
  if (index >= 0) {
    result.push(index);
  }
}

function getEntryPointsStartIndex(solution: Solution, solverTrack: SolverTrack): number {
  // console.debug('getEntryPointsStartIndex', solution.scoreInfo?.ep?.start.r);
  return solverTrack.getIndexInScoringTrack(solution.scoreInfo?.ep?.start.r);
}

function getClosingPointsInIndex(solution: Solution, solverTrack: SolverTrack): number {
  // console.debug('getClosingPointsInIndex', solution.scoreInfo?.cp?.in.r);
  return solverTrack.getIndexInScoringTrack(solution.scoreInfo?.cp?.in.r);
}

function getClosingPointsOutIndex(solution: Solution, solverTrack: SolverTrack): number {
  // console.debug('getClosingPointsOutIndex', solution.scoreInfo?.cp?.out.r);
  return solverTrack.getIndexInScoringTrack(solution.scoreInfo?.cp?.out.r);
}

function getEntryPointsFinishIndex(solution: Solution, solverTrack: SolverTrack): number {
  // console.debug('getEntryPointsFinishIndex', solution.scoreInfo?.ep?.finish.r);
  return solverTrack.getIndexInScoringTrack(solution.scoreInfo?.ep?.finish.r);
}

// Not the most performant solution but is used only for a low dimension problems
function deepCopy<T>(source: T): T {
  return JSON.parse(JSON.stringify(source));
}

/**
 * Embeds the track to score for the solver
 */
class SolverTrack {
  // When the track has not enough points (<5), we build a new one by adding interpolated points between existing ones.
  // see this issue https://github.com/mmomtchev/igc-xc-score/issues/231
  private static MIN_POINTS = 5;

  // For adding interpolated points, this constant adjusts the proximity of the points to the starting point of
  // the segment. We want the added points to be very close to the starting points of the segment so that the solution
  // points returned by the solver are as close as possible (or may be equal) to one of the original points of the track.
  private static DISTRIBUTION_FACTOR_FOR_ADDED_POINTS = 1e-5;

  /**
   * the track to optimize
   */
  private readonly scoringTrack: ScoringTrack;
  /**
   * Mapping between indices in solver track and indices in original track.
   * The key is an index in solver track, the value is an index in original track
   * This mapping is only needed when the original track has not the required number of points.
   */
  private readonly solverTrackToTrackMapping: Map<number, number>;

  /**
   * the solver requires at least 5 points, so if there is not enough points,
   * we create points between existing ones
   */
  constructor(track: ScoringTrack) {
    this.solverTrackToTrackMapping = new Map<number, number>();
    if (track.points.length >= SolverTrack.MIN_POINTS) {
      this.scoringTrack = track;
      return;
    }
    // console.debug(`not enough points (${track.points.length}) in track. Interpolate intermediate points`);
    track = deepCopy(track);
    const subTracks: ScoringTrack[] = [];
    if (track.points.length === 2) {
      // add 3 points near the first point => 4 segments
      subTracks.push(
        createSegments(track.points[0], track.points[1], track.startTimeSec, 4, SolverTrack.DISTRIBUTION_FACTOR_FOR_ADDED_POINTS),
      );
      this.solverTrackToTrackMapping
        // first, second, third and fourth points of solver track are near the first point of the original track
        .set(0, 0)
        .set(1, 0)
        .set(2, 0)
        .set(3, 0)
        // fifth point of solver track is near the second point of the original track
        .set(4, 1);
    } else if (track.points.length === 3) {
      // add 1 point near the first point => 2 segments
      subTracks.push(
        createSegments(track.points[0], track.points[1], track.startTimeSec, 2, SolverTrack.DISTRIBUTION_FACTOR_FOR_ADDED_POINTS),
      );
      // add 1 point near the second point => 2 segments
      subTracks.push(
        createSegments(track.points[1], track.points[2], track.startTimeSec, 2, SolverTrack.DISTRIBUTION_FACTOR_FOR_ADDED_POINTS),
      );
      this.solverTrackToTrackMapping
        // first and second points of solver track are near the first point of the original track
        .set(0, 0)
        .set(1, 0)
        // third and fourth points of solver track are near the second point of the original track
        .set(2, 1)
        .set(3, 1)
        // fifth point of solver track is near the third point of the original track
        .set(4, 2);
    } else if (track.points.length === 4) {
      // add 1 point near the first point => 2 segments
      subTracks.push(
        createSegments(track.points[0], track.points[1], track.startTimeSec, 2, SolverTrack.DISTRIBUTION_FACTOR_FOR_ADDED_POINTS),
      );
      // add 0 point near the second point => 1 segment
      subTracks.push(
        createSegments(track.points[1], track.points[2], track.startTimeSec, 1, SolverTrack.DISTRIBUTION_FACTOR_FOR_ADDED_POINTS),
      );
      // add 0 point near the third point => 1 segment
      subTracks.push(
        createSegments(track.points[2], track.points[3], track.startTimeSec, 1, SolverTrack.DISTRIBUTION_FACTOR_FOR_ADDED_POINTS),
      );
      this.solverTrackToTrackMapping
        // first and second points of solver track are near the first point of the original track
        .set(0, 0)
        .set(1, 0)
        // third point of solver track is near the second point of the original track
        .set(2, 1)
        // fourth point of solver track is near the third point of the original track
        .set(3, 2)
        // fifth point of solver track is near the fourth point of the original track
        .set(4, 3);
    }
    track = mergeTracks(...subTracks);
    this.scoringTrack = track;
  }

  /**
   * translates an index of a solution point returned by the solver to an index in the track to score
   * @param index index of a solution point
   * @return the index in the ScoringTrack (given in constructor)
   */
  public getIndexInScoringTrack(index: number): number {
    if (index === undefined) {
      return -1;
    }
    return this.solverTrackToTrackMapping.size === 0 ? index : this.solverTrackToTrackMapping[index];
  }

  /**
   * create igc file for the solver
   */
  public toIgcFile(): IGCFile {
    const fixes = this.scoringTrack.points.map((point): BRecord => {
      const timeMilliseconds = point.timeSec * 1000;
      return {
        timestamp: timeMilliseconds,
        time: new Date(timeMilliseconds).toISOString(),
        latitude: point.lat,
        longitude: point.lon,
        valid: true,
        pressureAltitude: null,
        gpsAltitude: point.alt,
        extensions: {},
        fixAccuracy: null,
        enl: null,
      };
    });
    // we ignore some properties of the igc-file, as they are not required for the computation
    // @ts-ignore
    return {
      date: new Date(this.scoringTrack.startTimeSec * 1000).toISOString(),
      fixes: fixes,
    };
  }
}

