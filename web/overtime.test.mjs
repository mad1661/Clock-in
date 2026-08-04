/**
 * California overtime rules, checked against the cases most timesheet tools get
 * wrong. Pure functions, no emulator needed:
 *
 *   npm --prefix web run test:overtime
 */
import { californiaOvertime } from './src/lib/overtime.ts';
let pass=0, fail=0;
const eq=(n,got,want)=>{
  const ok = Math.abs(got.regularHours-want[0])<0.01 && Math.abs(got.overtimeHours-want[1])<0.01 && Math.abs(got.doubleTimeHours-want[2])<0.01;
  ok?pass++:fail++;
  console.log(`${ok?'✅':'❌'} ${n} → reg ${got.regularHours} ot ${got.overtimeHours} dt ${got.doubleTimeHours}${ok?'':`  (wanted ${want.join('/')})`}`);
};
const d=(date,hours)=>({date,hours});

eq('5x8h = 40 straight', californiaOvertime([
  d('2026-08-03',8),d('2026-08-04',8),d('2026-08-05',8),d('2026-08-06',8),d('2026-08-07',8)]), [40,0,0]);

eq('4x10h — daily OT even though week is 40', californiaOvertime([
  d('2026-08-03',10),d('2026-08-04',10),d('2026-08-05',10),d('2026-08-06',10)]), [32,8,0]);

eq('one 14h day = 8 reg + 4 ot + 2 dt', californiaOvertime([d('2026-08-03',14)]), [8,4,2]);

eq('6x9h — daily OT plus weekly OT, no pyramiding', californiaOvertime([
  d('2026-08-03',9),d('2026-08-04',9),d('2026-08-05',9),d('2026-08-06',9),d('2026-08-07',9),d('2026-08-08',9)]), [40,14,0]);

eq('7 consecutive days, 8h each', californiaOvertime([
  d('2026-08-02',8),d('2026-08-03',8),d('2026-08-04',8),d('2026-08-05',8),
  d('2026-08-06',8),d('2026-08-07',8),d('2026-08-08',8)]), [40,16,0]);

eq('7th day 10h → 8 at 1.5x, 2 at 2x', californiaOvertime([
  d('2026-08-02',8),d('2026-08-03',8),d('2026-08-04',8),d('2026-08-05',8),
  d('2026-08-06',8),d('2026-08-07',8),d('2026-08-08',10)]), [40,16,2]);

eq('day off breaks the consecutive run', californiaOvertime([
  d('2026-08-02',8),d('2026-08-03',8),d('2026-08-04',8),d('2026-08-05',8),
  d('2026-08-06',8),d('2026-08-08',8)]), [40,8,0]);

eq('empty week', californiaOvertime([]), [0,0,0]);
eq('half day', californiaOvertime([d('2026-08-03',4)]), [4,0,0]);
eq('zero-hour entries ignored', californiaOvertime([d('2026-08-03',0),d('2026-08-04',8)]), [8,0,0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
