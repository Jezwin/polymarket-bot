const DEFAULT_BINARY_PRICE_FLOOR = 0.0001;
const CRYPTO_FEE_CURVE_EXPONENT = 2;

const clampProbability = (price: number, tickSize: number): number => {
  const floor = Math.max(DEFAULT_BINARY_PRICE_FLOOR, tickSize);
  const ceil = Math.max(floor, 1 - floor);
  return Math.max(floor, Math.min(ceil, price));
};

const curveTerm = (price: number): number => {
  const boundedPrice = clampProbability(price, DEFAULT_BINARY_PRICE_FLOOR);
  return (boundedPrice * (1 - boundedPrice)) ** CRYPTO_FEE_CURVE_EXPONENT;
};

const feeRate = (feeRateBps: number): number => Math.max(0, feeRateBps) / 10_000;

export const calculateProceedsFeeUsdc = (price: number, size: number, feeRateBps: number): number => {
  if (size <= 0 || price <= 0 || feeRateBps <= 0) {
    return 0;
  }

  return size * price * feeRate(feeRateBps) * curveTerm(price);
};

export const calculateNetBuyShares = (price: number, size: number, feeRateBps: number): number => {
  if (size <= 0 || price <= 0) {
    return 0;
  }

  const feeInShares = calculateProceedsFeeUsdc(price, size, feeRateBps) / price;
  return Math.max(0, size - feeInShares);
};

export const calculateEffectiveBuyUnitCost = (price: number, feeRateBps: number): number => {
  const netShares = calculateNetBuyShares(price, 1, feeRateBps);
  return netShares > 0 ? price / netShares : Number.POSITIVE_INFINITY;
};

export const calculateNetSellUnitProceeds = (price: number, feeRateBps: number): number => {
  return Math.max(0, price - calculateProceedsFeeUsdc(price, 1, feeRateBps));
};

export const findMaxEntryPriceForTargetCost = (
  targetUnitCost: number,
  feeRateBps: number,
  tickSize: number,
): number => {
  const minPrice = Math.max(DEFAULT_BINARY_PRICE_FLOOR, tickSize);
  const maxPrice = Math.max(minPrice, Math.min(1 - minPrice, targetUnitCost));

  let low = minPrice;
  let high = maxPrice;

  for (let iteration = 0; iteration < 40; iteration += 1) {
    const midpoint = (low + high) / 2;
    const effectiveCost = calculateEffectiveBuyUnitCost(midpoint, feeRateBps);

    if (effectiveCost <= targetUnitCost) {
      low = midpoint;
    } else {
      high = midpoint;
    }
  }

  return clampProbability(low, tickSize);
};

export const findRequiredExitPriceForTargetProceeds = (
  targetNetUnitProceeds: number,
  feeRateBps: number,
  tickSize: number,
): number => {
  const minPrice = Math.max(DEFAULT_BINARY_PRICE_FLOOR, tickSize);
  const maxPrice = Math.max(minPrice, 1 - minPrice);

  let low = minPrice;
  let high = maxPrice;

  for (let iteration = 0; iteration < 40; iteration += 1) {
    const midpoint = (low + high) / 2;
    const netProceeds = calculateNetSellUnitProceeds(midpoint, feeRateBps);

    if (netProceeds >= targetNetUnitProceeds) {
      high = midpoint;
    } else {
      low = midpoint;
    }
  }

  return clampProbability(high, tickSize);
};
