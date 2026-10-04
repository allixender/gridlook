/// <reference lib="webworker" />

import { buildSerializedGeoSampleIndexData } from "./gridWorkerCalculations.ts";
import {
  buildIgeo7Batch,
  buildIgeo7RangeIndex,
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

async function buildCellGeometry(request: TIgeo7WorkerRequest) {
  const { level } = request.grid;
  const index = buildIgeo7RangeIndex(request.cellIdRanges, level);
  if (index.cellCount !== request.data.length) {
    throw new Error(
      `IGEO7 cell id ranges describe ${index.cellCount} cells but data has ${request.data.length} values.`
    );
  }
  const cellIds = expandIgeo7Ranges(index);
  const engine = await getEngine(request.grid);
  return {
    centres: buildIgeo7Centroids(engine, cellIds, level),
    rings: buildIgeo7CellRings(engine, cellIds, level),
  };
}

async function buildGrid(request: TIgeo7WorkerRequest) {
  const { centres, rings } = await buildCellGeometry(request);
  const totalBatches = getIgeo7BatchCount(
    request.data.length,
    request.batchSize
  );
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { totalBatches },
  });
  postGridGeometryHoverIndex(
    workerScope,
    request.requestId,
    buildSerializedGeoSampleIndexData(
      centres.latitudes,
      centres.longitudes,
      request.data.slice()
    )
  );
  const projection = new ProjectionHelper(
    request.projectionType,
    request.projectionCenter
  );
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    postGridGeometryBatch(
      workerScope,
      request.requestId,
      buildIgeo7Batch(
        rings,
        request.data,
        batchIndex,
        request.batchSize,
        projection
      )
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
