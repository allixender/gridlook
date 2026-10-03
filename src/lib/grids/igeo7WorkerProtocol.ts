import type { TGridGeometryWorkerResponse } from "./gridGeometryWorkerProtocol.ts";
import type { TGridPointBatch } from "./gridWorkerTypes.ts";
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
  batchSize: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

export type TIgeo7WorkerMetadata = {
  totalBatches: number;
  estimatedSpacing: number;
};

export type TIgeo7WorkerResponse = TGridGeometryWorkerResponse<
  TIgeo7WorkerMetadata,
  TGridPointBatch
>;
