#!/usr/bin/env node
import { numberOption, parseArguments, stringOption } from './arguments.ts'
import { defaultOptions, start } from './server.ts'

const HELP = [
  '',
  'Usage: aws-kinesis-local [--port <port>] [--path <path>] [--ssl] [options]',
  '',
  'Serves the Amazon Kinesis Data Streams API in JSON and CBOR over HTTP/1.1 and HTTP/2, optionally backed by SQLite',
  '',
  'Options:',
  '--help                 Display this help message and exit',
  '--port <port>          The port to listen on (default: 4567)',
  '--path <path>          The directory for the SQLite store (in-memory by default)',
  '--ssl                  Enable SSL for the web server (default: false)',
  '--key <file>           PEM private key for --ssl (default: a generated self-signed key)',
  '--cert <file>          PEM certificate for --ssl (default: a generated self-signed certificate)',
  '--createStreamMs <ms>  Amount of time streams stay in CREATING state (default: 500)',
  '--deleteStreamMs <ms>  Amount of time streams stay in DELETING state (default: 500)',
  '--updateStreamMs <ms>  Amount of time streams stay in UPDATING state (default: 500)',
  '--shardLimit <limit>   Shard limit for error reporting (default: 10)',
  '',
  'Report bugs at github.com/saidsef/aws-kinesis-local/issues',
].join('\n')

const args = parseArguments(process.argv.slice(2))

if (args.help) {
  console.log(HELP)
} else {
  const defaults = defaultOptions()
  const server = await start({
    port: numberOption(args.port, defaults.port) || defaults.port,
    path: stringOption(args.path),
    ssl: args.ssl === true || args.ssl === 'true',
    keyFile: stringOption(args.key),
    certFile: stringOption(args.cert),
    createStreamMs: numberOption(args.createStreamMs, defaults.createStreamMs),
    deleteStreamMs: numberOption(args.deleteStreamMs, defaults.deleteStreamMs),
    updateStreamMs: numberOption(args.updateStreamMs, defaults.updateStreamMs),
    shardLimit: numberOption(args.shardLimit, defaults.shardLimit),
  })
  const { address, port } = server.address
  console.log('Listening at %s://%s:%s', server.protocol, address, port)
  const shutdown = () => {
    server.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
