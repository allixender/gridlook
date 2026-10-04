import { expect, it } from "vitest";

import fixture from "../../../fixtures/igeo7/pori_z7_r10.json";

import {
  buildIgeo7Batch,
  buildIgeo7RangeIndex,
  chooseIgeo7LevelOffset,
  coarsenIgeo7Cells,
  expandIgeo7Ranges,
  getIgeo7BatchCount,
  getIgeo7GridDefinition,
  monotonicToZ7,
  z7ToMonotonic,
} from "@/lib/grids/igeo7Calculations.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";
import type { TZarrDggsMetadata } from "@/lib/types/GlobeTypes.ts";

// Reference values from the Python implementation (xdggs-dggrid4py / DGGRID).
const dggs = fixture.dggs as unknown as TZarrDggsMetadata;
const level = dggs.refinement_level;
const rangeTable = BigUint64Array.from(fixture.ranges.flat(), (id) =>
  BigInt(id)
);

it("converts packed Z7 ids to monotonic integers and back", () => {
  expect(z7ToMonotonic(0x4240403fffffffn, 10)).toBe(6033909);
  expect(z7ToMonotonic(0x4040165bffffffn, 12)).toBe(284125838);
  expect(monotonicToZ7(6033909, 10)).toBe(0x4240403fffffffn);
  expect(monotonicToZ7(284125838, 12)).toBe(0x4040165bffffffn);
  for (const cell of fixture.cells) {
    expect(z7ToMonotonic(BigInt(cell.z7), level)).toBe(cell.mono);
    expect(monotonicToZ7(cell.mono, level)).toBe(BigInt(cell.z7));
  }
});

it("keeps the base cell in the top four bits", () => {
  const z7 = monotonicToZ7(11 * 7 ** 3 + 5, 3);

  expect(z7 >> 60n).toBe(11n);
  expect(z7ToMonotonic(z7, 3)).toBe(11 * 7 ** 3 + 5);
});

it("rejects ids and values outside the refinement level", () => {
  expect(() => z7ToMonotonic(0x4240403fffffffn, 11)).toThrow("coarser");
  expect(() => monotonicToZ7(12 * 7 ** 2, 2)).toThrow("out of range");
  expect(() => buildIgeo7RangeIndex(new BigUint64Array(0), 17)).toThrow(
    "not supported"
  );
});

it("indexes the range table in data order", () => {
  const index = buildIgeo7RangeIndex(rangeTable, level);

  expect(index.cellCount).toBe(fixture.cellCount);
  expect(index.offsets).toHaveLength(fixture.ranges.length + 1);
  expect(index.offsets[0]).toBe(0);
  expect(index.startMonotonic[0]).toBe(6033909);
});

it("expands the ranges to the reference cell ids", () => {
  const cellIds = expandIgeo7Ranges(buildIgeo7RangeIndex(rangeTable, level));

  expect(cellIds).toHaveLength(fixture.cellCount);
  for (const cell of fixture.cells) {
    expect(cellIds[cell.position]).toBe(BigInt(cell.z7));
  }
});

it("rejects unsorted, overlapping and incomplete range tables", () => {
  const first = monotonicToZ7(10, 2);
  const second = monotonicToZ7(20, 2);

  expect(() =>
    buildIgeo7RangeIndex(BigUint64Array.of(second, first), 2)
  ).toThrow("not sorted");
  expect(() =>
    buildIgeo7RangeIndex(BigUint64Array.of(first, second, second, second), 2)
  ).toThrow("overlaps");
  expect(() => buildIgeo7RangeIndex(BigUint64Array.of(first), 2)).toThrow(
    "pairs"
  );
});

it("reads the grid definition from the DGGS metadata", () => {
  expect(getIgeo7GridDefinition(dggs)).toEqual({
    level: 10,
    vert0Lon: 11.2,
    vert0Lat: 58.28252559,
    vert0Azimuth: 0,
  });
});

it("requires the icosahedron orientation", () => {
  const metadata = { ...dggs, ["dggs_vert0_lon"]: undefined };

  expect(() => getIgeo7GridDefinition(metadata)).toThrow("dggs_vert0_lon");
});

it("goes up the fewest levels that fit the cell budget", () => {
  const index = buildIgeo7RangeIndex(rangeTable, level);

  // Parent counts of the sample archive, from the Python reference.
  expect(chooseIgeo7LevelOffset(index, 3101)).toBe(0);
  expect(chooseIgeo7LevelOffset(index, 3100)).toBe(1);
  expect(chooseIgeo7LevelOffset(index, 478)).toBe(1);
  expect(chooseIgeo7LevelOffset(index, 477)).toBe(2);
  expect(chooseIgeo7LevelOffset(index, 82)).toBe(2);
  expect(chooseIgeo7LevelOffset(index, 18)).toBe(3);
  expect(chooseIgeo7LevelOffset(index, 0)).toBe(level);
});

