import pino from "pino";
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers['x-neptun-edge-signature']",
    "req.headers['x-neptun-edge-client-ip']",
    "password",
    "passwordHash",
    "apiKey",
    "token",
    "sessionToken",
  ],
});
