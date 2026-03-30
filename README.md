# Parquet write strategy and Xet chunk reuse

A Colab notebook that benchmarks how Parquet write decisions affect upload cost on the Hugging Face Hub.

## What it does

The Hub stores datasets using [Xet](https://huggingface.co/docs/hub/xet/index), a content-addressed storage system that breaks files into ~64KB chunks and deduplicates globally. When you push an update, chunks whose bytes haven't changed don't get uploaded.

The notebook simulates Xet chunk analysis locally — without needing Hub credentials — and measures how much data actually needs uploading for three common dataset operations, comparing naive and Xet-aware write strategies.

## Scenarios

| # | Operation | Naive reuse | Smart reuse |
|---|-----------|-------------|-------------|
| 1 | Append 1K rows to 100K row dataset | 0% (reshard) | 98.8% (add shard) |
| 2 | Fix 500 labels in 2 of 10 shards | 99.5% | 99.5% |
| 3 | Remove 5K duplicate rows | 0% (physical delete) | 97.6% (flag column) |
| 4 | Same label fix, stable vs. shuffled order | 99.5% (sorted) | 0% (shuffled) |

Scenario 2 is the counterintuitive one: naive full rewrites and surgical shard rewrites cost the same in upload bytes. Parquet's columnar layout combined with pyarrow's deterministic output means Xet automatically deduplicates unchanged column data, even across a full rewrite.

## Key findings

**What costs you**: resharding (changing how many shards you use), random row shuffle before writing, physical row deletion.

**What's free**: rewriting shards with unchanged data using consistent settings, updating small columns (int, float) in a subset of shards, appending new shards without touching existing ones.

**The rule**: Xet deduplication is content-addressed and global. It doesn't know what you changed — it just hashes bytes. Your job is to make sure unchanged data produces unchanged bytes.

## Running it

Open in Colab or run locally:

```bash
pip install pyarrow numpy matplotlib
jupyter notebook parquet-xet-write-strategy.ipynb
```

No Hub account or network access needed. The notebook generates synthetic data and runs all benchmarks locally using temporary directories.

## How the simulation works

Xet uses content-defined chunking (GearHash rolling hash, ~64KB average chunk size) with Blake3 content-addressing. The notebook approximates this with fixed 64KB chunks and Blake2b hashing — a conservative estimate, since real Xet CDC is more resilient to insertions.

For row-group-level analysis (did this shard's bytes change at all?), fixed-size simulation is exact: identical bytes → identical chunk hashes → zero upload cost.

The simulation is validated at startup: pyarrow's Parquet output is deterministic for the same input and settings within a process, which is required for unchanged-shard reuse to work correctly.

## Applying to a real dataset

See the final cell in the notebook. The workflow:

```python
from huggingface_hub import hf_hub_download
import pyarrow.parquet as pq

path = hf_hub_download(repo_id="your/dataset", filename="data/train-00000.parquet", repo_type="dataset")
chunks_before = compute_chunks(path)

# ... make your updates ...

chunks_after = compute_chunks(updated_path)
print(upload_delta(chunks_before, chunks_after))
```

`huggingface_hub >= 0.32.0` activates Xet automatically. No configuration needed.
