import { rateLimit } from "express-rate-limit";

export const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 500,
  statusCode: 429,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many requests",
      retryAfter: res.getHeader("Retry-After") ?? undefined,
    });
  },
});
