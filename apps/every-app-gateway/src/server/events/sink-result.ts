/**
 * What one attempt at one sink reports back to the delivery loop
 * (deliver.ts): delivered with the receiver's status (or, for the email
 * sink, how many recipients were mailed), or failed with the code the
 * delivery row keeps in `last_error` and whether retrying can help.
 */
export type SinkResult =
  | { ok: true; statusCode: number | null }
  | {
      ok: false;
      statusCode: number | null;
      /** `timeout`, `redirect`, `status_500`, `email_budget_exhausted`, … and up to 200 characters of the answer. */
      error: string;
      /** No retry will help (a 410, an unconfigured sender): dead at once. */
      dead: boolean;
    };
