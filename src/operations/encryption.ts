import { invalidArgument, resourceInUse } from '../errors.ts'
import type { Store } from '../store/store.ts'
import { account, getStream, streamNameOf, type Context, type Input } from './common.ts'

function activeStream(context: Context, name: string) {
  const stream = getStream(context, name)
  if (stream.StreamStatus !== 'ACTIVE') {
    throw resourceInUse(`Stream ${name} under account ${account(context)} not ACTIVE, instead in state ${stream.StreamStatus}`)
  }
  return stream
}

export function startStreamEncryption(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = activeStream(context, name)
  if (data.EncryptionType !== 'KMS') {
    throw invalidArgument(`EncryptionType ${data.EncryptionType} is not supported by StartStreamEncryption. Use KMS.`)
  }
  stream.StreamStatus = 'UPDATING'
  context.store.saveStream(stream)
  context.store.schedule('stream', name, 'startEncryption', context.store.options.updateStreamMs, { keyId: data.KeyId })
}

export function stopStreamEncryption(context: Context, data: Input) {
  const name = streamNameOf(data)
  const stream = activeStream(context, name)
  if (data.EncryptionType !== 'KMS') {
    throw invalidArgument(`EncryptionType ${data.EncryptionType} is not supported by StopStreamEncryption. Use KMS.`)
  }
  stream.StreamStatus = 'UPDATING'
  context.store.saveStream(stream)
  context.store.schedule('stream', name, 'stopEncryption', context.store.options.updateStreamMs)
}

export function registerEncryptionTransitions(store: Store) {
  store.registerTransition('startEncryption', (current, name, data) => {
    const stream = current.streams.get(name)
    if (!stream) return
    stream.EncryptionType = 'KMS'
    stream.KeyId = (data as { keyId: string }).keyId
    stream.StreamStatus = 'ACTIVE'
    current.saveStream(stream)
  })
  store.registerTransition('stopEncryption', (current, name) => {
    const stream = current.streams.get(name)
    if (!stream) return
    stream.EncryptionType = 'NONE'
    delete stream.KeyId
    stream.StreamStatus = 'ACTIVE'
    current.saveStream(stream)
  })
}
