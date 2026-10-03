/// <reference lib="webworker" />

import {
  buildIgeo7RangeIndex,
  expandIgeo7Ranges,
  type TIgeo7GridDefinition,
} from "./igeo7Calculations.ts";
import {
  buildIgeo7Centroids,
  loadIgeo7Engine,
  type TIgeo7Engine,
} from "./igeo7Geometry.ts";
import type {
  TIgeo7WorkerRequest,
  TIgeo7WorkerResponse,
} from "./igeo7WorkerProtocol.ts";
import {
  buildIrregularBatch,
  buildIrregularGridData,
  buildIrregularHoverIndexData,
  getIrregularBatchCount,
} from "./irregularCalculations.ts";

import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import {
  postGridGeometryHoverIndex,
  postGridGeometryResponse,
  postGridPointBatch,
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

async function buildCellCentres(request: TIgeo7WorkerRequest) {
  const index = buildIgeo7RangeIndex(request.cellIdRanges, request.grid.level);
  if (index.cellCount !== request.data.length) {
    throw new Error(
      `IGEO7 cell id ranges describe ${index.cellCount} cells but data has ${request.data.length} values.`
    );
  }
  return buildIgeo7Centroids(
    await getEngine(request.grid),
    expandIgeo7Ranges(index),
    request.grid.level
  );
}

async function buildGrid(request: TIgeo7WorkerRequest) {
  const { latitudes, longitudes } = await buildCellCentres(request);
  const cellCount = request.data.length;
  const grid = buildIrregularGridData(
    Float32Array.from(latitudes),
    Float32Array.from(longitudes),
    [cellCount],
    [cellCount],
    request.data,
    new ProjectionHelper(request.projectionType, request.projectionCenter)
  );
  const totalBatches = getIrregularBatchCount(grid, request.batchSize);
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { totalBatches, estimatedSpacing: grid.estimatedSpacing },
  });
  postGridGeometryHoverIndex(
    workerScope,
    request.requestId,
    buildIrregularHoverIndexData(grid)
  );
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    postGridPointBatch(
      workerScope,
      request.requestId,
      buildIrregularBatch(grid, batchIndex, request.batchSize)
    );
  }
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
