import { Webdggrid } from "webdggrid";

import type {
  TIgeo7CellRings,
  TIgeo7GridDefinition,
} from "./igeo7Calculations.ts";

// The part of a loaded webdggrid instance used here. The package declares
// `load()` as returning the class instead of an instance.
export type TIgeo7Engine = {
  setDggs(
    dggs: {
      poleCoordinates: { lat: number; lng: number };
      azimuth: number;
      topology: string;
      projection: string;
      aperture: number;
    },
    resolution: number
  ): void;
  z7ToSequenceNum(z7: bigint, resolution: number): bigint;
  sequenceNumToGeo(sequenceNums: bigint[], resolution: number): number[][];
  sequenceNumToGrid(
    sequenceNums: bigint[],
    resolution: number,
    unwrap: boolean
  ): number[][][];
  igeo7AuthalicToGeo(latitude: number): number;
};

export async function loadIgeo7Engine(grid: TIgeo7GridDefinition) {
  const engine = (await Webdggrid.load()) as unknown as
    TIgeo7Engine | undefined;
  if (!engine) {
    throw new Error("Could not load the DGGRID WebAssembly module.");
  }
  engine.setDggs(
    {
      poleCoordinates: { lat: grid.vert0Lat, lng: grid.vert0Lon },
      azimuth: grid.vert0Azimuth,
      topology: "HEXAGON",
      projection: "ISEA",
      aperture: 7,
    },
    grid.level
  );
  return engine;
}

function getSequenceNums(
  engine: TIgeo7Engine,
  cellIds: BigUint64Array,
  level: number
) {
  const sequenceNums = new Array<bigint>(cellIds.length);
  for (let index = 0; index < cellIds.length; index++) {
    sequenceNums[index] = engine.z7ToSequenceNum(cellIds[index], level);
  }
  return sequenceNums;
}

/** Geodetic (WGS84) cell centres for packed Z7 ids. */
export function buildIgeo7Centroids(
  engine: TIgeo7Engine,
  cellIds: BigUint64Array,
  level: number
) {
  const centroids = engine.sequenceNumToGeo(
    getSequenceNums(engine, cellIds, level),
    level
  );
  const latitudes = new Float64Array(cellIds.length);
  const longitudes = new Float64Array(cellIds.length);
  for (let index = 0; index < cellIds.length; index++) {
    longitudes[index] = centroids[index][0];
    // DGGRID works on the authalic sphere, IGEO7 cells are defined on WGS84.
    latitudes[index] = engine.igeo7AuthalicToGeo(centroids[index][1]);
  }
  return { latitudes, longitudes };
}

/** Geodetic (WGS84) cell corners for packed Z7 ids. */
export function buildIgeo7CellRings(
  engine: TIgeo7Engine,
  cellIds: BigUint64Array,
  level: number
): TIgeo7CellRings {
  const rings = engine.sequenceNumToGrid(
    getSequenceNums(engine, cellIds, level),
    level,
    false
  );
  const offsets = new Uint32Array(rings.length + 1);
  for (let cell = 0; cell < rings.length; cell++) {
    // DGGRID repeats the first corner at the end of each ring.
    offsets[cell + 1] = offsets[cell] + rings[cell].length - 1;
  }
  const latitudes = new Float64Array(offsets[rings.length]);
  const longitudes = new Float64Array(offsets[rings.length]);
  for (let cell = 0; cell < rings.length; cell++) {
    const cornerCount = offsets[cell + 1] - offsets[cell];
    for (let corner = 0; corner < cornerCount; corner++) {
      longitudes[offsets[cell] + corner] = rings[cell][corner][0];
      latitudes[offsets[cell] + corner] = engine.igeo7AuthalicToGeo(
        rings[cell][corner][1]
      );
    }
  }
  return { latitudes, longitudes, offsets };
}
