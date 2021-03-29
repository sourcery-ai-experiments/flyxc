import './styles/main.css';
// https://ionicframework.com/docs/intro/cdn
import '../../node_modules/@ionic/core/css/core.css';
import '../../node_modules/@ionic/core/css/normalize.css';
import '../../node_modules/@ionic/core/css/structure.css';
import '../../node_modules/@ionic/core/css/typography.css';
import '../../node_modules/@ionic/core/css/padding.css';
import './components/chart-element';
import './components/loader-element';
import './components/ui/main-menu';
import './components/2d/map-element';
import './components/3d/map3d-element';

import { LatLonZ } from 'flyxc/common/src/runtime-track';
import { customElement, html, internalProperty, LitElement, TemplateResult } from 'lit-element';
import { classMap } from 'lit-html/directives/class-map.js';
import { connect } from 'pwa-helpers';

import esriConfig from '@arcgis/core/config';
import { NavigationHookResult } from '@ionic/core/dist/types/components/route/route-interface';

import { ionicInit } from './components/ui/ionic';
import { requestCurrentPosition } from './logic/geolocation';
import {
  addUrlParamValues,
  deleteUrlParam,
  getSearchParams,
  getUrlParamValues,
  ParamNames,
  pushCurrentState,
} from './logic/history';
import * as msg from './logic/messages';
import { downloadTracksByGroupIds, downloadTracksByUrls, uploadTracks } from './logic/track';
import { setTimeSec, setView3d } from './redux/app-slice';
import { setRoute, setSpeed } from './redux/planner-slice';
import * as sel from './redux/selectors';
import { RootState, store } from './redux/store';
import { removeTracksByGroupIds, setDisplayLabels } from './redux/track-slice';

@customElement('fly-xc')
export class FlyXc extends connect(store)(LitElement) {
  constructor() {
    super();
    // Add or remove tracks when the url changes.
    window.addEventListener('popstate', () => this.handlePopState());
    // Handle dropping tracks.
    document.body.ondrop = async (e: DragEvent): Promise<void> => await this.handleDrop(e);
    document.body.ondragover = (e: DragEvent): void => e.preventDefault();

    // Download initial tracks.
    Promise.all([
      downloadTracksByGroupIds(getUrlParamValues(ParamNames.groupId)),
      downloadTracksByUrls(getUrlParamValues(ParamNames.trackUrl)),
    ]).then(() => {
      store.dispatch(setDisplayLabels(sel.numTracks(store.getState()) > 1));
      // Remove the track urls as they will be replaced with ids.
      deleteUrlParam(ParamNames.trackUrl);
    });
  }

  protected render(): TemplateResult {
    return html`
      <ion-app>
        <ion-router .useHash=${false}>
          <ion-route component="maps-element">
            <ion-route url="/" component="map-element" .beforeEnter=${async () => this.before2d()}></ion-route>
            <ion-route url="/3d" component="map3d-element" .beforeEnter=${async () => this.before3d()}></ion-route>
          </ion-route>
          <ion-route
            url="/devices.html"
            component="devices-page"
            .beforeEnter=${async () => this.beforeDevices()}
          ></ion-route>
          <ion-route
            url="/admin.html"
            component="admin-page"
            .beforeEnter=${async () => this.beforeAdmin()}
          ></ion-route>
          <ion-route url="/:any" .beforeEnter=${async () => this.handleCatchAll()} component="x-301"></ion-route>
        </ion-router>
        <ion-nav .animated=${false}></ion-nav>
      </ion-app>
    `;
  }

  createRenderRoot(): Element {
    return this;
  }

  firstUpdated(): void {
    // The ionic router would not trigger the beforeEnter on initial navigation.
    // See https://github.com/ionic-team/ionic-framework/issues/22936
    customElements.whenDefined('ion-router').then(() => {
      // const router = this.renderRoot.querySelector('ion-router');
      // const location = document.location;
      // const target = `${location.pathname}${location.search}${location.hash}`;
      //router?.push(target, 'root');
    });
  }

  async handleCatchAll(): Promise<NavigationHookResult> {
    const params = getSearchParams();
    let href;
    if (params.has(ParamNames.view3d)) {
      href = '/3d';
      await this.before3d();
    } else {
      href = '/';
      await this.before2d();
    }
    params.delete(ParamNames.view3d);
    const searchQuery = params.toString();
    if (searchQuery.length > 0) {
      href += '?' + searchQuery;
    }
    return { redirect: href };
  }

