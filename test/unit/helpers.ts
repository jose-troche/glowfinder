import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadDataset, type Dataset, type FetchLike } from "../../src/data/loader.ts";

export const ARTIFACTS = fileURLToPath(new URL("../../data/artifacts/", import.meta.url));

/** fetch() over data/artifacts on disk: the same files the browser gets. */
export const diskFetch: FetchLike = async (path) => {
  const name = path.replace(/^\/artifacts\//, "");
  const bytes = await readFile(ARTIFACTS + name);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(bytes.toString("utf8")),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
};

let cached: Promise<Dataset> | undefined;
export function realDataset(): Promise<Dataset> {
  return (cached ??= loadDataset(diskFetch));
}
