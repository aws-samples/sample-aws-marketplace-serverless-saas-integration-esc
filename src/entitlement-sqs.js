const winston = require('winston');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { MarketplaceEntitlementServiceClient, GetEntitlementsCommand } = require('@aws-sdk/client-marketplace-entitlement-service');
const { NewSubscribersTableName: newSubscribersTableName, AWS_REGION: aws_region, PricingModel: pricingModel } = process.env;
const dynamodb = new DynamoDBClient({ region: aws_region });
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});

// call GetEntitlements API using CustomerAWSAccountId as the filter
async function getEntitlements(productCode, customerAWSAccountId, region) {
  try {
    logger.info(`getEntitlements: productCode: ${productCode}, customerAWSAccountId: ${customerAWSAccountId}, region: ${region}`);
    const entitlementParams = {
      ProductCode: productCode,
      Filter: {
        CUSTOMER_AWS_ACCOUNT_ID: [customerAWSAccountId]
      }
    };
    logger.debug(`entitlementParams: ${JSON.stringify(entitlementParams, null, 2)}`);

    const mpClient = new MarketplaceEntitlementServiceClient({ region });
    const command = new GetEntitlementsCommand(entitlementParams);
    return await mpClient.send(command);
  } catch (error) {
    logger.error(`Error getting entitlements: ${error}`);
    return null;
  }
}

exports.handler = async (event) => {
  logger.info(`entitlement-sqs handler invoked: recordCount=${event.Records?.length}`);
  logger.debug(`event: ${JSON.stringify(event, null, 2)}`);
  await Promise.all(event.Records.map(async (record) => {

    const body = JSON.parse(record.body);
    logger.debug('body:', body);
    const detailType = body['detail-type'];

    logger.debug(`Detail Type: ${detailType}`);

    if (detailType === 'License Updated - Manufacturer' 
        || detailType === 'License Deprovisioned - Manufacturer' 
        || detailType === 'License Updated - Proposer' 
        || detailType === 'License Deprovisioned - Proposer') {
      logger.debug(`processing detail-type: ${detailType}`);

      const productId = body.detail.product.id;
      const productCode = body.detail.product.code;
      const licenseArn = body.detail.license.arn;
      const acceptorAccountId = body.detail.acceptor.accountId;
      const agreementId = body.detail.agreement.id;
      logger.debug(`productId: ${productId}`);
      logger.debug(`productCode: ${productCode}`);
      logger.debug(`licenseArn: ${licenseArn}`);
      logger.debug(`acceptorAccountId: ${acceptorAccountId}`);
      logger.debug(`agreementId: ${agreementId}`);

      // Agreement details and free trial detection are unavailable in the European Sovereign Cloud
      logger.warn('Agreement details and free trial detection are unavailable in the European Sovereign Cloud');
      const isFreeTrialTermPresent = false;

      let entitlementData = {};
      let isExpired = detailType === 'License Deprovisioned - Manufacturer' || detailType === 'License Deprovisioned - Proposer';
      let updateExpression = "";

      // Determine whether to call GetEntitlements based on PricingModel environment variable
      const callEntitlements = pricingModel === 'contracts' || pricingModel === 'contracts_with_subscription';
      logger.info(`callEntitlements: ${callEntitlements} (pricingModel: ${pricingModel})`);

      if (callEntitlements) {
        logger.info(`Calling GetEntitlements for contract-based pricing model with acceptorAccountId: ${acceptorAccountId}`);
        const entitlementsResponse = await getEntitlements(
          productCode,
          acceptorAccountId,
          aws_region
        );

        logger.debug(`entitlementsResponse: ${JSON.stringify(entitlementsResponse, null, 2)}`);
        if (entitlementsResponse) {
          const { $metadata, ...data } = entitlementsResponse;
          entitlementData = data;
          logger.debug(`entitlementData: ${JSON.stringify(entitlementData, null, 2)}`);
          isExpired = entitlementData.hasOwnProperty("Entitlements") === false || entitlementData.Entitlements.length === 0 ||
            new Date(entitlementData.Entitlements[0].ExpirationDate) < new Date();
          logger.debug(`isExpired: ${isExpired}`);
        }
        updateExpression = "set entitlement = :e, successfully_subscribed = :ss, subscription_expired = :se, is_free_trial_term_present = :ft, updated_at = :ua";
      } else {
        updateExpression = "set successfully_subscribed = :ss, subscription_expired = :se, is_free_trial_term_present = :ft, updated_at = :ua";
        logger.info('Skipping GetEntitlements call for subscriptions pricing model');
      }
      logger.debug(`updateExpression: ${updateExpression}`);

      // Use acceptorAccountId as the DynamoDB key instead of licenseArn
      const dynamoDbKey = acceptorAccountId;
      logger.debug(`dynamoDbKey: ${dynamoDbKey}`);

      // Build ExpressionAttributeValues
      const expressionAttributeValues = {
        ':ss': { BOOL: true },
        ':se': { BOOL: isExpired },
        ':ft': { BOOL: isFreeTrialTermPresent },
        ':ua': { S: new Date().toISOString() },
      };

      // Only include entitlement data for contract-based pricing models
      if (callEntitlements) {
        expressionAttributeValues[':e'] = { S: JSON.stringify(entitlementData) };
      }

      const dynamoDbParams = {
        TableName: newSubscribersTableName,
        Key: {
          customerIdentifier: { S: dynamoDbKey },
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'UPDATED_NEW',
      };

      logger.debug(`dynamoDbParams: ${JSON.stringify(dynamoDbParams, null, 2)}`);
      await dynamodb.send(new UpdateItemCommand(dynamoDbParams));
      logger.info(`License Agreement updated successfully in DynamoDB table ${newSubscribersTableName}`);
    } else {
      logger.error(`Unhandled action - msg: ${JSON.stringify(record)}`);
    }
  }));
  return {};
};
