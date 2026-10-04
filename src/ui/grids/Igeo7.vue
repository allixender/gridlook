<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount } from "vue";
import * as zarr from "zarrita";

import { useGridHoverLookup } from "./composables/gridHoverUtils.ts";
import { useGridDataLoader } from "./composables/useGridDataLoader.ts";
import { useScalarFieldCache } from "./composables/useScalarFieldCache.ts";
import { useSharedGridLogic } from "./composables/useSharedGridLogic.ts";

import { buildDimensionRangesAndIndices } from "@/lib/data/dimensionHandling.ts";
import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
} from "@/lib/data/variableDecoding.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  getGridVariableData,
  terminateGridDataWorker,
} from "@/lib/grids/gridDataWorkerClient.ts";
import type { TGridGeometryBatch } from "@/lib/grids/gridWorkerTypes.ts";
import {
  buildIgeo7RangeIndex,
  chooseIgeo7LevelOffset,
  getIgeo7GridDefinition,
} from "@/lib/grids/igeo7Calculations.ts";
import {
  buildIgeo7Grid,
  terminateIgeo7Worker,
} from "@/lib/grids/igeo7WorkerClient.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  createTriangleWrapProjectionGeometry,
  createWrappedProjectionMesh,
  setupProjectionGeometryWrap,
  updateProjectionMeshes,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { makeInvertableGpuMeshMaterial } from "@/lib/shaders/gridShaders.ts";
import type {
  TDimensionRange,
  TSources,
  TZarrDggsMetadata,
} from "@/lib/types/GlobeTypes.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { dimSlidersValues, colormap, varnameSelector, invertColormap, varinfo } =
  storeToRefs(store);
const urlParameterStore = useUrlParameterStore();
const { paramDimIndices, paramDimMinBounds, paramDimMaxBounds } =
  storeToRefs(urlParameterStore);

// Cells per mesh. Small enough that the first cells appear quickly.
const BATCH_SIZE = 10000;
// Finer data is drawn at the coarsest ancestor level that fits this budget.
const MAX_CELLS = 250000;
let meshes: THREE.Mesh[] = [];

const {
  getScene,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  fitCameraToDataset,
  getDataVar,
  fetchDimensionDetails,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  isSceneInMotion,
  onProjectionChange,
  onMotionStateChange,
  onColormapChange,
  redraw,
  canvas,
  box,
  updateHistogram,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookupFromIndex, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

onColormapChange(() => updateColormap(meshes));
onProjectionChange(updateMeshProjectionUniforms);
onMotionStateChange(updateMeshProjectionUniforms);

function updateMeshProjectionUniforms() {
  updateProjectionMeshes(meshes, {
    redraw,
    projectionHelper: projectionHelper.value,
    isSceneInMotion: isSceneInMotion.value,
  });
}

const colormapMaterial = computed(() => {
  const material = makeInvertableGpuMeshMaterial(
    colormap.value,
    invertColormap.value
  );
  material.uniforms.useTriangleWrapCull.value = 1;
  return material;
});

const scalarCache = useScalarFieldCache({
  updateHistogram,
  updateColormap: () => updateColormap(meshes),
  redraw,
});

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  scalarCache,
  clearHoverLookup,
  updateLandSeaMask,
  updateColormap: () => updateColormap(meshes),
});

function removeMeshes() {
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    getScene()?.remove(mesh);
  }
  meshes.length = 0;
}

function createBatchGeometry(batch: TGridGeometryBatch) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(batch.positionValues, 3)
  );
  geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(batch.dataValues, 1)
  );
  geometry.setAttribute(
    "latLon",
    new THREE.BufferAttribute(batch.latLonValues, 2)
  );
  geometry.setIndex(new THREE.BufferAttribute(batch.indices, 1));
  return createTriangleWrapProjectionGeometry(geometry);
}

function updateBatchMesh(batch: TGridGeometryBatch) {
  const geometry = createBatchGeometry(batch);
  setupProjectionGeometryWrap(geometry);
  if (meshes[batch.batchIndex]) {
    meshes[batch.batchIndex].geometry.dispose();
    meshes[batch.batchIndex].geometry = geometry;
    return;
  }
  const mesh = createWrappedProjectionMesh(
    geometry,
    colormapMaterial.value,
    projectionHelper.value.type
  );
  mesh.frustumCulled = false;
  meshes.push(mesh);
  getScene()?.add(mesh);
}

function fitCameraToExtent(extentLatLon: Float32Array) {
  fitCameraToDataset([
    {
      geometry: new THREE.BufferGeometry().setAttribute(
        "latLon",
        new THREE.BufferAttribute(extentLatLon, 2)
      ),
    },
  ]);
}

function getDisplayedAttributes(
  attrs: zarr.Attributes,
  level: number,
  levelOffset: number
) {
  if (levelOffset === 0) {
    return attrs;
  }
  const name = (attrs.long_name as string) ?? varnameSelector.value;
  return {
    ...attrs,
    ["long_name"]: `${name} (mean per level ${level - levelOffset} cell, data at level ${level})`,
  };
}

