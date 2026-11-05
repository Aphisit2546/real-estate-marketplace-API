import { oauthQuery } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { oauthUrl } from '@/modules/auth/auth.service';

export const GET = route({ query: oauthQuery }, ({ query }) => ok(oauthUrl(query.provider, query.redirectTo)));
