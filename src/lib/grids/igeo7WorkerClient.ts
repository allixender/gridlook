import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
} from "./gridGeometryWorkerClient.ts";
import { GridGeometryWorkerMessageType } from "./gridGeometryWorkerProtocol.ts";
import type { TGridPointBatch } from "./gridWorkerTypes.ts";
import type { TIgeo7GridDefinition } from "./igeo7Calculations.ts";
import type {
  TIgeo7WorkerMetadata,
  TIgeo7WorkerRequest,
} from "./igeo7WorkerProtocol.ts";

import type {
  TProjectionCenter,
  TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

type TIgeo7BuildRequest = {
  grid: TIgeo7GridDefinition;
  cellIdRanges: BigUint64Array;
  data: Float32Array;
  batchSize: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

const client = createGridGeometryWorkerClient<
  TIgeo7WorkerRequest,
  TIgeo7WorkerMetadata,
  TGridPointBatch
>(
  () =>
    new Worker(new URL("./igeo7.worker.ts", import.meta.url), {
      type: "module",
    })
);

export function buildIgeo7Grid(
  request: TIgeo7BuildRequest,
  callbacks: {
    onMetadata: (metadata: TIgeo7WorkerMetadata) => void;
    onBatch: (batch: TGridPointBatch) => void;
  }
) {
  return client.build((requestId) => {
    const cellIdRanges = request.cellIdRanges.slice();
    const data = copyGridWorkerArray(request.data);
    return {
      message: {
        ...request,
        requestId,
        type: GridGeometryWorkerMessageType.BUILD,
        grid: { ...request.grid },
        cellIdRanges,
        data,
        projectionCenter: {
          lat: request.projectionCenter.lat,
          lon: request.projectionCenter.lon,
        },
      },
      transfer: [cellIdRanges.buffer, data.buffer],
    };
  }, callbacks);
}

export const terminateIgeo7Worker = client.terminate;
