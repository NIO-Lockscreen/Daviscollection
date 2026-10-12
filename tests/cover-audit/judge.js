/* Cover audit: decide whether an automatic cover result is the right film for a ground-truth entry.
   Verdicts:
     CORRECT    cover is one of the accepted films
     WRONG      cover is a different film (or any cover for a non-film like a concert)
     RISKY      title is ambiguous (several films fit, shelf doesn't settle it) and a cover was still picked
     MISS       no cover although an accepted film exists (safe, just less helpful)
     SAFE_NONE  no cover for an ambiguous title or a non-film (the desired outcome) */
(function(root){
  const ROMAN={ii:'2',iii:'3',iv:'4',v:'5',vi:'6'};
  function normTitle(s){
    return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
      .replace(/\s*\((?:[^)]*\b(?:film|movie|series|miniseries)\b[^)]*)\)\s*$/,'') // "Heat (1995 film)"
      .replace(/&/g,' and ').replace(/['’`.]/g,'').replace(/[^a-z0-9]+/g,' ')
      .split(' ').filter(w=>w && !['the','a','an'].includes(w)).map(w=>ROMAN[w]||w).join(' ');
  }
  function yearOf(v){const m=String(v||'').match(/\b(18|19|20)\d{2}\b/); return m?Number(m[0]):null;}
  function judge(entry, result){
    const accept=entry.accept||[];
    if(!result || !result.posterUrl) return (entry.ambiguous || !accept.length) ? 'SAFE_NONE' : 'MISS';
    const rt=normTitle(result.title), ry=yearOf(result.year);
    const hit=accept.some(a=>normTitle(a.title)===rt && (!a.year || !ry || Math.abs(a.year-ry)<=1));
    if(!accept.length) return 'WRONG';
    if(entry.ambiguous) return hit ? 'RISKY' : 'WRONG';
    return hit ? 'CORRECT' : 'WRONG';
  }
  function summarize(rows){
    const c={CORRECT:0,WRONG:0,RISKY:0,MISS:0,SAFE_NONE:0};
    rows.forEach(r=>c[r.verdict]++);
    const assigned=c.CORRECT+c.WRONG+c.RISKY;
    const answerable=rows.filter(r=>!r.entry.ambiguous && (r.entry.accept||[]).length).length;
    return {...c, total:rows.length, assigned,
      precision: assigned ? c.CORRECT/assigned : null,          // share of auto covers that are right
      coverage: answerable ? c.CORRECT/answerable : null};      // share of clear-cut titles that got the right cover
  }
  const api={normTitle, judge, summarize};
  if(typeof module!=='undefined' && module.exports) module.exports=api; else root.CoverAudit=api;
})(this);
