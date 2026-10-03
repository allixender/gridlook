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
