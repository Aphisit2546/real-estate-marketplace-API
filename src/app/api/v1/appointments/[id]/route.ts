import { idParam, updateAppointmentSchema } from '@rem/shared';
import { ok, route } from '@/lib/http';
import { updateAppointment } from '@/modules/appointments/appointments.service';

export const PATCH = route(
  { auth: 'required', params: idParam, body: updateAppointmentSchema },
  async ({ actor, params, body }) => ok(await updateAppointment(actor, params.id, body)),
);
