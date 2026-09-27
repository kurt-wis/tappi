import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Public API handlers perform any endpoint-specific authentication themselves. */
export function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/signup" ||
    pathname === "/api/auth" || pathname.startsWith("/api/auth/") ||
    pathname === "/api/public" || pathname.startsWith("/api/public/");
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (isPublicPath(pathname)) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) => {
          // Downstream handlers must see the refreshed token on this request too.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          const previousCookies = response.cookies.getAll();
          response = NextResponse.next({ request });
          previousCookies.forEach((cookie) => response.cookies.set(cookie));
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser verifies with Auth and refreshes expired sessions; never trust getSession alone.
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    let denied: NextResponse;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      denied = NextResponse.json(
        { ok: false, error: { code: "unauthorized", message: "Not signed in" } },
        { status: 401 },
      );
    } else {
      const login = new URL("/login", request.url);
      login.searchParams.set("next", pathname + request.nextUrl.search);
      denied = NextResponse.redirect(login);
    }
    response.cookies.getAll().forEach((cookie) => denied.cookies.set(cookie));
    response = denied;
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
