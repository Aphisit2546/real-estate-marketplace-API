import { NextResponse, type NextRequest } from 'next/server';

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

/** The web app reaches the API server-side and mobile is not a browser, so CORS only matters for Expo web. */
export function proxy(req: NextRequest) {
  const origin = req.headers.get('origin');
  const allowed = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const isAllowed = origin !== null && allowed.includes(origin);

  const response = req.method === 'OPTIONS' ? new NextResponse(null, { status: 204 }) : NextResponse.next();
  if (isAllowed) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
    response.headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
    response.headers.set('Vary', 'Origin');
  }
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export const config = { matcher: '/api/:path*' };
