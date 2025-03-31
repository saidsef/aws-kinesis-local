# Docker Kinesis Local [![CI](https://github.com/saidsef/aws-kinesis-local/actions/workflows/docker.yml/badge.svg)](#howto-and-documentation) [![Tagging](https://github.com/saidsef/aws-kinesis-local/actions/workflows/charts.yml/badge.svg)](#howto-and-documentation)

Build for local AWS Kinesis

## Amazon Kinesis Streams

Amazon Kinesis Streams lets you build your own apps to deal with streaming data, tailored to your specific requirements. It achieves this by:

* **Continuous Data Capture:** Reliably storing huge volumes of data (terabytes per hour) from masses of sources. Think website activity, financial trades, social media, system logs, and location tracking.
* **Custom App Development:** Using the Amazon Kinesis Client Library (KCL) to build applications that use this stream of data.
* **Real-Time Use Cases:** Powering things like live dashboards, automated alerts, dynamic pricing models, and targeted advertising.
* **Integration with AWS:** Feeding data from Kinesis Streams into other AWS services, such as Amazon S3, Amazon Redshift, Amazon EMR, and AWS Lambda.

## Components

* NodeJS
* [Kinesislite](https://github.com/mhart/kinesalite)

## HowTo and Documentation

* [Kinesislite](https://github.com/mhart/kinesalite)

 ```bash
docker run --rm -ti docker.io/saidsef/aws-kinesis-local --help

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
docker run -d -p 4567:4567 docker.io/saidsef/aws-kinesis-local:latest --help
```

```bash
aws --endpoint-url=http://{kinesis-host}:4567 kinesis list-streams --region eu-west-1

{
    "StreamNames": []
}
```

## Kubernetes Deployment

### HELM

```shell
helm repo add kinesis https://saidsef.github.io/aws-kinesis-local/
helm repo update
helm upgrade --install kinesis kinesis/kinesis --namespace kinesis --create-namespace
```

### Kubectl

```bash
kubectl apply -k deployment/

```

### ArgoCD

```bash
kubectl apply -f argocd/application.yml
```

## Testing

### AWS CLI/SDK

```bash
aws --endpoint-url=http://[kinesis|IP_ADDRESS] kinesis list-streams --region eu-west-1

{
    "StreamNames": []
}
```

```javascript
// npm install aws-sdk
const AWS = require('aws-sdk');

let kinesis = new AWS.Kinesis({ endpoint: "http://kinesis.[namespace].svc", region: "eu-west-1"})
kinesis.listStreams(console.log);
```

> The `endpoint` value depends on your deployment type

> See [AWS Kinesis documentations](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Kinesis.html)

## Source

Our latest and greatest source of Jenkins can be found on [GitHub](#deployment). Fork us!

## Contributing

We would :heart:  you to contribute by making a [pull request](https://github.com/saidsef/aws-kinesis-local/pulls).

Please read the official [Contribution Guide](./CONTRIBUTING.md) for more information on how you can contribute.
