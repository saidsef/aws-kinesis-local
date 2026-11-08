import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const yamlValue = (path: string, key: string): string =>
  read(path).match(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\s#]+)`, 'm'))?.[1] ?? 'missing'

const versions: [string, string][] = [
  ['version in package.json', (JSON.parse(read('package.json')) as { version: string }).version],
  ['appVersion in charts/kinesis/Chart.yaml', yamlValue('charts/kinesis/Chart.yaml', 'appVersion')],
  ['newTag in deployment/base/kustomization.yml', yamlValue('deployment/base/kustomization.yml', 'newTag')],
]

for (const [source, version] of versions) console.log(`${source}: ${version}`)

const expected = versions[0]?.[1]
if (versions.some(([, version]) => version !== expected)) {
  console.error(`Set appVersion and newTag to ${expected}, the version in package.json.`)
  process.exitCode = 1
}