it("keeps the cells when no coarsening is needed", () => {
  const index = buildIgeo7RangeIndex(rangeTable, level);
  const data = new Float32Array(index.cellCount);

  const coarse = coarsenIgeo7Cells(index, data, 0);

  expect(coarse.index).toBe(index);
  expect(coarse.data).toBe(data);
});

it("averages cell values per ancestor cell", () => {
  // Level 2 cells 5..9 and 14..15: parents 0 (5, 6), 1 (7, 8, 9) and 2.
  const index = buildIgeo7RangeIndex(
    BigUint64Array.of(
      monotonicToZ7(5, 2),
      monotonicToZ7(9, 2),
      monotonicToZ7(14, 2),
      monotonicToZ7(15, 2)
    ),
    2
  );
  const data = Float32Array.of(1, 3, 10, NaN, -999, 4, 8);

  const coarse = coarsenIgeo7Cells(index, data, 1, -999);

  expect(coarse.index.level).toBe(1);
  expect(coarse.index.cellCount).toBe(3);
  expect(Array.from(expandIgeo7Ranges(coarse.index))).toEqual([
    monotonicToZ7(0, 1),
    monotonicToZ7(1, 1),
    monotonicToZ7(2, 1),
  ]);
  expect(Array.from(coarse.data)).toEqual([2, 10, 6]);
});

it("keeps separate runs of ancestors apart and marks empty ones", () => {
  // Level 1 cells 0 and 21..22: parents 0 and 3, nothing in between.
  const index = buildIgeo7RangeIndex(
    BigUint64Array.of(
      monotonicToZ7(0, 1),
      monotonicToZ7(0, 1),
      monotonicToZ7(21, 1),
      monotonicToZ7(22, 1)
    ),
    1
  );

  const coarse = coarsenIgeo7Cells(index, Float32Array.of(NaN, 2, 4), 1);

  expect(Array.from(coarse.index.startMonotonic)).toEqual([0, 3]);
  expect(Array.from(coarse.index.offsets)).toEqual([0, 1, 2]);
  expect(Array.from(coarse.data)).toEqual([NaN, 3]);
});

it("coarsens the sample archive to the reference parent counts", () => {
  const index = buildIgeo7RangeIndex(rangeTable, level);
  const data = new Float32Array(index.cellCount).fill(5);

  for (const [levelOffset, cellCount] of [
    [1, 478],
    [2, 82],
    [3, 18],
  ]) {
    const coarse = coarsenIgeo7Cells(index, data, levelOffset);
    expect(coarse.index.cellCount).toBe(cellCount);
    expect(coarse.data.every((value) => value === 5)).toBe(true);
  }
});

// A counter-clockwise hexagon and a clockwise pentagon around (0, 0).
const testRings = {
  latitudes: Float64Array.of(
    1,
    0.5,
    -0.5,
    -1,
    -0.5,
    0.5,
    1,
    0.3,
    -0.8,
    -0.8,
    0.3
  ),
  longitudes: Float64Array.of(0, -1, -1, 0, 1, 1, 0, 1, 0.6, -0.6, -1),
  offsets: Uint32Array.of(0, 6, 11),
};
const testProjection = new ProjectionHelper(
  PROJECTION_TYPES.NEARSIDE_PERSPECTIVE,
  { lat: 0, lon: 0 }
);

it("builds one fan of triangles per cell with the cell value", () => {
  const batch = buildIgeo7Batch(
    testRings,
    Float32Array.of(10, 20),
    0,
    testProjection
  );

  expect(batch.positionValues).toHaveLength(11 * 3);
  expect(batch.latLonValues).toHaveLength(11 * 2);
  expect(Array.from(batch.latLonValues.slice(0, 4))).toEqual([1, 0, 0.5, -1]);
  expect(Array.from(batch.dataValues)).toEqual([
    10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20,
  ]);
  expect(Array.from(batch.indices)).toEqual([
    0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 6, 8, 7, 6, 9, 8, 6, 10, 9,
  ]);
});

it("labels a batch and sizes it for a part of the cells", () => {
  const pentagon = {
    latitudes: testRings.latitudes.subarray(6),
    longitudes: testRings.longitudes.subarray(6),
    offsets: Uint32Array.of(0, 5),
  };

  const batch = buildIgeo7Batch(
    pentagon,
    Float32Array.of(20),
    3,
    testProjection
  );

  expect(getIgeo7BatchCount(25, 10)).toBe(3);
  expect(batch.batchIndex).toBe(3);
  expect(Array.from(batch.dataValues)).toEqual([20, 20, 20, 20, 20]);
  expect(Array.from(batch.indices)).toEqual([0, 2, 1, 0, 3, 2, 0, 4, 3]);
});
