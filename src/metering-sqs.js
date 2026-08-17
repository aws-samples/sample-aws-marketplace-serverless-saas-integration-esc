const winston = require('winston');
const { DynamoDBClient, UpdateItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { MarketplaceMeteringClient, BatchMeterUsageCommand } = require('@aws-sdk/client-marketplace-metering');
const { AWSMarketplaceMeteringRecordsTableName, NewSubscribersTableName, AWS_REGION: aws_region } = process.env;
const dynamodb = new DynamoDBClient({ region: aws_region });
const marketplacemetering = new MarketplaceMeteringClient({ region: aws_region });
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});

async function getProductCode(customerIdentifier) {
  try {
    const result = await dynamodb.send(new GetItemCommand({
      TableName: NewSubscribersTableName,
      Key: { customerIdentifier: { S: customerIdentifier } },
      ProjectionExpression: 'productCode',
    }));
    const productCode = result.Item?.productCode?.S;
    if (!productCode) {
      logger.error(`Could not find productCode for customerIdentifier: ${customerIdentifier}`);
    }
    return productCode;
  } catch (error) {
    logger.error(`Error looking up productCode for ${customerIdentifier}:`, error);
    return null;
  }
}

exports.handler = async (event) => {
  logger.debug({"event" : event});
  await Promise.all(event.Records.map(async (record) => {
    const body = JSON.parse(record.body);
    logger.debug({"SQS message body": body});

    const productCode = await getProductCode(body.customerIdentifier);
    if (!productCode) {
      logger.error(`Skipping metering for customerIdentifier: ${body.customerIdentifier} - productCode not found in Subscribers table`);
      return;
    }

    const timestmpNow = new Date();

    const UsageRecords = [];
    for (const r of body.dimension_usage) {
      UsageRecords.push({
        Dimension: r.dimension,
        Quantity: r.value,
        Timestamp: timestmpNow,
        CustomerAWSAccountId: body.customerIdentifier,
      });
    }

    const batchMeteringParams = { ProductCode: productCode, UsageRecords };

    logger.debug({"UsageRecords" : UsageRecords});
    let meteringResponse = '';
    let meteringFailed = false;
    try {
      logger.debug({"batchMeteringParams" : batchMeteringParams});
      meteringResponse = await marketplacemetering.send(new BatchMeterUsageCommand(batchMeteringParams));
      logger.debug({"meteringResponse" :  meteringResponse});
      if(meteringResponse.Results.find(r => r.Status !== 'Success')){
        logger.error({"meteringResponse" :  meteringResponse});
        meteringFailed = true;
      }
    } catch (error) {
      logger.error({'error': error});
      meteringResponse = JSON.stringify(error);
      meteringFailed = true;
    }

    await Promise.all(body.create_timestamps.map(async (ts) => {
      const dynamoDbParams = {
        TableName: AWSMarketplaceMeteringRecordsTableName,
        Key: {
          customerIdentifier: { S: body.customerIdentifier },
          create_timestamp: { N: `${ts}` },
        },
        UpdateExpression: 'set metering_response = :x, metering_failed = :mf remove metering_pending',
        ExpressionAttributeValues: {
          ':x': { S: JSON.stringify(meteringResponse) },
          ':mf': { BOOL: meteringFailed },
        },
        ReturnValues: 'UPDATED_NEW',
      };

      await dynamodb.send(new UpdateItemCommand(dynamoDbParams));
      
    }));
  
  }));


  return {};
};
