import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "../..");
const envFilePath = path.join(projectRoot, ".env");

dotenv.config({ path: envFilePath });

const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const nonEmpty = z.string().trim().min(1);

const envSchema = z.object({
  POLY_PRIVATE_KEY: nonEmpty,
  POLY_API_KEY: nonEmpty,
  POLY_API_SECRET: nonEmpty,
  POLY_PASSPHRASE: nonEmpty,
  POLY_ADDRESS: nonEmpty,
  POLY_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(2).default(0),

  CLOB_API_URL: z.string().url().default("https://clob.polymarket.com"),
  CHAIN_ID: z.coerce.number().int().default(137),
  ALCHEMY_WS_URL: z.string().url().default("wss://polygon-mainnet.g.alchemy.com/v2/4X-3b-IvrTq_9JAeVQW-M"),
  STATE_DB_PATH: z.string().trim().min(1).default("data/state.sqlite"),
  DRY_RUN: z.coerce.boolean().default(false),

  MARKET_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),
  DISCOVERY_MARKET_LIMIT: z.coerce.number().int().positive().default(500),
  TARGET_MARKET_COUNT: z.coerce.number().int().positive().default(4),
  STARTUP_MARKET_LOOKAHEAD_CYCLES: z.coerce.number().int().positive().default(4),
  FIFTEEN_MIN_LOOKAHEAD_CYCLES: z.coerce.number().int().positive().default(1),

  ORDER_PRICE: z.coerce.number().positive().max(1).default(0.04),
  ORDER_SIZE: z.coerce.number().positive().default(5),
  MIN_ORDER_SIZE: z.coerce.number().positive().default(5),
  MIN_RESERVE_USDC: z.coerce.number().nonnegative().default(2),
  RESERVE_BALANCE_USDC: z.coerce.number().nonnegative().default(5),
  ORDER_PLACE_MINUTES_BEFORE_START: z.coerce.number().int().nonnegative().default(15),
  ORDER_EXPIRATION_SECONDS: z.coerce.number().int().positive().default(45),
  DYNAMIC_QUOTING_ENABLED: z.coerce.boolean().default(true),
  ENTRY_EDGE_BUFFER: z.coerce.number().nonnegative().default(0.025),
  EXIT_EDGE_BUFFER: z.coerce.number().nonnegative().default(0.01),
  ADVERSE_SELECTION_BUFFER: z.coerce.number().nonnegative().default(0.015),
  DEFAULT_FEE_RATE_BPS: z.coerce.number().nonnegative().default(0),
  SELL_PLACEMENT_MAX_RETRIES: z.coerce.number().int().positive().default(5),
  SELL_PLACEMENT_RETRY_DELAY_MS: z.coerce.number().int().positive().default(5_000),

  MAX_RETRIES: z.coerce.number().int().positive().default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(500),

  LOG_LEVEL: z.enum(logLevels).default("info"),
  NTFY_TOPIC: z.string().optional().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${issues}`);
}

export const env = parsed.data;

export type AppEnv = typeof env;

export const envMeta = {
  envFilePath,
};
