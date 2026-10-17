import { z } from 'zod';
import { currentUser, errorResponse, sameOrigin } from '@/lib/auth';
import { command } from '@/lib/service';
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const user = await currentUser();
    const { type, data } = z
      .object({ type: z.string(), data: z.unknown() })
      .parse(await req.json());
    return Response.json({ result: await command(user, type, data) });
  } catch (e) {
    return errorResponse(e);
  }
}
