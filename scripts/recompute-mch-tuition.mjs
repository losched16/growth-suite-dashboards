// Recompute every MCH tuition total with the school-confirmed formula
// and rewrite the installment invoices. Fixes the June-15 date-regen
// that flattened totals down to base grid tuition.
//
// Formula (school-confirmed, NO plan/prompt-pay discount):
//   subtotal = base grid tuition − deposit + extended care
//   if sibling: subtotal × 0.90        (10% sibling discount)
//   total    = subtotal + development fee
//   Kindergarten: base = $13,500 grid, development fee = $250
//   Violet Sekel: show K $13,500 + $250 dev, then scholarship → $0 owed
//
// Stores the full line-item breakdown in family_tuition_enrollments.addons
// so the contract + DHS forms can display every line. Regenerates draft/
// open invoices at the correct total with the locked dates (7/15 → …).
//
// Usage:
//   node scripts/recompute-mch-tuition.mjs            # PREVIEW
//   node scripts/recompute-mch-tuition.mjs --apply

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
for (const line of envText.split('\n')) { const t=line.trim(); if(!t||t.startsWith('#'))continue; const i=t.indexOf('='); if(i>0&&!process.env[t.slice(0,i).trim()]) process.env[t.slice(0,i).trim()]=t.slice(i+1).trim(); }

