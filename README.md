# Docker Kinesis

Build for local AWS Kinesis

## Amazon Kinesis Streams

Amazon Kinesis Streams enables you to build custom applications that process or analyze streaming data for specialized needs. Amazon Kinesis Streams can continuously capture and store terabytes of data per hour from hundreds of thousands of sources such as website clickstreams, financial transactions, social media feeds, IT logs, and location-tracking events. With Amazon Kinesis Client Library (KCL), you can build Amazon Kinesis Applications and use streaming data to power real-time dashboards, generate alerts, implement dynamic pricing and advertising, and more. You can also emit data from Amazon Kinesis Streams to other AWS services such as Amazon Simple Storage Service (Amazon S3), Amazon Redshift, Amazon Elastic Map Reduce (Amazon EMR), and AWS Lambda.

## Components

 * NodeJS
 * [Kinesislite](https://github.com/mhart/kinesalite)

## Deployment

```bash
docker run -d -p 4567:4567 saidsef/aws-kinesis --help
```
