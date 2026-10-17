import { addMinutes } from 'date-fns';
import { overlaps } from './scheduling';

export type Window = { start: Date | string; end: Date | string; status: string };
export type AllocationMeeting = {
  id: string;
  issuerId: string;
  start: Date | string;
  end: Date | string;
  expectedAttendees: number;
  requiresCube: boolean;
  requiredBankerCount: number;
  requiredPrimaryCount: number;
};
export type AllocationBanker = {
  id: string;
  authorizedIssuerIds: string[];
  primaryIssuerIds: string[];
  availability: Window[];
};
export type Preference = {
  bankerId: string;
  issuerId: string;
  meetingId?: string | null;
  preferenceLevel: string;
  preferenceWeight: number;
  isMandatory: boolean;
};
export type CoverageAssignment = {
  meetingId: string;
  bankerId: string;
  coverageRole: string;
  isLocked: boolean;
};
export type AllocationCube = {
  id: string;
  capacity: number;
  status: string;
  availability: Window[];
};
export type CubeAssignment = { meetingId: string; cubeId: string; isLocked: boolean };

export type AllocationWeights = {
  preference: number;
  workload: number;
  backToBack: number;
};

export type MeetingAllocation = {
  meetingId: string;
  bankerIds: string[];
  coverageRoles: Record<string, string>;
  cubeId: string | null;
  coverageComplete: boolean;
  roomComplete: boolean;
  preferenceScore: number;
  explanations: string[];
};

const LEVEL_SCORE: Record<string, number> = {
  'Must Attend': 120,
  'High Priority': 80,
  'Medium Priority': 45,
  'Low Priority': 15,
  'No Preference': 0,
  'Cannot Attend': Number.NEGATIVE_INFINITY,
};

function contains(window: Window, meeting: AllocationMeeting) {
  return +new Date(window.start) <= +new Date(meeting.start) && +new Date(window.end) >= +new Date(meeting.end);
}

export function isResourceAvailable(meeting: AllocationMeeting, windows: Window[]) {
  const available = windows.filter((w) => w.status === 'Available');
  const blocked = windows.filter((w) => w.status !== 'Available');
  return available.some((w) => contains(w, meeting)) && !blocked.some((w) => overlaps(w, meeting));
}

function meetingOverlap(a: AllocationMeeting, b: AllocationMeeting, bufferMinutes = 0) {
  return overlaps(
    { start: addMinutes(new Date(a.start), -bufferMinutes), end: addMinutes(new Date(a.end), bufferMinutes) },
    b,
  );
}

function effectivePreference(
  preferences: Preference[],
  bankerId: string,
  meeting: AllocationMeeting,
) {
  const matches = preferences.filter(
    (p) =>
      p.bankerId === bankerId &&
      p.issuerId === meeting.issuerId &&
      (!p.meetingId || p.meetingId === meeting.id),
  );
  return matches.find((p) => p.meetingId === meeting.id) || matches.find((p) => !p.meetingId);
}

