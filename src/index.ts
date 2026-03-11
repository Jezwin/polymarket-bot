import { env, envMeta } from "./config/env.js";
import { OrderScheduler } from "./scheduler/orderScheduler.js";
import { ClobClientService } from "./services/clobClient.js";
import { MarketDiscoveryService } from "./services/marketDiscovery.js";
import { OrderService } from "./services/orderService.js";
import { FillListener } from "./services/fillListener.js";
import { PolygonWsClient } from "./services/polygonWsClient.js";
import { PositionManager } from "./services/positionManager.js";
import { PositionStore } from "./services/positionStore.js";
import { QuoteEngine } from "./services/quoteEngine.js";
import { logger } from "./utils/logger.js";

const bootstrap = async (): Promise<void> => {
  logger.info(
    {
      clobApiUrl: env.CLOB_API_URL,
      chainId: env.CHAIN_ID,
      targetMarketCount: env.TARGET_MARKET_COUNT,
      startupMarketLookaheadCycles: env.STARTUP_MARKET_LOOKAHEAD_CYCLES,
      orderPrice: env.ORDER_PRICE,
      orderSize: env.ORDER_SIZE,
      placeMinutesBeforeStart: env.ORDER_PLACE_MINUTES_BEFORE_START,
    },
    "Bot startup",
  );

  const clobClientService = new ClobClientService();
  logger.info(
    {
      envFilePath: envMeta.envFilePath,
      signerAddress: clobClientService.getSignerAddress(),
      polyAddress: env.POLY_ADDRESS,
      signatureType: env.POLY_SIGNATURE_TYPE,
    },
    "Runtime wallet configuration loaded",
  );
  await clobClientService.healthcheck();

  const balance = await clobClientService.getBalanceSnapshot();
  logger.info(
    {
      balanceUsdc: balance.balanceUsdc,
      allowanceUsdc: balance.allowanceUsdc,
    },
    "Wallet balance snapshot",
  );

  const marketDiscoveryService = new MarketDiscoveryService();
  const positionStore = new PositionStore();

  const polygonWsClient = new PolygonWsClient();
  await polygonWsClient.connect();
  const quoteEngine = new QuoteEngine(clobClientService);

  const positionManager = new PositionManager(positionStore, clobClientService, polygonWsClient, quoteEngine);
  positionManager.init();

  const fillListener = new FillListener(positionManager);

  await fillListener.connect();

  const orderService = new OrderService(clobClientService, fillListener, positionManager, quoteEngine, positionStore);
  positionManager.setOrderService(orderService);

  await positionManager.rehydrate(fillListener);

  const scheduler = new OrderScheduler(marketDiscoveryService, orderService, positionManager);
  await scheduler.start();

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "Shutdown signal received");
    scheduler.stop();
    fillListener.close();
    polygonWsClient.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

void bootstrap().catch((error: unknown) => {
  logger.fatal(
    {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
    "Bot failed to start",
  );
  process.exit(1);
});
