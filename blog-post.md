# How you write Parquet determines how much of your dataset uploads

The Hugging Face Hub switched to [Xet storage](https://huggingface.co/docs/hub/xet/index) as its default backend in mid-2025. Xet uses content-defined chunking to break files into ~64KB chunks and deduplicates globally: if a chunk's bytes haven't changed since your last push, it doesn't get uploaded.

For model weights, this is mostly invisible. Fine-tuned checkpoints share most chunks with their base model — you get the deduplication benefit without thinking about it.

For datasets, it's different. Whether Xet can skip 95% of your upload or has to re-upload everything depends on decisions you make when writing your Parquet files: how many shards, whether you sort, which compression codec, whether you physically delete rows or flag them. I ran a set of benchmarks to find out where the real costs are.

## The setup

I generated a synthetic NLP dataset — 100,000 rows of text documents with integer labels and float scores — and wrote it as 10 Parquet shards of 10,000 rows each, matching the layout the Hub uses for real datasets.

For each scenario, I simulated Xet chunk analysis locally using fixed 64KB chunks and Blake2b hashing. This is conservative: real Xet CDC uses content-defined variable-size chunks that are more resilient to insertions. The numbers below represent a lower bound on actual chunk reuse.

All code is in the [accompanying notebook](./parquet-xet-write-strategy.ipynb), runnable without a Hub account.

## Scenario 1: Appending new data

A new collection run produces 1,000 new examples. How do you add them?

**Naive**: concatenate everything, write 11 shards from scratch.
**Smart**: keep the 10 existing shards unchanged, write the new data as an 11th shard.

| Approach | Chunk reuse | Upload |
|----------|-------------|--------|
| Naive (reshard) | 0% | ~26 MB |
| Smart (add shard) | 98.8% | 320 KB |

The naive approach rewrites all 11 shards with new shard boundaries. Every byte shifts. Xet sees no reuse.

The smart approach copies the existing 10 shards byte-for-byte and only writes the new one. The original shards are chunk-for-chunk identical to what's already on the Hub.

**Lesson**: don't reshard when you append. Add new shards instead.

## Scenario 2: Correcting labels (the counterintuitive one)

A labeling audit finds 500 mis-labeled examples in shards 0 and 1. Labels need to be corrected.

My prediction was that the surgical approach — rewriting only the 2 affected shards — would significantly outperform a full rewrite of all 10. The actual numbers:

| Approach | Chunk reuse | Upload |
|----------|-------------|--------|
| Naive (rewrite all 10 shards) | 99.5% | 128 KB |
| Smart (rewrite 2 affected shards) | 99.5% | 128 KB |

Both approaches cost exactly the same in upload bytes. Two things explain this:

**pyarrow's output is deterministic.** Writing the same table data with the same settings twice produces byte-identical files. When the naive approach rewrites the 8 unchanged shards, it produces the same bytes that are already on the Hub — Xet sees 100% chunk reuse for those shards automatically.

**Parquet's columnar layout isolates the change.** The `label` column is a tiny int32 field — about 5KB per shard after compression. Changing 500 labels produces 1–2 new chunks regardless of how many shards you rewrite. The large `text` column in every shard is untouched and its chunks are reused in full.

The surgical approach saves CPU time and local I/O. It does not save upload bandwidth — Xet handles the deduplication either way.

This changes how I think about the advice "only rewrite what changed." It's still good advice for build time. For Xet upload cost, it only matters if you're changing data, not if you're touching files.

## Scenario 3: Deduplication

Quality checks identify 5,000 near-duplicate rows (5% of the dataset), randomly distributed across all 10 shards. How do you handle them?

| Approach | Chunk reuse | Upload |
|----------|-------------|--------|
| Physical delete (filter + rewrite all) | 0% | ~25 MB |
| Flag column (`is_duplicate=True`) | 97.6% | 640 KB |
| Surgical rewrite (affected shards only) | 0% | ~25 MB |

The flag column wins by a wide margin. Adding a boolean column means the existing row data, text, labels, and scores are all byte-identical. Xet only sees the new column's chunks as new — everything else is already on the Hub.

Physical deletion changes row counts in every shard (5% of 10,000 rows removed per shard, randomly). This shifts column chunk boundaries and produces entirely new bytes. No chunk reuse is possible.

The surgical rewrite has the same problem: every affected shard has fewer rows than before, which changes all of its column chunks.

**Lesson**: flag duplicates first. Do the physical compaction pass later, when you've decided the flags are stable. You can filter at load time with `datasets.filter(lambda x: not x["is_duplicate"])` without paying any upload cost.

## When sort order breaks everything

Scenario 2 showed that you don't need to be surgical about which shards you rewrite — Xet handles dedup automatically as long as the bytes are consistent. The critical condition is that your **row order stays stable between writes**.

To demonstrate what breaks it: I took the same 500 label fixes from Scenario 2 and wrote two versions of v2 — one with rows sorted by `id` (consistent with v1), one with rows randomly shuffled.

| Write order | Chunk reuse |
|-------------|-------------|
| Sort by id before writing | 99.5% |
| Random shuffle before writing | 0% |

Same data. Same fixes. Only the order differs.

When rows are shuffled, every shard contains a different random subset of the dataset. The bytes in each column chunk are completely different from v1, even for rows whose values didn't change. Xet correctly identifies that nothing matches and uploads everything.

If your pipeline normalizes data (re-sorts, re-shuffles, re-partitions) before writing, you lose automatic dedup — not because your data changed, but because the bytes changed. The fix is to sort by a stable key (`id`, or a deterministic hash) before calling `write_shards()`.

## What this looks like in practice

**Do:**
```python
# Sort before writing to guarantee stable chunk boundaries
table = table.sort_by([("id", "ascending")])
write_shards(table, output_dir, compression="snappy")

# Append by adding new shards, not resharding
pq.write_table(new_rows, f"{output_dir}/train-00010-of-00011.parquet", compression="snappy")

# Flag duplicates instead of deleting
table = table.append_column("is_duplicate", compute_dup_flags(table))
```

**Don't:**
```python
# Reshard on append — shifts all chunk boundaries
all_rows = pa.concat_tables([existing, new_rows])
write_shards(all_rows, output_dir, n_shards=11)  # all 11 shards = new bytes

# Physically delete rows — changes column chunk sizes
clean = table.filter(pa.array([i not in dup_ids for i in ids]))
write_shards(clean, output_dir)  # all shards = new bytes
```

## Summary

| Operation | Xet-aware approach | Reuse |
|-----------|-------------------|-------|
| Append new data | Add shard, don't reshard | ~99% |
| Update column values | Any approach (pyarrow determinism handles it) | ~99.5% |
| Remove duplicates | Flag column, defer physical delete | ~98% |
| Any operation | Sort by stable key before writing | maintains reuse |

The underlying principle is simple: Xet doesn't know what you changed. It just hashes bytes and skips what it's seen. Your job is to write in a way that makes unchanged data produce unchanged bytes. pyarrow's determinism and Parquet's columnar layout do most of the work — you mostly need to avoid resharding and random shuffles.

---

*All benchmarks run against a 100K row synthetic dataset, 10 shards, snappy compression, pyarrow 19.0. Code: [parquet-xet-write-strategy.ipynb](./parquet-xet-write-strategy.ipynb)*
