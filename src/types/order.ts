import type { DiscoveredMarket } from "./market.js";

export type MarketLeg = "YES" | "NO";

export interface TrackedOrder {
  orderId: string;
  marketId: string;
  conditionId: string;
  tokenId: string;
  price: number;
  size: number;
  leg: MarketLeg;
}

export interface TrackedMarketState {
  market: DiscoveredMarket;
  placementTimeMs: number;
  endTimeMs: number;
  orders: TrackedOrder[];
  ordersPlaced: boolean;
  placementInProgress: boolean;
  placementSuccessNotified: boolean;
  lastFailureReason?: string;
}
