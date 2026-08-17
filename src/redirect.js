// redirect.js
// redirects to signup page and includes registration token in the URL

const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});

exports.redirecthandler = async (event) => {
  logger.info(`redirect handler invoked: httpMethod=${event.httpMethod}, path=${event.path}, requestId=${event.requestContext?.requestId}`);
  logger.debug(`event: ${JSON.stringify(event, null, 2)}`);

  // Use the stage from the request context to build the correct redirect URL
  const stage = event.requestContext && event.requestContext.stage ? event.requestContext.stage : 'Prod';
  const redirectUrl = `/${stage}/?${event.body}`;
  logger.debug(`redirectUrl: ${redirectUrl}`);

  const response = {
      statusCode: 302,
      headers: {
          Location: redirectUrl
      },
  };

  return response;
};
