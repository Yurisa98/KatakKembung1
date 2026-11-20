import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { addDays, addYears, applyChanges, Conflict, defaultProgress, emptyData, makeRecord, nextPeriod, periodStart, periods, ScheduleIndex, shift, summaries, taskWarnings, type Change } from '../shared/model';

const project = makeRecord({ id: 'p', title: 'Project' });
const task = makeRecord({ id: 't', projectId: 'p', title: 'Task', plannedStart: '2026-12-29', plannedEnd: '2027-01-02', actualStart: '2026-12-31', status: 'In Progress', progress: 40 });
const setup: Change[] = [{ table: 'Projects', record: project, expectedVersion: 0 }, { table: 'Tasks', record: task, expectedVersion: 0 }];

test('each scale starts at the correct calendar boundary', () => {
  assert.equal(periodStart('2027-01-01', 'Week'), '2026-12-28');
  assert.equal(periodStart('2027-05-15', 'Month'), '2027-05-01');
  assert.equal(periodStart('2027-05-15', 'Quarter'), '2027-04-01');
  assert.equal(periodStart('2027-05-15', 'Year'), '2027-01-01');
  assert.equal(nextPeriod('2026-10-01', 'Quarter'), '2027-01-01');
  assert.equal(addYears('2028-02-29', 10), '2038-02-28');
  assert.equal(periods('2026-01-01', '2036-01-01', 'Year').length, 10);
});

test('move preserves duration and actuals across boundaries and resize cannot invert dates', () => {
  const moved = shift(task, 7, 'move');
  assert.equal(moved.plannedStart, '2027-01-05');
  assert.equal(moved.plannedEnd, '2027-01-09');
  assert.equal(moved.actualStart, '2026-12-31');
  assert.equal(shift(task, 15, 'start').plannedStart, task.plannedEnd);
  assert.equal(shift(task, -15, 'end').plannedEnd, task.plannedStart);
});

test('project/task changes are atomic and stale saves expose the current version', () => {
  const first = applyChanges(emptyData(), setup).data;
  const stored = first.Tasks[0];
  const second = applyChanges(first, [{ table: 'Tasks', record: shift(stored, 2, 'move'), expectedVersion: 1 }]).data;
  assert.equal(second.Tasks[0].version, 2);
  assert.throws(() => applyChanges(second, [{ table: 'Tasks', record: stored, expectedVersion: 1 }]), error => error instanceof Conflict && error.current?.version === 2);
  assert.throws(() => applyChanges(first, [{ table: 'Tasks', record: { ...stored, plannedEnd: '2036-12-29' }, expectedVersion: 1 }]), /exceeds 10 years/);
  assert.equal(first.Tasks[0].plannedEnd, '2027-01-02');
});

test('dependency/date and progress warnings do not change other tasks', () => {
  const a = { ...task, status: 'Completed' as const, progress: 85 };
  const b = makeRecord({ id: 'b', title: 'Second task', plannedStart: '2027-01-02', plannedEnd: '2027-01-08', projectId: 'p', dependencies: [task.id] });
  assert.equal(taskWarnings(a, [a, b]).length, 3);
  assert.equal(defaultProgress('In Progress', 5), 50);
  assert.equal(defaultProgress('On Hold', 76), 76);
  assert.throws(() => applyChanges(emptyData(), [setup[0], { table: 'Tasks', record: { ...a, dependencies: ['b'] }, expectedVersion: 0 }, { table: 'Tasks', record: b, expectedVersion: 0 }]), /circular/);
  assert.equal(b.plannedStart, '2027-01-02');
});

test('benchmark 500 projects, 50,000 tasks and one 10,000-task project without dropping rows', () => {
  const data = emptyData();
  for (let p = 0; p < 500; p++) data.Projects.push(makeRecord({ id: `project-${p}`, title: `Project ${p}`, version: 1 }));
  for (let i = 0; i < 50000; i++) {
    const n = i < 10000 ? 0 : 1 + ((i - 10000) % 499);
    const start = addDays('2026-01-01', i % 3550);
    data.Tasks.push(makeRecord({ id: `task-${i}`, projectId: `project-${n}`, title: `Task ${i}`, plannedStart: start, plannedEnd: addDays(start, 12), phase: `Phase ${i % 20}`, version: 1 }));
  }
  const start = performance.now();
  const index = new ScheduleIndex(data);
  const built = performance.now();
  const all = index.view({ project: '', q: '', start: '2026-01-01', end: '2035-12-31', status: '' });
  const queried = performance.now();
  assert.equal(all.filter(row => row.kind === 'task').length, 50000);
  assert.equal(all.filter(row => row.kind === 'project').length, 500);
  assert.equal(index.view({ project: 'project-0', q: '', start: '2026-01-01', end: '2035-12-31', status: '' }).filter(row => row.kind === 'task').length, 10000);
  assert.equal(summaries(data).length, 500);
  console.log(`Synthetic capacity: index ${(built - start).toFixed(1)} ms, combined window ${(queried - built).toFixed(1)} ms (${all.length} visible-model rows)`);
});
