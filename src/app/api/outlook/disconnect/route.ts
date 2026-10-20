import { banker, currentUser, errorResponse, sameOrigin } from '@/lib/auth';
import { disconnectOutlook } from '@/lib/outlook-service';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const user = await currentUser();
    banker(user);
    await disconnectOutlook(user.id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
