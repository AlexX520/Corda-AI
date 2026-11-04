import { Prisma, User } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { banker } from './auth';
import {
  AllocationBanker,
  AllocationCube,
  AllocationMeeting,
  CoverageAssignment,
  CubeAssignment,
  optimizeConference,
  validateApprovedAllocations,
} from './allocation';
import { overlaps } from './scheduling';
import { formatInTimeZone } from 'date-fns-tz';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function audit(
  tx: Tx,
  user: User,
  action: string,
  entityType: string,
  entityId: string,
  before?: unknown,
  after?: unknown,
) {
  await tx.auditLog.create({
    data: {
      actorId: user.id,
      action,
      entityType,
      entityId,
      ...(before ? { before: json(before) } : {}),
      ...(after ? { after: json(after) } : {}),
    },
  });
}

/** Replace banker, meeting and cube ids in messages with names people recognise. */
async function humanizer(tx: Tx | typeof db, conferenceId: string) {
  const [users, meetings, cubes, issuers, investors, conference] = await Promise.all([
    tx.user.findMany(),
    tx.meeting.findMany({ where: { conferenceId } }),
    tx.meetingCube.findMany({ where: { conferenceId } }),
    tx.issuer.findMany(),
    tx.investor.findMany(),
    tx.conference.findUniqueOrThrow({ where: { id: conferenceId } }),
  ]);
  const label = new Map<string, string>();
  for (const u of users) label.set(u.id, u.name);
  for (const c of cubes) label.set(c.id, c.name);
  for (const m of meetings)
    label.set(
      m.id,
      `${issuers.find((i) => i.id === m.issuerId)?.name} × ${investors.find((i) => i.id === m.investorId)?.name} at ${formatInTimeZone(m.start, conference.timezone, 'EEE h:mm a')}`,
    );
  const ids = [...label.keys()].sort((a, b) => b.length - a.length);
  const re = ids.length ? new RegExp(`\\b(${ids.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g') : null;
  return (text: string) => (re ? text.replace(re, (m) => label.get(m) || m) : text);
}
const cubeLabel = (cube: { name: string; location: string }) => `${cube.name} · ${cube.location}`;
/** Empty, TBD or cube-derived locations may be replaced by an approved room; anything else was set by a person. */
export function isManualLocation(location: string | null, cubeLabels: string[]) {
  const value = (location || '').trim();
  if (!value || /^(tbd|tba|to be confirmed)$/i.test(value)) return false;
  return !cubeLabels.includes(value);
}
async function loadInputs(tx: Tx | typeof db, conferenceId: string) {
  const conference = await tx.conference.findUniqueOrThrow({ where: { id: conferenceId } });
  const meetingsRaw = await tx.meeting.findMany({
    where: { conferenceId, status: 'Confirmed' },
    orderBy: { start: 'asc' },
  });
  const requirements = await tx.meetingCoverageRequirement.findMany({
    where: { meetingId: { in: meetingsRaw.map((m) => m.id) } },
  });
  const meetings: (AllocationMeeting & { changedAt: Date | null })[] = meetingsRaw.map((m) => {
    const requirement = requirements.find((r) => r.meetingId === m.id);
    return {
      ...m,
      requiredBankerCount: requirement?.requiredBankerCount ?? 2,
      requiredPrimaryCount: requirement?.requiredPrimaryCount ?? 1,
    };
  });
  const bankerRows = await tx.user.findMany({ where: { role: 'BANKER' }, orderBy: { name: 'asc' } });
  const [bankerAvailability, authorizations, issuers, preferences, coverage, cubesRaw, cubeAvailability, rooms] =
    await Promise.all([
      tx.bankerAvailability.findMany({ where: { conferenceId } }),
      tx.issuerCoverageAuthorization.findMany({ where: { conferenceId, isActive: true } }),
      tx.issuer.findMany(),
      tx.bankerPreference.findMany({ where: { conferenceId } }),
      tx.meetingCoverageAssignment.findMany({ where: { meetingId: { in: meetings.map((m) => m.id) } } }),
      tx.meetingCube.findMany({ where: { conferenceId }, orderBy: { name: 'asc' } }),
      tx.cubeAvailability.findMany(),
      tx.meetingCubeAssignment.findMany({ where: { meetingId: { in: meetings.map((m) => m.id) } } }),
    ]);
  const bankers: AllocationBanker[] = bankerRows.map((b) => {
    const coverageAuth = authorizations.filter((a) => a.bankerId === b.id);
    const owned = issuers.filter((i) => i.ownerId === b.id).map((i) => i.id);
    return {
      id: b.id,
      authorizedIssuerIds: [...new Set([...owned, ...coverageAuth.map((a) => a.issuerId)])],
      primaryIssuerIds: [
        ...new Set([
          ...owned,
          ...coverageAuth.filter((a) => a.qualification === 'Primary').map((a) => a.issuerId),
        ]),
      ],
      availability: bankerAvailability.filter((a) => a.bankerId === b.id),
    };
  });
  const cubes: AllocationCube[] = cubesRaw.map((cube) => ({
    ...cube,
    availability: cubeAvailability.filter((a) => a.cubeId === cube.id),
  }));
  return {
    conference,
    meetings,
    bankers,
    preferences,
    coverage: coverage as CoverageAssignment[],
    cubes,
    rooms: rooms as CubeAssignment[],
  };
}

const intervalSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  status: z.enum(['Available', 'Unavailable', 'Blocked']).default('Available'),
});

export async function handleResourceCommand(user: User, type: string, input: unknown) {
  if (type === 'saveCoveragePreferences') {
    banker(user);
    const p = z
      .object({
        conferenceId: z.string(),
        submit: z.boolean().default(false),
        items: z.array(
          z.object({
            issuerId: z.string(),
            meetingId: z.string().nullable().optional(),
            preferenceLevel: z.enum([
              'Must Attend',
              'High Priority',
              'Medium Priority',
              'Low Priority',
              'No Preference',
              'Cannot Attend',
            ]),
            preferenceWeight: z.number().int().min(0).max(150).default(0),
            isMandatory: z.boolean().default(false),
          }),
        ),
      })
      .parse(input);
    const conference = await db.conference.findUniqueOrThrow({ where: { id: p.conferenceId } });
    if (p.submit && conference.preferenceDeadline && conference.preferenceDeadline < new Date())
      throw new Error('The preference submission deadline has passed. Contact the conference lead.');
    return db.$transaction(async (tx) => {
      const before = await tx.bankerPreference.findMany({
        where: { conferenceId: p.conferenceId, bankerId: user.id },
      });
      await tx.bankerPreference.deleteMany({
        where: { conferenceId: p.conferenceId, bankerId: user.id },
      });
      if (p.items.length)
        await tx.bankerPreference.createMany({
          data: p.items.map((item) => ({
            ...item,
            meetingId: item.meetingId || null,
            conferenceId: p.conferenceId,
            bankerId: user.id,
            isMandatory: item.preferenceLevel === 'Must Attend' || item.isMandatory,
            submissionStatus: p.submit ? 'Submitted' : 'Draft',
          })),
        });
      await audit(tx, user, p.submit ? 'Coverage preferences submitted' : 'Coverage preferences saved', 'Conference', p.conferenceId, before, p.items);
      return { ok: true };
    });
  }

  if (type === 'saveBankerAvailability') {
    banker(user);
    const p = z.object({ conferenceId: z.string(), windows: z.array(intervalSchema) }).parse(input);
    return db.$transaction(async (tx) => {
      const before = await tx.bankerAvailability.findMany({
        where: { conferenceId: p.conferenceId, bankerId: user.id },
      });
      await tx.bankerAvailability.deleteMany({
        where: { conferenceId: p.conferenceId, bankerId: user.id },
      });
      if (p.windows.length)
        await tx.bankerAvailability.createMany({
          data: p.windows.map((w) => ({
            conferenceId: p.conferenceId,
            bankerId: user.id,
            start: new Date(w.start),
            end: new Date(w.end),
            status: w.status,
          })),
        });
      await audit(tx, user, 'Conference availability updated', 'Conference', p.conferenceId, before, p.windows);
      return { ok: true };
    });
  }

  if (type === 'saveMeetingCube') {
    banker(user);
    const p = z
      .object({
        id: z.string().optional(),
        conferenceId: z.string(),
        name: z.string().min(1).max(80),
        capacity: z.number().int().min(1).max(1000),
        location: z.string().max(200),
        status: z.enum(['Active', 'Inactive', 'Maintenance']).default('Active'),
        restrictions: z.string().max(1000).default(''),
        windows: z.array(intervalSchema),
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      const before = p.id ? await tx.meetingCube.findUnique({ where: { id: p.id } }) : null;
      const cube = p.id
        ? await tx.meetingCube.update({
            where: { id: p.id },
            data: {
              name: p.name,
              capacity: p.capacity,
              location: p.location,
              status: p.status,
              restrictions: p.restrictions,
            },
          })
        : await tx.meetingCube.create({
            data: {
              conferenceId: p.conferenceId,
              name: p.name,
              capacity: p.capacity,
              location: p.location,
              status: p.status,
              restrictions: p.restrictions,
            },
          });
      await tx.cubeAvailability.deleteMany({ where: { cubeId: cube.id } });
      if (p.windows.length)
        await tx.cubeAvailability.createMany({
          data: p.windows.map((w) => ({
            cubeId: cube.id,
            start: new Date(w.start),
            end: new Date(w.end),
            status: w.status,
          })),
        });
      await audit(tx, user, before ? 'Meeting cube updated' : 'Meeting cube created', 'MeetingCube', cube.id, before, cube);
      return cube;
    });
  }

  if (type === 'saveCoverageRequirement') {
    banker(user);
    const p = z
      .object({
        meetingId: z.string(),
        requiredBankerCount: z.number().int().min(1).max(12),
        requiredPrimaryCount: z.number().int().min(0).max(12),
        expectedAttendees: z.number().int().min(1).max(1000),
        requiresCube: z.boolean(),
      })
      .refine((v) => v.requiredPrimaryCount <= v.requiredBankerCount, {
        message: 'Primary coverage cannot exceed total required bankers.',
      })
      .parse(input);
    return db.$transaction(async (tx) => {
      const meeting = await tx.meeting.update({
        where: { id: p.meetingId },
        data: { expectedAttendees: p.expectedAttendees, requiresCube: p.requiresCube },
      });
      const requirement = await tx.meetingCoverageRequirement.upsert({
        where: { meetingId: p.meetingId },
        create: {
          meetingId: p.meetingId,
          requiredBankerCount: p.requiredBankerCount,
          requiredPrimaryCount: p.requiredPrimaryCount,
        },
        update: {
          requiredBankerCount: p.requiredBankerCount,
          requiredPrimaryCount: p.requiredPrimaryCount,
        },
      });
      await audit(tx, user, 'Meeting resource requirements updated', 'Meeting', meeting.id, undefined, { meeting, requirement });
      return requirement;
    });
  }

  if (type === 'optimizeConference') {
    banker(user);
    const p = z.object({ conferenceId: z.string() }).parse(input);
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(817205)`;
      const inputs = await loadInputs(tx, p.conferenceId);
      const human = await humanizer(tx, p.conferenceId);
      const optimized = optimizeConference({
        meetings: inputs.meetings,
        bankers: inputs.bankers,
        preferences: inputs.preferences,
        coverageAssignments: inputs.coverage,
        cubes: inputs.cubes,
        cubeAssignments: inputs.rooms,
        roomBufferMinutes: inputs.conference.roomBufferMinutes,
        weights: {
          preference: inputs.conference.preferenceWeight,
          workload: inputs.conference.workloadWeight,
          backToBack: inputs.conference.backToBackWeight,
        },
      });
      await tx.allocationRun.updateMany({
        where: { conferenceId: p.conferenceId, runStatus: 'Proposed' },
        data: { runStatus: 'Superseded' },
      });
      const run = await tx.allocationRun.create({
        data: {
          conferenceId: p.conferenceId,
          algorithmVersion: 'conferenceos-deterministic-v1',
          objectiveScore: optimized.objectiveScore,
          createdBy: user.id,
          summary: json(optimized.summary),
        },
      });
      if (optimized.allocations.length)
        await tx.allocationProposal.createMany({
          data: optimized.allocations.map((allocation) => ({
            allocationRunId: run.id,
            meetingId: allocation.meetingId,
            proposedBankerIds: allocation.bankerIds,
            proposedCubeId: allocation.cubeId,
            validationStatus:
              allocation.coverageComplete && allocation.roomComplete ? 'Valid' : 'Incomplete',
            preferenceScore: allocation.preferenceScore,
            explanation: human(allocation.explanations.join(' ')) || 'All hard constraints satisfied.',
          })),
        });
      const incomplete = optimized.allocations.filter(
        (a) => !a.coverageComplete || !a.roomComplete,
      );
      await tx.action.updateMany({
        where: { conferenceId: p.conferenceId, type: 'Resource allocation', status: 'Open' },
        data: { status: 'Resolved' },
      });
      if (incomplete.length)
        await tx.action.create({
          data: {
            conferenceId: p.conferenceId,
            type: 'Resource allocation',
            title: `${incomplete.length} meetings need resource resolution`,
            assignedTo: user.id,
            priority: 'Urgent',
            recommendation: 'Review incomplete banker coverage and meeting cube proposals before approval.',
          },
        });
      await audit(tx, user, 'Conference allocation generated', 'AllocationRun', run.id, undefined, optimized.summary);
      return { runId: run.id, ...optimized.summary };
    });
  }

  if (type === 'updateAllocationProposal') {
    banker(user);
    const p = z
      .object({ id: z.string(), bankerIds: z.array(z.string()), cubeId: z.string().nullable() })
      .parse(input);
    return db.$transaction(async (tx) => {
      const before = await tx.allocationProposal.findUniqueOrThrow({ where: { id: p.id } });
      const run = await tx.allocationRun.findUniqueOrThrow({ where: { id: before.allocationRunId } });
      if (run.runStatus !== 'Proposed') throw new Error('Approved allocation runs are immutable. Generate a new proposal.');
      const inputs = await loadInputs(tx, run.conferenceId);
      const meeting = inputs.meetings.find((m) => m.id === before.meetingId);
      if (!meeting) throw new Error('Meeting is no longer confirmed. Generate a new allocation proposal.');
      const requirementErrors: string[] = [];
      const uniqueBankers = [...new Set(p.bankerIds)];
      if (uniqueBankers.length < meeting.requiredBankerCount)
        requirementErrors.push(`Needs ${meeting.requiredBankerCount} bankers, has ${uniqueBankers.length}.`);
      for (const bankerId of uniqueBankers) {
        const b = inputs.bankers.find((banker) => banker.id === bankerId);
        if (!b?.authorizedIssuerIds.includes(meeting.issuerId))
          requirementErrors.push(`${bankerId} is not authorized for this issuer.`);
        if (!b || !b.availability.some((w) => w.status === 'Available' && +new Date(w.start) <= +new Date(meeting.start) && +new Date(w.end) >= +new Date(meeting.end)) || b.availability.some((w) => w.status !== 'Available' && overlaps(w, meeting)))
          requirementErrors.push(`${bankerId} is unavailable at this time.`);
        const preference = inputs.preferences.find((x) => x.bankerId === bankerId && x.issuerId === meeting.issuerId && (!x.meetingId || x.meetingId === meeting.id));
        if (preference?.preferenceLevel === 'Cannot Attend') requirementErrors.push(`${bankerId} marked Cannot Attend.`);
      }
      if (meeting.requiresCube) {
        const cube = inputs.cubes.find((c) => c.id === p.cubeId);
        if (!cube || cube.status !== 'Active' || cube.capacity < meeting.expectedAttendees)
          requirementErrors.push(!cube ? 'No room selected.' : cube.status !== 'Active' ? 'Selected room is not active.' : '');
        if (cube && (!cube.availability.some((w) => w.status === 'Available' && +new Date(w.start) <= +new Date(meeting.start) && +new Date(w.end) >= +new Date(meeting.end)) || cube.availability.some((w) => w.status !== 'Available' && overlaps(w, meeting))))
          requirementErrors.push('Selected cube is unavailable at this time.');
      }
      // Hard constraints across the run: a banker or room cannot be in two overlapping meetings.
      const others = await tx.allocationProposal.findMany({ where: { allocationRunId: run.id, id: { not: p.id } } });
      const meetingOf = (id: string) => inputs.meetings.find((m) => m.id === id);
      const buffer = inputs.conference.roomBufferMinutes * 60000;
      for (const bankerId of uniqueBankers) {
        const clash =
          others.find((o) => o.proposedBankerIds.includes(bankerId) && meetingOf(o.meetingId) && overlaps(meetingOf(o.meetingId)!, meeting))?.meetingId ||
          inputs.coverage.find((a) => a.isLocked && a.bankerId === bankerId && a.meetingId !== meeting.id && meetingOf(a.meetingId) && overlaps(meetingOf(a.meetingId)!, meeting))?.meetingId;
        if (clash) requirementErrors.push(`${bankerId} is already in ${clash}.`);
      }
      if (p.cubeId) {
        const padded = { start: new Date(+new Date(meeting.start) - buffer), end: new Date(+new Date(meeting.end) + buffer) };
        const clash =
          others.find((o) => o.proposedCubeId === p.cubeId && meetingOf(o.meetingId) && overlaps(meetingOf(o.meetingId)!, padded))?.meetingId ||
          inputs.rooms.find((a) => a.isLocked && a.cubeId === p.cubeId && a.meetingId !== meeting.id && meetingOf(a.meetingId) && overlaps(meetingOf(a.meetingId)!, padded))?.meetingId;
        if (clash) requirementErrors.push(`${p.cubeId} is already booked for ${clash}.`);
        const cube = inputs.cubes.find((c) => c.id === p.cubeId);
        if (cube && cube.capacity < meeting.expectedAttendees)
          requirementErrors.push(`${cube.id} holds ${cube.capacity}; the meeting expects ${meeting.expectedAttendees}.`);
      }
      const problems = requirementErrors.filter(Boolean);
      const updated = await tx.allocationProposal.update({
        where: { id: p.id },
        data: {
          proposedBankerIds: uniqueBankers,
          proposedCubeId: p.cubeId,
          validationStatus: problems.length ? 'Incomplete' : 'Valid',
          explanation: (await humanizer(tx, run.conferenceId))(problems.join(' ')) || 'Manual assignment satisfies meeting-level constraints; run-level validation occurs at approval.',
          manualOverride: true,
        },
      });
      await audit(tx, user, 'Allocation proposal edited', 'AllocationProposal', p.id, before, updated);
      return updated;
    });
  }

  if (type === 'approveAllocationRun') {
    banker(user);
    const p = z.object({ id: z.string() }).parse(input);
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(817205)`;
      const run = await tx.allocationRun.findUniqueOrThrow({ where: { id: p.id } });
      if (run.runStatus !== 'Proposed') throw new Error('This allocation run has already been reviewed.');
      const proposals = await tx.allocationProposal.findMany({ where: { allocationRunId: run.id } });
      const inputs = await loadInputs(tx, run.conferenceId);
      const proposedCoverage: CoverageAssignment[] = [];
      const proposedRooms: CubeAssignment[] = [];
      for (const proposal of proposals.filter((proposal) => proposal.validationStatus === 'Valid')) {
        const meetingInput = inputs.meetings.find((m) => m.id === proposal.meetingId);
        if (!meetingInput || (meetingInput.changedAt && meetingInput.changedAt > run.runTimestamp)) continue;
        let primaryAssigned = 0;
        for (const bankerId of proposal.proposedBankerIds) {
          const bankerInput = inputs.bankers.find((b) => b.id === bankerId);
          const isPrimary = Boolean(
            bankerInput?.primaryIssuerIds.includes(meetingInput.issuerId) &&
            primaryAssigned < meetingInput.requiredPrimaryCount,
          );
          if (isPrimary) primaryAssigned++;
          proposedCoverage.push({
            meetingId: proposal.meetingId,
            bankerId,
            coverageRole: isPrimary ? 'Primary' : 'Support',
            isLocked: false,
          });
        }
        if (proposal.proposedCubeId)
          proposedRooms.push({
            meetingId: proposal.meetingId,
            cubeId: proposal.proposedCubeId,
            isLocked: false,
          });
      }
      const stale = new Set(
        inputs.meetings.filter((m) => m.changedAt && m.changedAt > run.runTimestamp).map((m) => m.id),
      );
      const validMeetingIds = proposals
        .filter((proposal) => proposal.validationStatus === 'Valid' && !stale.has(proposal.meetingId))
        .map((proposal) => proposal.meetingId);
      const lockedCoverage = inputs.coverage.filter((a) => a.isLocked);
      const lockedRooms = inputs.rooms.filter((a) => a.isLocked);
      const errors = validateApprovedAllocations({
        meetings: inputs.meetings.filter((m) => validMeetingIds.includes(m.id)),
        bankers: inputs.bankers,
        cubes: inputs.cubes,
        coverage: [
          ...lockedCoverage.filter((a) => validMeetingIds.includes(a.meetingId)),
          ...proposedCoverage.filter(
            (a) => !lockedCoverage.some((locked) => locked.meetingId === a.meetingId && locked.bankerId === a.bankerId),
          ),
        ],
        rooms: [
          ...lockedRooms.filter((a) => validMeetingIds.includes(a.meetingId)),
          ...proposedRooms.filter(
            (a) => !lockedRooms.some((locked) => locked.meetingId === a.meetingId),
          ),
        ],
        bufferMinutes: inputs.conference.roomBufferMinutes,
      });
      if (errors.length) {
        const human = await humanizer(tx, run.conferenceId);
        throw new Error(`Allocation changed or conflicts remain: ${errors.slice(0, 4).map(human).join(' ')}`);
      }
      const cubeLabels = (await tx.meetingCube.findMany({ where: { conferenceId: run.conferenceId } })).flatMap((c) => [cubeLabel(c), c.location]);
      for (const meetingId of validMeetingIds) {
        await tx.meetingCoverageAssignment.deleteMany({ where: { meetingId, isLocked: false } });
        await tx.meetingCubeAssignment.deleteMany({ where: { meetingId, isLocked: false } });
        const bankers = proposedCoverage.filter((a) => a.meetingId === meetingId);
        for (const assignment of bankers) {
          if (lockedCoverage.some((locked) => locked.meetingId === meetingId && locked.bankerId === assignment.bankerId)) continue;
          await tx.meetingCoverageAssignment.upsert({
            where: { meetingId_bankerId: { meetingId, bankerId: assignment.bankerId } },
            create: { ...assignment, assignmentStatus: 'Approved', assignedBy: user.id },
            update: {
              coverageRole: assignment.coverageRole,
              assignmentStatus: 'Approved',
              assignedBy: user.id,
            },
          });
        }
        const room = proposedRooms.find((a) => a.meetingId === meetingId);
        if (room && !lockedRooms.some((locked) => locked.meetingId === meetingId))
          await tx.meetingCubeAssignment.upsert({
            where: { meetingId },
            create: { ...room, assignmentStatus: 'Approved', assignedBy: user.id },
            update: { cubeId: room.cubeId, assignmentStatus: 'Approved', assignedBy: user.id },
          });
        const approvedBankers = await tx.meetingCoverageAssignment.findMany({ where: { meetingId } });
        const approvedRoom = await tx.meetingCubeAssignment.findUnique({ where: { meetingId } });
        const cube = approvedRoom
          ? await tx.meetingCube.findUnique({ where: { id: approvedRoom.cubeId } })
          : null;
        const current = await tx.meeting.findUniqueOrThrow({ where: { id: meetingId } });
        // A location typed by a person (not one derived from a cube) is never overwritten.
        const keepLocation = isManualLocation(current.location, cubeLabels);
        await tx.meeting.update({
          where: { id: meetingId },
          data: {
            bankerIds: approvedBankers.map((a) => a.bankerId),
            ...(cube && !keepLocation ? { location: cubeLabel(cube) } : {}),
          },
        });
      }
      const approved = validMeetingIds.length;
      await tx.allocationRun.update({
        where: { id: run.id },
        data: { runStatus: 'Approved', approvedBy: user.id, approvedAt: new Date() },
      });
      await audit(tx, user, 'Conference allocation approved', 'AllocationRun', run.id, run, {
        approved,
        unresolved: proposals.length - approved,
      });
      return { approved, unresolved: proposals.length - approved };
    });
  }

  if (type === 'allocationDiff') {
    // Dry run of "Approve valid": what would change, per meeting, without writing anything.
    banker(user);
    const p = z.object({ id: z.string() }).parse(input);
    const run = await db.allocationRun.findUniqueOrThrow({ where: { id: p.id } });
    const [proposals, inputs, users, cubes, meetings, label] = await Promise.all([
      db.allocationProposal.findMany({ where: { allocationRunId: run.id } }),
      loadInputs(db, run.conferenceId),
      db.user.findMany(),
      db.meetingCube.findMany({ where: { conferenceId: run.conferenceId } }),
      db.meeting.findMany({ where: { conferenceId: run.conferenceId } }),
      humanizer(db, run.conferenceId),
    ]);
    const name = (id: string) => users.find((u) => u.id === id)?.name || id;
    const cubeName = (id?: string | null) => (id ? cubes.find((c) => c.id === id)?.name || id : 'none');
    const cubeLabels = cubes.flatMap((c) => [cubeLabel(c), c.location]);
    const changes = [];
    const isStale = (meetingId: string) => {
      const m = meetings.find((x) => x.id === meetingId);
      return Boolean(m?.changedAt && m.changedAt > run.runTimestamp) || m?.status !== 'Confirmed';
    };
    for (const proposal of proposals.filter((x) => x.validationStatus === 'Valid' && !isStale(x.meetingId))) {
      const meeting = meetings.find((m) => m.id === proposal.meetingId);
      if (!meeting) continue;
      const current = inputs.coverage.filter((a) => a.meetingId === meeting.id);
      const locked = current.filter((a) => a.isLocked).map((a) => a.bankerId);
      const before = current.map((a) => a.bankerId);
      const after = [...new Set([...locked, ...proposal.proposedBankerIds])];
      const room = inputs.rooms.find((r) => r.meetingId === meeting.id);
      const roomLocked = Boolean(room?.isLocked);
      const roomAfter = roomLocked ? room!.cubeId : proposal.proposedCubeId || room?.cubeId || null;
      const add = after.filter((id) => !before.includes(id)).map(name);
      const remove = before.filter((id) => !after.includes(id)).map(name);
      const roomChange = (room?.cubeId || null) !== roomAfter ? { from: cubeName(room?.cubeId), to: cubeName(roomAfter) } : null;
      const keepsLocation = Boolean(roomChange) && isManualLocation(meeting.location, cubeLabels);
      if (!add.length && !remove.length && !roomChange) continue;
      changes.push({
        meetingId: meeting.id,
        meeting: label(meeting.id),
        add,
        remove,
        room: roomChange,
        locked: [...locked.map(name), ...(roomLocked ? [cubeName(room!.cubeId)] : [])],
        keepsLocation: keepsLocation ? meeting.location : null,
      });
    }
    return {
      changes,
      valid: proposals.filter((x) => x.validationStatus === 'Valid').length,
      skipped: proposals
        .filter((x) => x.validationStatus !== 'Valid' || isStale(x.meetingId))
        .map((x) => ({
          meeting: label(x.meetingId),
          reason: isStale(x.meetingId) ? 'The meeting changed after this proposal. Run allocation again.' : label(x.explanation),
        })),
    };
  }

  if (type === 'toggleCoverageLock') {
    banker(user);
    const p = z.object({ id: z.string(), isLocked: z.boolean() }).parse(input);
    const updated = await db.meetingCoverageAssignment.update({ where: { id: p.id }, data: { isLocked: p.isLocked } });
    await db.auditLog.create({ data: { actorId: user.id, action: p.isLocked ? 'Coverage assignment locked' : 'Coverage assignment unlocked', entityType: 'MeetingCoverageAssignment', entityId: p.id, after: json(updated) } });
    return updated;
  }

  if (type === 'toggleRoomLock') {
    banker(user);
    const p = z.object({ id: z.string(), isLocked: z.boolean() }).parse(input);
    const updated = await db.meetingCubeAssignment.update({ where: { id: p.id }, data: { isLocked: p.isLocked } });
    await db.auditLog.create({ data: { actorId: user.id, action: p.isLocked ? 'Cube assignment locked' : 'Cube assignment unlocked', entityType: 'MeetingCubeAssignment', entityId: p.id, after: json(updated) } });
    return updated;
  }

  return undefined;
}

export async function getResourceState(user: User) {
  if (user.role !== 'BANKER')
    return {
      bankerPreferences: [],
      bankerAvailability: [],
      coverageAuthorizations: [],
      coverageRequirements: [],
      coverageAssignments: [],
      meetingCubes: [],
      cubeAvailability: [],
      cubeAssignments: [],
      allocationRuns: [],
      allocationProposals: [],
    };
  const [
    bankerPreferences,
    bankerAvailability,
    coverageAuthorizations,
    coverageRequirements,
    coverageAssignments,
    meetingCubes,
    cubeAvailability,
    cubeAssignments,
    allocationRuns,
  ] = await Promise.all([
    db.bankerPreference.findMany(),
    db.bankerAvailability.findMany(),
    db.issuerCoverageAuthorization.findMany(),
    db.meetingCoverageRequirement.findMany(),
    db.meetingCoverageAssignment.findMany(),
    db.meetingCube.findMany({ orderBy: { name: 'asc' } }),
    db.cubeAvailability.findMany(),
    db.meetingCubeAssignment.findMany(),
    db.allocationRun.findMany({ orderBy: { runTimestamp: 'desc' }, take: 20 }),
  ]);
  const proposalRows = allocationRuns.length
    ? await db.allocationProposal.findMany({
        where: { allocationRunId: { in: allocationRuns.map((r) => r.id) } },
      })
    : [];
  // A proposal is stale when its meeting changed after the run that produced it.
  const changed = await db.meeting.findMany({
    where: { id: { in: proposalRows.map((p) => p.meetingId) }, changedAt: { not: null } },
    select: { id: true, changedAt: true, status: true },
  });
  const allocationProposals = proposalRows.map((p) => {
    const run = allocationRuns.find((r) => r.id === p.allocationRunId);
    const m = changed.find((x) => x.id === p.meetingId);
    return { ...p, stale: Boolean(run && m?.changedAt && m.changedAt > run.runTimestamp) };
  });
  return {
    bankerPreferences,
    bankerAvailability,
    coverageAuthorizations,
    coverageRequirements,
    coverageAssignments,
    meetingCubes,
    cubeAvailability,
    cubeAssignments,
    allocationRuns,
    allocationProposals,
  };
}
