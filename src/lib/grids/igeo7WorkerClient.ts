import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
} from "./gridGeometryWorkerClient.ts";
import { GridGeometryWorkerMessageType } from "./gridGeometryWorkerProtocol.ts";
import type { TGridGeometryBatch } from "./gridWorkerTypes.ts";
import type {
  TIgeo7WorkerMetadata,
  TIgeo7WorkerRequest,
} from "./igeo7WorkerProtocol.ts";

type TIgeo7BuildRequest = Omit<TIgeo7WorkerRequest, "requestId" | "type">;

const client = createGridGeometryWorkerClient<
  TIgeo7WorkerRequest,
  TIgeo7WorkerMetadata
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
    onBatch: (batch: TGridGeometryBatch) => void;
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
