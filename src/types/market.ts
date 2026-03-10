export interface GammaSeries {
  recurrence?: string;
  slug?: string;
}

export interface GammaEvent {
  startTime?: string;
  startDate?: string;
  endDate?: string;
  resolutionSource?: string;
  series?: GammaSeries[];
}

export interface GammaMarket {
  id: string;
  conditionId?: string;
  question: string;
  slug?: string;
  description?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  startDate?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  archived?: boolean;
  events?: GammaEvent[];
}

export type CryptoSymbol = "BTC" | "ETH" | "SOL" | "XRP";

export interface DiscoveredMarket {
  marketId: string;
  conditionId: string;
  question: string;
  symbol: CryptoSymbol;
  recurrence: string;
  startTime: string;
  endTime: string;
  yesTokenId: string;
  noTokenId: string;
  yesLabel: string;
  noLabel: string;
}