  private async before2d(): Promise<NavigationHookResult> {
    await import('./components/2d/map-element');
    store.dispatch(setView3d(false));
    return true;
  }

  private async before3d(): Promise<NavigationHookResult> {
    await import('./components/3d/map3d-element');
    store.dispatch(setView3d(true));
    return true;
  }

  private async beforeDevices(): Promise<NavigationHookResult> {
    await import('./components/devices/devices-page');
    return true;
  }

  private async beforeAdmin(): Promise<NavigationHookResult> {
    await import('./components/admin/admin-page');
    return true;
  }

  private handlePopState(): void {
    // Handle added and removed tracks.
    const nextGroupIds = new Set(getUrlParamValues(ParamNames.groupId).map((txt) => Number(txt)));
    const currentGroupIds = sel.groupIds(store.getState());
    // Close all the tracks that have been removed.
    const removedTrackGroups = [...currentGroupIds].filter((id) => !nextGroupIds.has(id));
    if (removedTrackGroups.length) {
      store.dispatch(removeTracksByGroupIds(removedTrackGroups));
      msg.trackGroupsRemoved.emit(removedTrackGroups);
    }
    // Load all the tracks that have been added.
    downloadTracksByGroupIds([...nextGroupIds].filter((id) => !currentGroupIds.has(id)));
    store.dispatch(setView3d(getSearchParams().has(ParamNames.view3d)));

    // Update the route and speed.
    store.dispatch(setRoute(getUrlParamValues(ParamNames.route)[0] ?? ''));
    store.dispatch(setSpeed(Number(getUrlParamValues(ParamNames.speed)[0] ?? 20)));
  }

  // Load tracks dropped on the map.
  private async handleDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    const files: Array<File | null> = [];
    if (e.dataTransfer) {
      if (e.dataTransfer.items) {
        const items = e.dataTransfer.items;
        for (let i = 0; i < items.length; i++) {
          files.push(items[i].getAsFile());
        }
      } else if (e.dataTransfer.files) {
        const fileList = e.dataTransfer.files;
        for (let i = 0; i < fileList.length; i++) {
          files.push(fileList[i]);
        }
      }
    }
    const actualFiles = files.filter((file) => file != null) as File[];
    if (actualFiles.length) {
      const ids = await uploadTracks(actualFiles);
      pushCurrentState();
      addUrlParamValues(ParamNames.groupId, ids);
    }
  }
}

@customElement('maps-element')
export class MapsElement extends connect(store)(LitElement) {
  @internalProperty()
  private hasTrack = false;

  @internalProperty()
  private showLoader = false;

  stateChanged(state: RootState): void {
    this.hasTrack = sel.numTracks(state) > 0;
    this.showLoader = state.track.fetching || state.app.loadingApi;
  }

  render(): TemplateResult {
    const clMap = classMap({ 'has-tracks': this.hasTrack });

    return html`<ion-content id="main">
        <ion-nav .animated=${false} class=${clMap}></ion-nav>
        ${this.hasTrack
          ? html`<chart-element
              class=${clMap}
              @move=${(e: CustomEvent) => store.dispatch(setTimeSec(e.detail.timeSec))}
              @pin=${(e: CustomEvent) => msg.centerMap.emit(this.coordinatesAt(e.detail.timeSec))}
              @zoom=${(e: CustomEvent) =>
                msg.centerZoomMap.emit(this.coordinatesAt(e.detail.timeSec), { delta: e.detail.deltaY })}
            ></chart-element>`
          : ''}
      </ion-content>
      <main-menu></main-menu>
      <loader-element .show=${this.showLoader}></loader-element>`;
  }

  // Returns the coordinates of the active track at the given timestamp.
  private coordinatesAt(timeSec: number): LatLonZ {
    return sel.getTrackLatLonAlt(store.getState())(timeSec) as LatLonZ;
  }

  createRenderRoot(): HTMLElement {
    return this;
  }
}

requestCurrentPosition(false);

// Parent folder of the esri assets.
esriConfig.assetsPath = '/';

ionicInit();
