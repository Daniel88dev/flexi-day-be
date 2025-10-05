import type { Request, Response } from "express";
import { vi } from "vitest";

export const makeReqRes = (
  options: {
    query?: any;
    body?: any;
    params?: any;
  } = {}
) => {
  const req = {
    query: options.query || {},
    body: options.body || {},
    params: options.params || {},
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  return { req, res };
};

export const mockAuthData = {
  userId: "user_123",
  sessionId: "session_123",
  userName: "Test User",
  userEmail: "test@example.com",
  emailVerified: true,
};

export const mockDifferentAuthData = {
  userId: "different_user_456",
  sessionId: "session_456",
  userName: "Different User",
  userEmail: "different@example.com",
  emailVerified: true,
};
