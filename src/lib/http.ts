import { NextResponse } from "next/server";
import { ZodError } from "zod";

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "conflict"
  | "rate_limited"
  | "internal_error";

export function ok<T>(data: T, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json({ ok: true, data }, { ...init, headers });
}

export function fail(
  code: ApiErrorCode,
  message: string,
  status = 400,
  details?: unknown,
) {
  return NextResponse.json({ ok: false, error: { code, message, details } }, {
    status, headers: { "Cache-Control": "private, no-store" },
  });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError("validation_error", "Request body must be valid JSON", 422);
  }
}

/** Wrap a route handler so thrown errors become clean JSON responses. */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ZodError) {
        return fail("validation_error", "Invalid request body", 422, err.flatten());
      }
      if (err instanceof ApiError) {
        return fail(err.code, err.message, err.status, err.details);
      }
      console.error("[api] unhandled error:", err);
      return fail("internal_error", "Something went wrong", 500);
    }
  };
}

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
  static unauthorized(msg = "Not signed in") {
    return new ApiError("unauthorized", msg, 401);
  }
  static forbidden(msg = "You do not have access to this resource") {
    return new ApiError("forbidden", msg, 403);
  }
  static notFound(msg = "Not found") {
    return new ApiError("not_found", msg, 404);
  }
  static conflict(msg = "Conflict") {
    return new ApiError("conflict", msg, 409);
  }
}
