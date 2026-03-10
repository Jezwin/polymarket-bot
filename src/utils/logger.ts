import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "../..");
const logsDir = path.join(projectRoot, "logs");

fs.mkdirSync(logsDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const logFilePath = path.join(logsDir, `bot-${today}.log`);

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "polymarket-bot",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [
      {
        target: "pino-pretty",
        level: env.LOG_LEVEL,
        options: {
          colorize: true,
          ignore: "pid,hostname,service",
          translateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss.l'Z'",
        },
      },
      {
        target: "pino/file",
        level: env.LOG_LEVEL,
        options: {
          destination: logFilePath,
          mkdir: true,
        },
      },
    ],
  },
});

logger.info({ logFilePath }, "Logging to file");

const fillsLogFilePath = path.join(logsDir, `fills-${today}.log`);

export const fillsLogger = pino({
  level: "info",
  base: {
    service: "order-fills",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [
      {
        target: "pino-pretty",
        level: "info",
        options: {
          colorize: true,
          ignore: "pid,hostname,service",
          translateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss.l'Z'",
        },
      },
      {
        target: "pino/file",
        level: "info",
        options: {
          destination: fillsLogFilePath,
          mkdir: true,
        },
      },
    ],
  },
});
