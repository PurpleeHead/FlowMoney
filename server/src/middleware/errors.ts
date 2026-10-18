import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // CORS rejection is an expected client-policy failure, not a server error.
  if (err instanceof Error && err.message === 'Origin not allowed by CORS') {
    res.status(403).json({ message: 'Request origin is not allowed.' });
    return;
  }

  // Body-parser errors carry safe HTTP status codes for malformed or oversized
  // payloads. Keep the response generic; never expose the internal error text.
  const candidate = typeof err === 'object' && err !== null
    ? ('status' in err ? err.status : 'statusCode' in err ? err.statusCode : undefined)
    : undefined;
  const status = typeof candidate === 'number' &&
    Number.isInteger(candidate) &&
    candidate >= 400 &&
    candidate <= 599
    ? candidate
    : 500;

  if (status >= 500) console.error(err);
  res.status(status).json({
    message: status === 413
      ? 'Request body is too large.'
      : status === 400
        ? 'Request body is invalid.'
        : status === 403
          ? 'Request is not allowed.'
          : 'An unexpected server error occurred.',
  });
};
