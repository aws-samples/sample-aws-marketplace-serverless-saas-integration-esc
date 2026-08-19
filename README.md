# AWS Marketplace - Serverless integration for SaaS products (European Sovereign Cloud)

![Banner](misc/banner.png)

This project is a reference implementation of the integration required for SaaS applications in AWS Marketplace in the **AWS European Sovereign Cloud (ESC)**. It demonstrates how to [onboard customers](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-product-customer-setup.html) using AWS SAM (Serverless Application Model) for configuration, building, and deployment.

> This project is adapted from the [aws-marketplace-serverless-saas-integration](https://github.com/aws-samples/aws-marketplace-serverless-saas-integration) reference implementation for use in the **AWS European Sovereign Cloud**. Key differences from the commercial region version are documented in the [ESC-specific changes](#esc-specific-changes) section.

> [**EventBridge notifications**]
> This integration uses [Amazon EventBridge notifications](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-eventbridge-integration.html) for license lifecycle events. License events are processed via EventBridge rules and SQS queues. All lifecycle events are handled by [EventBridge license events](https://docs.aws.amazon.com/marketplace/latest/userguide/notifications-eventbridge.html#events-for-licenses).

> [**CustomerIdentifier**]
> This ESC implementation uses the **Customer AWS Account ID** as the primary customer identifier (`customerIdentifier`) in DynamoDB tables. The product code is looked up from the Subscribers table at metering time rather than being hardcoded or retrieved by the Marketplace Catalog API. The `GetEntitlements` API is filtered by `CUSTOMER_AWS_ACCOUNT_ID`.

> [**!IMPORTANT**]
> **For reference purposes only**: The solution created in this repo serves as a reference demonstrating the core components needed for integrating and operating a SaaS listing in AWS Marketplace. While we periodically update the solution to reflect current integration standards, it does not adhere to any service level agreement. Proceed with caution if you intend to use this solution in production or with other critical data. You are responsible for testing, securing, and optimizing AWS Content, such as sample code, as appropriate for production grade use based on your specific quality control practices and standards.

### Resources

* [SaaS Product Requirements & Recommendations](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-guidelines.html)
* [Managing SaaS subscription events with Amazon EventBridge](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-eventbridge-integration.html)
* [Listing and Selling in AWS Marketplace for AWS European Sovereign Cloud](https://docs.aws.amazon.com/marketplace/latest/userguide/esc_seller_guide.html)
* [AWS Marketplace - Seller Guide](https://docs.aws.amazon.com/marketplace/latest/userguide/what-is-marketplace.html)

## Project Structure & Solution Architecture

The sample in this repository demonstrates how to use AWS SAM to integrate your SaaS product with AWS Marketplace in the European Sovereign Cloud and how to perform:

- [Register new customers](#register-new-customers)
- [Grant and revoke access to your product](#grant-and-revoke-access-to-your-product)
- [Metering for usage](#metering-for-usage)
- [Deploying the application](#deploying-the-application)

![](misc/arch.png)

## Register new customers

With SaaS products, your customers subscribe to your products through AWS Marketplace, but access the product on an environment you manage in your AWS account. After subscribing to the product, your customer is directed to a registration/landing page you create and manage as a part of your SaaS product to create their account and configure the product.

When defining your product in AWS Marketplace Management Portal (Partner Central), you are asked to provide a fulfillment URL. This is the registration/landing page where AWS Marketplace redirects customers after they subscribe. On this page, you collect whatever information is required to create an account for the customer.

The registration/landing page needs to be able to accept the `x-amzn-marketplace-token` token in the form data from AWS Marketplace. Your landing page calls the [ResolveCustomer API](https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-metering_ResolveCustomer.html) to get and persist **CustomerAWSAccountId** and **ProductCode**.

> NOTE: This solution provides a registration/landing page that can be branded to match your product. However, deploying it is optional — you can choose to use your own existing registration page instead. In this case make sure you are collecting the customer data and calling register new subscriber endpoint. Please see the [deployment section](#deploying-the-application).

### Implementation

The POST request coming from AWS Marketplace is sent to **Amazon API Gateway**. The API Gateway invokes an **AWS Lambda** function - `src/redirect.js` - which transforms the POST request to a GET request, and passes the `x-amzn-marketplace-token` in the query string.
A static registration/landing page served by the `src/static-content.js` Lambda function (from S3) takes the user inputs defined in the HTML form and submits them to the `/subscriber` API Gateway endpoint.

The handler for the `/subscriber` endpoint is defined in `src/register-new-subscriber.js`. This Lambda function calls the [ResolveCustomer API](https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-metering_ResolveCustomer.html) and validates the token. If the token is valid, a customer record is created in the `AWSMarketplaceSubscribers` DynamoDB table with the customer's AWS Account ID as the partition key, along with the product code and form data.



## Grant and revoke access to your product

### Grant access to new subscribers

Once the **ResolveCustomer API** returns a successful response and the **License Updated** event is received via Amazon EventBridge, the SaaS vendor must provide access to the solution to the new subscriber.
Based on the product's pricing model: Subscriptions (PAYG), Contracts, or Contracts with Consumption,  we have defined different conditions in the `grant-revoke-access-to-product.js` stream handler that is executed on adding new or updating existing rows.

The property `successfully_subscribed` is set when a successful response is returned from the SQS entitlement handler for SaaS Contract based listings after receiving a **License Updated** event via Amazon EventBridge.

In our implementation the Marketplace Tech Admin (the email address you entered when deploying) will receive an email when a new environment needs to be provisioned or an existing environment needs to be updated. AWS Marketplace strongly recommends automating the access and environment management which can be achieved by modifying the `grant-revoke-access-to-product.js` function.

### Update entitlement levels (Contracts and Contracts with consumption only)

Each time the entitlement is updated, AWS Marketplace publishes a **License Updated** event to Amazon EventBridge in the seller's account. An EventBridge rule sends the message to the Entitlement SQS queue. The Lambda function `entitlement-sqs.js` is triggered by SQS and calls the `GetEntitlements` API (filtering by `CUSTOMER_AWS_ACCOUNT_ID`) when the product is contract based. After gathering all data it is stored in the DynamoDB `AWSMarketplaceSubscribers` table.

We use the same DynamoDB stream to detect changes in the DynamoDB table. When an item is updated, a notification is sent to the `MarketplaceTechAdmin`.

### Revoke access to customers with expired contracts or cancelled subscriptions

The revoke access logic is implemented in a similar manner as the grant access logic but uses the **License Deprovisioned** event.

In our implementation the `MarketplaceTechAdmin` receives email when the contract expires or the subscription is cancelled.

AWS Marketplace strongly recommends automating the access and environment management which can be achieved by modifying the `grant-revoke-access-to-product.js` function.

## Metering for usage

For SaaS Subscriptions or Contracts with Consumption, the SaaS provider must track and report all usage, and then customers are billed by AWS Marketplace based on the metering records provided. For SaaS Contracts with Consumption, you only meter for usage beyond a customer's contract entitlements. When your application meters usage for a customer, your application is providing AWS Marketplace with a quantity of usage accrued. Your application meters for the pricing dimensions that you defined when you created your product, such as gigabytes transferred or hosts scanned in a given hour.s transferred or hosts scanned in a given hour.

### Implementation

The solution creates a scheduled EventBridge rule that triggers the `metering-hourly-job.js` Lambda function **hourly**. It queries all pending/unreported metering records from the `AWSMarketplaceMeteringRecords` table using the `metering_pending` field.

All pending records are aggregated based on the `customerIdentifier` (AWS Account ID) and dimension name, and sent to the SQS Metering queue.

Ideally your SaaS application is going to inset the metering records programatically into the `AWSMarketplaceMeteringRecords`. For it you need to grant permissions to you application to write to the `AWSMarketplaceMeteringRecords` table.

The Lambda function `metering-sqs.js` looks up the **product code** from the `AWSMarketplaceSubscribers` table for the given customer, then sends all queued metering records to the AWS Marketplace Metering Service via the `BatchMeterUsage` API.

After every call to `BatchMeterUsage`, the rows are updated in the `AWSMarketplaceMeteringRecords` table with the response returned from the Metering Service (stored in the `metering_response` field). If the request was unsuccessful, `metering_failed` will be set to `true` and the error will also be stored in the `metering_response` field.

The new records in the `AWSMarketplaceMeteringRecords` table must be stored in the following format:

```json
{
  "create_timestamp": {
    "N": "1763634471636562122"
  },
  "customerIdentifier": {
    "S": "071964067459"
  },
  "dimension_usage": {
    "L": [
      {
        "M": {
          "dimension": {
            "S": "usage1"
          },
          "value": {
            "N": "3"
          }
        }
      }
    ]
  },
  "metering_pending": {
    "S": "true"
  }
}
```

Where `create_timestamp` is the sort key and `customerIdentifier` (the customer's AWS Account ID) is the partition key, forming the Primary key together.





After the record is submitted to the AWS Marketplace `BatchMeterUsage` API, it will be updated. An example of a correct sent metering record can be seen below:

```json
{
  "create_timestamp": 1763634471636562122,
  "customerIdentifier": "071964067459",
  "dimension_usage": [
    {
      "dimension": "usage1",
      "value": 3
    }
  ],
  "metering_failed": false,
  "metering_response": "{\"Results\":[{\"UsageRecord\":{\"Timestamp\":\"2026-04-23T14:49:14.499Z\",\"Dimension\":\"usage1\",\"Quantity\":3,\"CustomerAWSAccountId\":\"071964067459\"},\"MeteringRecordId\":\"1818031d-2bdf-43e8-ad5f-b85e28a14c7b\",\"Status\":\"Success\"}],\"UnprocessedRecords\":[]}"
}
```

## ESC-specific changes

This implementation differs from the [commercial region version](https://github.com/aws-samples/aws-marketplace-serverless-saas-integration) in the following ways:

| Area | Commercial Version | ESC Version |
|------|-------------------|-------------|
| **Customer Identifier** | License ARN as primary key | Customer AWS Account ID as primary key |
| **Product Code lookup** | From Marketplace Catalog API (`DescribeEntity`) | From `AWSMarketplaceSubscribers` DynamoDB table |
| **GetEntitlements filter** | `LICENSE_ARN` | `CUSTOMER_AWS_ACCOUNT_ID` |
| **Agreement details** | Available via `GetAgreementTerms` | Not available in ESC |
| **Free trial detection** | Detected from agreement terms | Always set to `false` |
| **Static content serving** | CloudFront + S3 | Lambda function (`static-content.js`) serving from S3 via API Gateway |
| **Console URLs** | `console.aws.amazon.com` | `console.amazonaws-eusc.eu` |
| **API endpoints** | `*.amazonaws.com` | `*.amazonaws.eu` |
| **Runtime** | Node.js 24.x | Node.js 24.x |
| **Cross-account role** | Supported | Not included |
| **CloudFront distribution** | Included | Not included |
| **Fulfillment URL auto-update** | Supported | Not included |


## Deploying the application

### Prerequisites

* AWS CLI configured with a profile for the European Sovereign Cloud account
* SAM CLI installed
* Node.js

### Build and deploy

Use the following commands to build and deploy the solution: 



```bash
sam build --profile esc
sam deploy --guided --capabilities CAPABILITY_NAMED_IAM --profile esc
```

### Parameters

Parameter name | Description
------------- | -----------
Stack Name | Name of the resulting CloudFormation stack
AWS Region | ESC region (e.g., `eusc-de-east-1`)
WebsiteS3BucketName | S3 bucket to store the HTML files; required if `CreateRegistrationWebPage` is `true`; will be created
NewSubscribersTableName | Name for the Subscribers Table; Default: `AWSMarketplaceSubscribers`
AWSMarketplaceMeteringRecordsTableName | Name for the Metering Records Table; Default: `AWSMarketplaceMeteringRecords`
TypeOfSaaSListing | Allowed values: `contracts_with_subscription`, `contracts`, `subscriptions`; Default: `contracts_with_subscription`
ProductId | Product ID provided from AWS Marketplace
MarketplaceTechAdminEmail | Email to be notified on changes requiring action
MarketplaceSellerEmail | (Optional) Seller email address, verified in SES. Used as the "From" address to send a welcome email to new subscribers upon registration. If left empty, no welcome email is sent.
CreateRegistrationWebPage | Creates a registration page; Default: `true`
KmsKeyArn | (Optional) ARN of a KMS Customer Managed Key for encrypting DynamoDB tables, SQS queues, and SNS topics. Set to `aws_managed` (default) to use AWS-managed encryption keys.

### Post deployment steps

1. Update the **MarketplaceFulfillmentURL** in Partner Central with the value from the stack output key `MarketplaceFulfillmentURL`.
2. If provided, ensure the MarketplaceSellerEmail is a verified identity/domain in Amazon Simple Email Service.
3. Confirm the SNS subscription for the `MarketplaceTechAdminEmail` to receive notifications.

### Diagram of created resources

Based on the value of the **TypeOfSaaSListing** parameter, the resources deployed will vary minimally.

* For ***subscriptions***: an additional dynamoDB table to store the metering records will be deployed.
The landing page is optional. Use the ***CreateRegistrationWebPage*** parameter to control if the registration page will be deployed.

![](misc/resources.png)

## Cleanup

To delete the application:

```bash
# If you deployed a registration page, empty the S3 bucket first
aws s3 rm s3://<WebsiteS3BucketName> --recursive --profile esc

# Delete the stack
aws cloudformation delete-stack --stack-name <stack-name> --profile esc
```


## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