export function optimizeConference(input: {
  meetings: AllocationMeeting[];
  bankers: AllocationBanker[];
  preferences: Preference[];
  coverageAssignments: CoverageAssignment[];
  cubes: AllocationCube[];
  cubeAssignments: CubeAssignment[];
  roomBufferMinutes: number;
  weights: AllocationWeights;
}) {
  const {
    meetings,
    bankers,
    preferences,
    coverageAssignments,
    cubes,
    cubeAssignments,
    roomBufferMinutes,
    weights,
  } = input;
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const assignedByBanker = new Map<string, AllocationMeeting[]>();
  const assignedByCube = new Map<string, AllocationMeeting[]>();
  const workload = new Map(bankers.map((b) => [b.id, 0]));
  const results = new Map<string, MeetingAllocation>();

  for (const meeting of meetings) {
    results.set(meeting.id, {
      meetingId: meeting.id,
      bankerIds: [],
      coverageRoles: {},
      cubeId: null,
      coverageComplete: false,
      roomComplete: !meeting.requiresCube,
      preferenceScore: 0,
      explanations: [],
    });
  }

  // Locked allocations are immutable inputs. Invalid locks remain visible as conflicts.
  for (const assignment of coverageAssignments.filter((a) => a.isLocked)) {
    const meeting = byId.get(assignment.meetingId);
    const result = meeting && results.get(meeting.id);
    if (!meeting || !result) continue;
    result.bankerIds.push(assignment.bankerId);
    result.coverageRoles[assignment.bankerId] = assignment.coverageRole;
    const conflicts = assignedByBanker.get(assignment.bankerId) || [];
    if (conflicts.some((m) => meetingOverlap(m, meeting)))
      result.explanations.push('Locked banker assignment overlaps another locked meeting.');
    conflicts.push(meeting);
    assignedByBanker.set(assignment.bankerId, conflicts);
    workload.set(assignment.bankerId, (workload.get(assignment.bankerId) || 0) + 1);
  }

  const ordered = [...meetings].sort((a, b) => {
    const mandatoryA = preferences.filter((p) => p.isMandatory && p.meetingId === a.id).length;
    const mandatoryB = preferences.filter((p) => p.isMandatory && p.meetingId === b.id).length;
    return mandatoryB - mandatoryA || +new Date(a.start) - +new Date(b.start);
  });

  for (const meeting of ordered) {
    const result = results.get(meeting.id)!;
    const candidateScore = (banker: AllocationBanker) => {
      const preference = effectivePreference(preferences, banker.id, meeting);
      const levelScore = preference
        ? Math.max(LEVEL_SCORE[preference.preferenceLevel] ?? 0, preference.preferenceWeight)
        : 0;
      const prior = coverageAssignments.some(
        (a) => a.meetingId === meeting.id && a.bankerId === banker.id,
      )
        ? 30
        : 0;
      const assigned = assignedByBanker.get(banker.id) || [];
      const backToBack = assigned.some(
        (m) => +new Date(m.end) === +new Date(meeting.start) || +new Date(meeting.end) === +new Date(m.start),
      );
      return (
        levelScore * weights.preference +
        prior * weights.preference -
        (workload.get(banker.id) || 0) * weights.workload -
        (backToBack ? weights.backToBack : 0)
      );
    };
    const eligible = bankers.filter((banker) => {
      const preference = effectivePreference(preferences, banker.id, meeting);
      if (preference?.preferenceLevel === 'Cannot Attend') return false;
      if (!banker.authorizedIssuerIds.includes(meeting.issuerId)) return false;
      if (!isResourceAvailable(meeting, banker.availability)) return false;
      if ((assignedByBanker.get(banker.id) || []).some((m) => meetingOverlap(m, meeting))) return false;
      return true;
    });
    const mandatory = bankers.filter((banker) => {
      const preference = effectivePreference(preferences, banker.id, meeting);
      return preference?.isMandatory || preference?.preferenceLevel === 'Must Attend';
    });
    for (const banker of mandatory) {
      if (result.bankerIds.includes(banker.id)) continue;
      if (!eligible.some((b) => b.id === banker.id)) {
        result.explanations.push(`Must-attend banker ${banker.id} violates a hard constraint.`);
        continue;
      }
      result.bankerIds.push(banker.id);
    }
    const primaryAlreadySelected = () => result.bankerIds.filter((id) =>
      bankers.find((b) => b.id === id)?.primaryIssuerIds.includes(meeting.issuerId),
    ).length;
    const rankedPrimary = eligible
      .filter((b) => b.primaryIssuerIds.includes(meeting.issuerId) && !result.bankerIds.includes(b.id))
      .sort((a, b) => candidateScore(b) - candidateScore(a) || a.id.localeCompare(b.id));
    for (const primary of rankedPrimary) {
      if (primaryAlreadySelected() >= meeting.requiredPrimaryCount || result.bankerIds.length >= meeting.requiredBankerCount) break;
      result.bankerIds.push(primary.id);
    }
    const ranked = eligible
      .filter((b) => !result.bankerIds.includes(b.id))
      .sort((a, b) => candidateScore(b) - candidateScore(a) || a.id.localeCompare(b.id));
    for (const banker of ranked) {
      if (result.bankerIds.length >= meeting.requiredBankerCount) break;
      result.bankerIds.push(banker.id);
    }
    const primaryCandidates = result.bankerIds.filter((id) =>
      bankers.find((b) => b.id === id)?.primaryIssuerIds.includes(meeting.issuerId),
    );
    for (const bankerId of result.bankerIds) {
      const lockedRole = coverageAssignments.find(
        (a) => a.meetingId === meeting.id && a.bankerId === bankerId && a.isLocked,
      )?.coverageRole;
      result.coverageRoles[bankerId] =
        lockedRole ||
        (primaryCandidates.includes(bankerId) &&
        primaryCandidates.indexOf(bankerId) < meeting.requiredPrimaryCount
          ? 'Primary'
          : 'Support');
      const alreadyAssigned = (assignedByBanker.get(bankerId) || []).some((m) => m.id === meeting.id);
      if (!alreadyAssigned) {
        assignedByBanker.set(bankerId, [...(assignedByBanker.get(bankerId) || []), meeting]);
        workload.set(bankerId, (workload.get(bankerId) || 0) + 1);
      }
      const preference = effectivePreference(preferences, bankerId, meeting);
      result.preferenceScore += Number.isFinite(LEVEL_SCORE[preference?.preferenceLevel || ''])
        ? LEVEL_SCORE[preference?.preferenceLevel || '']
        : 0;
    }
    const primaryCount = result.bankerIds.filter(
      (id) => result.coverageRoles[id] === 'Primary',
    ).length;
    result.coverageComplete =
      result.bankerIds.length >= meeting.requiredBankerCount &&
      primaryCount >= meeting.requiredPrimaryCount &&
      !result.explanations.some((e) => e.includes('Locked banker') || e.includes('Must-attend'));
    if (result.bankerIds.length < meeting.requiredBankerCount)
      result.explanations.push(
        `Coverage incomplete: ${result.bankerIds.length}/${meeting.requiredBankerCount} eligible bankers assigned.`,
      );
    if (primaryCount < meeting.requiredPrimaryCount)
      result.explanations.push(
        `Primary coverage incomplete: ${primaryCount}/${meeting.requiredPrimaryCount}.`,
      );
  }

  for (const locked of cubeAssignments.filter((a) => a.isLocked)) {
    const meeting = byId.get(locked.meetingId);
    const result = meeting && results.get(meeting.id);
    if (!meeting || !result) continue;
    result.cubeId = locked.cubeId;
    const cube = cubes.find((c) => c.id === locked.cubeId);
    const collisions = assignedByCube.get(locked.cubeId) || [];
    if (!cube || cube.status !== 'Active' || cube.capacity < meeting.expectedAttendees)
      result.explanations.push('Locked cube violates capacity or status constraints.');
    if (collisions.some((m) => meetingOverlap(m, meeting, roomBufferMinutes)))
      result.explanations.push('Locked cube overlaps another meeting or its room buffer.');
    collisions.push(meeting);
    assignedByCube.set(locked.cubeId, collisions);
    result.roomComplete = !result.explanations.some((e) => e.includes('Locked cube'));
  }

  for (const meeting of ordered) {
    const result = results.get(meeting.id)!;
    if (!meeting.requiresCube || result.cubeId) continue;
    const currentCube = cubeAssignments.find((a) => a.meetingId === meeting.id)?.cubeId;
    const eligible = cubes
      .filter(
        (cube) =>
          cube.status === 'Active' &&
          cube.capacity >= meeting.expectedAttendees &&
          isResourceAvailable(meeting, cube.availability) &&
          !(assignedByCube.get(cube.id) || []).some((m) =>
            meetingOverlap(m, meeting, roomBufferMinutes),
          ),
      )
      .sort(
        (a, b) =>
          Number(b.id === currentCube) - Number(a.id === currentCube) ||
          a.capacity - b.capacity ||
          a.id.localeCompare(b.id),
      );
    const cube = eligible[0];
    if (!cube) {
      result.explanations.push('Room unavailable: no valid cube satisfies capacity, availability, and buffer rules.');
      continue;
    }
    result.cubeId = cube.id;
    result.roomComplete = true;
    assignedByCube.set(cube.id, [...(assignedByCube.get(cube.id) || []), meeting]);
  }

  const allocations = [...results.values()];
  const complete = allocations.filter((a) => a.coverageComplete && a.roomComplete).length;
  const preferenceScore = allocations.reduce((sum, a) => sum + a.preferenceScore, 0);
  return {
    allocations,
    objectiveScore: preferenceScore + complete * 1000,
    summary: {
      meetings: meetings.length,
      fullyAllocated: complete,
      missingCoverage: allocations.filter((a) => !a.coverageComplete).length,
      missingRooms: allocations.filter((a) => !a.roomComplete).length,
      preferenceScore,
      workload: Object.fromEntries(workload),
    },
  };
}

