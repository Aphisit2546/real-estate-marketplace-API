import {
  nextAppointmentStatus, type Appointment, type AppointmentAction, type AppointmentStatus,
} from '@rem/shared';
import { notifyAndPush } from '@/lib/activity';
import { withService, withUser, type Actor, type Tx } from '@/lib/db';
import { conflict, forbidden, notFound, unprocessable } from '@/lib/errors';

type Row = Omit<Appointment, 'scheduledAt' | 'proposedAt' | 'createdAt'> & {
  scheduledAt: Date;
  proposedAt: Date | null;
  createdAt: Date;
};

const toAppointment = (row: Row): Appointment => ({
  ...row,
  scheduledAt: row.scheduledAt.toISOString(),
  proposedAt: row.proposedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

function query(tx: Tx, actor: Actor, id: string | null) {
  const filter = id ? tx`and a.id = ${id}` : tx``;
  return tx<Row[]>`
    select a.id, a.listing_id, l.title as listing_title, a.requester_id, requester.display_name as requester_name,
           a.owner_id, owner.display_name as owner_name, a.scheduled_at, a.proposed_at, a.proposed_by,
           a.status, a.note, a.created_at
    from public.appointments a
    join public.listings l on l.id = a.listing_id
    join public.profiles requester on requester.id = a.requester_id
    join public.profiles owner on owner.id = a.owner_id
    where (a.requester_id = ${actor.id} or a.owner_id = ${actor.id}) ${filter}
    order by a.scheduled_at desc`;
}

// Service role so names of the other party and sold listings stay readable; the WHERE clause scopes it to the caller.
export async function listAppointments(actor: Actor) {
  const rows = await withService(null, (tx) => query(tx, actor, null));
  return rows.map(toAppointment);
}

async function getAppointment(actor: Actor, id: string) {
  const [row] = await withService(null, (tx) => query(tx, actor, id));
  if (!row) throw notFound('ไม่พบนัดหมาย');
  return toAppointment(row);
}

export async function createAppointment(
  actor: Actor,
  input: { listingId: string; scheduledAt: string; note?: string },
) {
  const { id, ownerId } = await withUser(actor, async (tx) => {
    const [listing] = await tx<{ ownerId: string }[]>`
      select owner_id from public.listings where id = ${input.listingId} and status = 'published'`;
    if (!listing) throw notFound('ไม่พบประกาศ');
    if (listing.ownerId === actor.id) throw unprocessable('ไม่สามารถนัดหมายประกาศของตนเองได้', 'SELF_APPOINTMENT');
    const [blocked] = await tx<{ blocked: boolean }[]>`
      select public.is_blocked_between(${actor.id}, ${listing.ownerId}) as blocked`;
    if (blocked?.blocked) throw forbidden('ไม่สามารถนัดหมายกับผู้ใช้นี้ได้', 'USER_BLOCKED');

    const [conversation] = await tx<{ id: string }[]>`
      select id from public.conversations where listing_id = ${input.listingId} and initiator_id = ${actor.id}`;
    const [row] = await tx<{ id: string }[]>`
      insert into public.appointments (listing_id, requester_id, owner_id, conversation_id, scheduled_at, note)
      values (${input.listingId}, ${actor.id}, ${listing.ownerId}, ${conversation?.id ?? null},
              ${input.scheduledAt}::timestamptz, ${input.note ?? null})
      returning id`;
    return { id: row!.id, ownerId: listing.ownerId };
  });

  await notifyAndPush({
    userId: ownerId, type: 'appointment_requested', title: 'มีคำขอนัดหมายใหม่',
    body: 'มีผู้สนใจขอเข้าชมห้องของคุณ', data: { appointmentId: id },
  });
  return getAppointment(actor, id);
}

const NOTIFICATION_TITLES: Record<AppointmentAction, string> = {
  confirm: 'นัดหมายได้รับการยืนยัน',
  reject: 'นัดหมายถูกปฏิเสธ',
  reschedule: 'มีการขอเปลี่ยนเวลานัด',
  accept_reschedule: 'ยืนยันเวลานัดใหม่แล้ว',
  cancel: 'นัดหมายถูกยกเลิก',
  complete: 'นัดหมายเสร็จสิ้น',
};

export async function updateAppointment(
  actor: Actor,
  id: string,
  input: { action: AppointmentAction; scheduledAt?: string },
) {
  const otherId = await withUser(actor, async (tx) => {
    const [row] = await tx<{
      status: AppointmentStatus;
      requesterId: string;
      ownerId: string;
      proposedBy: string | null;
      proposedAt: Date | null;
    }[]>`
      select status, requester_id, owner_id, proposed_by, proposed_at
      from public.appointments where id = ${id} for update`;
    // RLS already hid it from outsiders, so they get the same 404 as a missing id.
    if (!row) throw notFound('ไม่พบนัดหมาย');

    const party = row.ownerId === actor.id ? 'owner' : 'requester';
    const next = nextAppointmentStatus({
      status: row.status,
      action: input.action,
      party,
      proposedByOtherParty: row.proposedBy !== null && row.proposedBy !== actor.id,
    });
    if (!next) throw conflict('ไม่สามารถดำเนินการกับนัดหมายนี้ได้', 'INVALID_APPOINTMENT_ACTION');

    if (input.action === 'reschedule') {
      await tx`
        update public.appointments
        set status = ${next}::public.appointment_status, proposed_at = ${input.scheduledAt!}::timestamptz, proposed_by = ${actor.id}
        where id = ${id}`;
    } else if (input.action === 'accept_reschedule') {
      await tx`
        update public.appointments
        set status = ${next}::public.appointment_status, scheduled_at = ${row.proposedAt}, proposed_at = null, proposed_by = null
        where id = ${id}`;
    } else {
      await tx`update public.appointments set status = ${next}::public.appointment_status where id = ${id}`;
    }
    return party === 'owner' ? row.requesterId : row.ownerId;
  });

  await notifyAndPush({
    userId: otherId, type: `appointment_${input.action}`, title: NOTIFICATION_TITLES[input.action],
    body: 'ดูรายละเอียดได้ในหน้านัดหมาย', data: { appointmentId: id },
  });
  return getAppointment(actor, id);
}
