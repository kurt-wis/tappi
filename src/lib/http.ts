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

export function download(file: { filename: string; contentType: string; body: string | Uint8Array }) {
  return new Response(file.body as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

export function fail(
  code: ApiErrorCode,
  message: string,
  status = 400,
  details?: unknown,
  extraHeaders?: Record<string, string>,
) {
  return NextResponse.json({ ok: false, error: { code, message, details } }, {
    status, headers: { ...extraHeaders, "Cache-Control": "private, no-store" },
  });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError("validation_error", "Request body must be valid JSON", 422);
  }
}

export async function readOptionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("validation_error", "Request body must be valid JSON", 422);
  }
}

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
        return fail(err.code, err.message, err.status, err.details, err.headers);
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
    public headers?: Record<string, string>,
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
