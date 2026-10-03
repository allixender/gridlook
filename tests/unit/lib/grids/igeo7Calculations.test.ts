import { expect, it } from "vitest";

import fixture from "../../../fixtures/igeo7/pori_z7_r10.json";

import {
  buildIgeo7RangeIndex,
  expandIgeo7Ranges,
  getIgeo7GridDefinition,
  monotonicToZ7,
  z7ToMonotonic,
} from "@/lib/grids/igeo7Calculations.ts";
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
