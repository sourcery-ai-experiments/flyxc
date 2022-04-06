import { findIndexes } from 'flyxc/common/src/math';
import { LatLonZ, RuntimeTrack } from 'flyxc/common/src/runtime-track';
import { LitElement, PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { connect } from 'pwa-helpers';

import Color from '@arcgis/core/Color';
import Graphic from '@arcgis/core/Graphic';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';

import * as sel from '../../redux/selectors';
import { RootState, store } from '../../redux/store';

const INACTIVE_ALPHA = 0.7;

@customElement('line3d-element')
export class Line3dElement extends connect(store)(LitElement) {
  @property({ attribute: false })
  track?: RuntimeTrack;

  @state()
  private layer?: GraphicsLayer;
  @state()
  private gndLayer?: GraphicsLayer;
  @state()
  private curtainLayer?: GraphicsLayer;
  @state()
  private opacity = 1;
  @state()
  private timeSec = 0;
  @state()
  private multiplier = 0;
  @state()
  private offsetSeconds = 0;
  @state()
  private color = '';

  private line = {
    type: 'polyline',
    paths: [] as number[][][],
    hasZ: true,
  };

  private symbol = {
    type: 'line-3d',
    symbolLayers: [
      {
        type: 'line',
        size: 2,
        material: { color: [50, 50, 50, 0.6] },
        cap: 'round',
        join: 'round',
      },
    ],
  };

  private curtainSymbol = {
    type: 'line-3d',
    symbolLayers: [
      {
        type: 'path',
        material: { color: [50, 50, 50, 0.6] },
        width: 0,
        height: 5000,
        join: 'miter',
        cap: 'butt',
        anchor: 'top',
        profileRotation: 'heading',
        profile: 'quad',
      },
    ],
  };

  private graphic?: Graphic;
  private gndGraphic?: Graphic;
  private curtainGraphic?: Graphic;
  private path3d: number[][] = [];

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.destroyLines();
  }

  stateChanged(state: RootState): void {
    if (this.track) {
      const id = this.track.id;
      this.offsetSeconds = sel.offsetSeconds(state)[id];
      this.color = sel.trackColors(state)[id];
      this.opacity = id == sel.currentTrackId(state) ? 1 : INACTIVE_ALPHA;
    }
    this.layer = state.arcgis.graphicsLayer;
    this.gndLayer = state.arcgis.gndGraphicsLayer;
    this.curtainLayer = state.arcgis.curtainGraphicsLayer;
    this.timeSec = state.app.timeSec;
    this.multiplier = state.arcgis.altMultiplier;
  }

  shouldUpdate(changedProps: PropertyValues): boolean {
    if (this.layer == null || this.gndLayer == null || this.curtainLayer == null) {
      this.destroyLines();
      return false;
    }

    if (changedProps.has('track') || changedProps.has('multiplier')) {
      this.destroyLines();
      this.maybeCreateLines();
    }

    if (this.graphic && this.track) {
      const timeSecs = this.track.timeSec;

      const timeSec = this.timeSec + this.offsetSeconds;

      let start = Math.min(findIndexes(timeSecs, timeSec - 15 * 60).beforeIndex, timeSecs.length - 4);
      const end = Math.max(findIndexes(timeSecs, timeSec).beforeIndex + 1, 4);
      let path = this.path3d.slice(start, end);
      // The last point must match the marker position and needs to be interpolated.
      const pos = sel.getTrackLatLonAlt(store.getState())(timeSec, this.track) as LatLonZ;
      path.push([pos.lon, pos.lat, this.multiplier * pos.alt]);
      this.line.paths[0] = path;

      this.graphic.set('geometry', this.line);
      this.graphic.set('attributes', { trackId: this.track.id });
      this.gndGraphic?.set('geometry', this.line);
      this.gndGraphic?.set('attributes', { trackId: this.track.id });

      let color = new Color(this.color);
      color.a = this.opacity;
      let rgba = color.toRgba();
      this.symbol.symbolLayers[0].material.color = rgba;
      this.graphic.set('symbol', this.symbol);

      start = Math.min(findIndexes(timeSecs, timeSec - 30).beforeIndex, timeSecs.length - 4);
      path = this.path3d.slice(start, end);
      path.push([pos.lon, pos.lat, this.multiplier * pos.alt]);
      this.line.paths[0] = path;

      this.curtainGraphic?.set('geometry', this.line);
      this.curtainGraphic?.set('attributes', { trackId: this.track.id });

      color = new Color(this.color);
      color.a = 0.2;
      rgba = color.toRgba();
      this.curtainSymbol.symbolLayers[0].material.color = rgba;
      this.curtainGraphic?.set('symbol', this.curtainSymbol);
    }

    return false;
  }

  private maybeCreateLines(): void {
    if (this.layer && this.gndLayer && this.curtainLayer && this.track) {
      this.graphic = new Graphic();
      this.layer.add(this.graphic);
      this.symbol.symbolLayers[0].material.color = [50, 50, 50, 0.6];
      this.gndGraphic = new Graphic({ symbol: this.symbol as any });
      this.gndLayer.add(this.gndGraphic);
      this.curtainGraphic = new Graphic({ symbol: this.curtainSymbol as any });
      this.curtainLayer.add(this.curtainGraphic);
      this.path3d.length = 0;
      const track = this.track;
      this.track.lat.forEach((lat, i) => this.path3d.push([track.lon[i], lat, this.multiplier * track.alt[i]]));
    }
  }

  private destroyLines(): void {
    if (this.graphic) {
      this.layer?.remove(this.graphic);
    }
    this.graphic = undefined;
    if (this.gndGraphic) {
      this.gndLayer?.remove(this.gndGraphic);
    }
    this.gndGraphic = undefined;
    if (this.curtainGraphic) {
      this.curtainLayer?.remove(this.curtainGraphic);
    }
    this.curtainGraphic = undefined;
    this.path3d.length = 0;
  }

  // There is not content - no need to create a shadow root.
  createRenderRoot(): Element {
    return this;
  }
}
