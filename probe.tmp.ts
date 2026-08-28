import fs from "node:fs";
import { deckSchema } from "./src/schema";
const base = JSON.parse(fs.readFileSync("tests/fixtures/all-layouts.json","utf8"));
const q = base.slides.find((s:any)=>s.layout==="quantitative");
const mk = (metrics:any[]) => ({...base, slides: base.slides.map((s:any)=> s.id===q.id ? {...q, composition:"gauge_row", content:{...q.content, metrics}} : s)});
for (const [name, metrics] of [
  ["億円 unit",      [{label:"売上",value:70,unit:"億円",period:"p"},{label:"利益",value:20,unit:"億円",period:"p"}]],
  ["% over 100",     [{label:"達成",value:250,unit:"%",period:"p"},{label:"進捗",value:40,unit:"%",period:"p"}]],
  ["% negative",     [{label:"成長",value:-15,unit:"%",period:"p"},{label:"進捗",value:40,unit:"%",period:"p"}]],
  ["% valid",        [{label:"達成",value:70,unit:"%",period:"p"},{label:"進捗",value:40,unit:"%",period:"p"}]],
] as any) {
  const r = deckSchema.safeParse(mk(metrics));
  console.log(name.padEnd(14), r.success ? "ACCEPTED" : "rejected: " + JSON.parse(r.error.message)[0].message.slice(0,70));
}
