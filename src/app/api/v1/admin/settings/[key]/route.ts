import { adminSettingSchema, settingKeyParam } from '@rem/shared';
import { noContent, route } from '@/lib/http';
import { updateSetting } from '@/modules/admin/admin.service';

export const PATCH = route(
  { auth: 'required', role: 'admin', params: settingKeyParam, body: adminSettingSchema },
  async ({ actor, params, body, ip }) => {
    await updateSetting(actor, params.key, body.value, ip);
    return noContent();
  },
);
