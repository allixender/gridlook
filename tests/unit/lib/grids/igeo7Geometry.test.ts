import { expect, it } from "vitest";

import fixture from "../../../fixtures/igeo7/pori_z7_r10.json";

import {
  buildIgeo7RangeIndex,
  expandIgeo7Ranges,
  getIgeo7GridDefinition,
  isIgeo7PhantomSlot,
  monotonicToZ7,
} from "@/lib/grids/igeo7Calculations.ts";
import {
  buildIgeo7CellRings,
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
      sequenceNumToGrid: () => [],
      igeo7AuthalicToGeo: (latitude) => latitude,
    },
    BigUint64Array.of(BigInt(cell.z7)),
    grid.level
  );

  expect(Math.abs(latitudes[0] - cell.lat)).toBeGreaterThan(0.1);
});

it("returns the corners of the reference hexagons", async () => {
  const engine = await loadIgeo7Engine(grid);
  const cellIds = BigUint64Array.from(fixture.cells, (cell) => BigInt(cell.z7));

  const rings = buildIgeo7CellRings(engine, cellIds, grid.level);

  expect(rings.offsets).toHaveLength(fixture.cells.length + 1);
  fixture.cells.forEach((cell, cellIndex) => {
    // The reference ring repeats its first corner at the end.
    const expected = cell.ring.slice(0, -1);
    const cornerCount = rings.offsets[cellIndex + 1] - rings.offsets[cellIndex];
    expect(cornerCount).toBe(expected.length);
    for (let corner = 0; corner < cornerCount; corner++) {
      const longitude = rings.longitudes[rings.offsets[cellIndex] + corner];
      const latitude = rings.latitudes[rings.offsets[cellIndex] + corner];
      // Corner order and start are not part of the contract.
      const distances = expected.map(([lon, lat]) =>
        Math.hypot(lon - longitude, lat - latitude)
      );
      expect(distances.some((distance) => distance < 1e-8)).toBe(true);
    }
  });
});

it("agrees with DGGRID on which slots of the number line are cells", async () => {
  const engine = (await loadIgeo7Engine(grid)) as Awaited<
    ReturnType<typeof loadIgeo7Engine>
  > & { sequenceNumToZ7(sequenceNum: bigint, resolution: number): bigint };
  const globalLevel = 3;
  let cells = 0;
  const outcomes = new Map<string, number>();

  for (let slot = 0; slot < 12 * 7 ** globalLevel; slot++) {
    const z7 = monotonicToZ7(slot, globalLevel);
    let outcome = "throws";
    try {
      const sequenceNum = engine.z7ToSequenceNum(z7, globalLevel);
      const back = BigInt.asUintN(
        64,
        engine.sequenceNumToZ7(sequenceNum, globalLevel)
      );
      outcome = back === z7 ? "cell" : "other cell";
    } catch {
      // DGGRID rejects the id
    }
    const phantom = isIgeo7PhantomSlot(slot, globalLevel);
    outcomes.set(
      `${phantom ? "phantom" : "real"}: ${outcome}`,
      (outcomes.get(`${phantom ? "phantom" : "real"}: ${outcome}`) ?? 0) + 1
    );
    cells += phantom ? 0 : 1;
  }

  expect(cells).toBe(10 * 7 ** globalLevel + 2);
  expect(outcomes.get("real: cell")).toBe(cells);
  expect(outcomes.get("phantom: cell")).toBeUndefined();
});
