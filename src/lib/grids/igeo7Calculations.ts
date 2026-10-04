import { shouldFlipCartesianTriangle } from "./gridWorkerCalculations.ts";
import type { TGridGeometryBatch } from "./gridWorkerTypes.ts";

import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TZarrDggsMetadata } from "@/lib/types/GlobeTypes.ts";

const Z7_DIGIT_COUNT = 20;
const Z7_PADDING_DIGIT = 7;
const Z7_BASE_CELL_COUNT = 12;
// Monotonic integers are kept as Number, which is exact up to 2^53.
// 12 * 7^level exceeds that above level 16.
const MAX_MONOTONIC_LEVEL = 16;

export type TIgeo7GridDefinition = {
  level: number;
  vert0Lon: number;
  vert0Lat: number;
  vert0Azimuth: number;
};

export type TIgeo7CellRings = {
  // Corners of all cells, ring after ring, without a closing point.
  latitudes: Float64Array;
  longitudes: Float64Array;
  // Index of the first corner of each cell, plus the total as last entry.
  offsets: Uint32Array;
};

type TIgeo7RangeIndex = {
  level: number;
  startMonotonic: Float64Array;
  endMonotonic: Float64Array;
  // Position of the first cell of each range, plus the total as last entry.
  offsets: Float64Array;
  cellCount: number;
};

function assertLevel(level: number) {
  if (!Number.isInteger(level) || level < 0 || level > MAX_MONOTONIC_LEVEL) {
    throw new Error(
      `IGEO7 refinement level ${level} is not supported (0..${MAX_MONOTONIC_LEVEL}).`
    );
  }
}

function digitShift(digitIndex: number) {
  return BigInt(60 - 3 * digitIndex);
}

/**
 * The IGEO7 grid is only reproduced correctly with the orientation stored in
 * the archive, so missing values are an error rather than defaulted.
 */
export function getIgeo7GridDefinition(
  metadata: TZarrDggsMetadata
): TIgeo7GridDefinition {
  const level = metadata.refinement_level;
  const vert0Lon = metadata.dggs_vert0_lon;
  const vert0Lat = metadata.dggs_vert0_lat;
  if (typeof vert0Lon !== "number" || typeof vert0Lat !== "number") {
    throw new Error(
      "IGEO7 metadata lacks dggs_vert0_lon / dggs_vert0_lat, cannot place cells."
    );
  }
  assertLevel(level);
  return {
    level,
    vert0Lon,
    vert0Lat,
    vert0Azimuth: metadata.dggs_vert0_azimuth ?? 0,
  };
}

/** Packed Z7 id to its position on the per-level number line. */
export function z7ToMonotonic(z7: bigint, level: number) {
  let monotonic = Number(z7 >> 60n);
  for (let digitIndex = 1; digitIndex <= level; digitIndex++) {
    const digit = Number((z7 >> digitShift(digitIndex)) & 7n);
    if (digit === Z7_PADDING_DIGIT) {
      throw new Error(
        `Z7 id 0x${z7.toString(16)} is coarser than refinement level ${level}.`
      );
    }
    monotonic = monotonic * 7 + digit;
  }
  return monotonic;
}

export function monotonicToZ7(monotonic: number, level: number) {
  let remaining = monotonic;
  let z7 = 0n;
  for (let digitIndex = Z7_DIGIT_COUNT; digitIndex >= 1; digitIndex--) {
    let digit = Z7_PADDING_DIGIT;
    if (digitIndex <= level) {
      digit = remaining % 7;
      remaining = Math.floor(remaining / 7);
    }
    z7 |= BigInt(digit) << digitShift(digitIndex);
  }
  if (remaining >= Z7_BASE_CELL_COUNT) {
    throw new Error(
      `Monotonic value ${monotonic} is out of range for refinement level ${level}.`
    );
  }
  return z7 | (BigInt(remaining) << 60n);
}

/**
 * Index a `(R, 2)` table of inclusive `[start, end]` packed Z7 ids. Data
 * variables are stored in the order in which the ranges enumerate their cells.
 */
