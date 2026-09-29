import { handler, ok, ApiError } from "@/lib/http";
import { env } from "@/lib/env";
import { deliverDueNotifications } from "@/lib/notifications";

export const POST = handler(async (request: Request) => {
  if (!env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    throw ApiError.unauthorized("Invalid cron credential");
  }
  return ok(await deliverDueNotifications());
});

export const GET = POST;
