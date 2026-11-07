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

## kinesalite data

aws-kinesis-local does not read the LevelDB database that kinesalite kept under `--path`. The two stores use different file names, so the LevelDB files stay untouched beside the SQLite database. [Upgrading from kinesalite](upgrading.md) describes the upgrade.
