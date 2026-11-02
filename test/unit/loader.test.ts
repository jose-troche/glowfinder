import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseVariants, variantCodes, type VariantIndex } from "../../src/data/loader.ts";
import { ARTIFACTS, realDataset } from "./helpers.ts";

describe("loader", async () => {
  const ds = await realDataset();

  it("decodes every variant", () => {
    expect(ds.count).toBe(51715);
    expect(ds.lookup.size).toBe(ds.count);
    let fromDepths = 0;
    for (const [depth, n] of Object.entries(ds.index.depthCounts)) {
      fromDepths += n;
      expect(ds.depth.filter((d) => d === Number(depth)).length).toBe(n);
    }
    expect(fromDepths).toBe(ds.count);
  });

  it("starts from wild type with the published brightness", () => {
    expect(variantCodes(ds, ds.wildTypeIndex).length).toBe(0);
    expect(ds.brightness[ds.wildTypeIndex]).toBeCloseTo(ds.index.brightness.wildType, 3);
  });

  it("keeps brightness on the log scale within the published range", () => {
    const { min, max } = ds.index.brightness;
    for (const b of ds.brightness) {
      expect(b).toBeGreaterThanOrEqual(min - 0.001);
      expect(b).toBeLessThanOrEqual(max + 0.001);
    }
  });

  it("codes within a variant are ascending and on distinct positions", () => {
    for (let i = 0; i < ds.count; i += 97) {
      const codes = Array.from(variantCodes(ds, i));
      const positions = codes.map((c) => Math.floor(c / 20));
      expect(codes).toEqual([...codes].sort((a, b) => a - b));
      expect(new Set(positions).size).toBe(positions.length);
    }
  });

  it("loads both model matrices", () => {
    expect(ds.models.esm.length).toBe(238 * 20);
    expect(ds.models.profile.length).toBe(238 * 20);
  });

  it("rejects a corrupted file", async () => {
    const index = JSON.parse(await readFile(ARTIFACTS + "variants.idx.json", "utf8")) as VariantIndex;
    const bytes = await readFile(ARTIFACTS + "variants.bin");
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const bad = buf.slice(0);
    new Uint8Array(bad)[0] = 0;
    expect(() => parseVariants(bad, index)).toThrow(/magic/);
    expect(() => parseVariants(buf.slice(0, buf.byteLength - 1), index)).toThrow();
  });
});
