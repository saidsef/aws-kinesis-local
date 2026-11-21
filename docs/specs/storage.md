# Storage

The store in `src/store/store.ts` keeps the state of aws-kinesis-local through a storage backend, which is an object that implements the `StorageBackend` interface in `src/store/types.ts`. `start()` uses the SQLite backend in `src/store/sqlite.ts` unless it receives a `backend` option. [Storage backends](../clients.md#storage-backends) describes each method for callers who write their own backend.

## Store and backend

The store loads every document from the backend at start-up and keeps the documents in memory. Operations read documents from memory and write each change through to the backend. The store reads records from the backend on demand.

Each backend method returns a promise. An operation makes all its changes to the documents in memory before its first `await`, and a request that arrives later sees those changes at once. The operation then waits for the backend and answers only after its writes finish. A write that fails ends the request with `InternalFailure`.

The store passes the backend a copy of each document, taken when the write starts. An operation can then change a document again while the backend still saves the previous version.

## Order of backend calls

A remote datastore can finish two calls in a different order from the one in which it received them. The store runs the backend calls for each stream one at a time, in the order they arrive. A later write to a stream waits for the earlier one, and a read waits for the writes before it. Requests to one stream then take effect in the order they arrive, whichever backend is in use.

The document of a stream, its records and its consumers share one queue. Each channel and its delivery positions share another, and each policy, the account settings and the clock have a queue of their own. Calls on different queues run side by side.

A backend does not need locks of its own. It needs to save each `putRecords` call in one write, with its stream document and records together. The stream document holds the counters that sequence numbers come from. A backend that cannot save both in one write saves the document first. A failure between the two writes then leaves a gap in the sequence numbers. It never leaves a sequence number that a later record could reuse.

## SQLite backend

The SQLite backend uses the `node:sqlite` module that ships with Node.js. With `--path`, the database is `aws-kinesis-local.sqlite` in that directory, in write-ahead logging mode. Without `--path`, SQLite keeps the database in memory.

| Table | Columns | Content |
| --- | --- | --- |
| `metadata` | `key`, `value` | Schema version and the offset of the clock |
| `documents` | `kind`, `key`, `doc` | One JSON document for each stream, consumer, channel and policy, and the account settings |
| `records` | `stream`, `shard`, `seq`, `partition_key`, `data`, `arrival`, `encryption` | One row for each record, with a unique index on stream, shard and sequence number |
| `delivery_positions` | `channel`, `stream`, `shard`, `seq` | Sequence number of the last record that each channel delivered from each shard, keyed by channel ID |

The backend keeps the clock document in its `metadata` table, where earlier versions keep the offset. An existing database then keeps its clock. The backend runs each method synchronously inside a promise. `putRecords`, `expireRecords` and `putDeliveryPositions` each run in one transaction.

## Documents

Stream documents include the hidden `_seqIx` counters and `_tags`, beside fields such as `StreamModeDetails` and `MaxRecordSizeInKiB`. Channel documents include `_activatedAt`, the time in milliseconds when the channel first became active. Fields that start with an underscore never appear in responses.

## Records

Version 2 sequence numbers always have 56 decimal digits. Their text order then matches their numeric order, and a backend can compare them as text. `GetRecords` reads records in that order from the iterator's position. It skips records older than the retention period and then asks the backend to expire them. It asks for one record more than its limit, which tells it whether the shard holds newer records for `MillisBehindLatest`. That extra record never reaches the response.

A background job deletes the records that no read reaches. A stream that nobody reads then stops growing. The job runs once at start-up and then at the interval that `expiryIntervalMs` sets in `defaultOptions()`. A shorter retention period takes effect on the next run.

The job takes each shard in turn. It asks the backend to expire one batch of the oldest records that arrived before the retention period began. The store rounds that time up to a whole second. Each sequence number carries the time of its record in whole seconds. A record then expires when the time in its sequence number falls before the retention period, which is the rule that `GetRecords` applies.

The SQLite backend reads one batch of sequence numbers from the oldest end of the `records_position` index. Expiry never loads record data, because the index holds the sequence numbers. The backend reads each record time from its sequence number. The `arrival` column is in the table and not in the index. Sequence numbers rise with time within a shard, and the backend stops at the first record that is still inside the retention period.

Requests and the job share one thread. The job yields to the event loop after each batch, and the queue of a stream holds a request behind one batch at most. SQLite reuses the pages that the job frees. The database file then stops growing but does not shrink.
