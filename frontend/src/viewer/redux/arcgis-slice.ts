import type GraphicsLayer from 'esri/layers/GraphicsLayer';
import type ElevationSampler from 'esri/layers/support/ElevationSampler';

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

type ArcgisState = {
  // Altitude exaggeration multiplier for 3d.
  altMultiplier: number;
  // Pilots, tracks, ...
  graphicsLayer?: GraphicsLayer;
  // Graphics layer with elevation mode "on-the-ground" for shadows.
  gndGraphicsLayer?: GraphicsLayer;
  // Graphics layer for the curtain.
  curtainGraphicsLayer?: GraphicsLayer;
  // Sample ground elevation in the SceneView (takes the exaggeration into account).
  elevationSampler?: ElevationSampler;
};

const initialState: ArcgisState = {
  altMultiplier: 1,
};

const arcgisSlice = createSlice({
  name: 'arcgis',
  initialState,
  reducers: {
    setGraphicsLayer: (state, action: PayloadAction<GraphicsLayer | undefined>) => {
      state.graphicsLayer = action.payload;
    },
    setGndGraphicsLayer: (state, action: PayloadAction<GraphicsLayer | undefined>) => {
      state.gndGraphicsLayer = action.payload;
    },
    setCurtainGraphicsLayer: (state, action: PayloadAction<GraphicsLayer | undefined>) => {
      state.curtainGraphicsLayer = action.payload;
    },
    setAltitudeMultiplier: (state, action: PayloadAction<number>) => {
      state.altMultiplier = action.payload;
    },
    setElevationSampler: (state, action: PayloadAction<ElevationSampler | undefined>) => {
      state.elevationSampler = action.payload;
    },
  },
});

export const reducer = arcgisSlice.reducer;
export const {
  setAltitudeMultiplier,
  setElevationSampler,
  setGraphicsLayer,
  setGndGraphicsLayer,
  setCurtainGraphicsLayer,
} = arcgisSlice.actions;