export function validateApprovedAllocations(input: {
  meetings: AllocationMeeting[];
  bankers: AllocationBanker[];
  cubes: AllocationCube[];
  coverage: CoverageAssignment[];
  rooms: CubeAssignment[];
  bufferMinutes: number;
}) {
  const errors: string[] = [];
  for (const meeting of input.meetings) {
    const coverage = input.coverage.filter((a) => a.meetingId === meeting.id);
    if (coverage.length < meeting.requiredBankerCount)
      errors.push(`${meeting.id}: coverage ${coverage.length}/${meeting.requiredBankerCount}`);
    for (const assignment of coverage) {
      const banker = input.bankers.find((b) => b.id === assignment.bankerId);
      if (!banker || !banker.authorizedIssuerIds.includes(meeting.issuerId))
        errors.push(`${meeting.id}: banker ${assignment.bankerId} unauthorized`);
      if (!banker || !isResourceAvailable(meeting, banker.availability))
        errors.push(`${meeting.id}: banker ${assignment.bankerId} unavailable`);
    }
    const primary = coverage.filter((a) => a.coverageRole === 'Primary').length;
    if (primary < meeting.requiredPrimaryCount)
      errors.push(`${meeting.id}: primary coverage ${primary}/${meeting.requiredPrimaryCount}`);
    const room = input.rooms.find((a) => a.meetingId === meeting.id);
    if (meeting.requiresCube && !room) errors.push(`${meeting.id}: room missing`);
    if (room) {
      const cube = input.cubes.find((c) => c.id === room.cubeId);
      if (!cube || cube.status !== 'Active' || cube.capacity < meeting.expectedAttendees || !isResourceAvailable(meeting, cube.availability))
        errors.push(`${meeting.id}: room ${room.cubeId} violates capacity or availability`);
    }
  }
  for (const banker of input.bankers) {
    const assigned = input.coverage
      .filter((a) => a.bankerId === banker.id)
      .map((a) => input.meetings.find((m) => m.id === a.meetingId)!)
      .filter(Boolean);
    for (let i = 0; i < assigned.length; i++)
      for (let j = i + 1; j < assigned.length; j++)
        if (meetingOverlap(assigned[i], assigned[j]))
          errors.push(`${banker.id}: overlapping meetings ${assigned[i].id} / ${assigned[j].id}`);
  }
  for (const cube of input.cubes) {
    const assigned = input.rooms
      .filter((a) => a.cubeId === cube.id)
      .map((a) => input.meetings.find((m) => m.id === a.meetingId)!)
      .filter(Boolean);
    for (let i = 0; i < assigned.length; i++)
      for (let j = i + 1; j < assigned.length; j++)
        if (meetingOverlap(assigned[i], assigned[j], input.bufferMinutes))
          errors.push(`${cube.id}: overlapping meetings ${assigned[i].id} / ${assigned[j].id}`);
  }
  return errors;
}
