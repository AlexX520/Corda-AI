import { banker, currentUser, errorResponse, sameOrigin } from '@/lib/auth';
import { command } from '@/lib/service';
import { syncOutlook } from '@/lib/outlook-service';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const user = await currentUser();
    banker(user);
    return Response.json(await syncOutlook(user, (input) => command(user, 'ingest', input)));
  } catch (e) {
    return errorResponse(e);
  }
}