async function getDggsMetadata() {
  const metadata = await ZarrDataManager.getDggsMetadata(
    props.datasources!,
    varnameSelector.value
  );
  if (!metadata?.coordinate) {
    throw new Error("IGEO7 metadata does not name the cell id coordinate.");
  }
  return metadata as TZarrDggsMetadata & { coordinate: string };
}

function fetchVariableData(
  variable: string,
  selection: (number | null | zarr.Slice)[]
) {
  return getGridVariableData({
    source: ZarrDataManager.getDatasetSource(
      props.datasources!,
      varnameSelector.value
    ),
    variable,
    format: props.datasources!.zarr_format,
    selection,
  });
}

async function fetchCellIdRanges(coordinate: string) {
  const ranges = await fetchVariableData(
    ZarrDataManager.resolveVariablePath(varnameSelector.value, coordinate),
    []
  );
  if (!(ranges instanceof BigUint64Array)) {
    throw new Error(`IGEO7 cell id ranges in ${coordinate} are not uint64.`);
  }
  return ranges;
}

async function buildDimensionConfig(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  spatialDimension: string | undefined
) {
  const dimensions = await ZarrDataManager.getDimensionNames(
    props.datasources!,
    varnameSelector.value
  );
  const spatialIndex = dimensions.indexOf(spatialDimension ?? "");
  return buildDimensionRangesAndIndices(
    datavar,
    dimensions,
    paramDimIndices.value,
    paramDimMinBounds.value,
    paramDimMaxBounds.value,
    dimSlidersValues.value.length > 0 ? dimSlidersValues.value : null,
    [spatialIndex === -1 ? datavar.shape.length - 1 : spatialIndex],
    varinfo.value?.dimRanges
  );
}

async function getDimensionValues(
  dimensionRanges: TDimensionRange[],
  indices: (number | zarr.Slice | null)[]
) {
  return await fetchDimensionDetails(
    varnameSelector.value,
    props.datasources!,
    dimensionRanges,
    indices
  );
}

/* eslint-disable-next-line max-lines-per-function */
async function fetchAndRenderData(
  datavar: zarr.Array<zarr.DataType, zarr.AsyncReadable>,
  isCurrent: () => boolean
) {
  const metadata = await getDggsMetadata();
  const { dimensionRanges, indices } = await buildDimensionConfig(
    datavar,
    metadata.spatial_dimension
  );
  const [variableData, cellIdRanges] = await Promise.all([
    fetchVariableData(varnameSelector.value, indices),
    fetchCellIdRanges(metadata.coordinate),
  ]);
  const rawData = castDataVarToFloat32(variableData);
  if (!isCurrent()) {
    return;
  }
  const { min, max, fillValue, missingValue } = decodeVariableDataAndGetBounds(
    datavar,
    rawData
  );
  const dimInfo = await getDimensionValues(dimensionRanges, indices);
  if (!isCurrent()) {
    return;
  }
  const grid = getIgeo7GridDefinition(metadata);
  const levelOffset = chooseIgeo7LevelOffset(
    buildIgeo7RangeIndex(cellIdRanges, grid.level),
    MAX_CELLS
  );
  const helper = projectionHelper.value;
  const batches: TGridGeometryBatch[] = [];
  let displayed = false;
  const build = buildIgeo7Grid(
    {
      grid,
      cellIdRanges,
      data: rawData,
      levelOffset,
      missingValue,
      fillValue,
      batchSize: BATCH_SIZE,
      projectionType: helper.type,
      projectionCenter: { lat: helper.center.lat, lon: helper.center.lon },
    },
    {
      onMetadata: ({ extentLatLon }) => {
        if (isCurrent()) {
          fitCameraToExtent(extentLatLon);
        }
      },
      // Batches arriving after the scalar is on screen are drawn right away.
      onBatch: (batch) => {
        batches.push(batch);
        if (displayed && isCurrent()) {
          updateBatchMesh(batch);
          updateColormap(meshes);
          updateMeshProjectionUniforms();
        }
      },
    }
  );
  scalarCache.captureScalar({
    render: () => {
      removeMeshes();
      batches.forEach(updateBatchMesh);
      displayed = true;
      updateMeshProjectionUniforms();
    },
    info: {
      attrs: getDisplayedAttributes(datavar.attrs, grid.level, levelOffset),
      dimInfo,
      bounds: { low: min, high: max },
      dimRanges: dimensionRanges,
    },
    indices: indices as number[],
    data: rawData,
    missingValue,
    fillValue,
    isCurrent,
  });
  const [result] = await Promise.all([build, scalarCache.restoreScalar()]);
  if (isCurrent()) {
    setHoverLookupFromIndex(
      createSerializedGeoSampleIndex(result.hoverIndexData),
      fillValue,
      missingValue
    );
  }
}

onBeforeMount(async () => {
  await datasourceUpdate();
});

onBeforeUnmount(() => {
  terminateIgeo7Worker();
  terminateGridDataWorker();
});

defineExpose({ makeSnapshot, toggleRotate, applyCameraPreset });
</script>

<template>
  <div ref="box" class="globe_box" tabindex="0" autofocus>
    <canvas ref="canvas" class="globe_canvas"> </canvas>
  </div>
</template>
