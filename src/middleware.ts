import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only check dashboard routes
  if (pathname.startsWith('/dashboard/')) {
    const segments = pathname.split('/');
    const restaurantId = segments[2];

    if (restaurantId) {
      // TODO: Implement actual authentication check
      // This is a placeholder for where you would verify the user's organization
      // matches the restaurantId in the URL.
      
      // Example:
      // const session = await getSession(request);
      // if (!session || session.user.orgId !== restaurantId) {
      //   return NextResponse.redirect(new URL('/login', request.url));
      // }
      
      console.log(`Middleware: Checking access for restaurantId: ${restaurantId}`);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
