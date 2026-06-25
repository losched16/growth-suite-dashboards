// Rebuild every MCH enrollment + invoices DIRECTLY from the school's
// verified reconciliation sheet ("Updated Sheet - Sheet1 (1).csv"), so our
// numbers match theirs line-for-line.
//
// Per the school's column order:
//   Total Due = base tuition + extra care − sibling − pay-early − deposit + dev fee   (+ ACH fee, see below)
// We store that "clean" tuition total on the enrollment + invoices. Payment
// fees are NOT pre-printed — they're applied automatically AT CHECKOUT based
// on the method the parent actually uses (fee-math.ts): card = 2.9% + $0.30,
// ACH = 0.8% capped at $5 (= $5/payment for tuition). pass_ach_fee +
// pass_card_fee stay ON so both fees show on the pay screen.
//
// Usage:
//   node scripts/apply-mch-verified-sheet.mjs          # PREVIEW (cross-checks every row vs the sheet)
//   node scripts/apply-mch-verified-sheet.mjs --apply

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
for (const line of envText.split('\n')) { const t=line.trim(); if(!t||t.startsWith('#'))continue; const i=t.indexOf('='); if(i>0&&!process.env[t.slice(0,i).trim()]) process.env[t.slice(0,i).trim()]=t.slice(i+1).trim(); }

const APPLY = process.argv.includes('--apply');
const SCHOOL = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8';
const CSV = 'C:\\Users\\thelo\\Downloads\\Updated Sheet - Sheet1 (1).csv';
const ACH_FEE_CENTS = 500; // $5 per ACH payment

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const HOLD_OFF = new Set(['maxwell devaughn', 'michael zakorchemny']);
const SKIP = new Set(['violet sekel']); // scholarship → $0, already correct
// Sheet-spelling → DB-spelling, for names that differ between the two.
const ALIAS = { nataliekorzeniowski: 'nataliekoreniowski' };

const money = (s) => { const n=parseFloat(String(s??'').replace(/[^0-9.]/g,'')); return Number.isFinite(n)?Math.round(n*100):0; };
const norm = (s) => String(s??'').toLowerCase().replace(/[^a-z0-9]/g,'');

