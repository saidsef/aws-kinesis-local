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

export type StreamStatus = 'CREATING' | 'ACTIVE' | 'UPDATING' | 'DELETING'
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

export type ConsumerStatus = 'CREATING' | 'ACTIVE' | 'DELETING'

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

export interface StoredRecord {
  SequenceNumber: string
  PartitionKey: string | null
  Data: Buffer
  ApproximateArrivalTimestamp: number
  EncryptionType: string | null
}

export interface NewRecord {
  shardIx: number
  sequenceNumber: string
  partitionKey: string | null
  data: Buffer
  arrival: number
  encryptionType: string | null
}
