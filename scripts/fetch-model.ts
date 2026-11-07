import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const commit = process.argv[2] ?? '6d00925efe97c160e67c2042e6c8fd2423ff3896'
const source = `https://raw.githubusercontent.com/aws/api-models-aws/${commit}/models/kinesis/service/2013-12-02/kinesis-2013-12-02.json`
const target = fileURLToPath(new URL('../model/kinesis-2013-12-02.json', import.meta.url))
const droppedTraits = new Set([
  'smithy.api#documentation',
  'smithy.api#examples',
  'smithy.rules#endpointRuleSet',
  'smithy.rules#endpointTests',
  'smithy.rules#endpointBdd',
  'smithy.test#smokeTests',
])

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function strip(value: Json): Json {
  if (Array.isArray(value)) return value.map(strip)
  if (value === null || typeof value !== 'object') return value
  const result: { [key: string]: Json } = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'traits' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
      const traits = Object.fromEntries(Object.entries(child).filter(([name]) => !droppedTraits.has(name)))
      if (Object.keys(traits).length) result[key] = strip(traits)
      continue
    }
    result[key] = strip(child)
  }
  return result
}

const response = await fetch(source)
if (!response.ok) throw new Error(`GET ${source} returned ${response.status}`)
const model = strip(await response.json() as Json) as { [key: string]: Json }
model.metadata = { source, commit }
writeFileSync(target, JSON.stringify(model, null, 2) + '\n')
console.log(`Wrote ${target} from ${commit}`)
