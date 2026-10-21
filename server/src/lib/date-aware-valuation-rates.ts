import {
  calculateObservedVndPerRub,
  calculateObservedVndPerUsdt,
  calculateRubPerUsdt,
  type DirectVndObservation,
} from './money.js';
import type { DateAwareValuationAggregate } from './date-aware-valuation-aggregates.js';

export type DateAwareValuationRates = {
  rubPerUsdt: number | null;
  vndPerUsdt: number | null;
  vndPerRub: number | null;
};

/**
 * Resolve historical rates from the date-scoped SQL sums while keeping all
 * validity checks and rate formulas in the established money helpers.
 *
 * SQL has already filtered each component to the same positive/finite-domain
 * candidates used by the mappers. We pass the weighted numerator/denominator
 * as a single observation so the shared helpers remain the sole formula owners.
 */
export function calculateDateAwareValuationRates(
  aggregate: DateAwareValuationAggregate,
): DateAwareValuationRates {
  const rubPerUsdt = calculateRubPerUsdt([{
    rubSpent: Number(aggregate.rubUsdtRub),
    usdtReceived: Number(aggregate.rubUsdtUsdt),
  }]);

  const cardVnd = Number(aggregate.cardVnd);
  const cardUsdt = Number(aggregate.cardUsdt);
  const actualVnd = Number(aggregate.actualVnd);
  const actualUsdt = Number(aggregate.actualUsdt);
  const observedCardRate = calculateObservedVndPerUsdt([{
    amountVnd: cardVnd,
    usdtCharged: cardUsdt,
  }]);
  const observedExchangeRate = calculateObservedVndPerUsdt([{
    amountVnd: actualVnd,
    usdtCharged: actualUsdt,
  }]);
  const vndPerUsdt = observedCardRate ?? observedExchangeRate;

  const direct: DirectVndObservation[] = [{
    rubSpent: Number(aggregate.directRub),
    vndReceived: Number(aggregate.directVnd),
  }];
  const indirect: DirectVndObservation[] = [{
    rubSpent: Number(aggregate.actualRubForVnd),
    vndReceived: Number(aggregate.actualVndForRub),
  }];

  const vndPerRub = calculateObservedVndPerRub({
    directExchanges: direct,
    actualVndExchanges: indirect,
    cardPurchases: [{ amountVnd: cardVnd, usdtCharged: cardUsdt }],
    rubPerUsdt,
  });

  return { rubPerUsdt, vndPerUsdt, vndPerRub };
}