const APPLY = process.argv.includes('--apply');
const SCHOOL='a6c4b2dd-050c-4bf9-893b-67106f0f20e8';
const rows = JSON.parse(readFileSync(join(__dirname,'mch_recompute.json'),'utf8'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// 11 kindergarten students (school-supplied), keyed "first last" to match
// the norm() key below. Forced to the K grid + $250 dev fee.
const K_LIST = new Set(['thea bailey','elynn dipasquale','gytha kalasunas','rory marlowe','prayan mishra','bella osuwa','maya pirrocco','alina quintans','violet sekel','ryan sobotta','alicia yang']);
// Violet Sekel = full scholarship (show value, owe $0).
const SCHOLARSHIP = new Set(['violet sekel']);

const EXT = { '1':{2:97500,3:136500,4:172000,5:202500}, '2':{2:172500,3:230000,4:286500,5:330000}, '3':{2:230000,3:313000,4:357000,5:400000}, '4':{2:285000,3:357000,4:404000,5:467500} };
function extTier(raw){ const s=String(raw??'').toLowerCase(); if(!s||s==='0'||s==='none')return null; if(s.includes('1 hour or less'))return '1'; if(s.includes('1 hours, up to 2')||(s.includes('1 hour')&&s.includes('2 hours')))return '2'; if(s.includes('2 hours')&&s.includes('3 hours'))return '3'; if(s.includes('more than 3'))return '4'; return null; }
function parseDays(raw, times){ let s=String(raw??'').toUpperCase(); let hf=s.includes('FULL')?'full':(s.includes('HAL')?'half':null);
  let c=s.replace(/\d+(?::\d+)?\s*[AP]M/g,'').replace(/\d+(?::\d+)?/g,'').replace(/[AP]M/g,'').replace(/[:,;]/g,' ').replace(/\bFULL\b/g,'').replace(/\bHAL?F?\b/g,'').trim();
  if(/M\s*-\s*F/.test(c)) return {count:5,hf:hf||'full'};
  let n=0; for(let i=0;i<c.length;i++){const ch=c[i]; if(ch===' '||ch==='-')continue; if(ch==='T'&&c[i+1]==='H'){n++;i++;continue;} if('MTWF'.includes(ch))n++;}
  if(n<1)n=5; if(n>5)n=5;
  if(!hf){const t=String(times??'').toLowerCase(); hf=(t.includes('11:30')||t.includes('11:45'))?'half':'full';}
  return {count:n,hf};
}
function gridName(program, days, hf){ const eff=days===4?5:days; if(program==='Kindergarten')return 'Kindergarten — 5 Full Days (8:30am–3:15pm)';
  const dl=`${eff} Days`, hl=hf==='half'?'Half Day':'Full Day';
  if(program==='Young Community'){ if(eff===2&&hf==='half')return 'YC — 2 Days, Half Day (9am–11:30am)'; if(eff===2)return 'YC — 2 Days, Full Day (9am–2:45pm)'; return `YC — ${dl}, ${hl}`; }
  if(eff===3&&hf==='half')return 'Primary — 3 Days, Half Day (8:45am–11:45am)'; if(eff===3)return 'Primary — 3 Days, Full Day (8:45am–2:45pm)'; return `Primary — ${dl}, ${hl}`;
}
function money(s){ const n=parseFloat(String(s??'').replace(/[^0-9.]/g,'')); return Number.isFinite(n)?Math.round(n*100):0; }
const norm=s=>String(s??'').toLowerCase().replace(/[^a-z ]/g,'').replace(/\s+/g,' ').trim();

// Port of the generator's computeDueDates (anchor-month boundary fix).
function dueDates(scheduleTpl, firstDueMonthDay, academicYear, count){
  const [sy]=academicYear.split('-'); const startYear=parseInt(sy,10);
  let aM=null,aD=null; if(firstDueMonthDay){const m=/^(\d{2})-(\d{2})$/.exec(firstDueMonthDay); if(m){aM=+m[1];aD=+m[2];}}
  const startMonth=aM??8; const yearOf=m=>m>=startMonth?startYear:startYear+1;
  const at=(y,m,d)=>{const last=new Date(Date.UTC(y,m,0)).getUTCDate(); return new Date(Date.UTC(y,m-1,Math.min(d,last),12,0,0));};
  const kind=scheduleTpl?.kind; const months=scheduleTpl?.months;
  if(kind==='single'){const m=aM??8,d=aD??15; return [at(yearOf(m),m,d)];}
  if(kind==='monthly'||kind==='semiannual'){const day=aD??1; return months.map(mm=>{const m=parseInt(mm,10);return at(yearOf(m),m,day);});}
  return [];
}

async function main(){
  let okCount=0; const preview=[];
  for(const r of rows){
    const [last,first]=r.name.split(',').map(x=>x.trim());
    const key=norm(`${first} ${last}`);
    // Find the active enrollment for this student.
    const { rows: er } = await pool.query(`
      SELECT fte.id, fte.academic_year, fte.payment_plan_id, fte.installment_count,
             pp.schedule_template, pp.first_due_month_day, s.id AS student_id, s.family_id
        FROM students s JOIN family_tuition_enrollments fte ON fte.student_id=s.id AND fte.status='active'
        JOIN payment_plans pp ON pp.id=fte.payment_plan_id
       WHERE s.school_id=$1 AND s.status='active' AND lower(s.first_name)=lower($2) AND lower(s.last_name)=lower($3) LIMIT 1`,
      [SCHOOL, first, last]);
    if(!er.length){ preview.push(`  ?? ${r.name} — no active enrollment`); continue; }
    const e=er[0];
    const isK=K_LIST.has(norm(`${first} ${last}`));
    const program = isK ? 'Kindergarten' : (r.yc ? 'Young Community' : 'Primary');
    const {count,hf}=parseDays(r.days, r.times);
    const gname=gridName(program,count,hf);
    const { rows: gr } = await pool.query(`SELECT id, annual_tuition_cents FROM tuition_grids WHERE school_id=$1 AND display_name=$2 AND is_active=true`,[SCHOOL,gname]);
    if(!gr.length){ preview.push(`  ?? ${r.name} — grid not found: ${gname}`); continue; }
    const base=gr[0].annual_tuition_cents, gridId=gr[0].id;
    const tier=extTier(r.extcare); const eff=count===4?5:count;
    const ext = tier ? (EXT[tier]?.[eff]??0) : 0;
    const isScholar=SCHOLARSHIP.has(key);
    const isSibling = /%|-10/.test(r.sibling||'');
    // Flat deposit rule (school-confirmed): every student gets a $400
    // deposit credit, siblings $200 — regardless of whether the sheet
    // cell is filled. Scholarship (Violet) has no deposit.
    const deposit = isScholar ? 0 : (isSibling ? 20000 : 40000);
    const devFee = isK ? 25000 : (money(r.devfee)||20000);

    // Build the breakdown.
    const addons=[];
    if(ext>0) addons.push({key:'extended_care',label:`Extended care (${r.extcare})`,amount_cents:ext});
    if(deposit>0) addons.push({key:'deposit',label:'Deposit (paid)',amount_cents:-deposit});
    let subtotal = base - deposit + ext;
    let sibAmt=0;
    if(isSibling){ const after=Math.round(subtotal*0.9); sibAmt=subtotal-after; subtotal=after; addons.push({key:'sibling_discount',label:'Sibling discount (10%)',amount_cents:-sibAmt}); }
    addons.push({key:'development_fee',label:`Development fee`,amount_cents:devFee});
    let total = subtotal + devFee;
    if(isScholar){ addons.push({key:'scholarship',label:'Full scholarship',amount_cents:-total}); }
    const owed = isScholar ? 0 : total;

    preview.push(`  ${r.name.padEnd(22)} ${program.slice(0,4)} base$${(base/100).toFixed(0).padStart(6)} -dep$${(deposit/100).toFixed(0)} +ext$${(ext/100).toFixed(0)} ${isSibling?'-10%':'    '} +dev$${(devFee/100).toFixed(0)} = $${(owed/100).toLocaleString()}${isScholar?' (scholarship; shows $'+(total/100).toLocaleString()+')':''}`);

    if(APPLY){
      await pool.query(`UPDATE family_tuition_enrollments SET tuition_grid_id=$2, annual_tuition_cents=$3, addons=$4::jsonb, total_annual_cents=$5,
        tuition_override_cents=$6, tuition_override_reason=$7, updated_at=now() WHERE id=$1`,
        [e.id, gridId, base, JSON.stringify(addons), owed, isScholar?0:null, isScholar?'Full scholarship 2026-27':null]);
      // Rewrite installment invoices.
      await pool.query(`DELETE FROM invoices WHERE source='tuition_plan' AND source_ref->>'enrollment_id'=$1 AND status IN ('draft','open')`,[e.id]);
      if(owed>0){
        const dates=dueDates(e.schedule_template,e.first_due_month_day,e.academic_year,e.installment_count);
        const n=e.installment_count; const per=Math.floor(owed/n); const rem=owed-per*n;
        for(let i=0;i<n;i++){
          const amt = i===n-1 ? per+rem : per;
          const due = dates[i] ? dates[i].toISOString().slice(0,10) : dates[dates.length-1].toISOString().slice(0,10);
          const cfg=await pool.query(`INSERT INTO school_payment_config (school_id) VALUES ($1) ON CONFLICT (school_id) DO UPDATE SET next_invoice_number=school_payment_config.next_invoice_number+1 RETURNING invoice_number_prefix prefix, next_invoice_number next`,[SCHOOL]);
          const seq=cfg.rows[0].next>1?cfg.rows[0].next-1:1; const invno=`${cfg.rows[0].prefix}-${String(seq).padStart(6,'0')}`;
          await pool.query(`INSERT INTO invoices (school_id,family_id,student_id,invoice_number,title,description,status,subtotal_cents,platform_fee_cents,discount_total_cents,total_cents,due_at,issued_at,source,source_ref,includes_platform_setup_fee,created_by_email)
            VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,0,0,$7,$8::date,null,'tuition_plan',$9::jsonb,false,'recompute@growthsuite.local')`,
            [SCHOOL,e.family_id,e.student_id,invno,`Tuition — installment ${i+1}/${n}`,`Annual ${e.academic_year}`,amt,due,JSON.stringify({enrollment_id:e.id,installment_number:i+1})]);
        }
      }
      await pool.query(`UPDATE family_tuition_enrollments SET installments_generated_at=now() WHERE id=$1`,[e.id]);
    }
    okCount++;
  }
  console.log(preview.join('\n'));
  console.log(`\n${APPLY?'APPLIED':'PREVIEW'} — ${okCount} enrollments.`);
  if(!APPLY) console.log('Re-run with --apply to write.');
  await pool.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
