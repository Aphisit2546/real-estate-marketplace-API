import { createAppointmentSchema } from '@rem/shared';
import { created, ok, route } from '@/lib/http';
import { createAppointment, listAppointments } from '@/modules/appointments/appointments.service';

export const GET = route({ auth: 'required' }, async ({ actor }) => ok(await listAppointments(actor)));
export const POST = route(
  { auth: 'required', body: createAppointmentSchema, rateLimit: { name: 'appointment', max: 20, windowSeconds: 3600 } },
  async ({ actor, body }) => created(await createAppointment(actor, body)),
);