export function buildIgeo7RangeIndex(
  ranges: BigUint64Array,
  level: number
): TIgeo7RangeIndex {
  assertLevel(level);
  if (ranges.length % 2 !== 0) {
    throw new Error("IGEO7 cell id ranges must contain start/end pairs.");
  }
  const rangeCount = ranges.length / 2;
  const startMonotonic = new Float64Array(rangeCount);
  const endMonotonic = new Float64Array(rangeCount);
  const offsets = new Float64Array(rangeCount + 1);
  for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex++) {
    const start = z7ToMonotonic(ranges[rangeIndex * 2], level);
    const end = z7ToMonotonic(ranges[rangeIndex * 2 + 1], level);
    if (
      end < start ||
      (rangeIndex > 0 && start <= endMonotonic[rangeIndex - 1])
    ) {
      throw new Error(
        `IGEO7 cell id range ${rangeIndex} is not sorted or overlaps.`
      );
    }
    startMonotonic[rangeIndex] = start;
    endMonotonic[rangeIndex] = end;
    offsets[rangeIndex + 1] = offsets[rangeIndex] + (end - start + 1);
  }
  return {
    level,
    startMonotonic,
    endMonotonic,
    offsets,
    cellCount: offsets[rangeCount],
  };
}

/** Packed Z7 ids of all cells, in data order. */
export function expandIgeo7Ranges(index: TIgeo7RangeIndex) {
  const cellIds = new BigUint64Array(index.cellCount);
  let position = 0;
  for (
    let rangeIndex = 0;
    rangeIndex < index.startMonotonic.length;
    rangeIndex++
  ) {
    const end = index.endMonotonic[rangeIndex];
    for (
      let monotonic = index.startMonotonic[rangeIndex];
      monotonic <= end;
      monotonic++
    ) {
      cellIds[position++] = monotonicToZ7(monotonic, index.level);
    }
  }
  return cellIds;
}

function countCoarseCells(index: TIgeo7RangeIndex, divisor: number) {
  let count = 0;
  let previousLast = -1;
  for (
    let rangeIndex = 0;
    rangeIndex < index.startMonotonic.length;
    rangeIndex++
  ) {
    const first = Math.floor(index.startMonotonic[rangeIndex] / divisor);
    const last = Math.floor(index.endMonotonic[rangeIndex] / divisor);
    count += last - first + (first === previousLast ? 0 : 1);
    previousLast = last;
  }
  return count;
}

/**
 * Number of refinement levels to go up so that at most `maxCells` cells
 * remain. Every level up merges the seven children of a cell.
 */
export function chooseIgeo7LevelOffset(
  index: TIgeo7RangeIndex,
  maxCells: number
) {
  for (let levelOffset = 0; levelOffset < index.level; levelOffset++) {
    if (countCoarseCells(index, 7 ** levelOffset) <= maxCells) {
      return levelOffset;
    }
  }
  return index.level;
}

function coarsenRanges(
  index: TIgeo7RangeIndex,
  levelOffset: number
): TIgeo7RangeIndex {
  const divisor = 7 ** levelOffset;
  const starts: number[] = [];
  const ends: number[] = [];
  for (
    let rangeIndex = 0;
    rangeIndex < index.startMonotonic.length;
    rangeIndex++
  ) {
    const first = Math.floor(index.startMonotonic[rangeIndex] / divisor);
    const last = Math.floor(index.endMonotonic[rangeIndex] / divisor);
    // Ranges that share or neighbour a parent continue the previous run.
    if (ends.length > 0 && first <= ends[ends.length - 1] + 1) {
      ends[ends.length - 1] = last;
    } else {
      starts.push(first);
      ends.push(last);
    }
  }
  const offsets = new Float64Array(starts.length + 1);
  for (let rangeIndex = 0; rangeIndex < starts.length; rangeIndex++) {
    offsets[rangeIndex + 1] =
      offsets[rangeIndex] + (ends[rangeIndex] - starts[rangeIndex] + 1);
  }
  return {
    level: index.level - levelOffset,
    startMonotonic: Float64Array.from(starts),
    endMonotonic: Float64Array.from(ends),
    offsets,
    cellCount: offsets[starts.length],
  };
}

