const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const winston = require("winston");

const s3Client = new S3Client();
const BUCKET_NAME = process.env.WebsiteS3BucketName;
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [new winston.transports.Console()],
});

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".map": "application/json",
};

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot",
]);

function getContentType(key) {
  const ext = key.lastIndexOf(".") !== -1 ? key.substring(key.lastIndexOf(".")).toLowerCase() : "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

function isBinary(key) {
  const ext = key.lastIndexOf(".") !== -1 ? key.substring(key.lastIndexOf(".")).toLowerCase() : "";
  return BINARY_EXTENSIONS.has(ext);
}

exports.handler = async (event) => {
  logger.info("Static content request received");
  logger.debug("Full event", { event: JSON.stringify(event) });
  logger.debug("Environment", { BUCKET_NAME, LOG_LEVEL: process.env.LOG_LEVEL });
  logger.debug("pathParameters", { pathParameters: event.pathParameters });
  logger.debug("path", { path: event.path });
  logger.debug("resource", { resource: event.resource });

  let key = event.pathParameters && event.pathParameters.proxy
    ? event.pathParameters.proxy
    : "index.html";

  logger.debug("Initial key from pathParameters", { key });

  // Strip leading slash if present
  if (key.startsWith("/")) {
    key = key.substring(1);
    logger.debug("Stripped leading slash", { key });
  }

  // Default empty path to index.html
  if (!key) {
    key = "index.html";
    logger.debug("Defaulted empty key to index.html");
  }

  const contentType = getContentType(key);
  const binary = isBinary(key);
  logger.info("Fetching from S3", { bucket: BUCKET_NAME, key, contentType, binary });

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const response = await s3Client.send(command);
    logger.debug("S3 response metadata", { statusCode: response.$metadata?.httpStatusCode, contentLength: response.ContentLength, s3ContentType: response.ContentType });

    let body;
    if (binary) {
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString("base64");
      logger.debug("Binary content encoded", { bodyLength: body.length });
    } else {
      body = await response.Body.transformToString();
      logger.debug("Text content read", { bodyLength: body.length });
    }

    const result = {
      statusCode: 200,
      headers: { "Content-Type": contentType },
      body: body,
      isBase64Encoded: binary,
    };
    logger.info("Returning 200", { key, contentType, binary, bodyLength: body.length });
    return result;
  } catch (err) {
    logger.error("Error serving static content", { 
      errorName: err.name, 
      errorMessage: err.message, 
      httpStatusCode: err.$metadata?.httpStatusCode,
      bucket: BUCKET_NAME, 
      key 
    });

    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "text/html" },
        body: "<html><body><h1>404 Not Found</h1><p>The requested resource was not found.</p></body></html>",
        isBase64Encoded: false,
      };
    }

    return {
      statusCode: 500,
      headers: { "Content-Type": "text/html" },
      body: "<html><body><h1>500 Internal Server Error</h1><p>An error occurred while serving the requested resource.</p></body></html>",
      isBase64Encoded: false,
    };
  }
};
