import { addDays, emptyData, makeRecord, periodStart, today, type Data, type Status } from '../shared/model';

export const demoAnchor = addDays(periodStart(today(), 'Week'), -14);
export function demoData(): Data {
  const data = emptyData();
  data.Projects = [
    makeRecord({ id: 'yard', code: 'YD-01', title: 'Yard development', owner: 'Alex', version: 1 }),
    makeRecord({ id: 'gate', code: 'GA-02', title: 'Gate access upgrade', owner: 'Nadia', version: 1 }),
    makeRecord({ id: 'training', code: 'TR-03', title: 'Driver training rollout', owner: 'Jasmin', version: 1 }),
  ];
  const tasks: [string, string, string, string, number, number, number | null, number | null, Status, number][] = [
    ['yard', 'Site assessment', 'Kick-off and site briefing', 'Alex', 0, 4, 0, 4, 'Completed', 100],
    ['yard', 'Site assessment', 'Survey vehicle circulation', 'Nadia', 5, 15, 6, null, 'In Progress', 72],
    ['yard', 'Site assessment', 'Count holding and staging bays', 'Alex', 7, 18, 8, null, 'In Progress', 45],
    ['yard', 'Layout and approvals', 'Draft yard layout', 'Jasmin', 14, 28, 15, null, 'In Progress', 25],
    ['yard', 'Layout and approvals', 'Review access and safety', 'Nadia', 28, 42, null, null, 'Not Started', 0],
    ['yard', 'Layout and approvals', 'Approve concept layout', 'Alex', 45, 45, null, null, 'Not Started', 0],
    ['gate', 'Planning', 'Measure gate clearance', 'Nadia', 3, 11, 3, 12, 'Completed', 100],
    ['gate', 'Planning', 'Review carrier turning path', 'Amir', 9, 20, 11, null, 'In Progress', 55],
    ['gate', 'Trial', 'Run controlled access trial', 'Amir', 25, 36, null, null, 'Not Started', 0],
    ['training', 'Preparation', 'Draft training checklist', 'Jasmin', 12, 25, 12, null, 'In Progress', 30],
    ['training', 'Trial', 'Run pilot briefing', 'Jasmin', 34, 42, null, null, 'Not Started', 0],
  ];
  data.Tasks = tasks.map(([projectId, phase, title, owner, start, end, actualStart, actualEnd, status, progress], index) => makeRecord({
    id: `sample-${index + 1}`, version: 1, code: `T-${String(index + 1).padStart(3, '0')}`, projectId, phase, title, owner, status, progress,
    plannedStart: addDays(demoAnchor, start), plannedEnd: addDays(demoAnchor, end),
    actualStart: actualStart === null ? '' : addDays(demoAnchor, actualStart), actualEnd: actualEnd === null ? '' : addDays(demoAnchor, actualEnd),
    dependencies: index === 4 ? ['sample-4'] : index === 5 ? ['sample-5'] : [],
  }));
  data.Deliverables.push(makeRecord({ version: 1, title: 'Concept layout package', owner: 'Alex', projectId: 'yard', plannedEnd: addDays(demoAnchor, 45), fields: { Approver: 'Nadia' } }));
  data['Risks & Issues'].push(makeRecord({ version: 1, title: 'Limited space during site survey', projectId: 'yard', owner: 'Nadia', status: 'In Progress', fields: { Type: 'Risk', Likelihood: 3, Impact: 3, Mitigation: 'Confirm an off-peak slot.' } }));
  data.Resources.push(makeRecord({ version: 1, title: 'Survey crew', projectId: 'yard', fields: { Role: 'Site survey', Allocation: 70 } }));
  data.Costs.push(makeRecord({ version: 1, title: 'Survey support', projectId: 'yard', fields: { Category: 'Services', 'Planned amount': 2500, 'Actual amount': 1800 } }));
  data.Stakeholders.push(makeRecord({ version: 1, title: 'Site operations', projectId: 'yard', fields: { Role: 'Reviewer', Influence: 'High', Communication: 'Weekly' } }));
  data.Members.push(makeRecord({ version: 1, title: 'owner@example.com', fields: { role: 'Owner' } }));
  return data;
}
