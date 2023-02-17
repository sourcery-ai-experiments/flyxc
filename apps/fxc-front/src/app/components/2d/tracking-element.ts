import { html, LitElement, TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';
import { connect } from 'pwa-helpers';
import { FixType } from '../../logic/live-track';
import { popupContent } from '../../logic/live-track-popup';
import * as units from '../../logic/units';
import { setCurrentLiveId } from '../../redux/live-track-slice';
import * as sel from '../../redux/selectors';
import { RootState, store } from '../../redux/store';
import { getUniqueContrastColor } from '../../styles/track';

// A track is considered recent if ended less than timeout ago.
const RECENT_TIMEOUT_MIN = 2 * 60;
// Old tracks.
const OLD_TIMEOUT_MIN = 12 * 60;

// Only the last track uses a solid line.
// Former tracks use a dashed line.
const dashedLineIconsFactory: (opacity: number) => google.maps.IconSequence[] = (opacity: number) => [
  {
    icon: {
      path: 'M 0,-1 0,1',
      strokeOpacity: opacity,
    },
    offset: '0',
    repeat: '5px',
  },
];

////////
function extractFeatures(geojson: any) {
  const lines: { coordinates: [lon: number, lat: number][]; properties: Record<string, string> }[] = [];
  const points: { coordinates: [lon: number, lat: number]; properties: Record<string, string> }[] = [];
  for (let feature of geojson.features ?? []) {
    if (feature?.type === 'Feature') {
      switch (feature?.geometry?.type) {
        case 'LineString': {
          const coordinates = feature.geometry.coordinates;
          const properties = feature.properties ?? {};
          lines.push({ coordinates, properties });
          break;
        }
        case 'Point': {
          const coordinates = feature.geometry.coordinates;
          const properties = feature.properties ?? {};
          points.push({ coordinates, properties });
        }
      }
    }
  }

  return { lines, points };
}

let divEl: HTMLDivElement;

export function createElement(html: string): HTMLElement {
  if (divEl == null) {
    divEl = document.createElement('div');
  }
  // TODO: script injection - use lit ?
  divEl.innerHTML = html;
  return divEl.firstChild as HTMLElement;
}

//////

@customElement('tracking-element')
export class TrackingElement extends connect(store)(LitElement) {
  @property({ attribute: false })
  map!: google.maps.Map;

  @state()
  private displayLabels = true;
  @state()
  private geojson: any;
  // Id of the selected pilot.
  @state()
  private currentId?: string;
  @state()
  private numTracks = 0;
  @state()
  plannerEnabled = false;

  private units?: units.Units;
  private info?: google.maps.InfoWindow;

  private clearCurrentPilotListener?: google.maps.MapsEventListener;
  private eventsAbortController?: AbortController;

  connectedCallback(): void {
    super.connectedCallback();
    this.eventsAbortController = new AbortController();

    this.info = new google.maps.InfoWindow();
    this.info.addListener('closeclick', () => {
      store.dispatch(setCurrentLiveId(undefined));
    });
    this.clearCurrentPilotListener = this.map.addListener('click', () => {
      store.dispatch(setCurrentLiveId(undefined));
      this.info?.close();
    });

    this.addEventListener('line-click', (e) => this.onLineClick(e as CustomEvent), {
      signal: this.eventsAbortController.signal,
    });
    this.addEventListener('point-click', (e) => this.onPointClick(e as CustomEvent), {
      signal: this.eventsAbortController.signal,
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.eventsAbortController?.abort();
    this.eventsAbortController = undefined;
    this.clearCurrentPilotListener?.remove();
    this.clearCurrentPilotListener = undefined;
    this.info?.close();
    this.info = undefined;
  }

  stateChanged(state: RootState): void {
    this.units = state.units;
    this.displayLabels = state.liveTrack.displayLabels;
    this.geojson = state.liveTrack.geojson;
    this.currentId = state.liveTrack.currentLiveId;
    this.numTracks = sel.numTracks(state);
    this.plannerEnabled = state.planner.enabled;
  }

  private onLineClick(event: CustomEvent) {
    event.stopPropagation();
    const { properties } = event.detail;
    this.info?.close();
    store.dispatch(setCurrentLiveId(properties.id));
  }

  private onPointClick(event: CustomEvent) {
    event.stopPropagation();
    const { properties, latLon } = event.detail;
    store.dispatch(setCurrentLiveId(properties.id));
    const pilotId: string = properties.pilotId;
    const index = Number(properties.index ?? 0);
    const popup = popupContent(pilotId, index, this.units!);

    if (!popup) {
      this.info?.close();
    } else {
      this.info?.setContent(`<strong>${popup.title}</strong><br>${popup.content}`);
      this.info?.setPosition({ lat: latLon.lat, lng: latLon.lon });
      this.info?.open(this.map);
      store.dispatch(setCurrentLiveId(pilotId));
    }
  }

  createRenderRoot(): Element {
    return this;
  }

  protected render(): TemplateResult {
    const nowSec = Math.round(Date.now() / 1000);
    // TODO: move to a @state
    const faded = this.numTracks > 0 || this.plannerEnabled;
    const { lines, points } = extractFeatures(this.geojson);

    return html`${when(
      this.map,
      () =>
        html`
          ${repeat(
            lines,
            (line) => line.properties.hash,
            (line) =>
              html`<live-line
                .coordinates=${line.coordinates}
                .properties=${line.properties}
                .map=${this.map}
                .timeSec=${nowSec}
                .faded=${faded}
                .selectedId=${this.currentId}
              ></live-line>`,
          )}
          ${repeat(
            points,
            (point) => point.properties.hash,
            (point) => {
              const alt = Number(point.properties.alt);
              const altLabel = units.formatUnit(alt, this.units!.altitude);
              const gndAlt = Number(point.properties.gndAlt);
              const altAglLabel =
                point.properties.gndAlt == null
                  ? undefined
                  : `${units.formatUnit(Math.max(0, alt - gndAlt), this.units!.altitude)} AGL`;

              return html`<live-point
                .coordinates=${point.coordinates}
                .properties=${point.properties}
                .map=${this.map}
                .timeSec=${nowSec}
                .selectedId=${this.currentId}
                .units=${this.units}
                .displayLabels=${this.displayLabels}
                .altLabel=${altLabel}
                .altAglLabel=${altAglLabel}
              ></live-point>`;
            },
          )}
        `,
    )}`;
  }
}

@customElement('live-line')
export class LiveLineElement extends LitElement {
  @property({ attribute: false })
  map!: google.maps.Map;

  // Coordinates never change for a given hash.
  public coordinates: [lon: number, lat: number][] = [];

  @property({ attribute: false })
  selectedId?: string;

  @property({ attribute: false })
  faded = false;

  @property({ attribute: false })
  timeSec = 0;

  @property({ attribute: false })
  properties: Record<string, string> = {};

  private line?: google.maps.Polyline;
  private listener?: google.maps.MapsEventListener;
  options: google.maps.PolylineOptions = { visible: false };

  connectedCallback(): void {
    super.connectedCallback();
    const path = this.coordinates.map(([lng, lat]) => ({
      lat,
      lng,
    }));
    this.line = new google.maps.Polyline({
      path,
      map: this.map,
      visible: false,
    });
    this.listener = this.line.addListener('click', () =>
      this.dispatchEvent(
        new CustomEvent('line-click', {
          bubbles: true,
          detail: { properties: this.properties },
        }),
      ),
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.listener?.remove();
    this.listener = undefined;
    this.line?.setMap(null);
    this.line = undefined;
  }

  protected shouldUpdate(): boolean {
    this.updateStyle();
    return false;
  }

  protected updateStyle() {
    const id = this.properties.id;
    const isEmergency = this.properties.isEmergency;
    const ageMin = (this.timeSec - Number(this.properties.lastTimeSec)) / 60;

    const strokeColor = Boolean(this.properties.isUfo) === true ? '#aaa' : getUniqueContrastColor(id);
    let strokeWeight = 1;
    let strokeOpacity = 1;
    let zIndex = 10;
    let iconsFactory: ((opacity: number) => google.maps.IconSequence[]) | undefined;

    if (isEmergency) {
      strokeWeight = 6;
      zIndex = 30;
    } else if (Boolean(this.properties.last) !== true) {
      // Dashed lines for previous tracks.
      iconsFactory = dashedLineIconsFactory;
    } else if (id == this.selectedId) {
      // Make the selected track very visible.
      strokeWeight = 4;
      zIndex = 20;
    } else if (ageMin > OLD_TIMEOUT_MIN) {
      // Dashed lines for old tracks.
      iconsFactory = dashedLineIconsFactory;
    } else if (ageMin < RECENT_TIMEOUT_MIN && !this.faded) {
      // Make the recent tracks more visible when there are no non-live tracks.
      strokeWeight = 2;
      zIndex = 15;
    }

    // Fade the non selected tracks.
    // Helpful when there are many tracks (i.e. a comp).
    if (this.selectedId != null && id != this.selectedId) {
      strokeOpacity *= 0.5;
    }

    const options = {
      strokeColor,
      strokeOpacity: iconsFactory ? 0 : strokeOpacity,
      strokeWeight,
      zIndex,
      icons: iconsFactory ? iconsFactory(strokeOpacity) : undefined,
      visible: true,
    };

    if (!deepCompare(options, this.options)) {
      this.line?.setOptions(options);
      this.options = options;
    }
  }

  protected createRenderRoot(): Element {
    return this;
  }
}

const positionSvg = (
  color: string,
  opacity: number,
): string => `<svg xmlns="http://www.w3.org/2000/svg" height="9" width="9" style="top:-4px;left:-4px">
<circle r="3" cx="4" cy="4" fill="${color}" stroke="black" stroke-width="1" opacity="${opacity}"/>
</svg>`;

const arrowSvg = (
  angle: number,
  color: string,
  opacity: number,
) => `<svg xmlns="http://www.w3.org/2000/svg" height="19" width="19" style="top:-9px;left:-9px">
<path d='M9 3 l-5 13 l5 -3 l5 3z' fill="${color}" stroke="black" stroke-width="1" transform="rotate(${angle}, 9, 9)"  opacity="${opacity}"/>
</svg>`;

const msgSvg = (
  color: string,
  opacity: number,
): string => `<svg xmlns="http://www.w3.org/2000/svg" height="16" width="16" style="top:-7px;left:-7px">
<path fill="${color}" stroke="black" stroke-width="1" opacity="${opacity}" d="M2.5 2C1.7 2 1 2.7 1 3.5 l 0 8 c0 .8.7 1.5 1.5 1.5 H4 l 0 2.4 L 7.7 13 l 4.8 0 c.8 0 1.5 -.7 1.5 -1.5 l 0 -8 c 0 -.8 -.7 -1.5 -1.5 -1.5 z"/>
</svg>`;

// https://www.svgrepo.com/svg/23593/old-plane
const ufoSvg = (
  angle: number,
  color: string,
  opacity: number,
): string => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 183 183" style="top:-8px;left:-8px">
<path fill="${color}" stroke="black" stroke-width="1" opacity="${opacity}" transform="rotate(${angle}, 91, 91)" d="M170 58h-56V29c0-9-4-14-13-16-2-7-5-13-9-13-5 0-8 6-10 13-8 2-13 7-13 16v29H13c-4 0-8 4-8 8v14c0 4 3 8 7 9l19 4 10 1h31a314 314 0 0 1 3 33l6 21-20 5c-3 1-5 4-5 7v5c0 3 3 5 6 5h22c2 9 4 13 8 13 3 0 5-4 7-13h22c3 0 6-2 6-5v-5c0-3-2-6-5-7l-20-5 7-23 1-8 2-23h29l10-1 20-4c3-1 6-5 6-9V66c0-4-3-8-7-8z"/>
</svg>`;

// TODO:
// create -> create marker + update.
// update -> update text (time) and style
@customElement('live-point')
export class LivePointElement extends LitElement {
  @property({ attribute: false })
  map!: google.maps.Map;

  // Coordinates never change for a given hash.
  public coordinates!: [lon: number, lat: number];

  @property({ attribute: false })
  selectedId?: string;

  @property({ attribute: false })
  timeSec = 0;

  @property({ attribute: false })
  properties: Record<string, string> = {};

  @property({ attribute: false })
  displayLabels = true;

  @property({ attribute: false })
  altLabel = '';

  @property({ attribute: false })
  altAglLabel?: string;

  private marker?: google.maps.marker.AdvancedMarkerElement;
  private listener?: google.maps.MapsEventListener;
  options: google.maps.marker.AdvancedMarkerElementOptions = {};

  connectedCallback(): void {
    super.connectedCallback();
    this.marker = new google.maps.marker.AdvancedMarkerElement({
      map: this.map,
      position: { lat: this.coordinates[1], lng: this.coordinates[0] },
    });
    this.listener = this.marker.addListener('click', () =>
      this.dispatchEvent(
        new CustomEvent('point-click', {
          bubbles: true,
          detail: {
            properties: this.properties,
            latLon: { lat: this.coordinates[1], lon: this.coordinates[0] },
          },
        }),
      ),
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.listener?.remove();
    this.listener = undefined;
    if (this.marker) {
      this.marker.map = null;
      this.marker = undefined;
    }
  }

  protected shouldUpdate(): boolean {
    this.updateStyle();
    return false;
  }

  protected updateStyle() {
    console.log(`updateStyle`, this.properties);
    const pilotId: string = this.properties.pilotId;
    const ageMin = Math.round((this.timeSec - Number(this.properties.timeSec)) / 60);
    const fixType = this.properties.fixType as unknown as FixType;
    const isActive = pilotId === this.selectedId;

    let opacity = ageMin > RECENT_TIMEOUT_MIN ? 0.3 : 0.9;
    const color = getUniqueContrastColor(pilotId);
    let labelColor = 'black';
    let svg = positionSvg(color, opacity);
    let label = '';
    let zIndex = 10;
    let fontWeight = 'normal';

    if (isActive) {
      opacity = 0.9;
      labelColor = '#BF1515';
      zIndex = 20;
      fontWeight = '500';
    }

    switch (fixType) {
      case FixType.pilot:
        const heading = Number(this.properties.heading);
        if (Boolean(this.properties.isUfo) === true) {
          svg = ufoSvg(heading, color, opacity);
        } else {
          svg = arrowSvg(heading, color, opacity);
        }
        break;

      case FixType.message:
        svg = msgSvg('yellow', opacity);
        zIndex = 50;
        break;

      case FixType.emergency:
        svg = msgSvg('red', 1);
        zIndex = 60;
        break;
    }

    if (
      fixType != FixType.dot &&
      Boolean(this.properties.isLast) &&
      this.displayLabels &&
      (isActive || ageMin < 6 * 60)
    ) {
      label = `<ul>
      <li>${this.properties.name}</li>
      <li>${this.altLabel} · -${units.formatDurationMin(ageMin)}</li>
      </ul>`;
    }

    if (this.marker) {
      this.marker.content = createElement(
        `<div class='live-label' style='color:${labelColor};font-weight:${fontWeight};z-index:${zIndex}'>${svg}${label}</div>`,
      );
      this.marker.title = this.altAglLabel ?? 'TODO';
    }
  }

  protected createRenderRoot(): Element {
    return this;
  }
}

function deepCompare(obj1: unknown, obj2: unknown) {
  if (Object.is(obj1, obj2)) {
    return true;
  }

  if (obj1 == null || obj2 == null) {
    return obj1 === obj2;
  }

  if (typeof obj1 === 'function' || typeof obj2 === 'function') {
    return obj1 === obj2;
  }

  if (Array.isArray(obj1)) {
    if (!Array.isArray(obj2)) {
      return false;
    }
    for (let i = 0; i < obj1.length; i++) {
      if (!deepCompare(obj1[i], (obj2 as Array<unknown>)[i])) {
        return false;
      }
    }
    return true;
  }

  if (typeof obj1 === 'object') {
    if (typeof obj2 !== 'object') {
      return false;
    }

    const k1 = Object.keys(obj1);
    const k2 = Object.keys(obj2);
    if (k1.length != k2.length) {
      return false;
    }

    for (const k in k1) {
      if (!(k in obj2)) {
        return false;
      }
      if (!deepCompare((obj1 as any)[k], (obj2 as any)[k])) {
        return false;
      }
    }

    return true;
  }

  return false;
}