function averageByParent(
  index: TIgeo7RangeIndex,
  coarse: TIgeo7RangeIndex,
  data: Float32Array,
  missingValue: number,
  fillValue: number
) {
  const divisor = 7 ** (index.level - coarse.level);
  const sums = new Float64Array(coarse.cellCount);
  const counts = new Uint32Array(coarse.cellCount);
  let coarseRange = 0;
  for (
    let rangeIndex = 0;
    rangeIndex < index.startMonotonic.length;
    rangeIndex++
  ) {
    const start = index.startMonotonic[rangeIndex];
    const end = index.endMonotonic[rangeIndex];
    while (Math.floor(start / divisor) > coarse.endMonotonic[coarseRange]) {
      coarseRange++;
    }
    // Position of a parent = this base + its monotonic value.
    const base =
      coarse.offsets[coarseRange] - coarse.startMonotonic[coarseRange];
    for (let monotonic = start; monotonic <= end; monotonic++) {
      const value = data[index.offsets[rangeIndex] + (monotonic - start)];
      if (
        Number.isNaN(value) ||
        value === missingValue ||
        value === fillValue
      ) {
        continue;
      }
      const parent = base + Math.floor(monotonic / divisor);
      sums[parent] += value;
      counts[parent]++;
    }
  }
  const means = new Float32Array(coarse.cellCount);
  for (let parent = 0; parent < means.length; parent++) {
    means[parent] = counts[parent] > 0 ? sums[parent] / counts[parent] : NaN;
  }
  return means;
}

/**
 * Replace the cells by their ancestors `levelOffset` levels up, each carrying
 * the mean of the valid values of its descendants in the data. Cells are equal
 * in area, so this is the area-weighted mean.
 */
export function coarsenIgeo7Cells(
  index: TIgeo7RangeIndex,
  data: Float32Array,
  levelOffset: number,
  missingValue = NaN,
  fillValue = NaN
) {
  if (levelOffset === 0) {
    return { index, data };
  }
  const coarse = coarsenRanges(index, levelOffset);
  return {
    index: coarse,
    data: averageByParent(index, coarse, data, missingValue, fillValue),
  };
}

function toCartesian(rings: TIgeo7CellRings, corner: number) {
  const latitude = (rings.latitudes[corner] * Math.PI) / 180;
  const longitude = (rings.longitudes[corner] * Math.PI) / 180;
  return [
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  ] as const;
}

/** Meshes are drawn single-sided, so corners must run counter-clockwise. */
function isClockwise(rings: TIgeo7CellRings, cell: number) {
  const first = rings.offsets[cell];
  return shouldFlipCartesianTriangle(
    ...toCartesian(rings, first),
    ...toCartesian(rings, first + 1),
    ...toCartesian(rings, first + 2)
  );
}

export function getIgeo7BatchCount(cellCount: number, batchSize: number) {
  return Math.ceil(cellCount / batchSize);
}

function fillCell(
  rings: TIgeo7CellRings,
  projection: ProjectionHelper,
  cell: number,
  value: number,
  batch: TGridGeometryBatch,
  target: { vertex: number; index: number }
) {
  const cornerCount = rings.offsets[cell + 1] - rings.offsets[cell];
  for (let corner = 0; corner < cornerCount; corner++) {
    const source = rings.offsets[cell] + corner;
    projection.projectLatLonToArrays(
      rings.latitudes[source],
      rings.longitudes[source],
      batch.positionValues,
      (target.vertex + corner) * 3,
      batch.latLonValues,
      (target.vertex + corner) * 2
    );
  }
  batch.dataValues.fill(value, target.vertex, target.vertex + cornerCount);
  // Cells are convex, so a fan from the first corner covers them.
  const clockwise = isClockwise(rings, cell);
  for (let corner = 1; corner < cornerCount - 1; corner++) {
    batch.indices[target.index++] = target.vertex;
    batch.indices[target.index++] =
      target.vertex + (clockwise ? corner + 1 : corner);
    batch.indices[target.index++] =
      target.vertex + (clockwise ? corner : corner + 1);
  }
  target.vertex += cornerCount;
}

/**
 * One polygon per cell of the batch, all corners of a cell carrying the cell
 * value. `rings` and `data` describe the cells of this batch only.
 */
export function buildIgeo7Batch(
  rings: TIgeo7CellRings,
  data: Float32Array,
  batchIndex: number,
  projection: ProjectionHelper
): TGridGeometryBatch {
  const vertexCount = rings.offsets[data.length];
  const triangleCount = vertexCount - 2 * data.length;
  const batch: TGridGeometryBatch = {
    batchIndex,
    positionValues: new Float32Array(vertexCount * 3),
    dataValues: new Float32Array(vertexCount),
    latLonValues: new Float32Array(vertexCount * 2),
    indices: new Uint32Array(triangleCount * 3),
  };
  const target = { vertex: 0, index: 0 };
  for (let cell = 0; cell < data.length; cell++) {
    fillCell(rings, projection, cell, data[cell], batch, target);
  }
  return batch;
}
