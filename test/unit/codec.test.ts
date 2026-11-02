import { describe, expect, it } from "vitest";
import { decodeMutation, encodeMutation, formatVariant, variantKey } from "../../src/data/codec.ts";
import { variantCodes } from "../../src/data/loader.ts";
import { realDataset } from "./helpers.ts";

describe("codec agrees with the pipeline (implementation §4.3)", async () => {
  const ds = await realDataset();
  const spec = ds.index;

  it.each(ds.index.testVectors.mutations)("$mutation -> $code", (v) => {
    expect(encodeMutation(v.position, v.aa, spec)).toBe(v.code);
    expect(decodeMutation(v.code, spec)).toEqual({ position: v.position, aa: v.aa });
  });

  it.each(ds.index.testVectors.variants)("variant #$index ($mutations)", (v) => {
    expect(Array.from(variantCodes(ds, v.index))).toEqual(v.codes);
    expect(ds.brightness[v.index]).toBeCloseTo(v.brightness, 5);
    expect(Boolean(ds.flags[v.index]! & ds.index.flags.lowConfidence)).toBe(v.lowConfidence);
    // labels use the construct's wild-type letters, exactly as the pipeline wrote them
    expect(formatVariant(v.codes, ds.reference.sequence, spec)).toBe(v.mutations || "wild type");
  });

  it("ships at least 50 vectors", () => {
    expect(ds.index.testVectors.mutations.length).toBeGreaterThanOrEqual(50);
  });
});

describe("codec", () => {
  const spec = { aaOrder: "ACDEFGHIKLMNPQRSTVWY", sequenceLength: 238 };

  it("round-trips every code", () => {
    for (let code = 0; code < 238 * 20; code++) {
      const { position, aa } = decodeMutation(code, spec);
      expect(encodeMutation(position, aa, spec)).toBe(code);
    }
  });

  it("rejects out-of-range input", () => {
    expect(() => encodeMutation(0, "A", spec)).toThrow(RangeError);
    expect(() => encodeMutation(239, "A", spec)).toThrow(RangeError);
    expect(() => encodeMutation(5, "*", spec)).toThrow(RangeError);
    expect(() => decodeMutation(238 * 20, spec)).toThrow(RangeError);
  });

  it("variant keys are order-independent", () => {
    expect(variantKey([30, 4, 1200])).toBe(variantKey([1200, 30, 4]));
    expect(variantKey([])).toBe("");
  });
});
