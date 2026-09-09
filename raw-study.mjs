import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeInput } from "./research-recorder-core.mjs";
const quote = (v) => '"' + String(v ?? "").replaceAll('"', '""') + '"';
export class RawStudy {
  constructor(dir, identity) {
    this.dir = join(dir, "raw");
    this.identity = Object.freeze({ ...identity });
    this.queue = Promise.resolve();
    this.versions = new Map();
  }
  append(file, value) {
    const row = { ...value, ...this.identity, acquired_at_ms: Date.now() };
    if (Number.isFinite(row.timestamp_ms))
      row.iso_utc = new Date(row.timestamp_ms).toISOString();
    this.queue = this.queue.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(join(this.dir, file), JSON.stringify(row) + "\n");
    });
    return this.queue;
  }
  input(value) {
    return this.append("input_events.jsonl", {
      ...safeInput(value),
      source: "macos_cgeventtap",
    });
  }
  activity(bucketId, events) {
    for (const e of events) {
      const key = `${bucketId}:${e.id}`,
        version = JSON.stringify(e);
      if (this.versions.get(key) === version) continue;
      this.versions.set(key, version);
      this.append("activitywatch_events.jsonl", {
        source: "activitywatch",
        bucket_id: bucketId,
        event: e,
        timestamp_ms: Date.parse(e.timestamp),
      });
    }
    return this.queue;
  }
  async exportCsv(files = [], gaps = []) {
    await this.queue;
    const read = async (n) =>
      (await readFile(join(this.dir, n), "utf8").catch(() => ""))
        .split(/\r?\n/)
        .filter(Boolean)
        .map(JSON.parse);
    const write = async (n, rows, keys) =>
      writeFile(
        join(this.dir, n),
        keys.join(",") +
          "\r\n" +
          rows
            .map((r) =>
              keys.map((k) => quote(r[k] ?? this.identity[k])).join(","),
            )
            .join("\r\n"),
      );
    const input = await read("input_events.jsonl"),
      aw = await read("activitywatch_events.jsonl");
    await write("input_events.csv", input, [
      "participant_id",
      "session_id",
      "timestamp_ms",
      "iso_utc",
      "source",
      "type",
      "monotonic_ms",
      "interval_ms",
      "delta_x",
      "delta_y",
      "scroll_x",
      "scroll_y",
    ]);
    await write(
      "activitywatch_events.csv",
      aw.map((r) => ({ ...r, event_json: JSON.stringify(r.event) })),
      [
        "participant_id",
        "session_id",
        "timestamp_ms",
        "iso_utc",
        "bucket_id",
        "event_json",
      ],
    );
    await write("media_index.csv", files, [
      "kind",
      "path",
      "startUtcMs",
      "endUtcMs",
      "startMonotonicMs",
      "endMonotonicMs",
      "mediaDurationMs",
      "sampleCount",
      "container",
      "codec",
      "sizeBytes",
    ]);
    await write("gaps.csv", gaps, [
      "channel",
      "startUtcMs",
      "endUtcMs",
      "reason",
    ]);
  }
}
