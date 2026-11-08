# Storage

aws-kinesis-local keeps its state in a SQLite database through the `node:sqlite` module that ships with Node.js. With `--path`, the database is `aws-kinesis-local.sqlite` in that directory, in write-ahead logging mode. Without `--path`, the database lives in memory.

## Tables

| Table | Columns | Content |
| --- | --- | --- |
| `metadata` | `key`, `value` | Schema version |
| `documents` | `kind`, `key`, `doc` | One JSON document for each stream, consumer, channel and policy, and the account settings |
| `records` | `stream`, `shard`, `seq`, `partition_key`, `data`, `arrival`, `encryption` | One row for each record, with a unique index on stream, shard and sequence number |

aws-kinesis-local loads every document into memory at start-up and writes each change through to SQLite. It reads records from SQLite on demand.

## Documents

Stream documents keep the field names that kinesalite used for its stream records, including the hidden `_seqIx` counters and `_tags`. Newer fields, such as `StreamModeDetails` and `MaxRecordSizeInKiB`, sit beside them. Fields that start with an underscore never appear in responses.

## Records

Version 2 sequence numbers always have 56 decimal digits, so the text order of the `seq` column matches their numeric order. `GetRecords` reads rows in that order from the iterator's position. It skips records older than the retention period and then deletes them.

A background job deletes the records that no read reaches, so a stream that nobody reads stops growing. The job runs once at start-up and then at the interval that `expiryIntervalMs` sets in `defaultOptions()`. A shorter retention period takes effect on the next run.

The job takes each shard in turn and reads one batch of sequence numbers from the oldest end of the `records_position` index. The index holds the sequence numbers, so the job never loads record data. Sequence numbers rise with time within a shard, and the job stops at the first record that is still inside the retention period. It applies the rule that `GetRecords` applies, which compares the record time in the sequence number with the retention period.

Requests and the job share one thread. Each batch commits in its own transaction, and the job then yields to the event loop, so a request waits for one batch at most. SQLite reuses the pages that the job frees, so the database file stops growing but does not shrink.

## kinesalite data

aws-kinesis-local does not read the LevelDB database that kinesalite kept under `--path`. The two stores use different file names, so the LevelDB files stay untouched beside the SQLite database. [Upgrading from kinesalite](upgrading.md) describes the upgrade.
