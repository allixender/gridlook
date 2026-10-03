import { Webdggrid } from "webdggrid";

import type { TIgeo7GridDefinition } from "./igeo7Calculations.ts";

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

/** Geodetic (WGS84) cell centres for packed Z7 ids. */
export function buildIgeo7Centroids(
  engine: TIgeo7Engine,
  cellIds: BigUint64Array,
  level: number
) {
  const sequenceNums = new Array<bigint>(cellIds.length);
  for (let index = 0; index < cellIds.length; index++) {
    sequenceNums[index] = engine.z7ToSequenceNum(cellIds[index], level);
  }
  const centroids = engine.sequenceNumToGeo(sequenceNums, level);
  const latitudes = new Float64Array(cellIds.length);
  const longitudes = new Float64Array(cellIds.length);
  for (let index = 0; index < cellIds.length; index++) {
    longitudes[index] = centroids[index][0];
    // DGGRID works on the authalic sphere, IGEO7 cells are defined on WGS84.
    latitudes[index] = engine.igeo7AuthalicToGeo(centroids[index][1]);
  }
  return { latitudes, longitudes };
}
