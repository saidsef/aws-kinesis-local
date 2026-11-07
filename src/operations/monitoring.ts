import { shapes } from '../generated/model.ts'
import { getStream, streamNameOf, type Context, type Input } from './common.ts'

const METRICS = ((shapes.MetricsName as { enum: string[] }).enum).filter(metric => metric !== 'ALL')

function expand(metrics: string[]) {
  return metrics.includes('ALL') ? METRICS : metrics
}

function update(context: Context, data: Input, change: (current: Set<string>, requested: string[]) => void) {
  const name = streamNameOf(data)
  const stream = getStream(context, name)
  const monitoring = stream.EnhancedMonitoring[0] ?? { ShardLevelMetrics: [] }
  const current = [...monitoring.ShardLevelMetrics]
  const desired = new Set(current)
  change(desired, expand(data.ShardLevelMetrics as string[]))
  const ordered = METRICS.filter(metric => desired.has(metric))
  stream.EnhancedMonitoring = [{ ShardLevelMetrics: ordered }]
  context.store.saveStream(stream)
  return { StreamName: name, CurrentShardLevelMetrics: current, DesiredShardLevelMetrics: ordered, StreamARN: stream.StreamARN }
}

export function enableEnhancedMonitoring(context: Context, data: Input) {
  return update(context, data, (desired, requested) => requested.forEach(metric => desired.add(metric)))
}

export function disableEnhancedMonitoring(context: Context, data: Input) {
  return update(context, data, (desired, requested) => requested.forEach(metric => desired.delete(metric)))
}