// minimal CSV line parser (handles double-quoted fields with commas)
function parseLine(line){ const out=[]; let cur='',q=false; for(let i=0;i<line.length;i++){const c=line[i]; if(q){ if(c==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=c; } else { if(c==='"')q=true; else if(c===','){out.push(cur);cur='';} else cur+=c; } } out.push(cur); return out; }

function dueDates(tpl, monthDay, ay, count){
  const [sy]=ay.split('-'); const startYear=parseInt(sy,10);
  let aM=null,aD=null; if(monthDay){const m=/^(\d{2})-(\d{2})$/.exec(monthDay); if(m){aM=+m[1];aD=+m[2];}}
  const startMonth=aM??8; const yearOf=m=>m>=startMonth?startYear:startYear+1;
  const at=(y,m,d)=>{const last=new Date(Date.UTC(y,m,0)).getUTCDate(); return new Date(Date.UTC(y,m-1,Math.min(d,last),12,0,0));};
  const kind=tpl?.kind, months=tpl?.months;
  if(kind==='single'){const m=aM??8,d=aD??15; return [at(yearOf(m),m,d)];}
  if(kind==='monthly'||kind==='semiannual'){const day=aD??15; return months.map(mm=>{const m=parseInt(mm,10);return at(yearOf(m),m,day);});}
  return [];
}

async function main(){
  // Fees apply at checkout based on actual method — turn the automatic ACH
  // fee back ON (card fee is already on). No pre-printed fee lines.
  if(APPLY){ await pool.query("UPDATE school_payment_config SET pass_ach_fee=true, pass_card_fee=true, updated_at=now() WHERE school_id=$1",[SCHOOL]); }

  // plans by installment count
  const { rows: plans } = await pool.query("SELECT id,installment_count,schedule_template,first_due_month_day FROM payment_plans WHERE school_id=$1",[SCHOOL]);
  const planByCount = new Map(plans.map(p=>[p.installment_count,p]));

  // grids by grade_level:cents
  const { rows: grids } = await pool.query("SELECT id,grade_level,annual_tuition_cents,display_name FROM tuition_grids WHERE school_id=$1 AND is_active=true",[SCHOOL]);
  const gridBy = new Map(grids.map(g=>[`${g.grade_level}:${g.annual_tuition_cents}`,g]));
  const gradeOf = { YC:'Young Community', Primary:'Primary', K:'Kindergarten' };

  // active students
  const { rows: studs } = await pool.query("SELECT s.id,s.family_id,s.first_name,s.last_name,fte.id eid, fte.academic_year FROM students s JOIN family_tuition_enrollments fte ON fte.student_id=s.id AND fte.status='active' WHERE s.school_id=$1 AND s.status='active'",[SCHOOL]);
  const studMap = new Map(studs.map(s=>[norm(s.first_name+s.last_name),s]));

  const lines = readFileSync(CSV,'utf8').split(/\r?\n/);
  const out=[]; const unmatched=[]; const mismatches=[];

  for(const line of lines.slice(1)){
    const c=parseLine(line);
    const rawName=(c[0]||'').trim();
    if(!rawName || rawName==='...' || rawName.startsWith('[Message')) continue;
    // name parse
    let first,last;
    if(rawName.includes(',')){ [last,first]=rawName.split(',').map(x=>x.trim()); }
    else { const parts=rawName.split(/\s+/); first=parts.pop(); last=parts.join(' '); }
    const nkey = norm(first+last);
    if(SKIP.has(`${first} ${last}`.toLowerCase())) { out.push(`  ⊝ ${first} ${last} — skipped (scholarship, $0)`); continue; }

    const program = c[1].trim() ? 'YC' : (c[2].trim() ? 'Primary' : (c[3].trim()?'K':null));
    const payCell = (c[4]||'').trim();
    const num = parseInt(payCell,10) || 0;
    const isACH = /ach/i.test(payCell);
    const base=money(c[5]), extra=money(c[6]), sibling=money(c[8]), payEarly=money(c[10]), ach=money(c[12]), deposit=money(c[13]), dev=money(c[14]), totalDue=money(c[15]);
    const notes=((c[16]||'')+' '+(c[17]||'')).toLowerCase();

    const st = studMap.get(nkey) || studMap.get(ALIAS[nkey]);

    if(HOLD_OFF.has(`${first} ${last}`.toLowerCase()) || notes.includes('hold off')){
      out.push(`  ⏸ ${first} ${last} — HOLD OFF (delete draft invoices, no billing)`);
      if(APPLY && st){ await pool.query("DELETE FROM invoices WHERE source='tuition_plan' AND source_ref->>'enrollment_id'=$1 AND status IN ('draft','open')",[st.eid]); }
      continue;
    }
    if(!st){ unmatched.push(`${first} ${last} (key=${nkey})`); continue; }

    const cleanTotal = base + extra - sibling - payEarly - deposit + dev;
    const expectClean = totalDue - ach;
    if(cleanTotal !== expectClean) mismatches.push(`${first} ${last}: computed clean $${(cleanTotal/100).toFixed(2)} vs sheet(TotalDue−ACH) $${(expectClean/100).toFixed(2)}`);

    // grid
    let gradeLevel = gradeOf[program];
    let grid = gridBy.get(`${gradeLevel}:${base}`);
    if(!grid && program==='Primary'){ grid = gridBy.get(`Young Community:${base}`); if(grid) gradeLevel='Young Community'; } // Tessa: Primary-marked but $11,600 = YC 4-day
    const gridId = grid?.id;

    // addons
    const addons=[];
    if(extra>0) addons.push({key:'extended_care',label:'Extended care',amount_cents:extra});
    if(deposit>0) addons.push({key:'deposit',label:'Deposit (paid)',amount_cents:-deposit});
    if(sibling>0) addons.push({key:'sibling_discount',label:'Sibling discount (10%)',amount_cents:-sibling});
    if(payEarly>0) addons.push(num===1
      ? {key:'prompt_pay_discount',label:'Paid-in-full discount (3%)',amount_cents:-payEarly}
      : {key:'semi_annual_discount',label:'Semi-annual discount (2%)',amount_cents:-payEarly});
    if(dev>0) addons.push({key:'development_fee',label:'Development fee',amount_cents:dev});

    const plan = planByCount.get(num);
    const achTag = isACH ? '  (ACH — fee at checkout)' : '';
    const gridTag = gridId ? '' : '  ⚠ NO GRID';
    out.push(`  ${(first+' '+last).padEnd(22)} ${program.padEnd(7)} /${String(num).padEnd(2)} base $${(base/100).toString().padStart(6)} ext $${(extra/100)} = clean $${(cleanTotal/100).toFixed(2).padStart(10)}${achTag}${gridTag}`);

    if(APPLY && gridId && plan){
      await pool.query("UPDATE family_tuition_enrollments SET tuition_grid_id=$2, payment_plan_id=$3, annual_tuition_cents=$4, addons=$5::jsonb, total_annual_cents=$6, installment_count=$7, updated_at=now() WHERE id=$1",
        [st.eid, gridId, plan.id, base, JSON.stringify(addons), cleanTotal, num]);
      await pool.query("DELETE FROM invoices WHERE source='tuition_plan' AND source_ref->>'enrollment_id'=$1 AND status IN ('draft','open')",[st.eid]);
      if(cleanTotal>0 && num>0){
        const dates=dueDates(plan.schedule_template, plan.first_due_month_day, st.academic_year, num);
        const per=Math.floor(cleanTotal/num), rem=cleanTotal-per*num;
        for(let i=0;i<num;i++){
          const tuition = i===num-1 ? per+rem : per; // CLEAN tuition; fees applied at checkout
          const due = (dates[i]||dates[dates.length-1]).toISOString().slice(0,10);
          const cfg=await pool.query("INSERT INTO school_payment_config (school_id) VALUES ($1) ON CONFLICT (school_id) DO UPDATE SET next_invoice_number=school_payment_config.next_invoice_number+1 RETURNING invoice_number_prefix prefix, next_invoice_number next",[SCHOOL]);
          const seq=cfg.rows[0].next>1?cfg.rows[0].next-1:1; const invno=`${cfg.rows[0].prefix}-${String(seq).padStart(6,'0')}`;
          await pool.query("INSERT INTO invoices (school_id,family_id,student_id,invoice_number,title,description,status,subtotal_cents,platform_fee_cents,discount_total_cents,total_cents,due_at,issued_at,source,source_ref,includes_platform_setup_fee,created_by_email) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,0,0,$7,$8::date,null,'tuition_plan',$9::jsonb,false,'verified-sheet@growthsuite.local')",
            [SCHOOL,st.family_id,st.id,invno,`Tuition — installment ${i+1}/${num}`,`Annual ${st.academic_year}`,tuition,due,JSON.stringify({enrollment_id:st.eid,installment_number:i+1})]);
        }
      }
      await pool.query("UPDATE family_tuition_enrollments SET installments_generated_at=now() WHERE id=$1",[st.eid]);
    }
  }

  console.log(out.join('\n'));
  if(unmatched.length){ console.log('\n⚠ UNMATCHED students (not found in DB):\n  '+unmatched.join('\n  ')); }
  if(mismatches.length){ console.log('\n⚠ TOTAL MISMATCHES (computed vs sheet):\n  '+mismatches.join('\n  ')); }
  else console.log('\n✓ Every matched student\'s computed clean total equals the sheet (Total Due − ACH).');
  console.log(`\n${APPLY?'APPLIED':'PREVIEW'}. ${APPLY?'Invoices are clean tuition; card/ACH fees apply at checkout.':'Re-run with --apply to write.'}`);
  await pool.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
