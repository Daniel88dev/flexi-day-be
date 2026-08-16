import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import { config, type PaddleConfig } from "../config.js";
import AppError from "./appError.js";

const client: Paddle | undefined = config.paddle
  ? new Paddle(config.paddle.apiKey, {
      environment:
        config.paddle.environment === "production" ? Environment.production : Environment.sandbox,
    })
  : undefined;

/** 503s when Paddle is not configured, so half-set-up environments fail loudly. */
export const requirePaddle = (): { paddle: Paddle; paddleConfig: PaddleConfig } => {
  if (!client || !config.paddle) {
    throw new AppError({
      message: "Billing is not configured on this environment",
      logging: true,
      code: 503,
    });
  }
  return { paddle: client, paddleConfig: config.paddle };
};
