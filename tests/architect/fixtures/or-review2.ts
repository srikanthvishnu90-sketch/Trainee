// The second review's 80 "or" queries with the alternatives each must keep whole, and its checker (its s6.ts).
const A = [
"product designer [los angeles|san diego]","nurse practitioner [st louis|kansas city]","[paralegal|legal assistant] in boston","barista [part time|full time] denver","[ux researcher|product designer] at [adobe|figma]",
"warehouse associate [night shift|day shift]","mechanical engineer intern [summer 2027|fall 2027]","[accounting|finance] internship minneapolis","teacher [elementary|middle school] austin","[c++|rust] developer remote",
"[node.js|python] backend engineer","data analyst [salt lake city|las vegas]","[google|jane street] swe intern","[investment banking|private equity] analyst new york","[registered nurse|medical assistant] phoenix",
"[electrician|plumber] apprentice","marketing intern [nyc|la|chicago]","[sales|marketing|operations] associate","project manager [construction|healthcare]","[morgan stanley|goldman sachs] summer analyst",
"software engineer [washington dc|baltimore]","line cook [brooklyn|queens]","[devops|site reliability] engineer","[junior|senior] accountant dallas","[remote|hybrid|onsite] product manager",
"graphic designer [freelance|contract]","[pharmacist|pharmacy technician] in miami","customer support [spanish|portuguese] speaking","research assistant [biology|chemistry] lab","[hr generalist|recruiter] atlanta",
"civil engineer [new orleans|baton rouge]","data engineer at [snowflake|databricks]","[quant researcher|quant trader] at [citadel|two sigma]","[bank teller|loan officer] [san antonio|el paso]","security analyst [entry level|mid level]",
"[tesla|spacex] mechanical engineer intern","[amazon|microsoft] sde intern seattle","consultant at [bain|bcg|mckinsey]","[venture capital|private equity] associate [bay area|new york]","[swe|pm] intern [summer 2027|winter 2027]",
"[dental hygienist|dental assistant] portland","truck driver [cdl a|cdl b]","[react|vue] frontend developer","[ios|android] engineer [austin|remote]","social worker [msw|lcsw] chicago",
"[welder|machinist] near detroit","tutor [math|physics] online","[copywriter|content strategist] remote","[staff|principal] engineer at stripe","[ml engineer|data scientist] [san jose|san francisco|remote]",
"[frontend|backend|fullstack|mobile|devops|qa] engineer","intern [boston|nyc|sf|la|dc]","[analyst|associate] at [jpmorgan|citadel|blackrock] in [new york|chicago]",
];
const RAW: [string, string[][]][] = [
 ["jobs at google or at meta", [["google","meta"]]],["swe in austin or in dallas", [["austin","dallas"]]],["either nursing or teaching jobs", [["nursing","teaching"]]],["data analyst (remote or new york)", [["remote","new york"]]],
 ["(product manager or program manager) seattle", [["product manager","program manager"]]],["software engineer, boston or remote", [["boston","remote"]]],["Chicago, IL or Milwaukee, WI accountant", [["chicago, il","milwaukee, wi"]]],
 ["analyst and/or associate roles", [["analyst","associate"]]],["remote or in denver data analyst", [["remote","in denver"]]],["part-time or full-time cashier", [["part-time","full-time"]]],["cashier or stocker or bagger", [["cashier","stocker","bagger"]]],
 ["new york or new jersey or connecticut paralegal", [["new york","new jersey","connecticut"]]],["intern for summer 2027 or for fall 2027", [["summer 2027","fall 2027"]]],["java or kotlin or scala engineer in new york or remote", [["java","kotlin","scala"],["new york","remote"]]],
 ["san francisco or oakland or san jose barista", [["san francisco","oakland","san jose"]]],["ux or ui designer", [["ux","ui"]]],["work at deloitte or pwc or kpmg or ey audit", [["deloitte","pwc","kpmg","ey"]]],["Front End OR Back End developer", [["front end","back end"]]],
 ["software engineer or", []],["or software engineer", []],["oregon software engineer", []],["coordinator", []],["director or above marketing", [["director","above"]]],["nurse (rn or lpn) in (tampa or orlando)", [["rn","lpn"],["tampa","orlando"]]],
 ["intern or co-op mechanical", [["intern","co-op"]]],["hartford or new haven insurance analyst", [["hartford","new haven"]]],["fort worth or dallas hvac", [["fort worth","dallas"]]],
];
export const OR_REVIEW2: [string, string[][]][] = [...A.map((a): [string, string[][]] => [a.replace(/\[([^\]]+)\]/g, (_, g) => g.split("|").join(" or ")), [...a.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].split("|"))]), ...RAW];
const norm = (s: string) => " " + s.toLowerCase().replace(/[(),]/g, " ").replace(/\s+/g, " ").trim() + " ";
export function orCheck(q: string, groups: string[][], queries: string[], notS: string[]): string[] {
  const bad: string[] = []; if (queries.length > 4) bad.push(">4");
  const altWords = new Set(groups.flat().flatMap((a) => norm(a).trim().split(" ")));
  const shared = norm(q).trim().split(" ").filter((w) => !["or", "either", "and/or", "at", "in", "for"].includes(w) && !altWords.has(w));
  for (const x of queries) { const nx = norm(x);
    for (const w of shared) if (!nx.includes(` ${w} `)) bad.push(`shared '${w}' missing in "${x}"`);
    for (const g of groups) { const inn = g.filter((a) => nx.includes(norm(a))); if (inn.length !== 1) bad.push(`"${x}" holds ${inn.length} whole alternatives of [${g}]`);
      const partial = g.filter((a) => !nx.includes(norm(a)) && norm(a).trim().split(" ").some((w) => nx.includes(` ${w} `) && !inn.some((i) => norm(i).includes(` ${w} `)) && !shared.includes(w))); if (partial.length) bad.push(`"${x}" mixes in part of '${partial}'`); }
    if (/\bor\b/i.test(x) && groups.length) bad.push(`"or" left in "${x}"`); }
  for (const g of groups) for (const a of g) if (![...queries, ...notS].some((x) => norm(x).includes(norm(a)))) bad.push(`alternative '${a}' in no query and not in not_searched`);
  for (const g of groups) for (const a of g) if (!queries.some((x) => norm(x).includes(norm(a))) && queries.length < 4) bad.push(`'${a}' unsearched though <4 queries`);
  return bad;
}
