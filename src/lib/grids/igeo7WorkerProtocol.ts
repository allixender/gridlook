import type {
  TGridGeometryWorkerMetadata,
  TGridGeometryWorkerResponse,
} from "./gridGeometryWorkerProtocol.ts";
import type { TIgeo7GridDefinition } from "./igeo7Calculations.ts";

import type {
  TProjectionCenter,
  TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

export type TIgeo7WorkerRequest = {
  requestId: number;
  type: "build";
  grid: TIgeo7GridDefinition;
  cellIdRanges: BigUint64Array;
  data: Float32Array;
  // Refinement levels to go up before drawing; cell values are averaged.
  levelOffset: number;
  missingValue: number;
  fillValue: number;
  batchSize: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

export type TIgeo7WorkerMetadata = TGridGeometryWorkerMetadata & {
  // Centres (lat, lon) of a sample of the cells, known before any batch.
  extentLatLon: Float32Array;
};

export type TIgeo7WorkerResponse =
  TGridGeometryWorkerResponse<TIgeo7WorkerMetadata>;
