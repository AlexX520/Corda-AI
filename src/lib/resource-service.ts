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

async function loadInputs(tx: Tx | typeof db, conferenceId: string) {
  const conference = await tx.conference.findUniqueOrThrow({ where: { id: conferenceId } });
  const meetingsRaw = await tx.meeting.findMany({
    where: { conferenceId, status: 'Confirmed' },
    orderBy: { start: 'asc' },
  });
  const requirements = await tx.meetingCoverageRequirement.findMany({
    where: { meetingId: { in: meetingsRaw.map((m) => m.id) } },
  });
  const meetings: AllocationMeeting[] = meetingsRaw.map((m) => {
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
            explanation: allocation.explanations.join(' ') || 'All hard constraints satisfied.',
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
        requirementErrors.push(`Coverage ${uniqueBankers.length}/${meeting.requiredBankerCount}.`);
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
          requirementErrors.push('Selected cube is missing or too small.');
        if (cube && (!cube.availability.some((w) => w.status === 'Available' && +new Date(w.start) <= +new Date(meeting.start) && +new Date(w.end) >= +new Date(meeting.end)) || cube.availability.some((w) => w.status !== 'Available' && overlaps(w, meeting))))
          requirementErrors.push('Selected cube is unavailable at this time.');
      }
      const updated = await tx.allocationProposal.update({
        where: { id: p.id },
        data: {
          proposedBankerIds: uniqueBankers,
          proposedCubeId: p.cubeId,
          validationStatus: requirementErrors.length ? 'Incomplete' : 'Valid',
          explanation: requirementErrors.join(' ') || 'Manual assignment satisfies meeting-level constraints; run-level validation occurs at approval.',
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
        const meetingInput = inputs.meetings.find((m) => m.id === proposal.meetingId)!;
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
      const validMeetingIds = proposals
        .filter((proposal) => proposal.validationStatus === 'Valid')
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
      if (errors.length) throw new Error(`Allocation changed or conflicts remain: ${errors.slice(0, 4).join(' ')}`);
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
        await tx.meeting.update({
          where: { id: meetingId },
          data: {
            bankerIds: approvedBankers.map((a) => a.bankerId),
            ...(cube ? { location: `${cube.name} · ${cube.location}` } : {}),
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
  const allocationProposals = allocationRuns.length
    ? await db.allocationProposal.findMany({
        where: { allocationRunId: { in: allocationRuns.map((r) => r.id) } },
      })
    : [];
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
