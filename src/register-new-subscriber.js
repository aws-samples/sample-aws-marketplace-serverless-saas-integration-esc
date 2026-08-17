const winston = require('winston');
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { MarketplaceMeteringClient, ResolveCustomerCommand } = require("@aws-sdk/client-marketplace-metering");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");

const { NewSubscribersTableName: newSubscribersTableName, MarketplaceSellerEmail: marketplaceSellerEmail, AWS_REGION: aws_region } = process.env;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});

const ses = new SESClient({ region: aws_region });
const marketplacemetering = new MarketplaceMeteringClient({ region: aws_region });
const dynamodb = new DynamoDBClient({ region: aws_region });

const lambdaResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'OPTIONS,POST',
  },

  body: JSON.stringify(body),
});

const setBuyerNotificationHandler = function (contactEmail) {
  if (typeof marketplaceSellerEmail == 'undefined') {
    return;
  }
  let params = {
    Destination: {
      ToAddresses: [contactEmail],
    },
    Message: {
      Body: {
        Html: {
          Charset: "UTF-8",
          Data: "<!DOCTYPE html><html><head><title>Welcome!<\/title><\/head><body><h1>Welcome!<\/h1><p>Thanks for purchasing<\/p><p>We\u2019re thrilled to have you on board. Our team is hard at work setting up your account, please expect to hear from a member of our customer success team soon<\/p><\/body><\/html>"
        },
        Text: {
          Charset: "UTF-8",
          Data: "Welcome! Thanks for purchasing. We’re thrilled to have you on board. Our team is hard at work setting up your account, please expect to hear from a member of our customer success team soon"
        }
      },

      Subject: {
        Charset: 'UTF-8',
        Data: "Welcome Email"
      }
    },
    Source: marketplaceSellerEmail,
  };

  // catch SES error. When SES fails to send an email
  // to the email address the customer entered
  // the registering page fails with internal error
  // catching this error solves this internal error message
  ses.send(new SendEmailCommand(params))
    .then(result => {
      return true
    })
    .catch(error => {
      logger.error(`sending email via SES failed: ${error.message}`);
      return false
    });
};

exports.registerNewSubscriber = async (event) => {
  logger.info(`registerNewSubscriber invoked: httpMethod=${event.httpMethod}, path=${event.path}, requestId=${event.requestContext?.requestId}`);
  logger.debug(`event: ${JSON.stringify(event, null, 2)}`);
  const {
    // Accept form inputs from ../web/index.html
    regToken, companyName, contactPerson, contactPhone, contactEmail,
  } = JSON.parse(event.body);

  // Validate the request with form inputs from ../web/index.html
  if (regToken && companyName && contactPerson && contactPhone && contactEmail) {
    try {
      const resolveCustomerResponse = await marketplacemetering.send(
        new ResolveCustomerCommand({ RegistrationToken: regToken })
      );

      logger.info(`resolveCustomer successful: CustomerAWSAccountId=${resolveCustomerResponse.CustomerAWSAccountId}, ProductCode=${resolveCustomerResponse.ProductCode}`);

      // Store new subscriber data in dynamoDb
      // Get ProductCode, customerAwsAccountId and LicenseArn from Registration Token
      const { ProductCode, CustomerAWSAccountId, LicenseArn } = resolveCustomerResponse;

      const datetime = new Date().getTime().toString();

      // Write form inputs from ../web/index.html
      // Use UpdateItem to upsert (update if exists, create if doesn't)
      const dynamoDbParams = {
        TableName: newSubscribersTableName,
        Key: {
          customerIdentifier: { S: CustomerAWSAccountId },
        },
        UpdateExpression: 'set companyName = :cn, contactPerson = :cp, contactPhone = :cph, contactEmail = :ce, productCode = :pc, customerAwsAccountId = :caid, successfully_registered = :sr, updated_at = :ua',
        ExpressionAttributeValues: {
          ':cn': { S: companyName },
          ':cp': { S: contactPerson },
          ':cph': { S: contactPhone },
          ':ce': { S: contactEmail },
          ':pc': { S: ProductCode },
          ':caid': { S: CustomerAWSAccountId },
          ':sr': { BOOL: true },
          ':ua': { S: new Date().toISOString() },
        },
        // Only set created timestamp if the item doesn't exist
        ConditionExpression: 'attribute_not_exists(created)',
        ReturnValues: 'UPDATED_NEW',
      };

      try {
        logger.debug(`updating DynamoDB table=${newSubscribersTableName}, key=${CustomerAWSAccountId}`);
        await dynamodb.send(new UpdateItemCommand(dynamoDbParams));
        logger.info('DynamoDB updated - new record created');
      } catch (error) {
        // If condition fails, it means the record exists, so update without the condition
        if (error.name === 'ConditionalCheckFailedException') {
          delete dynamoDbParams.ConditionExpression;
          logger.info('Record exists, updating existing record');
          await dynamodb.send(new UpdateItemCommand(dynamoDbParams));
          logger.info('DynamoDB updated - existing record modified');
        } else {
          throw error;
        }
      }

      await setBuyerNotificationHandler(contactEmail);

      return lambdaResponse(200, 'Success! Registration completed. You have purchased an enterprise product that requires some additional setup. A representative from our team will be contacting you within two business days with your account credentials. Please contact Support through our website if you have any questions.');
    } catch (error) {
      logger.error(`Registration failed: ${error.message}`);
      return lambdaResponse(400, 'Registration data not valid. Please try again, or contact support!');
    }
  } else {
    return lambdaResponse(400, 'Request no valid');
  }
};
