import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optional access code for a hosted demo. When ACCESS_CODE is set, the browser asks for it
 * once (any user name, the code as password). Without it the app is open, as in local dev.
 */
export function middleware(req: NextRequest) {
  const code = process.env.ACCESS_CODE;
  if (!code) return NextResponse.next();
  const header = req.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6));
      if (decoded.slice(decoded.indexOf(':') + 1) === code) return NextResponse.next();
    } catch {
      // fall through to the prompt
    }
  }
  return new NextResponse('Enter the Corda AI access code as the password.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Corda AI demo", charset="UTF-8"' },
  });
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health).*)'] };
