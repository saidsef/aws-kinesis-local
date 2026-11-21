export interface HashKeyRange {
  StartingHashKey: string
  EndingHashKey: string
}

export interface ShardDoc {
  ParentShardId?: string
  AdjacentParentShardId?: string
  HashKeyRange: HashKeyRange
  SequenceNumberRange: {
    StartingSequenceNumber: string
    EndingSequenceNumber?: string
  }
  ShardId: string
}

type StreamStatus = 'CREATING' | 'ACTIVE' | 'UPDATING' | 'DELETING'
export type StreamMode = 'PROVISIONED' | 'ON_DEMAND'

export interface Pending {
  action: string
  due: number
  data?: unknown
}

export interface StreamDoc {
  RetentionPeriodHours: number
  EnhancedMonitoring: { ShardLevelMetrics: string[] }[]
  EncryptionType: 'NONE' | 'KMS'
  KeyId?: string
  HasMoreShards: boolean
  Shards: ShardDoc[]
  StreamARN: string
  StreamName: string
  StreamStatus: StreamStatus
  StreamCreationTimestamp: number
  StreamModeDetails?: { StreamMode: StreamMode }
  MaxRecordSizeInKiB?: number
  WarmThroughput?: { TargetMiBps?: number, CurrentMiBps?: number }
  RecordDistributionStrategy?: 'AUTO' | 'USER_PARTITION_KEY'
  _seqIx: (number | null)[]
  _tags: Record<string, string>
  _pending?: Pending
}

type ConsumerStatus = 'CREATING' | 'ACTIVE' | 'DELETING'

export interface ConsumerDoc {
  ConsumerName: string
  ConsumerARN: string
  ConsumerStatus: ConsumerStatus
  ConsumerCreationTimestamp: number
  StreamARN: string
  StreamName: string
  _tags: Record<string, string>
  _pending?: Pending
}

export interface ChannelDoc {
  ChannelName: string
  ChannelARN: string
  ChannelId: string
  ChannelStatus: 'CREATING' | 'ACTIVE' | 'UPDATING' | 'DELETING' | 'FAILED'
  ChannelCreationTimestamp: number
  ServiceExecutionRoleARN: string
  StreamConfigurationList: Record<string, unknown>[]
  S3DestinationConfiguration?: Record<string, unknown>
  S3TablesDestinationConfiguration?: Record<string, unknown>
  EncryptionConfiguration?: Record<string, unknown>
  LoggingConfiguration: Record<string, unknown>
  _tags: Record<string, string>
  _activatedAt?: number
  _pending?: Pending
}

export interface AccountSettings {
  MinimumThroughputBillingCommitment: {
    Status: 'ENABLED' | 'DISABLED' | 'ENABLED_UNTIL_EARLIEST_ALLOWED_END'
    StartedAt?: number
    EndedAt?: number
    EarliestAllowedEndAt?: number
  }
}

export type DocumentKind = 'stream' | 'consumer' | 'channel' | 'policy' | 'settings' | 'clock'

export type StoredDocument =
  | { kind: 'stream', key: string, value: StreamDoc }
  | { kind: 'consumer', key: string, value: ConsumerDoc }
  | { kind: 'channel', key: string, value: ChannelDoc }
  | { kind: 'policy', key: string, value: string }
  | { kind: 'settings', key: string, value: AccountSettings }
  | { kind: 'clock', key: string, value: number }

export interface StoredRecord {
  shardIx: number
  sequenceNumber: string
  partitionKey: string | null
  data: Uint8Array
  arrival: number
  encryptionType: string | null
}

export interface RecordQuery {
  stream: string
  shardIx: number
  from?: string
  after?: string
  arrivedSince?: number
  limit: number
}

export interface StorageBackend {
  readDocuments(): Promise<StoredDocument[]>
  putDocument(document: StoredDocument): Promise<void>
  deleteDocument(kind: DocumentKind, key: string): Promise<void>
  putRecords(stream: StreamDoc, records: StoredRecord[]): Promise<void>
  readRecords(query: RecordQuery): Promise<StoredRecord[]>
  expireRecords(stream: string, shardIx: number, arrivedBefore: number, limit: number): Promise<number>
  deleteRecords(stream: string): Promise<void>
  readDeliveryPositions(channelId: string, stream: string): Promise<Map<number, string>>
  putDeliveryPositions(channelId: string, stream: string, positions: Map<number, string>): Promise<void>
  deleteDeliveryPositions(channelId: string): Promise<void>
  ping(): Promise<void>
}
