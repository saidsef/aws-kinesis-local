# Docker Kinesis Local [![CI](https://github.com/saidsef/aws-kinesis-local/actions/workflows/docker.yml/badge.svg)](#howto-and-documentation) [![Tagging](https://github.com/saidsef/aws-kinesis-local/actions/workflows/tagging.yml/badge.svg)](#howto-and-documentation) [![Release](https://github.com/saidsef/aws-kinesis-local/actions/workflows/release.yml/badge.svg)](#howto-and-documentation)

Build for local AWS Kinesis

## Amazon Kinesis Streams

Amazon Kinesis Streams enables you to build custom applications that process or analyze streaming data for specialized needs. Amazon Kinesis Streams can continuously capture and store terabytes of data per hour from hundreds of thousands of sources such as website clickstreams, financial transactions, social media feeds, IT logs, and location-tracking events. With Amazon Kinesis Client Library (KCL), you can build Amazon Kinesis Applications and use streaming data to power real-time dashboards, generate alerts, implement dynamic pricing and advertising, and more. You can also emit data from Amazon Kinesis Streams to other AWS services such as Amazon Simple Storage Service (Amazon S3), Amazon Redshift, Amazon Elastic Map Reduce (Amazon EMR), and AWS Lambda.

## Components

* NodeJS
* [Kinesislite](https://github.com/mhart/kinesalite)

## HowTo and Documentation

* [Kinesislite](https://github.com/mhart/kinesalite)

 ```bash
docker run --rm -ti saidsef/aws-kinesis-local --help

 Usage: kinesalite [--port <port>] [--path <path>] [--ssl] [options]

 A Kinesis http server, optionally backed by LevelDB

 Options:
 --help                 Display this help message and exit
 --port <port>          The port to listen on (default: 4567)
 --path <path>          The path to use for the LevelDB store (in-memory by default)
 --ssl                  Enable SSL for the web server (default: false)
 --createStreamMs <ms>  Amount of time streams stay in CREATING state (default: 500)
 --deleteStreamMs <ms>  Amount of time streams stay in DELETING state (default: 500)
 --updateStreamMs <ms>  Amount of time streams stay in UPDATING state (default: 500)
 --shardLimit <limit>   Shard limit for error reporting (default: 10)
 ```

## Local Deployment

```bash
docker run -d -p 4567:4567 saidsef/aws-kinesis-local:latest --help
```

```bash
aws --endpoint-url=http://{kinesis-host}:4567 kinesis list-streams --region eu-west-1

{
    "StreamNames": []
}
```

## Kubernetes Deployment

```bash
kubectl apply -k deployment/

```

Or, to deploy via argocd:

```bash
kubectl apply -f argocd/application.yml
```

```bash
aws --endpoint-url=http://kinesis.[namespace].svc kinesis list-streams --region eu-west-1

{
    "StreamNames": []
}
```

```javascript
// npm install aws-sdk
const AWS = require('aws-sdk);

let kinesis = new AWS.Kinesis({ endpoint: "http://kinesis.[namespace].svc", region: "eu-west-1"})
kinesis.listStreams(console.log);
```

> The `endpoint` value depends on your deployment type

> See [AWS Kinesis documentations](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Kinesis.html)
