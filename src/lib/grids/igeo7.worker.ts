/// <reference lib="webworker" />

import { buildSerializedGeoSampleIndexData } from "./gridWorkerCalculations.ts";
import {
  buildIgeo7Batch,
  buildIgeo7RangeIndex,
  coarsenIgeo7Cells,
  expandIgeo7Ranges,
  getIgeo7BatchCount,
  type TIgeo7GridDefinition,
} from "./igeo7Calculations.ts";
import {
  buildIgeo7CellRings,
  buildIgeo7Centroids,
  loadIgeo7Engine,
  type TIgeo7Engine,
} from "./igeo7Geometry.ts";
import type {
  TIgeo7WorkerRequest,
  TIgeo7WorkerResponse,
} from "./igeo7WorkerProtocol.ts";

import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import {
  postGridGeometryBatch,
  postGridGeometryHoverIndex,
  postGridGeometryResponse,
} from "@/lib/grids/gridGeometryWorkerUtils.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

let engine: { key: string; loaded: Promise<TIgeo7Engine> } | undefined;

function getEngine(grid: TIgeo7GridDefinition) {
  const key = JSON.stringify(grid);
  if (engine?.key !== key) {
    engine = { key, loaded: loadIgeo7Engine(grid) };
  }
  return engine.loaded;
}

function postResponse(
  response: TIgeo7WorkerResponse,
  transfer: Transferable[] = []
) {
  postGridGeometryResponse(workerScope, response, transfer);
}

const EXTENT_SAMPLE_COUNT = 256;

function getDisplayedCells(request: TIgeo7WorkerRequest) {
  const index = buildIgeo7RangeIndex(request.cellIdRanges, request.grid.level);
  if (index.cellCount !== request.data.length) {
    throw new Error(
      `IGEO7 cell id ranges describe ${index.cellCount} cells but data has ${request.data.length} values.`
    );
  }
  const displayed = coarsenIgeo7Cells(
    index,
    request.data,
    request.levelOffset,
    request.missingValue,
    request.fillValue
  );
  return {
    level: displayed.index.level,
    cellIds: expandIgeo7Ranges(displayed.index),
    data: displayed.data,
  };
}

function buildExtentSample(
  engine: TIgeo7Engine,
  cellIds: BigUint64Array,
  level: number
) {
  const stride = Math.ceil(cellIds.length / EXTENT_SAMPLE_COUNT);
  const sample = cellIds.filter((_, cell) => cell % stride === 0);
  const { latitudes, longitudes } = buildIgeo7Centroids(engine, sample, level);
  const latLon = new Float32Array(sample.length * 2);
  for (let cell = 0; cell < sample.length; cell++) {
    latLon[cell * 2] = latitudes[cell];
    latLon[cell * 2 + 1] = longitudes[cell];
  }
  return latLon;
}

async function buildGrid(request: TIgeo7WorkerRequest) {
  const { level, cellIds, data } = getDisplayedCells(request);
  const engine = await getEngine(request.grid);
  const totalBatches = getIgeo7BatchCount(cellIds.length, request.batchSize);
  const extentLatLon = buildExtentSample(engine, cellIds, level);
  postResponse(
    {
      requestId: request.requestId,
      type: GridGeometryWorkerMessageType.METADATA,
      metadata: { totalBatches, extentLatLon },
    },
    [extentLatLon.buffer]
  );
  const projection = new ProjectionHelper(
    request.projectionType,
    request.projectionCenter
  );
  const latitudes = new Float64Array(cellIds.length);
  const longitudes = new Float64Array(cellIds.length);
  // Batches are posted as soon as they are built, so they can be drawn
  // while the geometry of the remaining cells is still being computed.
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * request.batchSize;
    const batchIds = cellIds.subarray(start, start + request.batchSize);
    const centres = buildIgeo7Centroids(engine, batchIds, level);
    latitudes.set(centres.latitudes, start);
    longitudes.set(centres.longitudes, start);
    postGridGeometryBatch(
      workerScope,
      request.requestId,
      buildIgeo7Batch(
        buildIgeo7CellRings(engine, batchIds, level),
        data.subarray(start, start + request.batchSize),
        batchIndex,
        projection
      )
    );
  }
  postGridGeometryHoverIndex(
    workerScope,
    request.requestId,
    buildSerializedGeoSampleIndexData(latitudes, longitudes, data.slice())
  );
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.DONE,
  });
}

workerScope.onmessage = async (event: MessageEvent<TIgeo7WorkerRequest>) => {
  try {
    await buildGrid(event.data);
  } catch (error) {
    postResponse({
      requestId: event.data.requestId,
      type: GridGeometryWorkerMessageType.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
