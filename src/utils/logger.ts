import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "polymarket-bot",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      ignore: "pid,hostname,service",
      translateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss.l'Z'",
    },
  },
});
