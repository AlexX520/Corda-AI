'use client';
import { useMemo, useState } from 'react';
import { fromZonedTime } from 'date-fns-tz';
import { Boxes, CalendarClock, CheckCircle2, Lock, Play, SlidersHorizontal, Users } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Button } from './ui/button';
import { Badge, Empty, Field, fmt, names, type Run } from './shared';

const levels = ['Must Attend', 'High Priority', 'Medium Priority', 'Low Priority', 'No Preference', 'Cannot Attend'];

export function ResourceAllocationView({ data, conferenceId, run }: { data: AppState; conferenceId: string; run: Run }) {
  const [tab, setTab] = useState<'preferences' | 'allocation' | 'cubes'>('allocation');
  const conference = data.conferences.find((c) => c.id === conferenceId)!;
  const n = names(data);
  const meetings = data.meetings.filter((m) => m.conferenceId === conferenceId && m.status === 'Confirmed');
  const conferenceDays = useMemo(() => {
    const days: string[] = [], cursor = new Date(`${conference.startDate}T12:00:00Z`), end = new Date(`${conference.endDate}T12:00:00Z`);
    while (cursor <= end) { days.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
    return days;
  }, [conference.startDate, conference.endDate]);
  const bankers = data.users.filter((u) => u.role === 'BANKER');
  const cubes = data.meetingCubes.filter((c) => c.conferenceId === conferenceId);
  const latestRun = data.allocationRuns.find((r) => r.conferenceId === conferenceId);
  const proposals = latestRun ? data.allocationProposals.filter((p) => p.allocationRunId === latestRun.id) : [];
  const unresolved = proposals.filter((p) => p.validationStatus !== 'Valid').length;
  const complete = proposals.length - unresolved;
  const currentPrefs = data.bankerPreferences.filter((p) => p.conferenceId === conferenceId && p.bankerId === data.user.id && !p.meetingId);
  const [prefs, setPrefs] = useState<Record<string, string>>(() => Object.fromEntries(currentPrefs.map((p) => [p.issuerId, p.preferenceLevel])));
  const currentMeetingPrefs = data.bankerPreferences.filter((p) => p.conferenceId === conferenceId && p.bankerId === data.user.id && p.meetingId);
  const [meetingPrefs, setMeetingPrefs] = useState<Record<string, string>>(() => Object.fromEntries(currentMeetingPrefs.map((p) => [p.meetingId!, p.preferenceLevel])));
  const [meetingChoice, setMeetingChoice] = useState(meetings[0]?.id || '');
  const [meetingLevel, setMeetingLevel] = useState('High Priority');
  const [cubeName, setCubeName] = useState('');
  const [cubeCapacity, setCubeCapacity] = useState(6);

  async function savePreferences(submit: boolean) {
    await run('saveCoveragePreferences', {
      conferenceId, submit,
      items: [...Object.entries(prefs).filter(([, level]) => level !== 'No Preference').map(([issuerId, preferenceLevel]) => ({
        issuerId, preferenceLevel, preferenceWeight: levels.indexOf(preferenceLevel) === 0 ? 120 : levels.indexOf(preferenceLevel) === 1 ? 80 : 45,
        isMandatory: preferenceLevel === 'Must Attend',
      })), ...Object.entries(meetingPrefs).map(([meetingId, preferenceLevel]) => ({
        meetingId, issuerId: meetings.find((m) => m.id === meetingId)!.issuerId, preferenceLevel,
        preferenceWeight: preferenceLevel === 'Must Attend' ? 120 : preferenceLevel === 'High Priority' ? 80 : 45,
        isMandatory: preferenceLevel === 'Must Attend',
      }))],
    }, submit ? 'Coverage preferences submitted.' : 'Coverage preferences saved as draft.');
  }
  const availability = data.bankerAvailability.filter((a) => a.conferenceId === conferenceId && a.bankerId === data.user.id);
  async function saveAvailability() {
    const windows = conferenceDays.map((day) => ({
      start: fromZonedTime(`${day}T09:00:00`, conference.timezone).toISOString(), end: fromZonedTime(`${day}T17:00:00`, conference.timezone).toISOString(), status: 'Available',
    }));
    await run('saveBankerAvailability', { conferenceId, windows }, 'Conference availability saved.');
  }
  async function addCube() {
    if (!cubeName.trim()) return;
    await run('saveMeetingCube', {
      conferenceId, name: cubeName, capacity: cubeCapacity, location: conference.location, status: 'Active', restrictions: '',
      windows: conferenceDays.map((day) => ({ start: fromZonedTime(`${day}T09:00:00`, conference.timezone).toISOString(), end: fromZonedTime(`${day}T17:00:00`, conference.timezone).toISOString(), status: 'Available' })),
    }, 'Meeting cube added.');
    setCubeName('');
  }
  return <>
    <div className="page-heading">
      <div><div className="section-eyebrow">PEOPLE + SPACE, PLANNED TOGETHER</div><h1>Coverage & resources</h1><p>Collect banker preferences, allocate coverage and assign meeting cubes in one review flow.</p></div>
      <Button onClick={() => run('optimizeConference', { conferenceId }, 'New allocation proposal generated.')}><Play size={16}/>Run allocation</Button>
    </div>
    <div className="stats-grid resource-stats">
      <ResourceStat label="Confirmed meetings" value={meetings.length} icon={<CalendarClock size={17}/>} />
      <ResourceStat label="Fully allocated" value={complete} icon={<CheckCircle2 size={17}/>} />
      <ResourceStat label="Needs review" value={unresolved} icon={<SlidersHorizontal size={17}/>} />
      <ResourceStat label="Active cubes" value={cubes.filter((c) => c.status === 'Active').length} icon={<Boxes size={17}/>} />
    </div>
    <div className="panel resource-panel">
      <div className="panel-toolbar"><div className="tab-buttons">
        <button className={tab === 'allocation' ? 'active' : ''} onClick={() => setTab('allocation')}>Allocation review <span>{proposals.length}</span></button>
        <button className={tab === 'preferences' ? 'active' : ''} onClick={() => setTab('preferences')}>My preferences</button>
        <button className={tab === 'cubes' ? 'active' : ''} onClick={() => setTab('cubes')}>Meeting cubes <span>{cubes.length}</span></button>
      </div>{latestRun && <Badge>{latestRun.runStatus}</Badge>}</div>
      {tab === 'allocation' && <AllocationReview data={data} conferenceId={conferenceId} proposals={proposals} latestRun={latestRun} run={run}/>} 
      {tab === 'preferences' && <div className="resource-split">
        <section><div className="resource-section-title"><div><h3>Issuer coverage preferences</h3><p>These are weighted preferences. Authorization and schedule conflicts remain hard constraints.</p></div></div>
          <div className="preference-list">{data.issuers.map((issuer) => <div key={issuer.id}><span className="issuer-dot" style={{background: issuer.color}}/><strong>{issuer.name}</strong><select value={prefs[issuer.id] || 'No Preference'} onChange={(e) => setPrefs({...prefs, [issuer.id]: e.target.value})}>{levels.map((level) => <option key={level}>{level}</option>)}</select></div>)}</div>
          <div className="meeting-preference"><h4>Specific meeting preferences</h4><div><select value={meetingChoice} onChange={(e) => setMeetingChoice(e.target.value)}>{meetings.map((m) => <option value={m.id} key={m.id}>{n.issuer(m.issuerId)} × {n.investor(m.investorId)} · {fmt(m.start, conference.timezone, 'EEE h:mm a')}</option>)}</select><select value={meetingLevel} onChange={(e) => setMeetingLevel(e.target.value)}>{levels.filter((x) => x !== 'No Preference').map((level) => <option key={level}>{level}</option>)}</select><Button variant="outline" onClick={() => meetingChoice && setMeetingPrefs({...meetingPrefs, [meetingChoice]: meetingLevel})}>Add</Button></div>{Object.entries(meetingPrefs).map(([id, level]) => { const m = meetings.find((x) => x.id === id); return m ? <button key={id} onClick={() => { const next = {...meetingPrefs}; delete next[id]; setMeetingPrefs(next); }}>{n.issuer(m.issuerId)} · {level} ×</button> : null; })}</div>
          <div className="resource-actions"><Button variant="outline" onClick={() => savePreferences(false)}>Save draft</Button><Button onClick={() => savePreferences(true)}>Submit preferences</Button></div>
        </section>
        <section><div className="resource-section-title"><div><h3>My conference availability</h3><p>Availability is interpreted in {conference.timezone}.</p></div></div>
          {availability.length ? <div className="availability-summary">{availability.map((a) => <div key={a.id}><CalendarClock size={15}/><span>{fmt(a.start, conference.timezone)} – {fmt(a.end, conference.timezone, 'h:mm a')}</span><Badge>{a.status}</Badge></div>)}</div> : <Empty title="No availability submitted" description="Add the standard conference-day window, then adjust exceptions as needed."/>}
          <Button variant="outline" onClick={saveAvailability}>Use 9:00 AM–5:00 PM conference days</Button>
        </section>
      </div>}
      {tab === 'cubes' && <div className="resource-split">
        <section><div className="resource-section-title"><div><h3>Meeting cube inventory</h3><p>Capacity, availability and room buffers are enforced by the allocator.</p></div></div>
          <div className="cube-grid">{cubes.map((cube) => { const used = data.cubeAssignments.filter((a) => a.cubeId === cube.id).length; return <div className="cube-card" key={cube.id}><div><Boxes size={18}/><Badge>{cube.status}</Badge></div><strong>{cube.name}</strong><span>{cube.location}</span><small>Capacity {cube.capacity} · {used} approved meetings</small></div>})}</div>
        </section>
        <section><div className="resource-section-title"><div><h3>Add a cube</h3><p>Create a room without leaving the allocation workflow.</p></div></div>
          <div className="form-grid"><Field label="Cube name"><input value={cubeName} onChange={(e) => setCubeName(e.target.value)} placeholder="Meeting Cube 6"/></Field><Field label="Capacity"><input type="number" min={1} value={cubeCapacity} onChange={(e) => setCubeCapacity(Number(e.target.value))}/></Field><Button onClick={addCube}>Add meeting cube</Button></div>
        </section>
      </div>}
    </div>
  </>;
}

function ResourceStat({label, value, icon}: {label: string; value: number; icon: React.ReactNode}) { return <div className="stat-card resource-stat"><div><span>{label}</span>{icon}</div><strong>{value}</strong></div> }

function AllocationReview({data, conferenceId, proposals, latestRun, run}: {data: AppState; conferenceId: string; proposals: AppState['allocationProposals']; latestRun: AppState['allocationRuns'][number] | undefined; run: Run}) {
  const n = names(data); const c = data.conferences.find((x) => x.id === conferenceId)!;
  const meetings = useMemo(() => new Map(data.meetings.map((m) => [m.id, m])), [data.meetings]);
  if (!latestRun) return <Empty title="No allocation proposal yet" description="Run allocation to match confirmed meetings with authorized bankers and available cubes."/>;
  return <>
    <div className="allocation-banner"><div><strong>Proposal generated {fmt(latestRun.runTimestamp, c.timezone)}</strong><p>Review exceptions and manual edits before approving. Locked assignments are preserved.</p></div>{latestRun.runStatus === 'Proposed' && <Button onClick={() => run('approveAllocationRun', {id: latestRun.id}, 'Valid allocations approved; unresolved meetings remain in the action queue.')}>Approve valid allocations</Button>}</div>
    <div className="table-scroll"><table><thead><tr><th>Meeting</th><th>Time</th><th>Coverage</th><th>Meeting cube</th><th>Validation</th></tr></thead><tbody>{proposals.map((proposal) => { const meeting = meetings.get(proposal.meetingId); if (!meeting) return null; return <ProposalRow key={proposal.id} proposal={proposal} meeting={meeting} data={data} conferenceId={conferenceId} run={run}/>; })}</tbody></table></div>
    <div className="table-footer"><span><Lock size={12}/> Approval writes the reviewed proposal to the master schedule.</span><span>Algorithm: deterministic constraints + weighted preferences</span></div>
  </>;
}

function ProposalRow({proposal, meeting, data, conferenceId, run}: {proposal: AppState['allocationProposals'][number]; meeting: AppState['meetings'][number]; data: AppState; conferenceId: string; run: Run}) {
  const n = names(data), c = data.conferences.find((x) => x.id === conferenceId)!;
  const [editing, setEditing] = useState(false), [bankerIds, setBankerIds] = useState<string[]>(proposal.proposedBankerIds), [cubeId, setCubeId] = useState(proposal.proposedCubeId || '');
  const authorized = data.coverageAuthorizations.filter((a) => a.conferenceId === conferenceId && a.issuerId === meeting.issuerId && a.isActive).map((a) => a.bankerId);
  const bankers = data.users.filter((u) => u.role === 'BANKER' && (authorized.includes(u.id) || data.issuers.find((i) => i.id === meeting.issuerId)?.ownerId === u.id));
  const cube = data.meetingCubes.find((x) => x.id === proposal.proposedCubeId);
  async function save() { if (await run('updateAllocationProposal', {id: proposal.id, bankerIds, cubeId: cubeId || null}, 'Allocation proposal updated.')) setEditing(false); }
  return <tr><td><strong>{n.issuer(meeting.issuerId)}</strong><small>{n.investor(meeting.investorId)}</small></td><td>{fmt(meeting.start, c.timezone)}<small>to {fmt(meeting.end, c.timezone, 'h:mm a')}</small></td><td>{editing ? <select multiple className="allocation-multi" value={bankerIds} onChange={(e) => setBankerIds(Array.from(e.currentTarget.selectedOptions, (o) => o.value))}>{bankers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select> : <><strong>{proposal.proposedBankerIds.slice(0,2).map(n.user).join(' · ') || 'Unassigned'}</strong><small>{proposal.proposedBankerIds.length > 2 ? `+${proposal.proposedBankerIds.length - 2} additional` : proposal.manualOverride ? 'Manual override' : 'Optimized proposal'}</small></>}</td><td>{editing ? <select className="compact-select" value={cubeId} onChange={(e) => setCubeId(e.target.value)}><option value="">Unassigned</option>{data.meetingCubes.filter((x) => x.conferenceId === conferenceId).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.capacity}</option>)}</select> : <>{cube?.name || 'Unassigned'}<small>{cube?.capacity ? `Capacity ${cube.capacity}` : 'Needs resolution'}</small></>}</td><td><Badge>{proposal.validationStatus}</Badge><small className="allocation-explanation">{proposal.explanation}</small>{proposal.validationStatus !== 'Valid' || editing ? <button className="text-button allocation-edit" onClick={editing ? save : () => setEditing(true)}>{editing ? 'Save assignment' : 'Edit manually'}</button> : null}</td></tr>;
}
