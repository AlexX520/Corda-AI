import { currentUser, errorResponse } from '@/lib/auth';
import { getState } from '@/lib/service';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    return Response.json(await getState(await currentUser()), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
