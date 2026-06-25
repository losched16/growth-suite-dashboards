// Populate students.metadata.date_of_admission from metadata.start_date
// (the enrollment-sheet "Start Date" column) so the DHS Agreement's
// "Date of child's admission" field prefills. The DHS form reads
// student.date_of_admission; start dates were imported under start_date,
// so the field was blank. Converts M/D/YY or M/D/YYYY → ISO YYYY-MM-DD.
//
// Usage: node scripts/import-mch-admission-dates.mjs            # preview
//        node scripts/import-mch-admission-dates.mjs --apply

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname,'..','.env.local'),'utf8');
for (const line of envText.split('\n')){const t=line.trim();if(!t||t.startsWith('#'))continue;const i=t.indexOf('=');if(i>0&&!process.env[t.slice(0,i).trim()])process.env[t.slice(0,i).trim()]=t.slice(i+1).trim();}

const APPLY = process.argv.includes('--apply');
const SCHOOL = 'a6c4b2dd-050c-4bf9-893b-67106f0f20e8';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// "9/10/26" | "9/4/2025" | "09/04/2025" → "2026-09-10" etc.
function toISO(raw){
  const s=String(raw||'').trim(); if(!s) return null;
  const m=/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s); if(!m) return null;
  let [,mo,d,y]=m; mo=+mo; d=+d; y=+y; if(y<100) y+=2000;
  if(mo<1||mo>12||d<1||d>31) return null;
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

async function main(){
  const { rows } = await pool.query("SELECT id,first_name,last_name,metadata->>'start_date' sd,metadata->>'date_of_admission' adm FROM students WHERE school_id=$1 AND status='active' ORDER BY last_name",[SCHOOL]);
  let set=0; const missing=[]; const bad=[];
  for(const r of rows){
    const iso=toISO(r.sd);
    if(!iso){ if(!r.sd) missing.push(`${r.first_name} ${r.last_name} (no start_date)`); else bad.push(`${r.first_name} ${r.last_name}: unparseable "${r.sd}"`); continue; }
    if(r.adm===iso) continue; // already correct
    if(APPLY){ await pool.query("UPDATE students SET metadata = metadata || jsonb_build_object('date_of_admission',$2::text), updated_at=now() WHERE id=$1",[r.id,iso]); }
    console.log(`  ${(r.first_name+' '+r.last_name).padEnd(22)} ${r.sd} → ${iso}`);
    set++;
  }
  if(missing.length) console.log('\nNo start_date (need from school):\n  '+missing.join('\n  '));
  if(bad.length) console.log('\nUnparseable start_date:\n  '+bad.join('\n  '));
  console.log(`\n${APPLY?'APPLIED':'PREVIEW'} — ${set} students ${APPLY?'updated':'to update'}.`);
  await pool.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
