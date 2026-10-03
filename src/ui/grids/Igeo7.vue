<script lang="ts" setup>
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { computed, onBeforeMount, onBeforeUnmount, ref } from "vue";
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
import type { TGridPointBatch } from "@/lib/grids/gridWorkerTypes.ts";
import { getIgeo7GridDefinition } from "@/lib/grids/igeo7Calculations.ts";
import {
  buildIgeo7Grid,
  terminateIgeo7Worker,
} from "@/lib/grids/igeo7WorkerClient.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  makeGpuProjectedPointMaterial,
  updateProjectionUniforms,
} from "@/lib/shaders/gridShaders.ts";
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

const estimatedSpacing = ref(0);
const BATCH_SIZE = 500000;
const MIN_POINT_SIZE = 1.5;
const MAX_POINT_SIZE = 64;
let points: THREE.Points[] = [];

const {
  getScene,
  getCamera,
  makeSnapshot,
  toggleRotate,
  applyCameraPreset,
  fitCameraToDataset,
  getDataVar,
  fetchDimensionDetails,
  registerUpdateLOD,
  updateLandSeaMask,
  updateColormap,
  projectionHelper,
  onProjectionChange,
  onColormapChange,
  redraw,
  canvas,
  box,
  updateHistogram,
  hoveredGeoPoint,
} = useSharedGridLogic();

const { setHoverLookupFromIndex, clearHoverLookup } =
  useGridHoverLookup(hoveredGeoPoint);

onColormapChange(() => updateColormap(points));
onProjectionChange(updatePointsProjectionUniforms);

function updatePointsProjectionUniforms() {
  const helper = projectionHelper.value;
  for (const pointBatch of points) {
    const material = pointBatch.material as THREE.ShaderMaterial;
    if (material.uniforms?.projectionType) {
      updateProjectionUniforms(material, helper);
    }
  }
  redraw();
}

const colormapMaterial = computed(() => {
  return invertColormap.value
    ? makeGpuProjectedPointMaterial(colormap.value, 1.0, -1.0)
    : makeGpuProjectedPointMaterial(colormap.value, 0.0, 1.0);
});

const scalarCache = useScalarFieldCache({
  updateHistogram,
  updateColormap: () => updateColormap(points),
  redraw,
});

const { datasourceUpdate } = useGridDataLoader({
  getDatasources: () => props.datasources,
  getDataVar,
  fetchAndRenderData,
  scalarCache,
  clearHoverLookup,
  updateLandSeaMask,
  updateColormap: () => updateColormap(points),
});

function cleanupPoints(totalBatches: number) {
  if (points.length <= totalBatches) {
    return;
  }
  for (const pointBatch of points) {
    pointBatch.geometry.dispose();
    getScene()?.remove(pointBatch);
  }
  points.length = 0;
}

function updateBatch(batch: TGridPointBatch) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(batch.positionValues, 3)
  );
  geometry.setAttribute(
    "latLon",
    new THREE.BufferAttribute(batch.latLonValues, 2)
  );
  geometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(batch.dataValues, 1)
  );
  geometry.computeBoundingSphere();
  if (points[batch.batchIndex]) {
    points[batch.batchIndex].geometry.dispose();
    points[batch.batchIndex].geometry = geometry;
    return;
  }
  const pointBatch = new THREE.Points(geometry, colormapMaterial.value);
  pointBatch.frustumCulled = false;
  points.push(pointBatch);
  getScene()?.add(pointBatch);
}

// Cells are far smaller than the globe, so a point is sized to cover the
// on-screen extent of one cell at the current camera altitude.
function updateLOD() {
  const camera = getCamera();
  if (!camera || !canvas.value) {
    return;
  }
  const altitude = projectionHelper.value.isFlat
    ? camera.position.z
    : camera.position.length() - 1;
  const visibleHeight =
    2 * altitude * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const pointSize =
    (estimatedSpacing.value * canvas.value.height) / visibleHeight;
  for (const pointBatch of points) {
    const material = pointBatch.material as THREE.ShaderMaterial;
    material.uniforms.basePointSize.value = pointSize;
    material.uniforms.minPointSize.value = MIN_POINT_SIZE;
    material.uniforms.maxPointSize.value = MAX_POINT_SIZE;
  }
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
  const helper = projectionHelper.value;
  const batches: TGridPointBatch[] = [];
  let spacing = estimatedSpacing.value;
  const result = await buildIgeo7Grid(
    {
      grid: getIgeo7GridDefinition(metadata),
      cellIdRanges,
      data: rawData,
      batchSize: BATCH_SIZE,
      projectionType: helper.type,
      projectionCenter: { lat: helper.center.lat, lon: helper.center.lon },
    },
    {
      onMetadata: (workerMetadata) => {
        spacing = workerMetadata.estimatedSpacing;
      },
      onBatch: (batch) => batches.push(batch),
    }
  );
  const hoverIndex = createSerializedGeoSampleIndex(result.hoverIndexData);
  if (!isCurrent()) {
    return;
  }
  const dimInfo = await getDimensionValues(dimensionRanges, indices);
  if (!isCurrent()) {
    return;
  }
  scalarCache.captureScalar({
    render: () => {
      cleanupPoints(batches.length);
      batches.forEach(updateBatch);
      estimatedSpacing.value = spacing;
      updatePointsProjectionUniforms();
      fitCameraToDataset(points);
      updateLOD();
      setHoverLookupFromIndex(hoverIndex, fillValue, missingValue);
    },
    info: {
      attrs: datavar.attrs,
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
  await scalarCache.restoreScalar();
}

onBeforeMount(async () => {
  await datasourceUpdate();
  registerUpdateLOD(updateLOD);
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
