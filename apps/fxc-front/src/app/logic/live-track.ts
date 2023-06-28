import {
  differentialDecodeLiveTrack,
  getFixMessage,
  isEmergencyFix,
  isEmergencyTrack,
  IsSimplifiableFix,
  isUfo,
  LIVE_MINIMAL_INTERVAL_SEC,
  mergeLiveTracks,
  protos,
  simplifyLiveTrack,
} from '@flyxc/common';
import { getRhumbLineBearing } from 'geolib';

export enum FixType {
  dot,
  pilot,
  message,
  emergency,
}

// Creates GeoJSON features from a live track.
//
// - Segments are created when there is a gap larger than gapMin,
// - Segments are returned as a multi-line,
// - Points are returned for all the points of interest:
//   - first and last for all the tracks,
//   - fixes with messages or emergency,
//   - 3 last fixes of the last track (last has heading),
export function trackToFeatures(track: protos.LiveTrack, gapMin: number): any[] {
  const features: any[] = [];

  // Compute the segments

  if (track.timeSec.length > 0) {
    // A segment start at [start] and ends at [end].
    const segments: { firstIndex: number; lastIndex: number }[] = [];
    let firstIndex = 0;

    // Compute segments.
    let currentTime = track.timeSec[0];
    for (let i = 1; i < track.timeSec.length; i++) {
      const nextTime = track.timeSec[i];
      if (nextTime - currentTime > 60 * gapMin) {
        segments.push({ firstIndex, lastIndex: i - 1 });
        firstIndex = i;
      }
      currentTime = nextTime;
    }
    segments.push({ firstIndex, lastIndex: track.timeSec.length - 1 });

    const pointsByIndex = new Map<number, any>();

    // Create:
    // - a line for each segment.
    // - points for non simplifiable fixes.
    segments.forEach(({ firstIndex, lastIndex }, index) => {
      const line: [number, number, number][] = [];
      for (let i = firstIndex; i <= lastIndex; i++) {
        if (!IsSimplifiableFix(track, i, firstIndex, lastIndex)) {
          addPoint(pointsByIndex, track, i);
        }
        line.push([track.lon[i], track.lat[i], track.alt[i]]);
      }
      if (line.length > 1) {
        const id = String(track.id ?? track.idStr);
        const timeSec = track.timeSec;
        const properties: { [k: string]: unknown } = {
          id,
          // hash changes when the line changes (either start, end, or nb of points).
          hash: `${id}-${timeSec[firstIndex]}-${timeSec[lastIndex]}-${lastIndex - firstIndex}`,
          firstIndex,
          lastIndex,
          lastTimeSec: track.timeSec[lastIndex],
          isUfo: isUfo(track.flags[firstIndex]),
          isEmergency: isEmergencyTrack(track),
        };
        if (index == segments.length - 1) {
          properties.last = true;
        }
        features.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: line,
          },
          properties,
        });
      }
    });

    // Add 3 last points of the last segment (at least 2mn apart) - unless ufo
    if (segments.length > 0) {
      const { firstIndex, lastIndex } = segments[segments.length - 1];
      let previousSec = track.timeSec[lastIndex];
      let numPoints = isUfo(track.flags[firstIndex]) ? 0 : 3;
      for (let i = lastIndex - 1; i >= firstIndex && numPoints > 0; --i) {
        const currentSec = track.timeSec[i];
        if (previousSec - currentSec >= 2 * 60) {
          previousSec = currentSec;
          addPoint(pointsByIndex, track, i);
          numPoints--;
        }
      }
    }

    features.push(...pointsByIndex.values());
  }

  return features;
}

function addPoint(
  pointsByIndex: Map<number, any>,
  track: protos.LiveTrack,
  index: number,
  props: { [key: string]: any } = {},
): void {
  const len = track.timeSec.length;
  // Compute the heading for the last fix of last segment.
  let fixType: FixType = FixType.dot;
  if (index == len - 1) {
    fixType = FixType.pilot;
    props.isLast = true;
    if (len > 1) {
      const previous = { lat: track.lat[len - 2], lon: track.lon[len - 2] };
      const current = { lat: track.lat[len - 1], lon: track.lon[len - 1] };
      props.heading = Math.round(getRhumbLineBearing(previous, current));
    } else {
      props.heading = 0;
    }
  }
  const message = getFixMessage(track, index);
  if (message != null) {
    fixType = FixType.message;
    props.msg = message;
  }
  if (isEmergencyFix(track.flags[index])) {
    fixType = FixType.emergency;
  }
  const pilotId = String(track.id ?? track.idStr);
  const timeSec = track.timeSec[index];
  pointsByIndex.set(index, {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [track.lon[index], track.lat[index], track.alt[index]],
    },
    properties: {
      ...props,
      id: `${pilotId}-${index}`,
      // hash changes if the fix type changes.
      hash: `${pilotId}-${timeSec}-${fixType}`,
      pilotId,
      index,
      fixType,
      isUfo: isUfo(track.flags[index]),
      alt: track.alt[index],
      gndAlt: track.extra[index]?.gndAlt,
      timeSec,
      name: track.name,
    },
  });
}

// Handles the live track updates from the server.
//
// For full (i.e. not incremental updates) the track received from the server are returned.
//
// For incremental updates, the updates are merged with the tracks and old fixes are removed.
// The returned tracks contain the updated tracks and the old tracks that still have some fixes.
export function updateLiveTracks(
  tracks: { [id: string]: protos.LiveTrack },
  updates: protos.LiveDifferentialTrackGroup,
): protos.LiveTrack[] {
  // Tracks received from the server (either full or incremental).
  const updatedTracks: { [id: string]: protos.LiveTrack } = {};

  updates.tracks.forEach((diffTrack) => {
    const id = String(diffTrack.id ?? diffTrack.idStr);
    if (id != null) {
      updatedTracks[id] = differentialDecodeLiveTrack(diffTrack);
    }
  });

  if (updates.incremental) {
    // Update the current tracks by:
    // - patching the deltas,
    // - removing old points,
    // - deleting processed tracks from the server tracks.
    for (const id of Object.keys(tracks)) {
      let track = tracks[id];
      if (!track) {
        continue;
      }
      if (id in updatedTracks) {
        track = mergeLiveTracks(track, updatedTracks[id]);
        simplifyLiveTrack(track, LIVE_MINIMAL_INTERVAL_SEC);
      }
      updatedTracks[id] = track;
    }
  }

  return Object.values(updatedTracks);
}
