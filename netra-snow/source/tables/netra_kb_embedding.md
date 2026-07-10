# Table: `<scope>_kb_embedding`

RAG cache for semantic knowledge search. One row per embedded knowledge
article; vectors are produced by `gemini-embedding-001` (768 dims,
L2-normalised client-side) and reused across searches so a warm cache does
zero live embedding calls.

| Column | Type | Purpose |
|---|---|---|
| `source_table`  | String (40)     | Source table (kb_knowledge) |
| `source_sys_id` | String (32)     | Source record sys_id |
| `source_number` | String (32)     | Source display number (KB…) |
| `title`         | String (240)    | Article title at embed time |
| `body_digest`   | String (1500)   | Digest of the text that was embedded (staleness check) |
| `embedding`     | String (32000)  | JSON array of 768 floats |
| `model`         | String (64)     | Embedding model id |
| `embedded_at`   | Glide date time | When the vector was produced |

Maintenance: rows are upserted lazily during `semantic_search_knowledge`
(max 8 live embeds per search, 200-article scan cap — R4.7). Safe to
truncate; the cache rebuilds itself.
