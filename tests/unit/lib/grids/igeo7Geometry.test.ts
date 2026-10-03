import { expect, it } from "vitest";

import fixture from "../../../fixtures/igeo7/pori_z7_r10.json";

import {
  buildIgeo7RangeIndex,
  expandIgeo7Ranges,
  getIgeo7GridDefinition,
} from "@/lib/grids/igeo7Calculations.ts";
import {
  buildIgeo7Centroids,
  loadIgeo7Engine,
} from "@/lib/grids/igeo7Geometry.ts";
import type { TZarrDggsMetadata } from "@/lib/types/GlobeTypes.ts";

// Reference values from the Python implementation (xdggs-dggrid4py / DGGRID).
const grid = getIgeo7GridDefinition(
  fixture.dggs as unknown as TZarrDggsMetadata
);
const rangeTable = BigUint64Array.from(fixture.ranges.flat(), (id) =>
  BigInt(id)
);

it("places all cells where the reference implementation does", async () => {
  const engine = await loadIgeo7Engine(grid);
  const cellIds = expandIgeo7Ranges(
    buildIgeo7RangeIndex(rangeTable, grid.level)
  );

  const { latitudes, longitudes } = buildIgeo7Centroids(
    engine,
    cellIds,
    grid.level
  );

  expect(latitudes).toHaveLength(fixture.cellCount);
  for (const cell of fixture.cells) {
    expect(longitudes[cell.position]).toBeCloseTo(cell.lon, 9);
    expect(latitudes[cell.position]).toBeCloseTo(cell.lat, 9);
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (let index = 0; index < latitudes.length; index++) {
    minLat = Math.min(minLat, latitudes[index]);
    maxLat = Math.max(maxLat, latitudes[index]);
    minLon = Math.min(minLon, longitudes[index]);
    maxLon = Math.max(maxLon, longitudes[index]);
  }
  expect(minLat).toBeCloseTo(fixture.bbox.minLat, 9);
  expect(maxLat).toBeCloseTo(fixture.bbox.maxLat, 9);
  expect(minLon).toBeCloseTo(fixture.bbox.minLon, 9);
  expect(maxLon).toBeCloseTo(fixture.bbox.maxLon, 9);
});

it("shifts cells when the authalic conversion is skipped", async () => {
  const engine = await loadIgeo7Engine(grid);
  const cell = fixture.cells[0];

  const { latitudes } = buildIgeo7Centroids(
    {
      setDggs: () => undefined,
      z7ToSequenceNum: (z7, resolution) =>
        engine.z7ToSequenceNum(z7, resolution),
      sequenceNumToGeo: (sequenceNums, resolution) =>
        engine.sequenceNumToGeo(sequenceNums, resolution),
      igeo7AuthalicToGeo: (latitude) => latitude,
    },
    BigUint64Array.of(BigInt(cell.z7)),
    grid.level
  );

  expect(Math.abs(latitudes[0] - cell.lat)).toBeGreaterThan(0.1);
});
